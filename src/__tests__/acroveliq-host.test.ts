// The AcrovelIQ host filter (task acroveliq-host-szures, src/web/acroveliq-host.ts).
// WHAT TURNS THIS RED:
//   - a request on the AcrovelIQ host reaches a path that is not on the positive
//     list, or a header lets a client turn the filter OFF;
//   - a list row names an /api/ route that is not a read (OLVASO) or public
//     (NYILVANOS) route rule, or a static file that does not exist;
//   - the AcrovelIQ page (or the login overlay) sends a GET the list does not allow;
//   - src/web.ts stops running the filter before CORS, the preflight and the auth gate;
//   - the AcrovelIQ listener (ACROVELIQ_PORT) stops applying the list to EVERY request
//     (the fail-closed layer: a proxy that rewrites Host cannot open the dashboard);
//   - /api/agents or /api/agents/activity give out more on the AcrovelIQ surface than
//     the fields the page reads (pane tail, ssh target, security profile, auth mode...).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACROVELIQ_ACTIVITY_FIELDS,
  ACROVELIQ_AGENT_FIELDS,
  ACROVELIQ_ROUTES,
  acroveliqActivityView,
  acroveliqAgentsView,
  acroveliqAllows,
  acroveliqBindAddress,
  isAcroveliqRequest,
  normalizeHost,
  parseAcroveliqHost,
  parseAcroveliqPort,
  requestHosts,
} from '../web/acroveliq-host.js'
import { matchRouteRule } from '../web/route-match.js'
import { markAcroveliqShell } from '../web/routes/static.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const WEB = join(ROOT, 'web')
const APP = readFileSync(join(WEB, 'app.js'), 'utf-8')
const SERVER = readFileSync(join(ROOT, 'src/web.ts'), 'utf-8')
const AGENTS = readFileSync(join(ROOT, 'src/web/routes/agents.ts'), 'utf-8')

const AQ = 'acroveliq.acropora.hu'

describe('normalizeHost', () => {
  it('lowercases and drops the port and a trailing dot', () => {
    expect(normalizeHost('AcrovelIQ.Acropora.HU:443')).toBe(AQ)
    expect(normalizeHost(' acroveliq.acropora.hu. ')).toBe(AQ)
    expect(normalizeHost('"acroveliq.acropora.hu"')).toBe(AQ)
    expect(normalizeHost('[::1]:3420')).toBe('[::1]')
    expect(normalizeHost('')).toBe('')
    expect(normalizeHost(undefined)).toBe('')
  })
})

describe('isAcroveliqRequest', () => {
  const host = parseAcroveliqHost('AcrovelIQ.acropora.hu')

  it('is off when no host is configured', () => {
    expect(parseAcroveliqHost(undefined)).toBe('')
    expect(isAcroveliqRequest('', { host: AQ })).toBe(false)
  })

  it('is on for the Host header, with any port or case', () => {
    expect(isAcroveliqRequest(host, { host: AQ })).toBe(true)
    expect(isAcroveliqRequest(host, { host: 'ACROVELIQ.acropora.hu:8443' })).toBe(true)
  })

  it('is on when any X-Forwarded-Host hop or Forwarded host= names it', () => {
    expect(isAcroveliqRequest(host, { host: '127.0.0.1:3420', 'x-forwarded-host': AQ })).toBe(true)
    expect(isAcroveliqRequest(host, { host: '127.0.0.1:3420', 'x-forwarded-host': `evil.example, ${AQ}` })).toBe(true)
    expect(isAcroveliqRequest(host, { host: '127.0.0.1:3420', forwarded: `for=1.2.3.4;proto=https;host="${AQ}"` })).toBe(true)
  })

  it('a header can only turn the filter on: an extra header naming the admin host does not turn it off', () => {
    expect(isAcroveliqRequest(host, { host: AQ, 'x-forwarded-host': 'localhost:3420' })).toBe(true)
    expect(isAcroveliqRequest(host, { host: AQ, forwarded: 'host=localhost' })).toBe(true)
    expect(requestHosts({ host: AQ, 'x-forwarded-host': 'localhost:3420' })).toEqual([AQ, 'localhost'])
  })

  it('stays off for the admin hosts', () => {
    expect(isAcroveliqRequest(host, { host: '127.0.0.1:3420' })).toBe(false)
    expect(isAcroveliqRequest(host, { host: 'machine.tail1501e6.ts.net', 'x-forwarded-host': 'machine.tail1501e6.ts.net' })).toBe(false)
    // a suffix or a prefix of the configured host is another host
    expect(isAcroveliqRequest(host, { host: `x.${AQ}` })).toBe(false)
    expect(isAcroveliqRequest(host, { host: `${AQ}.evil.example` })).toBe(false)
  })
})

describe('parseAcroveliqPort', () => {
  it('unset is no listener, a port is a listener', () => {
    expect(parseAcroveliqPort(undefined, 3420)).toEqual({ port: null })
    expect(parseAcroveliqPort(' ', 3420)).toEqual({ port: null })
    expect(parseAcroveliqPort('3421', 3420)).toEqual({ port: 3421 })
  })

  it('not a port, or the dashboard port itself, is a named problem and no listener', () => {
    for (const bad of ['0', '65536', '34x', '-1', '3421.5', 'abc'])
      expect(parseAcroveliqPort(bad, 3420), bad).toMatchObject({ port: null, problem: expect.stringContaining('ACROVELIQ_PORT') })
    expect(parseAcroveliqPort('3420', 3420)).toMatchObject({ port: null, problem: expect.stringContaining('dashboard port') })
  })
})

describe('acroveliqBindAddress', () => {
  it('ACROVELIQ_BIND when set, WEB_HOST otherwise', () => {
    expect(acroveliqBindAddress('0.0.0.0', '127.0.0.1')).toBe('0.0.0.0')
    expect(acroveliqBindAddress(' 10.0.1.5 ', '127.0.0.1')).toBe('10.0.1.5')
    expect(acroveliqBindAddress(undefined, '127.0.0.1')).toBe('127.0.0.1')
    expect(acroveliqBindAddress('  ', '127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('acroveliqAllows: the positive list', () => {
  it('lets the page, its static files, the login and the page reads through', () => {
    for (const [method, path] of [
      ['GET', '/'], ['GET', '/index.html'], ['GET', '/app.js'], ['GET', '/style.css'],
      ['GET', '/lang/hu.js'], ['GET', '/manifest.json'], ['GET', '/icons/icon-192.png'],
      ['GET', '/api/marveen/avatar'], ['GET', '/api/auth/status'], ['POST', '/api/auth/login'],
      ['GET', '/api/tasks'], ['GET', '/api/tasks/acroveliq-host-szures/timeline'],
      ['GET', '/api/agents'], ['GET', '/api/agents/activity'], ['GET', '/api/messages/backlog'],
      ['OPTIONS', '/api/tasks'],
    ]) expect(acroveliqAllows(method!, path!), `${method} ${path}`).toBe(true)
  })

  it('answers nothing else: writes, other reads of the same family, management, terminal, settings', () => {
    for (const [method, path] of [
      ['POST', '/api/tasks'], ['POST', '/api/tasks/x/events'], ['GET', '/api/tasks/x/usage'],
      ['GET', '/api/tasks/x/handoffs/latest'], ['POST', '/api/tasks/x/handoffs'],
      ['GET', '/api/tasks//timeline'], ['GET', '/api/tasks/a/b/timeline'], ['GET', '/api/tasks/'],
      ['POST', '/api/agents'], ['GET', '/api/agents/nautilus'], ['POST', '/api/agents/nautilus/restart'],
      ['GET', '/api/agents/nautilus/terminal'], ['GET', '/api/kanban'], ['GET', '/api/settings'],
      ['PUT', '/api/settings'], ['GET', '/api/marveen'], ['GET', '/api/auth/users'],
      ['POST', '/api/auth/users'], ['POST', '/api/auth/password'], ['GET', '/api/auth/sessions'],
      ['GET', '/api/approvals'], ['GET', '/api/fleet'], ['GET', '/api/vault/ssh-keys'],
      ['POST', '/'], ['HEAD', '/'], ['DELETE', '/app.js'], ['GET', '/sw.js'],
      ['GET', '/avatars/01_robot.png'], ['GET', '/icons/other.png'], ['GET', '/lang/de.js'],
      ['OPTIONS', '/api/kanban'], ['GET', '/API/tasks'],
    ]) expect(acroveliqAllows(method!, path!), `${method} ${path}`).toBe(false)
  })

  it('every /api/ row is a read or public route rule, matched by the very pattern it names', () => {
    for (const row of ACROVELIQ_ROUTES.filter((r) => r.path.startsWith('/api/'))) {
      const concrete = row.path.replace(/:[A-Za-z_]+/g, 'x')
      const rule = matchRouteRule(row.method, concrete)
      expect(rule?.path, `${row.method} ${row.path}`).toBe(row.path)
      expect(['OLVASO', 'NYILVANOS'], `${row.method} ${row.path} is ${rule?.class}`).toContain(rule!.class)
    }
  })

  it('the one non-GET row is the login', () => {
    expect(ACROVELIQ_ROUTES.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/auth/login'])
  })

  it('every static row names a file the dashboard ships', () => {
    for (const row of ACROVELIQ_ROUTES.filter((r) => !r.path.startsWith('/api/'))) {
      const file = row.path === '/' ? 'index.html' : row.path.slice(1)
      expect(existsSync(join(WEB, file)), row.path).toBe(true)
    }
  })
})

describe('the AcrovelIQ page reads only what the list allows', () => {
  const START = APP.indexOf('// === AcrovelIQ (read-only view, task acroveliq-vp-v1) ===')
  const SECTION = START >= 0 ? APP.slice(START) : ''

  it('every /api/ literal of the page section is an allowed GET', () => {
    const literals = [...SECTION.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]!)
    expect(literals.length).toBeGreaterThanOrEqual(5)
    for (const lit of literals) {
      // the timeline URL is built as '/api/tasks/' + id + '/timeline'
      const path = lit.endsWith('/') ? `${lit}x/timeline` : lit
      expect(acroveliqAllows('GET', path), lit).toBe(true)
    }
  })

  it('the login overlay reaches the two auth calls it makes', () => {
    expect(APP).toContain("originalFetch('/api/auth/status')")
    expect(APP).toContain("originalFetch('/api/auth/login', {")
    expect(acroveliqAllows('GET', '/api/auth/status')).toBe(true)
    expect(acroveliqAllows('POST', '/api/auth/login')).toBe(true)
  })
})

describe('the two agent reads on the AcrovelIQ surface give the page fields only', () => {
  const summary = {
    name: 'polip', displayName: 'Polip', description: 'research', model: 'opus', running: true,
    remote: { host: 'user@10.0.0.5', workdir: '/srv/polip' }, securityProfile: 'dev', authMode: 'oauth',
    claudePlan: 'max', telegramBotUsername: 'polip_bot', hasTelegram: true,
  }
  const activity = {
    name: 'polip', isMain: false, running: true, state: 'idle', mode: 'bypass', prompt: null,
    tail: ['$ cat secret.txt', 'hunter2'],
  }

  it('picks the fields the page reads, and nothing a later field could add', () => {
    expect(acroveliqAgentsView([summary])).toEqual([{ name: 'polip', displayName: 'Polip', description: 'research' }])
    expect(acroveliqActivityView([activity])).toEqual([{ name: 'polip', isMain: false, running: true, state: 'idle', prompt: null }])
    expect([...ACROVELIQ_AGENT_FIELDS]).toEqual(['name', 'displayName', 'description'])
    expect([...ACROVELIQ_ACTIVITY_FIELDS]).toEqual(['name', 'isMain', 'running', 'state', 'prompt'])
  })

  it('the page reads no field of the two sources outside these lists', () => {
    const START = APP.indexOf('// === AcrovelIQ (read-only view, task acroveliq-vp-v1) ===')
    const SECTION = APP.slice(START)
    for (const f of [...SECTION.matchAll(/\bact\.([A-Za-z_]+)/g)].map((m) => m[1]!))
      expect(ACROVELIQ_ACTIVITY_FIELDS as readonly string[], `act.${f}`).toContain(f)
    for (const f of [...SECTION.matchAll(/\binfo\.([A-Za-z_]+)/g)].map((m) => m[1]!))
      expect(ACROVELIQ_AGENT_FIELDS as readonly string[], `info.${f}`).toContain(f)
  })

  function call(path: string, surface: RouteContext['surface']) {
    let body = ''
    const res = {
      statusCode: 200,
      setHeader() { return res },
      writeHead() { return res },
      end(chunk?: string | Buffer) { if (chunk) body += chunk.toString() },
    }
    const url = new URL(`http://localhost:3420${path}`)
    const ctx = { req: { headers: {} }, res, path, method: 'GET', url, surface } as unknown as RouteContext
    return tryHandleAgents(ctx, WEB).then((handled) => ({ handled, rows: JSON.parse(body) as Record<string, unknown>[] }))
  }

  it('GET /api/agents/activity through the real handler: no tail and no mode there, both on the dashboard', async () => {
    const aq = await call('/api/agents/activity', 'acroveliq')
    const full = await call('/api/agents/activity', 'dashboard')
    expect(aq.handled && full.handled).toBe(true)
    // the main agent's row is always there, running or not
    expect(aq.rows.length).toBeGreaterThan(0)
    for (const row of aq.rows) expect(Object.keys(row).sort()).toEqual([...ACROVELIQ_ACTIVITY_FIELDS].sort())
    for (const row of full.rows) expect(row).toHaveProperty('tail')
  })

  it('agents.ts serves the views on the AcrovelIQ surface only', () => {
    expect(AGENTS).toContain("jsonMaybeGzip(req, res, ctx.surface === 'acroveliq' ? acroveliqAgentsView(summaries) : summaries)")
    expect(AGENTS).toContain("jsonMaybeGzip(req, res, ctx.surface === 'acroveliq' ? acroveliqActivityView(entries) : entries)")
  })
})

describe('wiring', () => {
  it('the AcrovelIQ listener applies the list to every request, whatever the headers say', () => {
    expect(SERVER).toContain('const acroveliq = onAcroveliqPort || isAcroveliqRequest(acroveliqHost, req.headers)')
    expect(SERVER).toContain('http.createServer((req, res) => { void handleRequest(req, res, true) })')
    expect(SERVER).toContain('http.createServer((req, res) => { void handleRequest(req, res, false) })')
    expect(SERVER.match(/handleRequest\(req, res, true\)/g)).toHaveLength(1)
    // its own bind address: the main port keeps WEB_HOST, the AcrovelIQ port may be opened alone
    expect(SERVER).toContain('const aqBind = acroveliqBindAddress(ACROVELIQ_BIND_SETTING, WEB_HOST)')
    expect(SERVER).toContain('acroveliqServer.listen(aqPort, aqBind,')
    expect(SERVER).not.toContain('acroveliqServer.listen(aqPort, WEB_HOST')
    expect(SERVER).toContain('server.listen(port, WEB_HOST, () => {')
  })

  it('src/web.ts runs the filter first: before CORS, the preflight, the auth gate and the routes', () => {
    const handler = SERVER.indexOf('const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse, onAcroveliqPort: boolean): Promise<void> => {')
    const filter = SERVER.indexOf('if (acroveliq && !acroveliqAllows(method, path)) {', handler)
    expect(handler).toBeGreaterThan(0)
    expect(filter).toBeGreaterThan(handler)
    for (const later of ['const origin = req.headers.origin', "if (method === 'OPTIONS')", 'resolveAuth(req, url, path, method', 'await accessGate(', 'tryHandleStatic(routeCtx'])
      expect(SERVER.indexOf(later, handler), later).toBeGreaterThan(filter)
  })

  it('the AcrovelIQ host gets a marked shell, and the page router opens only the AcrovelIQ page there', () => {
    const shell = markAcroveliqShell(readFileSync(join(WEB, 'index.html'), 'utf-8'))
    expect(shell).toContain('<html data-surface="acroveliq" lang="hu"')
    expect(shell.match(/data-surface="acroveliq"/g)).toHaveLength(1)
    expect(APP).toContain("const AQ_SURFACE = document.documentElement.dataset.surface === 'acroveliq'")
    expect(APP).toContain("if (AQ_SURFACE) pageId = 'acroveliq'")
  })
})
