// B29 (task b29-flotta-olvas): the main agent's named reads. WHAT TURNS THIS RED: another agent,
// the shared token or a device getting an answer; a question name or parameter taken unchecked
// (bad epoch, too wide a window, an unregistered agent, an unknown outcome); a filter ignored;
// message or log text returned uncut or with a secret shape in it; the tool-log key not the B29
// coverage key (`cd X &&` dropped, the script name kept); the matrix not limiting it to S and A.
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'acrobot' }
})
vi.mock('../web/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../web/agent-config.js')>('../web/agent-config.js')
  return { ...actual, listAgentNames: () => ['nautilus', 'murena'] }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { initDatabase, getDb } from '../db.js'
import { ensureAccessDecisionSchema } from '../web/access-enforcement.js'
import { ensurePrincipalSchema } from '../web/auth-principals.js'
import { tryHandleFleetReads, toolKey, safeText } from '../web/routes/fleet-reads.js'
import { matchRouteRule } from '../web/route-match.js'
import { decide } from '../web/route-access.js'
import type { RouteContext } from '../web/routes/types.js'

const SECRET = 'ghp_' + 'A'.repeat(36)
const NOW = Math.floor(Date.now() / 1000)

async function call(path: string, auth: RouteContext['auth'] | 'nincs' = { kind: 'session', user: 'balazs' }, method = 'GET') {
  let status = 200
  let raw = ''
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req: {} as any,
    res: { writeHead: (s: number) => { status = s }, end: (b?: string) => { raw = b || '' } } as any,
    path: url.pathname, method, url, auth: auth === 'nincs' ? undefined : auth,
  } as RouteContext
  const handled = await tryHandleFleetReads(ctx)
  return { handled, status, body: raw ? JSON.parse(raw) : null }
}

beforeAll(() => {
  initDatabase(':memory:')
  const db = getDb()
  ensureAccessDecisionSchema(db)
  ensurePrincipalSchema(db)
  const ad = db.prepare('INSERT INTO access_decisions (day, project, actor, method, path, outcome, mode, reason, count, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  ad.run('2026-10-16', 'acropora', 'nautilus', 'GET', '/api/messages/:id', 'would-deny', 'naplo', 'message-read-one: not its own', 1, 1792132017, 1792132017)
  ad.run('2026-10-16', 'acropora', 'legacy', 'POST', '/api/kanban', 'denied', 'kikenyszerit', 'legacy minimum', 1, 1792111091, 1792111091)
  const ra = db.prepare('INSERT INTO request_actors (day, project, actor, method, path, count, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)')
  ra.run('2026-10-16', 'acropora', 'nautilus', 'GET', '/api/messages', 1, 1792132017, 1792132017)
  ra.run('2026-10-16', 'acropora', 'nautilus', 'GET', '/api/agents', 3, 1792100000, 1792100500)
  const msg = db.prepare("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?,?,?,'delivered',?)")
  msg.run('acrobot', 'nautilus', 'a kulcs: ' + SECRET + ' ' + 'x'.repeat(400), 1792131563)
  msg.run('murena', 'acrobot', 'masik', 1792131600)
  const tl = db.prepare('INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at, agent_id) VALUES (?,?,?,1,?,?)')
  for (let i = 0; i < 3; i++) tl.run('s', 'Bash', 'cd /home/marveen/marveen && bash scripts/fleet-api.sh kanban-list', NOW - 60, 'acrobot')
  tl.run('s', 'Bash', 'curl -s -H "Authorization: ' + 'Bearer ' + 'b'.repeat(30) + '" http://x', NOW - 60, 'acrobot')
  tl.run('s', 'Read', '/home/marveen/marveen/CLAUDE.md', NOW - 60, 'acrobot')
  tl.run('s', 'Bash', 'grep x', NOW - 40 * 86400, 'acrobot')
  db.prepare("INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at) VALUES ('e7e85a81', '[flotta] kvota-kapu', 'planned', 'low', 1792111091, 1792111091)").run()
})

describe('fleet-reads: who gets an answer', () => {
  it('the session and the main agent yes; another agent, the shared token, a device no', async () => {
    expect((await call('/api/fleet-reads/uzenet?id=1')).status).toBe(200)
    expect((await call('/api/fleet-reads/uzenet?id=1', { kind: 'token', actor: 'acrobot' })).status).toBe(200)
    expect((await call('/api/fleet-reads/uzenet?id=1', { kind: 'token', actor: 'nautilus' })).status).toBe(403)
    expect((await call('/api/fleet-reads/uzenet?id=1', { kind: 'token', actor: 'legacy' })).status).toBe(403)
    expect((await call('/api/fleet-reads/uzenet?id=1', { kind: 'device', device: 'telefon' })).status).toBe(403)
    expect((await call('/api/fleet-reads/uzenet?id=1', 'nincs')).status).toBe(403)
  })

  it('the matrix gives it to S and A only', () => {
    const rule = matchRouteRule('GET', '/api/fleet-reads/uzenet-ablak')
    expect(rule?.module).toBe('fleet-reads')
    expect(decide(rule, { column: 'A', name: 'acrobot' }).allowed).toBe(true)
    expect(decide(rule, { column: 'S', name: 'session:balazs' }).allowed).toBe(true)
    for (const column of ['G', 'L', 'D'] as const) expect(decide(rule, { column, name: 'x' }).allowed).toBe(false)
    expect(matchRouteRule('GET', '/api/fleet-reads/barmi-mas')).toBeNull()
  })

  it('an unknown question, another method or a foreign path is not handled here (the router answers 404)', async () => {
    expect((await call('/api/fleet-reads/sql')).handled).toBe(false)
    expect((await call('/api/fleet-reads/uzenet?id=1', { kind: 'session', user: 'b' }, 'POST')).handled).toBe(false)
    expect((await call('/api/memories')).handled).toBe(false)
  })
})

describe('fleet-reads: the questions', () => {
  it('access-decisions: by day, actor and outcome (deny means denied)', async () => {
    const all = await call('/api/fleet-reads/access-decisions?nap=2026-10-16')
    expect(all.body.darab).toBe(2)
    const n = await call('/api/fleet-reads/access-decisions?nap=2026-10-16&actor=nautilus')
    expect(n.body.sorok.map((r: any) => r.path)).toEqual(['/api/messages/:id'])
    expect((await call('/api/fleet-reads/access-decisions?nap=2026-10-16&outcome=deny')).body.sorok[0].actor).toBe('legacy')
    expect((await call('/api/fleet-reads/access-decisions?tol=1792132000&ig=1792132100')).body.darab).toBe(1)
  })

  it('request-actors: the rows around one second', async () => {
    const r = await call('/api/fleet-reads/request-actors?actor=nautilus&ido=1792132017&ablak=5')
    expect(r.body.sorok.map((x: any) => x.path)).toEqual(['/api/messages'])
  })

  it('uzenet-ablak and uzenet: either party, text cut to 200 and the secret masked', async () => {
    const w = await call('/api/fleet-reads/uzenet-ablak?agens=nautilus&tol=1792131500&ig=1792131700')
    expect(w.body.darab).toBe(1)
    const c = w.body.sorok[0].content as string
    expect(c).not.toContain(SECRET)
    expect(c).toContain('[TITOK]')
    expect(c.length).toBeLessThanOrEqual(201)
    expect((await call('/api/fleet-reads/uzenet-ablak?agens=acrobot&tol=1792131500&ig=1792131700')).body.darab).toBe(2)
    expect((await call('/api/fleet-reads/uzenet?id=2')).body.sorok[0].from_agent).toBe('murena')
    expect((await call('/api/fleet-reads/uzenet?id=999')).body.darab).toBe(0)
  })

  it('tool-log-osszesito and -minta: the B29 key, the day window, masked samples', async () => {
    const o = await call('/api/fleet-reads/tool-log-osszesito?agens=acrobot&napok=7')
    expect(o.body.sorok).toEqual([
      { kulcs: 'Bash: bash scripts/fleet-api.sh', darab: 3 },
      { kulcs: 'Bash: curl', darab: 1 },
      { kulcs: 'Read', darab: 1 },
    ])
    expect((await call('/api/fleet-reads/tool-log-osszesito?agens=acrobot&napok=7&csoport=eszkoz')).body.sorok).toEqual([
      { kulcs: 'Bash', darab: 4 },
      { kulcs: 'Read', darab: 1 },
    ])
    const m = await call('/api/fleet-reads/tool-log-minta?agens=acrobot&elotag=' + encodeURIComponent('Bash: curl'))
    expect(m.body.darab).toBe(1)
    expect(m.body.sorok[0].input_summary).toContain('[TITOK]')
    expect(m.body.sorok[0].input_summary).not.toMatch(/b{30}/)
  })

  it('kartya-letrehozas: the cards created in the window', async () => {
    const k = await call('/api/fleet-reads/kartya-letrehozas?tol=1792111090&ig=1792111092')
    expect(k.body.sorok).toEqual([{ id: 'e7e85a81', title: '[flotta] kvota-kapu', assignee: null, created_at: 1792111091 }])
  })

  it('every bad parameter is 400, and nothing is answered', async () => {
    for (const p of [
      '/api/fleet-reads/access-decisions',
      '/api/fleet-reads/access-decisions?nap=2026-1-16',
      '/api/fleet-reads/access-decisions?nap=2026-10-16&outcome=allow',
      '/api/fleet-reads/access-decisions?nap=2026-10-16&actor=Rossz%20nev',
      '/api/fleet-reads/request-actors?actor=nautilus&ido=1792132017&ablak=301',
      '/api/fleet-reads/request-actors?actor=nautilus&ido=abc',
      '/api/fleet-reads/uzenet-ablak?agens=senki&tol=1792131500&ig=1792131700',
      '/api/fleet-reads/uzenet-ablak?agens=nautilus&tol=1792131700&ig=1792131500',
      '/api/fleet-reads/uzenet?id=0',
      '/api/fleet-reads/tool-log-osszesito?agens=acrobot&napok=31',
      '/api/fleet-reads/tool-log-osszesito?agens=acrobot&csoport=tabla',
      '/api/fleet-reads/tool-log-minta?agens=acrobot',
      '/api/fleet-reads/kartya-letrehozas?tol=1792000000&ig=1792200000',
    ]) {
      const r = await call(p)
      expect(r.status, p).toBe(400)
      expect(r.body.sorok, p).toBeUndefined()
    }
  })
})

describe('fleet-reads helpers', () => {
  it('toolKey drops a leading cd and keeps the script name', () => {
    expect(toolKey('Bash', 'cd /x && bash scripts/a.sh b')).toBe('Bash: bash scripts/a.sh')
    expect(toolKey('Bash', 'python3 -c "x"')).toBe('Bash: python3')
    expect(toolKey('Write', 'x')).toBe('Write')
  })
  it('safeText masks every occurrence and cuts', () => {
    expect(safeText(SECRET + ' es ' + SECRET)).toBe('[TITOK] es [TITOK]')
    expect(safeText('y'.repeat(300)).length).toBe(201)
  })
})
