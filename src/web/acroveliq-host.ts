// The AcrovelIQ host filter (task acroveliq-host-szures). A request that
// arrives on the configured AcrovelIQ host (ACROVELIQ_HOST, e.g.
// acroveliq.acropora.hu) may reach only the read-only AcrovelIQ page: the page
// shell and its static files, the login, and the GET endpoints the page reads.
// Everything else is a 404 there. Every other host keeps the full dashboard.
//
// Balázs's decision (18:31:43 UTC, msg 1559634758932242504): the new domain
// serves the AcrovelIQ page, the authentication it needs, its static resources
// and the read-only APIs; no fleet management, terminal, agent restart or
// configuration change; everything else denied by default; the backend check
// stays (this list runs IN the server, in front of the auth gate and the access
// matrix, which still run on every request it lets through).
//
// Which host a request is on: the Host header, every X-Forwarded-Host hop and
// every `host=` of a Forwarded header. If ANY of them is the AcrovelIQ host,
// the filter applies -- a client can add a header, so a header can only ever
// turn the filter ON, never off. A proxy that drops the public host from all
// three would bypass it; the proxy setup is a separate step (not this task).

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
