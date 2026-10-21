// B29 (task b29-flotta-olvas): the main agent's named reads of the fleet database.
//
// After B29's step B the main agent's session runs under its own OS user and cannot open
// store/claudeclaw.db (the dashboard's, 0600). The reads it needs are fixed questions here: no SQL,
// no table or column name from the caller, every parameter checked, a row limit, message and log
// text cut to 200 characters and masked for secret shapes. Only the session and the main agent's
// own token get an answer: the access matrix says so (group fleet-reads), and this handler checks
// it too, because the matrix only logs until P0-1 enforcement is on.
//
// Questions (acrobot, exchange/biztonsag/baseline/b29-flotta-olvas-kerdesek-2026-10-16.md):
//   access-decisions   ?nap=YYYY-MM-DD | ?tol=&ig=   [&actor=] [&outcome=would-deny|denied]
//   request-actors     ?actor= &ido= [&ablak=1..300]
//   uzenet-ablak       ?agens= &tol= &ig=
//   uzenet             ?id=
//   tool-log-osszesito ?agens= [&napok=1..30] [&csoport=elotag|eszkoz]
//   tool-log-minta     ?agens= &elotag= [&napok=1..30]
//   kartya-letrehozas  ?tol= &ig=            (window at most a day)
//   legacy-hivok       ?nap=YYYY-MM-DD | ?tol=&ig=   [&method=] [&path=]
//                      the shared token's calls with their three hints (legacy_callers:
//                      User-Agent product, self-declared name, remote address): the one table
//                      that says WHERE a residual shared-token call came from, and until now
//                      nothing read it (card 809a2f48, task p0-1-preflight-tisztitas)
// Answer: { sorok: [...], darab: n }.
import { getDb } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { listAgentNames } from '../agent-config.js'
import { SECRET_PATTERNS } from '../../security/secret-gate.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export const FLEET_READS = ['access-decisions', 'request-actors', 'uzenet-ablak', 'uzenet', 'tool-log-osszesito', 'tool-log-minta', 'kartya-letrehozas', 'legacy-hivok'] as const
const MAX_ROWS = 500
const CUT = 200
const DAY = 86400

class BadParam extends Error {}

const SECRET_RX = SECRET_PATTERNS.map((p) => new RegExp(p.pattern.source, p.pattern.flags.includes('g') ? p.pattern.flags : p.pattern.flags + 'g'))

/** Cut to 200 characters and mask every secret shape the secret gate knows. */
export function safeText(s: unknown): string {
  let t = typeof s === 'string' ? s : s == null ? '' : String(s)
  for (const rx of SECRET_RX) t = t.replace(rx, '[TITOK]')
  return t.length > CUT ? t.slice(0, CUT) + '…' : t
}

function epoch(sp: URLSearchParams, k: string, required = true): number | undefined {
  const v = sp.get(k)
  if (v == null || v === '') {
    if (required) throw new BadParam(`${k} kell (epoch, egész)`)
    return undefined
  }
  if (!/^\d{9,11}$/.test(v)) throw new BadParam(`${k}: epoch másodperc, egész`)
  return Number(v)
}
function int(sp: URLSearchParams, k: string, lo: number, hi: number, def?: number): number {
  const v = sp.get(k)
  if (v == null || v === '') {
    if (def === undefined) throw new BadParam(`${k} kell`)
    return def
  }
  if (!/^\d{1,6}$/.test(v) || Number(v) < lo || Number(v) > hi) throw new BadParam(`${k}: egész, ${lo} és ${hi} között`)
  return Number(v)
}
function actorName(sp: URLSearchParams, k: string, required: boolean): string | undefined {
  const v = sp.get(k)
  if (v == null || v === '') {
    if (required) throw new BadParam(`${k} kell`)
    return undefined
  }
  if (!/^[a-z][a-z0-9:/_-]{0,63}$/.test(v)) throw new BadParam(`${k}: érvénytelen név`)
  return v
}
function agentName(sp: URLSearchParams, k: string): string {
  const v = sp.get(k) ?? ''
  const known = new Set([MAIN_AGENT_ID, ...listAgentNames()])
  if (!known.has(v)) throw new BadParam(`${k}: nem regisztrált ágens`)
  return v
}
function window(sp: URLSearchParams, max?: number): [number, number] {
  const tol = epoch(sp, 'tol')!
  const ig = epoch(sp, 'ig')!
  if (ig < tol) throw new BadParam('ig nem lehet korábbi a tol-nál')
  if (max !== undefined && ig - tol > max) throw new BadParam(`az ablak legfeljebb ${max} másodperc`)
  return [tol, ig]
}

/** The tool-log grouping key: the tool, and for Bash its first word after a leading `cd X &&`
 *  (for bash, python3, node, npx also the script name), the same as the B29 coverage log. */
export function toolKey(tool: string, summary: string | null): string {
  if (tool !== 'Bash') return tool
  const cmd = (summary ?? '').replace(/^\s*cd\s+\S+\s*&&\s*/, '').trim()
  const words = cmd.split(/\s+/)
  const first = words[0] ?? ''
  if (['bash', 'python3', 'node', 'npx'].includes(first) && words[1] && !words[1].startsWith('-')) return `Bash: ${first} ${words[1]}`
  return `Bash: ${first}`
}

type Row = Record<string, unknown>

function answer(name: string, sp: URLSearchParams): Row[] {
  const db = getDb()
  switch (name) {
    case 'access-decisions': {
      const actor = actorName(sp, 'actor', false)
      // the table stores `denied` and `would-deny` (access-enforcement.ts); `deny` is accepted for `denied`
      const raw = sp.get('outcome') || undefined
      if (raw !== undefined && !['would-deny', 'denied', 'deny'].includes(raw)) throw new BadParam('outcome: would-deny vagy denied')
      const outcome = raw === 'deny' ? 'denied' : raw
      const nap = sp.get('nap')
      const where: string[] = []
      const args: unknown[] = []
      if (nap) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nap)) throw new BadParam('nap: ÉÉÉÉ-HH-NN')
        where.push('day = ?'); args.push(nap)
      } else {
        const [tol, ig] = window(sp)
        where.push('last_seen >= ? AND first_seen <= ?'); args.push(tol, ig)
      }
      if (actor) { where.push('actor = ?'); args.push(actor) }
      if (outcome) { where.push('outcome = ?'); args.push(outcome) }
      return db.prepare(`SELECT day, actor, method, path, outcome, mode, reason, count, first_seen, last_seen FROM access_decisions WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT ${MAX_ROWS}`).all(...args) as Row[]
    }
    case 'request-actors': {
      const actor = actorName(sp, 'actor', true)!
      const ido = epoch(sp, 'ido')!
      const ablak = int(sp, 'ablak', 1, 300, 5)
      return db.prepare(`SELECT actor, method, path, count, first_seen, last_seen FROM request_actors WHERE actor = ? AND last_seen >= ? AND first_seen <= ? ORDER BY first_seen LIMIT ${MAX_ROWS}`).all(actor, ido - ablak, ido + ablak) as Row[]
    }
    case 'uzenet-ablak': {
      const agens = agentName(sp, 'agens')
      const [tol, ig] = window(sp)
      const rows = db.prepare(`SELECT id, from_agent, to_agent, status, created_at, delivered_at, content FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND created_at BETWEEN ? AND ? ORDER BY id LIMIT ${MAX_ROWS}`).all(agens, agens, tol, ig) as Row[]
      return rows.map((r) => ({ ...r, content: safeText(r['content']) }))
    }
    case 'uzenet': {
      const id = int(sp, 'id', 1, 999999)
      const r = db.prepare('SELECT id, from_agent, to_agent, status, created_at, delivered_at, content FROM agent_messages WHERE id = ?').get(id) as Row | undefined
      return r ? [{ ...r, content: safeText(r['content']) }] : []
    }
    case 'tool-log-osszesito':
    case 'tool-log-minta': {
      const agens = agentName(sp, 'agens')
      const napok = int(sp, 'napok', 1, 30, 7)
      const since = Math.floor(Date.now() / 1000) - napok * DAY
      const rows = db.prepare('SELECT tool_name, input_summary FROM tool_call_log WHERE agent_id = ? AND created_at >= ?').all(agens, since) as { tool_name: string; input_summary: string | null }[]
      const counts = new Map<string, number>()
      if (name === 'tool-log-osszesito') {
        const csoport = sp.get('csoport') || 'elotag'
        if (!['elotag', 'eszkoz'].includes(csoport)) throw new BadParam('csoport: elotag vagy eszkoz')
        for (const r of rows) {
          const k = csoport === 'eszkoz' ? r.tool_name : toolKey(r.tool_name, r.input_summary)
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ROWS).map(([kulcs, darab]) => ({ kulcs: safeText(kulcs), darab }))
      }
      const elotag = sp.get('elotag') ?? ''
      if (!elotag || elotag.length > 80) throw new BadParam('elotag kell (legfeljebb 80 karakter)')
      for (const r of rows) {
        if (toolKey(r.tool_name, r.input_summary) !== elotag) continue
        const k = safeText(r.input_summary)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([input_summary, darab]) => ({ input_summary, darab }))
    }
    case 'kartya-letrehozas': {
      const [tol, ig] = window(sp, DAY)
      const rows = db.prepare(`SELECT id, title, assignee, created_at FROM kanban_cards WHERE created_at BETWEEN ? AND ? ORDER BY created_at LIMIT ${MAX_ROWS}`).all(tol, ig) as Row[]
      return rows.map((r) => ({ ...r, title: safeText(r['title']) }))
    }
    case 'legacy-hivok': {
      const where: string[] = []
      const args: unknown[] = []
      const nap = sp.get('nap')
      if (nap) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nap)) throw new BadParam('nap: ÉÉÉÉ-HH-NN')
        where.push('day = ?'); args.push(nap)
      } else {
        const [tol, ig] = window(sp)
        where.push('last_seen >= ? AND first_seen <= ?'); args.push(tol, ig)
      }
      const method = sp.get('method')
      if (method) {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new BadParam('method: GET, POST, PUT, PATCH vagy DELETE')
        where.push('method = ?'); args.push(method)
      }
      // the stored path is the route rule's pattern (routeKey), so the filter is one too
      const path = sp.get('path')
      if (path) {
        if (!/^(\/[a-z0-9:._-]+)+$|^:ismeretlen( \/api\/[a-z0-9-]+)?$/.test(path)) throw new BadParam('path: egy szabály mintája (/api/messages/:id) vagy :ismeretlen')
        where.push('path = ?'); args.push(path)
      }
      return db.prepare(`SELECT day, method, path, ua, claimed, remote, count, first_seen, last_seen FROM legacy_callers WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT ${MAX_ROWS}`).all(...args) as Row[]
    }
  }
  throw new BadParam('ismeretlen kérdés')
}

export async function tryHandleFleetReads(ctx: RouteContext): Promise<boolean> {
  const { res, method, path } = ctx
  // the eight names spelled out, so the route inventory reads this matcher as the rule's route
  const m = path.match(/^\/api\/fleet-reads\/(access-decisions|request-actors|uzenet-ablak|uzenet|tool-log-osszesito|tool-log-minta|kartya-letrehozas|legacy-hivok)$/)
  if (!m || method !== 'GET') return false
  const name = m[1]!
  const a = ctx.auth
  const allowed = a?.kind === 'session' || (a?.kind === 'token' && a.actor === MAIN_AGENT_ID)
  if (!allowed) { json(res, { error: 'csak a session és a fő ágens' }, 403); return true }
  try {
    const sorok = answer(name, ctx.url.searchParams)
    json(res, { sorok, darab: sorok.length })
  } catch (err) {
    if (err instanceof BadParam) { json(res, { error: err.message }, 400); return true }
    throw err
  }
  return true
}
