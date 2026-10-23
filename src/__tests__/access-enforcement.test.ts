// The access check at the dispatcher (acrovelIQ P0-1, PR 3b), run through a
// real HTTP server with the same accessGate web.ts calls. WHAT TURNS THIS RED:
//   - the setting has a position where the shared token keeps full rights
//     while the check enforces, or a typo in it opens instead of closing;
//   - in `naplo` a request is denied, or a would-be denial is not logged;
//   - enforced, an agent token schedules on the main agent, decides an
//     approval (with any resolved_by), reads another agent's messages or
//     changes another agent's card or memory; the shared token reaches a
//     critical route; an unruled route stays open to a token;
//   - the owner is taken from the wrong place (a body field the handler then
//     cannot read again, a path value, a record);
//   - a value from a request (an owner from a body) reaches the denial log;
//   - a failing check opens where it should close, or locks out the session;
//   - web.ts stops calling the gate after the auth gate and before the handlers.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { initDatabase, getDb } from '../db.js'
import { PROBE_UNRULED_PATH, probesFor } from '../web/access-mode-switch.js'
import { readBody } from '../web/http-helpers.js'
import {
  ACCESS_MODES, accessGate, callerOf, enforces, parseAccessMode, scheduleAgentFrom,
  type AccessMode, type CallerSource, type OwnerDeps,
} from '../web/access-enforcement.js'

const root = mkdtempSync(join(tmpdir(), 'access-enforcement-'))
const tasksDir = join(root, 'scheduled-tasks')
const principal = (actor: string, project = 'acropora') => ({ id: 1, project, actor })

const S: CallerSource = { kind: 'session', user: 'balazs' }
const A: CallerSource = { kind: 'token', principal: principal('acrobot') }
const G: CallerSource = { kind: 'token', principal: principal('murena') }
const G2: CallerSource = { kind: 'token', principal: principal('nautilus') }
const G3: CallerSource = { kind: 'token', principal: principal('polip') }
const L: CallerSource = { kind: 'token' }
const D: CallerSource = { kind: 'device', device: 'telefon' }

let server: Server
let port = 0
let mode: AccessMode = 'naplo'
let auth: CallerSource = L
let failDb = false
let deps: OwnerDeps

beforeAll(async () => {
  initDatabase(':memory:')
  const db = getDb()
  db.prepare("INSERT INTO kanban_cards (id, title, assignee, created_at, updated_at) VALUES ('c-murena', 'x', 'murena', 0, 0), ('c-nautilus', 'x', 'nautilus', 0, 0)").run()
  // 17 delivered (the recipient closes it), 18 pending to another agent, 19 pending from nautilus to murena
  db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, content, created_at, status, delivered_at) VALUES (17, 'nautilus', 'murena', 'x', 0, 'delivered', 0)").run()
  db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, content, created_at) VALUES (18, 'nautilus', 'acrobot', 'x', 0), (19, 'nautilus', 'murena', 'x', 0)").run()
  db.prepare("INSERT INTO memories (id, chat_id, content, sector, agent_id, category, created_at, accessed_at) VALUES (5, 'c', 'x', 'semantic', 'murena', 'warm', 0, 0), (6, 'c', 'x', 'semantic', 'nautilus', 'warm', 0, 0)").run()
  for (const [name, agent] of [['murena-feladat', 'murena'], ['fo-feladat', undefined]] as const) {
    mkdirSync(join(tasksDir, name), { recursive: true })
    writeFileSync(join(tasksDir, name, 'task-config.json'), JSON.stringify(agent ? { agent } : {}))
  }
  const realDeps: OwnerDeps = { db, mainAgent: 'acrobot', scheduleAgent: scheduleAgentFrom(tasksDir, 'acrobot') }
  deps = {
    get db() {
      if (failDb) throw new Error('the database is gone')
      return realDeps.db
    },
    mainAgent: realDeps.mainAgent,
    scheduleAgent: realDeps.scheduleAgent,
  }
  // the gate, then a handler that reads the body itself: the request reached it
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void (async () => {
      if (await accessGate({ auth, method: req.method ?? 'GET', path: url.pathname, url, req, res }, mode, deps)) return
      const body = (await readBody(req)).toString()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ handled: true, body }))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server?.close()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().prepare('DELETE FROM access_decisions').run()
  failDb = false
})

async function call(as: CallerSource, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  auth = as
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.text() }
}

describe('access enforcement: the setting', () => {
  it('ACCESS-MODE: three positions, naplo by default, a typo enforces; no enforcing position leaves the shared token unchecked', () => {
    const parsed = [undefined, '', 'naplo', ' NAPLO ', 'legacy-szukitett', 'kikenyszerit', 'kikényszerít', 'off'].map((raw) => {
      const p = parseAccessMode(raw)
      return [p.mode, p.problem !== null]
    })
    const table = ACCESS_MODES.map((m) => (['S', 'A', 'G', 'L', 'D', 'F'] as const).map((c) => enforces(m, c)))
    expect([parsed, table], 'ACCESS-MODE').toEqual([
      [['naplo', false], ['naplo', false], ['naplo', false], ['naplo', false], ['legacy-szukitett', false], ['kikenyszerit', false], ['kikenyszerit', true], ['kikenyszerit', true]],
      [
        [false, false, false, false, false, false], // naplo: logs only
        [false, false, false, true, false, false], // legacy-szukitett: the shared token
        [true, true, true, true, true, true], // kikenyszerit: everyone, the shared token held to its column
      ],
    ])
  })

  it('ACCESS-CALLER: the column comes from the credential, never from the request', () => {
    expect(
      [S, A, G, L, D, { kind: 'federation', peer: 'tars' } as CallerSource, { kind: 'token', principal: principal('acrobot', 'masik') } as CallerSource, { kind: 'none' } as CallerSource]
        .map((c) => callerOf(c, 'acrobot')),
      'ACCESS-CALLER',
    ).toEqual([
      { column: 'S', name: 'session:balazs' },
      { column: 'A', name: 'acrobot' },
      { column: 'G', name: 'murena' },
      { column: 'L', name: 'legacy' },
      { column: 'D', name: 'device:telefon' },
      { column: 'F', name: 'tars' },
      { column: 'G', name: 'masik/acrobot' }, // another project's main agent owns nothing here
      null,
    ])
  })
})

describe('access enforcement: through the gate', () => {
  it('ACCESS-NAPLO: nothing is denied, every would-be denial is logged, the handler still reads the body', async () => {
    mode = 'naplo'
    const r = await call(L, 'POST', '/api/schedules', { agent: 'acrobot', prompt: 'x' })
    const log = getDb().prepare('SELECT actor, method, path, outcome, mode FROM access_decisions').all()
    expect([r.status, JSON.parse(r.body).body, log], 'ACCESS-NAPLO').toEqual([
      200,
      JSON.stringify({ agent: 'acrobot', prompt: 'x' }),
      [{ actor: 'legacy', method: 'POST', path: '/api/schedules', outcome: 'would-deny', mode: 'naplo' }],
    ])
  })

  it('ACCESS-UNKNOWN-FAMILY: a route no rule answers is logged with its family, never with a value from the path', async () => {
    mode = 'naplo'
    await call(G, 'GET', '/api/kanban/ckz9x0abc123def456')
    await call(G, 'GET', '/api/Zm9vYmFyYmF6cXV4MTIzNDU2/x')
    const log = getDb().prepare('SELECT actor, method, path, outcome FROM access_decisions ORDER BY path').all()
    expect(log, 'ACCESS-UNKNOWN-FAMILY').toEqual([
      { actor: 'murena', method: 'GET', path: ':ismeretlen', outcome: 'would-deny' },
      { actor: 'murena', method: 'GET', path: ':ismeretlen /api/kanban', outcome: 'would-deny' },
    ])
  })

  it('ACCESS-ENFORCED: the brief\'s cases, caller by caller, as status codes', async () => {
    mode = 'kikenyszerit'
    const cases: Array<[CallerSource, string, string, unknown, number]> = [
      // a schedule on the main agent with an agent token; its own; the session for anyone
      [G, 'POST', '/api/schedules', { agent: 'acrobot' }, 403],
      [G, 'POST', '/api/schedules', {}, 403], // a missing agent is the main agent's
      [G, 'POST', '/api/schedules', { agent: 'murena' }, 200],
      [S, 'POST', '/api/schedules', { agent: 'acrobot' }, 200],
      [G, 'PUT', '/api/schedules/murena-feladat', { prompt: 'x' }, 200],
      [G, 'PUT', '/api/schedules/murena-feladat', { prompt: 'x', agent: 'acrobot' }, 403], // moving its task to the main agent
      [G, 'POST', '/api/schedules/fo-feladat/run', undefined, 403], // a task without an agent is the main agent's
      [A, 'POST', '/api/schedules/fo-feladat/run', undefined, 200],
      // an approval decided with an agent token, whatever resolved_by says
      [A, 'PATCH', '/api/approvals/42', { status: 'approved', resolved_by: 'balazs' }, 403],
      [G, 'PATCH', '/api/approvals/42', { status: 'approved', resolved_by: 'murena' }, 403],
      [S, 'PATCH', '/api/approvals/42', { status: 'approved' }, 200],
      // the shared token on critical routes; an unruled route with a token
      [L, 'POST', '/api/agents/murena/restart', undefined, 403],
      [L, 'POST', '/api/schedules', { agent: 'murena' }, 403],
      [A, 'GET', '/api/nincs-ilyen', undefined, 403],
      [S, 'GET', '/api/nincs-ilyen', undefined, 200],
      // messages: read own (query), one message by either party, closed by the recipient
      [G, 'GET', '/api/messages?agent=nautilus', undefined, 403],
      [G, 'GET', '/api/messages?agent=murena', undefined, 200],
      [G, 'GET', '/api/messages/17', undefined, 200],
      [G, 'GET', '/api/messages/18', undefined, 403],
      [G, 'PUT', '/api/messages/17', { status: 'done' }, 200],
      [G2, 'PUT', '/api/messages/17', { status: 'done' }, 403], // the sender does not close a DELIVERED message
      // a PENDING message: its sender may withdraw it (acrobot 34258), the recipient may close it, a third agent not
      [G2, 'PUT', '/api/messages/19', { status: 'done' }, 200],
      [G, 'PUT', '/api/messages/19', { status: 'done' }, 200],
      [G3, 'PUT', '/api/messages/19', { status: 'done' }, 403],
      [G3, 'PUT', '/api/messages/18', { status: 'done' }, 403], // pending, but neither its sender nor its recipient
      [G, 'PUT', '/api/messages/99', { status: 'done' }, 403], // no such message: no owner
      // cards and memories: own only; moving a memory to another writer is not own
      [G, 'POST', '/api/kanban/c-murena/move', { status: 'done' }, 200],
      [G, 'POST', '/api/kanban/c-nautilus/move', { status: 'done' }, 403],
      [G, 'PUT', '/api/kanban/c-murena', { title: 'uj cim' }, 200],
      [G, 'PUT', '/api/kanban/c-murena', { assignee: 'acrobot' }, 200], // the escalation to the main agent
      [G, 'PUT', '/api/kanban/c-murena', { assignee: 'nautilus' }, 403], // handing it to another agent
      [G, 'PUT', '/api/kanban/c-murena', { assignee: null }, 403], // dropping it
      [A, 'PUT', '/api/kanban/c-murena', { assignee: 'nautilus' }, 200], // the main agent assigns
      [G, 'DELETE', '/api/kanban/c-murena/labels/c-nautilus', undefined, 200], // two parameters: the card is :id
      [G, 'DELETE', '/api/kanban/c-nautilus/labels/c-murena', undefined, 403],
      [G, 'POST', '/api/memories', { agent_id: 'murena', content: 'x' }, 200],
      [G, 'POST', '/api/memories', { agent_id: 'acrobot', category: 'shared', content: 'x' }, 403],
      [G, 'PUT', '/api/memories/5', { content: 'y' }, 200],
      [G, 'PUT', '/api/memories/5', { content: 'y', agent_id: 'nautilus' }, 403],
      [G, 'DELETE', '/api/memories/6', undefined, 403],
      // a session read from the path; a device reads, but does not administer
      [G, 'GET', '/api/agents/nautilus/conversation', undefined, 403],
      [G, 'GET', '/api/agents/murena/conversation', undefined, 200],
      [D, 'GET', '/api/agents/murena/conversation', undefined, 200],
      [D, 'POST', '/api/settings', {}, 403],
      // an agent's own voice directive: the owner is the agent query parameter
      [A, 'GET', '/api/voice/directive?agent=acrobot', undefined, 200],
      [A, 'GET', '/api/voice/directive?agent=murena', undefined, 403],
      [G, 'GET', '/api/voice/directive?agent=murena', undefined, 200],
      [G, 'GET', '/api/voice/directive?agent=nautilus', undefined, 403],
      [G, 'GET', '/api/voice/directive', undefined, 403], // no owner named
      [L, 'GET', '/api/voice/directive?agent=murena', undefined, 403],
      [D, 'GET', '/api/voice/directive?agent=murena', undefined, 403],
      // outside the API: not checked
      [L, 'GET', '/index.html', undefined, 200],
      [L, 'GET', '/kepek/logo.png', undefined, 200], // no rule, but not the API
    ]
    const wrong: string[] = []
    for (const [as, method, path, body, expected] of cases) {
      const r = await call(as, method, path, body)
      if (r.status !== expected) wrong.push(`${callerOf(as, 'acrobot')?.column} ${method} ${path}: ${r.status}, expected ${expected}`)
    }
    expect(wrong, 'ACCESS-ENFORCED').toEqual([])
  })

  it('ACCESS-PREFLIGHT-1023: the three shapes the 2026-10-23 preflight listed get a 403 enforced, the control call too, and the main agent\'s fixed routes a 200', async () => {
    mode = 'kikenyszerit'
    // a DELIVERED message murena sent to nautilus: murena (the sender) does not close it
    getDb().prepare("INSERT OR REPLACE INTO agent_messages (id, from_agent, to_agent, content, created_at, status, delivered_at) VALUES (20, 'murena', 'nautilus', 'x', 0, 'delivered', 0)").run()
    const reads = ['access-decisions', 'request-actors', 'uzenet-ablak', 'uzenet', 'tool-log-osszesito', 'tool-log-minta', 'kartya-letrehozas', 'legacy-hivok']
    const cases: Array<[string, CallerSource, string, string, number]> = [
      ['murena moves nautilus\'s card (kanban-card-change)', G, 'POST', '/api/kanban/c-nautilus/move', 403],
      ['murena closes the delivered message it sent (message-state)', G, 'PUT', '/api/messages/20', 403],
      ['the control call: the shared token on a route no rule answers', L, 'GET', PROBE_UNRULED_PATH, 403],
      ...reads.flatMap((q): Array<[string, CallerSource, string, string, number]> => [
        [`nautilus reads fleet-reads/${q}`, G2, 'GET', `/api/fleet-reads/${q}`, 403],
        [`murena reads fleet-reads/${q}`, G, 'GET', `/api/fleet-reads/${q}`, 403],
        [`the shared token reads fleet-reads/${q}`, L, 'GET', `/api/fleet-reads/${q}`, 403],
        [`the main agent reads fleet-reads/${q}`, A, 'GET', `/api/fleet-reads/${q}`, 200],
        [`the session reads fleet-reads/${q}`, S, 'GET', `/api/fleet-reads/${q}`, 200],
      ]),
      ...probesFor('kikenyszerit', '2026-10-23').filter((p) => p.caller === 'A' && p.expected === 200)
        .map((p): [string, CallerSource, string, string, number] => [`the main agent's fixed route ${p.path}`, A, 'GET', p.path, 200]),
    ]
    const wrong: string[] = []
    for (const [what, as, method, path, expected] of cases) {
      const r = await call(as, method, path)
      if (r.status !== expected) wrong.push(`${what}: ${r.status}, expected ${expected}`)
    }
    expect(wrong, 'ACCESS-PREFLIGHT-1023').toEqual([])
  })

  it('ACCESS-SWITCH-PROBES: what the switch step expects of the running mode (403 or let through) is what the gate does, mode by mode', async () => {
    // the real dashboard answers a let-through unruled route with 404; this harness has one handler that says 200
    const letThrough = (expected: number) => (expected === 403 ? 403 : 200)
    for (const m of ['naplo', 'legacy-szukitett', 'kikenyszerit'] as const) {
      mode = m
      for (const p of probesFor(m, '2026-10-23')) {
        const r = await call(p.caller === 'L' ? L : A, 'GET', p.path)
        expect(r.status, `${m}: ${p.name}`).toBe(letThrough(p.expected))
      }
    }
  })

  it('ACCESS-LEGACY-NARROWED: only the shared token is held; an agent token is logged, not denied', async () => {
    mode = 'legacy-szukitett'
    const legacy = await call(L, 'PATCH', '/api/approvals/42', { status: 'approved' })
    const agent = await call(G, 'PATCH', '/api/approvals/42', { status: 'approved' })
    const log = getDb().prepare('SELECT actor, outcome FROM access_decisions ORDER BY actor').all()
    expect([legacy.status, agent.status, log], 'ACCESS-LEGACY-NARROWED').toEqual([
      403,
      200,
      [{ actor: 'legacy', outcome: 'denied' }, { actor: 'murena', outcome: 'would-deny' }],
    ])
  })

  it('ACCESS-LOG-NO-VALUES: the denial log keeps the route pattern and the group, never a value from the request; a 403 names no owner', async () => {
    mode = 'kikenyszerit'
    const fromBody = await call(G, 'POST', '/api/memories', { agent_id: 'titkos-ertek-a-torzsben', content: 'x' })
    const fromPath = await call(G, 'GET', '/api/agents/titkos-ertek-az-utban/conversation')
    const others = await call(G, 'GET', '/api/messages/18') // nautilus to acrobot: none of murena's business
    const dump = JSON.stringify(getDb().prepare('SELECT * FROM access_decisions').all())
    const answers = fromBody.body + fromPath.body + others.body
    expect(
      [dump.includes('titkos-ertek'), dump.includes('/api/agents/:name/conversation'), answers.includes('titkos-ertek'), /nautilus|acrobot/.test(answers), others.status],
      'ACCESS-LOG-NO-VALUES',
    ).toEqual([false, true, false, false, 403])
  })

  // The session's exemption in the failure branch is not measured here: the
  // session's decision reads no database, so no failure this test can inject
  // reaches it. It stays as a defence for the way back in (plan 5, step 4).
  it('ACCESS-FAIL-CLOSED: a failing check closes where it enforces, and not in naplo', async () => {
    failDb = true
    mode = 'kikenyszerit'
    const agent = await call(G, 'PUT', '/api/messages/17', { status: 'done' })
    const session = await call(S, 'PUT', '/api/messages/17', { status: 'done' })
    mode = 'naplo'
    const logged = await call(G, 'PUT', '/api/messages/17', { status: 'done' })
    expect([agent.status, session.status, logged.status], 'ACCESS-FAIL-CLOSED').toEqual([403, 200, 200])
  })

  it('ACCESS-WIRED: web.ts runs the gate after the auth gate and before the first handler', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'web.ts'), 'utf-8')
    const at = (needle: string) => source.indexOf(needle)
    const auth = at('resolveAuth(req, url, path, method, DASHBOARD_TOKEN)')
    const gate = at('if (await accessGate({ auth, method, path, url, req, res }, access.mode, accessDeps)) return')
    const firstHandler = at('if (await tryHandle')
    const networkInfo = at("if (path === '/api/network-info'")
    expect([auth > 0, gate > auth, gate < firstHandler, gate < networkInfo], 'ACCESS-WIRED').toEqual([true, true, true, true])
  })
})
