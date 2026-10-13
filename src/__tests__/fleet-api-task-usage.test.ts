// The per-task usage commands of scripts/fleet-api.sh (acrovelIQ token brief,
// item 1), run for real against a throwaway HTTP server. WHAT TURNS THIS RED:
//   - task-usage does not stop (exit 3) on an overlapping window, or does not name it;
//   - task-usage hides the capacity kinds or the variants;
//   - task-event sends the time as something the server cannot read;
//   - L1: task-event retries without its key, or with a NEW key (a lost answer
//     would then make two rows), or two runs share one key; --data does not
//     reach the body, or a non-object goes out; task-new - drops a field.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'


const root = mkdtempSync(join(tmpdir(), 'fleet-api-task-usage-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let received: unknown = null
let receivedPath = ''
/** What the fake dashboard answers next: [status, body]. */
let answer: [number, unknown] = [200, {}]
/** Answers used before `answer`, one per request. */
let queue: [number, unknown][] = []
/** Every request: its path, Idempotency-Key header and body. */
let requests: { path: string; key: string | undefined; body: unknown; method?: string }[] = []
/** L5: a stateful fake dashboard; when set, it answers before `queue` and `answer`. */
let router: ((method: string, path: string, body: unknown) => [number, unknown] | undefined) | null = null

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  copyFileSync(join(process.cwd(), 'scripts', 'agent-msg.sh'), join(root, 'scripts', 'agent-msg.sh'))
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      receivedPath = req.url ?? ''
      received = raw ? JSON.parse(raw) : null
      const key = req.headers['idempotency-key']
      requests.push({ path: receivedPath, key: Array.isArray(key) ? key[0] : key, body: received, method: req.method })
      const routed = router?.(req.method ?? 'GET', receivedPath, received)
      const [status, body] = routed ?? queue.shift() ?? answer
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}


const totals = (calls: number, cacheRead: number) => ({
  calls, input: calls * 10, output: calls * 20, cache_read: cacheRead, cache_write: 0, first_call: null, last_call: null,
})
const empty = totals(0, 0)
const usage = (id: string, variant: string | null, valid: boolean) => ({
  task: { id, project: 'acropora', variant },
  valid,
  overlaps: valid ? [] : [{ call_id: 9, agent: 'murena', timestamp: 1760252700, tasks: [id, 'masik'] }],
  totals: totals(43, 7_990_000),
  by_capacity: { work: totals(40, 7_000_000), review: empty, fix: totals(3, 990_000), admin: empty, repeat: empty },
  unassigned: { admin: totals(4, 2_000_000), review: empty },
  by_agent: {}, by_session: {}, by_mode: { session: 0, window: 43 },
  duration_seconds: 900, repeated_of: null,
})

describe('fleet-api.sh task-usage', () => {
  it('FLEET-TASK-USAGE: prints the breakdown and the variants; an overlap stops with 3 and names it', async () => {
    answer = [200, { task: usage('m1', null, true), variants: [usage('m1-V1', 'V1', true)] }]
    const ok = await run(['task-usage', 'm1', 'variants'])
    const okPath = receivedPath
    answer = [200, usage('m1', null, false)]
    const bad = await run(['task-usage', 'm1'])
    expect([ok.code, okPath, /43 hivas .*cache-olv +7\.99M/.test(ok.out), /fix +3 hivas/.test(ok.out),
      ok.out.includes('m1-V1 (acropora, V1)'), /admin: nem rendelheto, 4 hivas/.test(ok.out), /review: nem rendelheto/.test(ok.out), bad.code, /ERVENYTELEN/.test(bad.out), /ATFEDES: murena .*m1, masik/.test(bad.out)],
    'FLEET-TASK-USAGE').toEqual([0, '/api/tasks/m1/usage?variants=1', true, true, true, true, false, 3, true, true])
  })

  it('FLEET-TASK-EVENT: the time and the reference go as given, the task id URL-encoded', async () => {
    answer = [201, { id: 1 }]
    const r = await run(['task-event', 'kartya 1', 'started', 'murena', '2026-10-12T07:03:00Z', 'msg 28421'])
    expect([r.code, receivedPath, received], 'FLEET-TASK-EVENT').toEqual([
      0, '/api/tasks/kartya%201/events', { kind: 'started', actor: 'murena', at: '2026-10-12T07:03:00Z', ref: 'msg 28421' },
    ])
  })

  it('FLEET-TASK-EVENT-IDEM: a run retries a 500 with the SAME key; the next run has a new one', async () => {
    requests = []
    queue = [[500, { error: 'x' }]]
    answer = [201, { id: 7 }]
    const first = await run(['task-event', 't1', 'fix_started', 'murena'])
    const second = await run(['task-event', 't1', 'fix_started', 'murena'])
    const keys = requests.map((r) => r.key)
    expect([first.code, second.code, requests.length, keys[0] === keys[1], keys[1] === keys[2], /^[0-9a-f-]{36}$/.test(keys[0] ?? '')],
      'FLEET-TASK-EVENT-IDEM').toEqual([0, 0, 3, true, false, true])
  })

  it('FLEET-TASK-EVENT-DATA: --data - sends the object from STDIN; a non-object stops before any request', async () => {
    requests = []
    answer = [201, { id: 8 }]
    const ok = await run(['task-event', 't1', 'merged', 'acrobot', '', 'PR #41', '--data', '-'], '{"repo":"KratoBal/marveen","pr":41,"merge_sha":"' + 'a'.repeat(40) + '"}')
    const sent = requests.length
    const bad = await run(['task-event', 't1', 'merged', 'acrobot', '--data', '-'], '[1,2]')
    expect([ok.code, received, sent, bad.code, requests.length, /JSON objektum/.test(bad.out)], 'FLEET-TASK-EVENT-DATA').toEqual([
      0, { kind: 'merged', actor: 'acrobot', ref: 'PR #41', data: { repo: 'KratoBal/marveen', pr: 41, merge_sha: 'a'.repeat(40) } }, 1, 1, 1, true,
    ])
  })

  it('FLEET-TASK-NEW-JSON: task-new <id> - takes every field from STDIN, the id from the argument', async () => {
    answer = [201, { id: 'tcl-x' }]
    const r = await run(['task-new', 'tcl-x', '-'], '{"id":"masik","title":"Cím","assignee":"murena","verification_profile":"code_fleet","acceptance":["zöld"]}')
    expect([r.code, receivedPath, received], 'FLEET-TASK-NEW-JSON').toEqual([
      0, '/api/tasks', { id: 'tcl-x', title: 'Cím', assignee: 'murena', verification_profile: 'code_fleet', acceptance: ['zöld'] },
    ])
  })

  it('FLEET-TASK-TIMELINE: one line per item, and the count', async () => {
    answer = [200, { task: 't1', items: [
      { at: 1760252580, source: 'event', id: 1, kind: 'started', actor: 'murena', ref: null, data: null },
      { at: 1760252590, source: 'session', agent: 'murena', session_id: 'sess-1' },
      { at: 1760252600, source: 'handoff', id: 3, agent: 'murena', status: 'in_progress', next_step: 'x' },
    ] }]
    const r = await run(['task-timeline', 't1'])
    expect([r.code, receivedPath, /esemeny  started +murena/.test(r.out), /session  sess-1/.test(r.out), /atadas   rekord 3/.test(r.out), /-- 3 tetel, t1/.test(r.out)],
      'FLEET-TASK-TIMELINE').toEqual([0, '/api/tasks/t1/timeline', true, true, true, true])
  })

  it('FLEET-TASK-TIMELINE-MESSAGE: a message item prints its own line; an unknown source is shown raw, not a crash', async () => {
    answer = [200, { task: 't1', items: [
      { at: 1760252580, source: 'message', id: 29772, from: 'acrobot', to: 'murena', status: 'delivered' },
      { at: 1760252590, source: 'jovobeli', id: 5, mi: 'uj fajta' },
    ] }]
    const r = await run(['task-timeline', 't1'])
    expect([r.code, /uzenet +29772 +acrobot -> murena +delivered/.test(r.out), /jovobeli  \{.*"mi": "uj fajta"/.test(r.out),
      /KeyError|Traceback/.test(r.out), /-- 2 tetel, t1/.test(r.out)],
    'FLEET-TASK-TIMELINE-MESSAGE').toEqual([0, true, true, false, true])
  })
})

// TC-Lite L5: fleet-api.sh kiadas. WHAT TURNS THIS RED:
//   - a step does not stop with its own exit code (4 task, 3 handoff, 5 busy, 8 pane, 6 restart, 7 message);
//   - a working pane or a pending message still gets a restart;
//   - a second run of a successful hand-out writes `assigned` again, restarts again or sends again;
//   - the restart is not fresh, or does not carry the task id; the message is not linked to the task.
describe('fleet-api.sh kiadas (TC-Lite L5)', () => {
  type Item = Record<string, unknown>
  interface Fake {
    fields: Record<string, string | null> | null
    items: Item[]
    handoffOk: boolean
    busy: { id: string; last_kind: string; busy: boolean }[]
    state: string
    pending: { id: number; to_agent: string }[]
    restart: [number, unknown]
    message: [number, unknown]
  }
  const goodFields = { title: 'L5', goal: 'kiadas', assignee: 'nautilus', reviewer: 'barracuda', authorization_ref: 'msg 1', verification_profile: 'code_fleet' }
  const fake = (over: Partial<Fake> = {}): Fake => ({
    fields: { ...goodFields }, items: [], handoffOk: true, busy: [], state: 'idle', pending: [],
    restart: [200, { ok: true, session_id: 'sess-new' }], message: [200, { id: 77, status: 'pending' }], ...over,
  })
  let f = fake()
  const install = (state: Fake) => {
    f = state
    requests = []
    router = (method, path, body) => {
      const b = body as Record<string, unknown> | null
      if (method === 'GET' && path === '/api/tasks/t5/timeline')
        return f.fields ? [200, { task: 't5', fields: f.fields, items: f.items }] : [404, { error: 'no task t5' }]
      if (method === 'GET' && path === '/api/tasks/t5/handoffs/latest?verify=1')
        return [200, { id: 18, agent: 'acrobot', created_at: 1, record: { next_step: 'olvasd' },
          check: f.handoffOk ? { ok: true, mismatches: [] } : { ok: false, mismatches: ['code.head: a rekord abc, az ag most def'] } }]
      if (method === 'GET' && path === '/api/tasks?assignee=nautilus&busy=1') return [200, f.busy]
      if (method === 'POST' && path === '/api/tasks/t5/events') {
        f.items.push({ at: 1, source: 'event', id: 1, kind: b?.kind, actor: b?.actor, ref: b?.ref, data: b?.data ?? null })
        return [201, { id: 41 }]
      }
      if (method === 'GET' && path === '/api/agents/activity')
        return [200, [{ name: 'nautilus', isMain: false, running: true, state: f.state, mode: null, tail: ['egy', 'ket', 'harom utolso sor'] }]]
      if (method === 'GET' && path === '/api/messages?agent=nautilus&status=pending') return [200, f.pending]
      if (method === 'POST' && path === '/api/agents/nautilus/restart') {
        if (f.restart[0] === 200 && (f.restart[1] as { session_id?: string }).session_id)
          f.items.push({ at: 2, source: 'session', agent: 'nautilus', session_id: 'sess-new' })
        return f.restart
      }
      if (method === 'POST' && path === '/api/messages') {
        if (f.message[0] === 200) f.items.push({ at: 3, source: 'message', id: 77, from: b?.from, to: b?.to, status: 'pending' })
        return f.message
      }
      return [599, { error: `unexpected ${method} ${path}` }]
    }
  }
  const writes = () => requests.filter((r) => r.method === 'POST').map((r) => r.path)
  const restartCalls = () => requests.filter((r) => r.path === '/api/agents/nautilus/restart').length

  afterAll(() => { router = null })

  it('FLEET-KIADAS-OK: every step once; the second run duplicates neither assigned, nor the restart, nor the message', async () => {
    install(fake())
    const first = await run(['kiadas', 't5', 'nautilus'])
    const firstWrites = writes()
    const restartBody = requests.find((r) => r.path === '/api/agents/nautilus/restart')?.body
    const msg = requests.find((r) => r.path === '/api/messages')?.body as Record<string, string> | undefined
    const assigned = requests.find((r) => r.path === '/api/tasks/t5/events')?.body
    requests = []
    const second = await run(['kiadas', 't5', 'nautilus'])
    expect([first.code, firstWrites, restartBody, msg?.task_id, msg?.from, msg?.to, /handoff-read t5/.test(msg?.content ?? ''), assigned,
      /KIADVA: t5 -> nautilus/.test(first.out), second.code, writes(), /4 kihagyva/.test(second.out), /5 kihagyva/.test(second.out), /6 kihagyva/.test(second.out)],
    'FLEET-KIADAS-OK').toEqual([
      0, ['/api/tasks/t5/events', '/api/agents/nautilus/restart', '/api/messages'], { fresh: true, task_id: 't5' }, 't5', 'acrobot', 'nautilus', true,
      { kind: 'assigned', actor: 'acrobot', ref: 'nautilus', data: { agent: 'nautilus' } },
      true, 0, [], true, true, true,
    ])
  })

  it('FLEET-KIADAS-1: no task, a missing field, another assignee: exit 4 and named, nothing written', async () => {
    install(fake({ fields: null }))
    const none = await run(['kiadas', 't5', 'nautilus'])
    install(fake({ fields: { ...goodFields, goal: null, authorization_ref: '' } }))
    const missing = await run(['kiadas', 't5', 'nautilus'])
    install(fake({ fields: { ...goodFields, assignee: 'murena' } }))
    const other = await run(['kiadas', 't5', 'nautilus'])
    const otherWrites = writes()
    install(fake())
    router = ((inner) => (method: string, path: string, body: unknown) =>
      path === '/api/tasks/t5/timeline' ? [200, 'nem objektum'] as [number, unknown] : inner!(method, path, body))(router)
    const garbled = await run(['kiadas', 't5', 'nautilus'])
    expect([none.code, /nincs ilyen feladat: t5/.test(none.out), missing.code, /hianyzik a feladatrol: goal/.test(missing.out),
      /hianyzik a feladatrol: authorization_ref/.test(missing.out), other.code, /felelose murena, nem nautilus/.test(other.out),
      /Atiras: fleet-api\.sh task-new t5 - < feladat\.json, benne "assignee": "nautilus"/.test(other.out), otherWrites,
      garbled.code, /nem olvashato JSON objektum/.test(garbled.out), writes()],
    'FLEET-KIADAS-1').toEqual([4, true, 4, true, true, 4, true, true, [], 1, true, []])
  })

  it('FLEET-KIADAS-REPEAT-CLOSED: an unreadable timeline item stops with 1 before any write (no second assigned, restart, message)', async () => {
    install(fake({ items: [{ at: 1, kind: 'assigned' }] }))
    const r = await run(['kiadas', 't5', 'nautilus'])
    expect([r.code, /nem olvashato, mi tortent mar a feladaton/.test(r.out), writes()], 'FLEET-KIADAS-REPEAT-CLOSED').toEqual([1, true, []])
  })

  it('FLEET-KIADAS-2: a handoff record about a changed state stops with 3 and shows the mismatch', async () => {
    install(fake({ handoffOk: false }))
    const r = await run(['kiadas', 't5', 'nautilus'])
    expect([r.code, /code\.head: a rekord abc/.test(r.out), /FAIL 2/.test(r.out), writes()], 'FLEET-KIADAS-2').toEqual([3, true, true, []])
  })

  it('FLEET-KIADAS-3: another busy task stops with 5 and names it; --parallel goes on and records the reason', async () => {
    const busy = [{ id: 'masik', last_kind: 'started', busy: true }, { id: 't5', last_kind: 'assigned', busy: true }]
    install(fake({ busy }))
    const stop = await run(['kiadas', 't5', 'nautilus'])
    const stopWrites = writes()
    install(fake({ busy }))
    const go = await run(['kiadas', 't5', 'nautilus', '--parallel', 'surgos javitas'])
    const assigned = requests.find((r) => r.path === '/api/tasks/t5/events')?.body as { data?: unknown } | undefined
    expect([stop.code, /foglalt: masik\(started\)$/m.test(stop.out), stopWrites, go.code, assigned?.data], 'FLEET-KIADAS-3').toEqual([
      5, true, [], 0, { agent: 'nautilus', parallel: 'surgos javitas' },
    ])
  })

  it('FLEET-KIADAS-4B: a working pane or a pending message stops with 8, shows what it saw, and never restarts', async () => {
    install(fake({ state: 'working' }))
    const working = await run(['kiadas', 't5', 'nautilus'])
    const workingRestarts = restartCalls()
    install(fake({ pending: [{ id: 901, to_agent: 'nautilus' }] }))
    const pending = await run(['kiadas', 't5', 'nautilus'])
    const pendingRestarts = restartCalls()
    install(fake({ state: 'working' }))
    const cont = await run(['kiadas', 't5', 'nautilus', '--continue'])
    expect([working.code, /Allapot: working/.test(working.out), /\| harom utolso sor/.test(working.out), workingRestarts,
      pending.code, /fuggo uzenet: 1 \(901\)/.test(pending.out), pendingRestarts,
      cont.code, restartCalls(), requests.some((r) => r.path === '/api/agents/activity'), writes()], 'FLEET-KIADAS-4B').toEqual([
      8, true, true, 0, 8, true, 0, 0, 0, false, ['/api/tasks/t5/events', '/api/messages'],
    ])
  })

  it('FLEET-KIADAS-5: a refused restart, or one whose session was not registered, stops with 6 before the message', async () => {
    install(fake({ restart: [400, { error: 'Agent not found' }] }))
    const refused = await run(['kiadas', 't5', 'nautilus'])
    const refusedWrites = writes()
    install(fake({ restart: [200, { ok: true, session_id: 's', registered: false }] }))
    const unregistered = await run(['kiadas', 't5', 'nautilus'])
    expect([refused.code, /FAIL 5: .*Agent not found/.test(refused.out), refusedWrites, unregistered.code, writes().includes('/api/messages')],
      'FLEET-KIADAS-5').toEqual([6, true, ['/api/tasks/t5/events', '/api/agents/nautilus/restart'], 6, false])
  })

  it('FLEET-KIADAS-6: no OK id from the message helper stops with 7', async () => {
    install(fake({ message: [400, { error: 'nope' }] }))
    const r = await run(['kiadas', 't5', 'nautilus'])
    expect([r.code, /FAIL 6: az indito uzenet nem ment el/.test(r.out), /KIADVA/.test(r.out)], 'FLEET-KIADAS-6').toEqual([7, true, false])
  }, 15_000)
})
