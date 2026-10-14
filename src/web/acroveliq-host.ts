// The AcrovelIQ host filter (task acroveliq-host-szures). A request that
// arrives on the configured AcrovelIQ host (ACROVELIQ_HOST, e.g.
// acroveliq.acropora.hu) may reach only the AcrovelIQ page: the page shell and
// its static files, the login, the GET endpoints the page reads, and the owner's
// named writes (the decision and the task actions, session only, each by its own
// decision of Balázs). Everything else is a 404 there. Every other host keeps the full dashboard.
//
// Balázs's decision (18:31:43 UTC, msg 1559634758932242504): the new domain
// serves the AcrovelIQ page, the authentication it needs, its static resources
// and the read-only APIs; no fleet management, terminal, agent restart or
// configuration change; everything else denied by default; the backend check
// stays (this list runs IN the server, in front of the auth gate and the access
// matrix, which still run on every request it lets through).
//
// Two ways a request is on the AcrovelIQ surface, and the first one is the
// protection:
//   1. it arrived on ACROVELIQ_PORT, the listener the public proxy points at:
//      there the list applies to EVERY request, whatever the headers say, so a
//      proxy that rewrites or drops the host header cannot open the dashboard
//      (barracuda, #70 review: header-only detection fails open);
//   2. on any port, its Host header, an X-Forwarded-Host hop or a Forwarded
//      `host=` names ACROVELIQ_HOST. A client can add a header, so a header can
//      only ever turn the filter ON, never off. This is the second layer.

import type { DecisionView, HandoffDecisionView } from '../decisions.js'
import type { OpenMatters, OpenMattersMemory } from '../open-matters.js'

/** Lowercased host without port and trailing dot; '' for an empty or unparsable value. */
export function normalizeHost(raw: string | undefined | null): string {
  let h = (raw ?? '').trim().toLowerCase()
  if (!h) return ''
  if (h.startsWith('"') && h.endsWith('"') && h.length >= 2) h = h.slice(1, -1)
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(0, end + 1) : ''
  }
  const colon = h.indexOf(':')
  if (colon >= 0) h = h.slice(0, colon)
  return h.replace(/\.+$/, '')
}

/**
 * The AcrovelIQ listener port: null when unset (no second listener). A value
 * that is not a port, or is the dashboard's own port, is a problem and no
 * listener: the proxy then reaches nothing, which fails closed.
 */
export function parseAcroveliqPort(setting: string | undefined, dashboardPort: number): { port: number | null; problem?: string } {
  const raw = (setting ?? '').trim()
  if (!raw) return { port: null }
  const n = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { port: null, problem: `ACROVELIQ_PORT is not a port: ${JSON.stringify(raw)}; no AcrovelIQ listener` }
  if (n === dashboardPort) return { port: null, problem: `ACROVELIQ_PORT is the dashboard port (${n}); no AcrovelIQ listener` }
  return { port: n }
}

/**
 * The address the AcrovelIQ listener binds: ACROVELIQ_BIND, or WEB_HOST when
 * unset. Its own setting so the public proxy in ANOTHER container can reach the
 * AcrovelIQ port (e.g. 0.0.0.0) while the main dashboard port stays on loopback
 * (WEB_HOST=127.0.0.1); barracuda, #70 review.
 */
export function acroveliqBindAddress(setting: string | undefined, webHost: string): string {
  const raw = (setting ?? '').trim()
  return raw || webHost
}

/** The configured AcrovelIQ host, normalized; '' means the filter is off. */
export function parseAcroveliqHost(setting: string | undefined): string {
  return normalizeHost(setting)
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(','))
}

/** Every host the request names: Host, each X-Forwarded-Host hop, each Forwarded `host=`. */
export function requestHosts(headers: {
  host?: string | string[]
  'x-forwarded-host'?: string | string[]
  forwarded?: string | string[]
}): string[] {
  const out = [...headerValues(headers.host), ...headerValues(headers['x-forwarded-host'])]
  for (const element of headerValues(headers.forwarded)) {
    for (const pair of element.split(';')) {
      const eq = pair.indexOf('=')
      if (eq > 0 && pair.slice(0, eq).trim().toLowerCase() === 'host') out.push(pair.slice(eq + 1))
    }
  }
  return out.map(normalizeHost).filter(Boolean)
}

/** True when the filter applies to this request: a host is configured and any named host is it. */
export function isAcroveliqRequest(configured: string, headers: Parameters<typeof requestHosts>[0]): boolean {
  if (!configured) return false
  return requestHosts(headers).includes(configured)
}

export interface AcroveliqRoute {
  method: 'GET' | 'POST'
  /** An exact path, or a `:param` pattern of one segment (the route-rules syntax). */
  path: string
  why: string
}

// The positive list. An /api/ row must be a route rule (src/web/route-rules.ts)
// of class OLVASO or NYILVANOS -- src/__tests__/acroveliq-host.test.ts holds
// that, and that every GET the page's section of web/app.js sends is on it.
export const ACROVELIQ_ROUTES: readonly AcroveliqRoute[] = [
  { method: 'GET', path: '/', why: 'page shell' },
  { method: 'GET', path: '/index.html', why: 'page shell' },
  { method: 'GET', path: '/app.js', why: 'static' },
  { method: 'GET', path: '/style.css', why: 'static' },
  { method: 'GET', path: '/lang/hu.js', why: 'static' },
  { method: 'GET', path: '/lang/en.js', why: 'static' },
  { method: 'GET', path: '/manifest.json', why: 'static' },
  { method: 'GET', path: '/icons/icon-192.png', why: 'static, manifest icon' },
  { method: 'GET', path: '/icons/icon-512.png', why: 'static, manifest icon' },
  { method: 'GET', path: '/api/marveen/avatar', why: 'favicon (public)' },
  { method: 'GET', path: '/api/auth/status', why: 'login: is a password login available' },
  { method: 'POST', path: '/api/auth/login', why: 'login' },
  { method: 'GET', path: '/api/tasks', why: 'AcrovelIQ: task list' },
  { method: 'GET', path: '/api/tasks/:id/timeline', why: 'AcrovelIQ: task sheet' },
  { method: 'GET', path: '/api/agents', why: 'AcrovelIQ: agent descriptions' },
  { method: 'GET', path: '/api/agents/activity', why: 'AcrovelIQ: agent state' },
  { method: 'GET', path: '/api/messages/backlog', why: 'AcrovelIQ: message backlog' },
  // memory text and handoff questions are internal: the surface gets the picked view
  // below (acroveliqOpenMattersView), and only Balázs's session (the handler: 403
  // for a device key or any token there)
  { method: 'GET', path: '/api/open-matters', why: 'AcrovelIQ: Döntéseim (picked view)' },
  // THE DECISION WRITE (Balázs's decision B, 2026-10-14 08:52:26 UTC, msg 1559851364950220852):
  // the three Dontéseim actions on a decision row, and nothing else. The handler takes the
  // session only and refuses every row that is not a decision; the discord-reply route
  // under it is a longer path and does not match this pattern.
  { method: 'POST', path: '/api/decisions/:id', why: 'AcrovelIQ: Döntéseim, approve / reject / discuss (session only)' },
  // THE TASK WRITES (Balázs's decision B for Feladatkezelés V1, 2026-10-14 10:12:09 UTC,
  // msg 1559871429544120323): create a task, and assign / priority / pause / resume on one.
  // Session only (the handler); no agent start: the hand-out stays acrobot's.
  { method: 'POST', path: '/api/task-actions', why: 'AcrovelIQ: Feladatkezelés, new task (session only)' },
  { method: 'POST', path: '/api/task-actions/:id', why: 'AcrovelIQ: Feladatkezelés, assign / priority / pause / resume (session only)' },
]

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes(':')) return pattern === path
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return false
  return want.every((seg, i) => (seg.startsWith(':') ? got[i]!.length > 0 : seg === got[i]))
}

/**
 * Whether the AcrovelIQ host may answer (method, path). An OPTIONS preflight
 * passes for a path that is on the list with any method; HEAD is not served.
 */
export function acroveliqAllows(method: string, path: string): boolean {
  return ACROVELIQ_ROUTES.some((r) => (method === 'OPTIONS' || r.method === method) && pathMatches(r.path, path))
}

// What the two agent reads give out on the AcrovelIQ surface: the fields the
// page reads, picked (not the rest deleted), so a field added to the dashboard
// shape later does not reach the public domain. Not there: the pane tail, the
// permission mode, the remote ssh target and workdir, the security profile, the
// auth mode, the plan, the channel bot names (barracuda, #70 review).
export const ACROVELIQ_AGENT_FIELDS = ['name', 'displayName', 'description'] as const
export const ACROVELIQ_ACTIVITY_FIELDS = ['name', 'isMain', 'running', 'state', 'prompt'] as const

function pick(row: object, fields: readonly string[]): Record<string, unknown> {
  const src = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in src) out[f] = src[f]
  return out
}

/** /api/agents rows as the AcrovelIQ surface serves them. */
export function acroveliqAgentsView(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((r) => pick(r, ACROVELIQ_AGENT_FIELDS))
}

/** /api/agents/activity rows as the AcrovelIQ surface serves them. */
export function acroveliqActivityView(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((r) => pick(r, ACROVELIQ_ACTIVITY_FIELDS))
}

// /api/open-matters on the AcrovelIQ surface: the three groups of the Döntéseim view
// and their generation time, picked (task acroveliq-donteseim). Not there: the
// budgeted text and the counts and ids beside it, which also carry the open tasks, every
// handoff question and the waiting cards; the view does not read them.
export function acroveliqOpenMattersView(out: OpenMatters): { generated_at: number; items: OpenMatters['items'] } {
  const memory = (m: OpenMattersMemory): OpenMattersMemory => ({ id: m.id, content: m.content, created_at: m.created_at })
  const row = (d: DecisionView): DecisionView => ({
    id: d.id, requested_by: d.requested_by, task_id: d.task_id, summary: d.summary, reason: d.reason, consequence: d.consequence, status: d.status,
    requested_at: d.requested_at, timeout_at: d.timeout_at, resolved_at: d.resolved_at, resolved_by: d.resolved_by,
    discuss_requested_at: d.discuss_requested_at, discord_message: d.discord_message, discord_url: d.discord_url,
  })
  const dt = out.items.dontes
  return {
    generated_at: out.generated_at,
    items: {
      owes: out.items.owes.map(memory),
      decisions: out.items.decisions.map(memory),
      balazs_questions: out.items.balazs_questions.map((q) => ({ task: q.task, handoff: q.handoff, index: q.index, from: q.from, what: q.what })),
      dontes: {
        pending: dt.pending.map(row), discuss: dt.discuss.map(row), discord_replied: dt.discord_replied.map(row),
        expired: dt.expired.map(row), recent: dt.recent.map(row),
        recent_discord: dt.recent_discord.map((h: HandoffDecisionView) => ({
          task: h.task, handoff: h.handoff, what: h.what, quote: h.quote, discord_messages: [...h.discord_messages], at: h.at,
        })),
      },
    },
  }
}
