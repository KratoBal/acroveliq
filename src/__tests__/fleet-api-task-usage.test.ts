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
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { NON_STATE_KINDS } from '../task-usage.js'


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

function run(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port), ...env } }, (error, stdout, stderr) =>
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

  it('FLEET-TASK-USAGE-COORD: the coord line, and the concurrent other tasks said on their own line', async () => {
    const u = usage('koord', null, true)
    answer = [200, { ...u, by_capacity: { ...u.by_capacity, coord: totals(12, 4_000_000) },
      coordination: { concurrent: totals(5, 1_000_000), concurrent_tasks: ['masik', 'harmadik'], open_since: 1760252700, ceded: totals(2, 300_000), ceded_to: ['k4'] } }]
    const r = await run(['task-usage', 'koord'])
    answer = [200, { ...u, by_capacity: { ...u.by_capacity, coord: totals(12, 4_000_000) }, coordination: { concurrent: empty, concurrent_tasks: [] } }]
    const quiet = await run(['task-usage', 'koord'])
    expect([r.code, /coord +12 hivas .*cache-olv +4\.00M/.test(r.out),
      /coord: ebbol 5 hivas idejen mas feladat ablaka is nyitva volt \(masik, harmadik\)/.test(r.out),
      /mas feladat ablaka/.test(quiet.out), /LEZARATLAN ablak 1760252700 ota/.test(r.out), /LEZARATLAN/.test(quiet.out), /coord: 2 hivas a feladat sajat ablakaban egy masik feladat coord ablakaba esett \(k4\), ott szamolva/.test(r.out), /coord ablakaba esett/.test(quiet.out)], 'FLEET-TASK-USAGE-COORD').toEqual([0, true, true, false, true, false, true, false])
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

  /*
    AZ ELDOBOTT KULCS HANGOSAN (aktualis-munka-ures, acrobot döntése). MI PIROSÍT: az
    ignored lista mellett nincs figyelmeztetés, vagy a kilépés nem 0; üres listánál is
    figyelmeztet; egy elbukott hívás 0-val tér vissza (a post alhéjban fut).
  */
  it('FLEET-TASK-NEW-IGNORED: ignored keys warn on stderr with exit 0; none, no warning; a failed post still fails', async () => {
    answer = [201, { id: 'tcl-y', ignored: ['felelos', 'cim'] }]
    const warned = await run(['task-new', 'tcl-y', '-'], '{"cim":"Cím","felelos":"murena"}')
    answer = [201, { id: 'tcl-z', ignored: [] }]
    const clean = await run(['task-new', 'tcl-z', '-'], '{"title":"Cím","assignee":"murena"}')
    answer = [500, { error: 'boom' }]
    const failed = await run(['task-new', 'tcl-w', '-'], '{"title":"Cím"}')
    expect([
      warned.code, /FIGYELEM: a szerver ezeket a kulcsokat NEM tarolta \(ismeretlen mezo\): felelos, cim/.test(warned.out),
      clean.code, /FIGYELEM/.test(clean.out),
      failed.code !== 0, /FAIL http=500/.test(failed.out),
    ], 'FLEET-TASK-NEW-IGNORED').toEqual([0, true, 0, false, true, true])
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
    paused?: boolean
    serverSaysFree?: boolean
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
        return f.fields ? [200, { task: 't5', fields: f.fields, paused: f.paused ?? false, items: f.items }] : [404, { error: 'no task t5' }]
      if (method === 'GET' && path === '/api/tasks/t5/handoffs/latest?verify=1')
        return [200, { id: 18, agent: 'acrobot', created_at: 1, record: { next_step: 'olvasd' },
          check: f.handoffOk ? { ok: true, mismatches: [] } : { ok: false, mismatches: ['code.head: a rekord abc, az ag most def'] } }]
      if (method === 'GET' && path === '/api/tasks?assignee=nautilus&busy=1') {
        // the server's rule, modelled: t5 keeps the agent busy while its last state event is assigned,
        // started or fix_started (task-usage.ts BUSY_KINDS); f.busy can name it explicitly instead
        if (f.busy.some((t) => t.id === 't5') || f.serverSaysFree) return [200, f.busy]
        const states = f.items.filter((i) => i.source === 'event' && !(NON_STATE_KINDS as readonly string[]).includes(String(i.kind)))
        const last = states[states.length - 1]
        const t5busy = !!last && ['assigned', 'started', 'fix_started'].includes(String(last.kind))
        return [200, t5busy ? [...f.busy, { id: 't5', last_kind: String(last.kind), busy: true }] : f.busy]
      }
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

  // Feladatkezelés V1: a paused task is not handed out; a resumed one is handed out again
  it('FLEET-KIADAS-PAUSED: a paused task stops at step 1 with 4, says so, and writes nothing', async () => {
    install(fake({ paused: true }))
    const r = await run(['kiadas', 't5', 'nautilus'])
    expect([r.code, /szunetel/.test(r.out), writes()], 'FLEET-KIADAS-PAUSED').toEqual([4, true, []])
  })

  it('FLEET-KIADAS-RESUMED: after a pause and a resume, assigned, the restart and the message go again', async () => {
    install(fake({
      items: [
        { at: 1, source: 'event', id: 1, kind: 'assigned', actor: 'acrobot', ref: 'nautilus', data: { agent: 'nautilus' } },
        { at: 2, source: 'session', agent: 'nautilus', session_id: 'sess-old' },
        { at: 3, source: 'message', id: 70, from: 'acrobot', to: 'nautilus', status: 'delivered' },
        { at: 4, source: 'event', id: 2, kind: 'paused', actor: 'balazs', ref: 'pause', data: null },
        { at: 5, source: 'event', id: 3, kind: 'resumed', actor: 'balazs', ref: 'resume', data: null },
      ],
    }))
    const r = await run(['kiadas', 't5', 'nautilus'])
    expect([r.code, writes()], 'FLEET-KIADAS-RESUMED').toEqual([0, ['/api/tasks/t5/events', '/api/agents/nautilus/restart', '/api/messages']])
    // the control: the same history WITHOUT the pause skips all three, as a repeat should
    install(fake({ items: [
      { at: 1, source: 'event', id: 1, kind: 'assigned', actor: 'acrobot', ref: 'nautilus', data: { agent: 'nautilus' } },
      { at: 2, source: 'session', agent: 'nautilus', session_id: 'sess-old' },
      { at: 3, source: 'message', id: 70, from: 'acrobot', to: 'nautilus', status: 'delivered' },
    ] }))
    const repeat = await run(['kiadas', 't5', 'nautilus'])
    expect([repeat.code, writes()]).toEqual([0, []])
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

  // A new stage of the same task, handed out to the same agent (acrobot 30669; measured 2026-10-14 15:28: the
  // dashboard showed no active task, the hand-out skipped assigned, and acrobot wrote it by hand, event 819).
  // The rule is the server's busy flag (barracuda #132), not a list in the script.
  it('FLEET-KIADAS-REFREE: a task that no longer keeps its agent busy is claimed again; one that does is not', async () => {
    const before: Item[] = [
      { at: 1, source: 'event', id: 1, kind: 'assigned', actor: 'acrobot', ref: 'nautilus', data: { agent: 'nautilus' } },
      { at: 2, source: 'session', agent: 'nautilus', session_id: 'sess-old' },
      { at: 3, source: 'message', id: 70, from: 'acrobot', to: 'nautilus', status: 'delivered' },
      { at: 4, source: 'event', id: 2, kind: 'started', actor: 'nautilus', ref: '', data: null },
    ]
    const ev = (id: number, kind: string, actor = 'nautilus'): Item => ({ at: 4 + id, source: 'event', id, kind, actor, ref: '', data: null })
    const outcome = async (tail: Item[], over: Partial<Fake> = {}) => {
      install(fake({ items: [...before, ...tail], ...over }))
      const r = await run(['kiadas', 't5', 'nautilus'])
      const assigned = requests.find((q) => q.path === '/api/tasks/t5/events')?.body as Record<string, unknown> | undefined
      return [r.code, writes(), assigned?.kind ?? null, /4 ujra foglal/.test(r.out), /5 kihagyva/.test(r.out), /6 kihagyva/.test(r.out)]
    }
    const claimed = [0, ['/api/tasks/t5/events'], 'assigned', true, true, true]
    const kept = [0, [], null, false, true, true]
    expect([
      await outcome([ev(3, 'review_requested')]),
      await outcome([ev(3, 'review_requested'), ev(4, 'verdict', 'barracuda')]),
      await outcome([ev(3, 'merged', 'acrobot')]),
      await outcome([ev(3, 'merged', 'acrobot'), ev(4, 'deployed', 'acrobot')]),
      await outcome([ev(3, 'blocked')]),
      await outcome([ev(3, 'done')]),
    ], 'FLEET-KIADAS-REFREE claimed').toEqual([claimed, claimed, claimed, claimed, claimed, claimed])
    expect([
      await outcome([]), // last state: started
      await outcome([ev(3, 'review_requested'), ev(4, 'fix_started')]),
      await outcome([ev(3, 'merged', 'acrobot'), { ...ev(4, 'assigned', 'acrobot'), ref: 'nautilus', data: { agent: 'nautilus' } }]),
    ], 'FLEET-KIADAS-REFREE kept').toEqual([kept, kept, kept])
    // the server decides, not the timeline: the same review_requested history the server still counts as
    // busy is skipped, and a started history it counts as free is claimed
    expect([
      await outcome([ev(3, 'review_requested')], { busy: [{ id: 't5', last_kind: 'review_requested', busy: true }] }),
      await outcome([], { serverSaysFree: true }),
    ], 'FLEET-KIADAS-REFREE server').toEqual([kept, claimed])
    // the hand-out's second run after the re-claim writes nothing (the claim is the last state event now)
    install(fake({ items: [...before, ev(3, 'review_requested')] }))
    await run(['kiadas', 't5', 'nautilus'])
    requests = []
    const again = await run(['kiadas', 't5', 'nautilus'])
    expect([again.code, writes()], 'FLEET-KIADAS-REFREE repeat').toEqual([0, []])
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

// TC-03 minimum (task deployed-esemeny): fleet-api.sh deployed. WHAT TURNS THIS RED:
//   - it writes before it measured, or writes when the change is not running;
//   - a cherry-pick of ANOTHER change passes (the patch-id check);
//   - an acropora app whose image lacks the merge does not stop the whole run before any write;
//   - the same deployment run twice sends two different keys.
describe('fleet-api.sh deployed (TC-03 minimum)', () => {
  const repo = mkdtempSync(join(root, 'deployed-git-'))
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv }).toString().trim()
  let BASE = '', MERGE = '', PICK = '', OTHER_PICK = '', MAIN = ''
  const bin = join(root, 'deployed-bin')
  beforeAll(() => {
    g('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base'); BASE = g('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'b.txt'), 'the change\n'); g('add', '.'); g('commit', '-q', '-m', 'squash merge (#7)'); MERGE = g('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'c.txt'), 'another change\n'); g('add', '.'); g('commit', '-q', '-m', 'another (#8)'); const other = g('rev-parse', 'HEAD')
    MAIN = other
    // a release-only commit first: without it the cherry-pick recreates the very same commit
    // object (same parent, tree, author and second), and it would not be a cherry-pick at all
    g('checkout', '-q', '-b', 'release', BASE)
    writeFileSync(join(repo, 'r.txt'), 'release only\n'); g('add', '.'); g('commit', '-q', '-m', 'release-only')
    g('cherry-pick', MERGE); PICK = g('rev-parse', 'HEAD')
    g('checkout', '-q', '-b', 'release-wrong', 'release~1')
    g('cherry-pick', other); OTHER_PICK = g('rev-parse', 'HEAD')
    mkdirSync(bin, { recursive: true })
  })
  const merged = (over: Record<string, unknown> = {}) => ({
    at: 5, source: 'event', id: 9, kind: 'merged', actor: 'acrobot', ref: 'KratoBal/marveen#7',
    data: { repo: 'KratoBal/marveen', pr: 7, merge_sha: MERGE, ...over },
  })
  const fakeTimeline = (items: unknown[]) => {
    requests = []
    router = (method, path) => {
      if (method === 'GET' && path === '/api/tasks/t9/timeline') return [200, { task: 't9', fields: {}, items }]
      if (method === 'POST' && path === '/api/tasks/t9/events') return [201, { id: 55 }]
      return [599, { error: `unexpected ${method} ${path}` }]
    }
  }
  const posts = () => requests.filter((r) => r.method === 'POST')
  const live = (ref: string) => { g('checkout', '-q', ref); return { DEPLOYED_LIVE_TREE: repo } }
  afterAll(() => { router = null })

  it('DEPLOYED-ANCESTOR: the merge is an ancestor of the live HEAD: one event, evidence ancestor, the HEAD as deployed_sha', async () => {
    fakeTimeline([merged()])
    const r = await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    const body = posts()[0]?.body as { kind: string; data: Record<string, unknown> } | undefined
    expect([r.code, posts().length, body?.kind, body?.data.evidence, body?.data.deployed_sha, body?.data.merge_sha, posts()[0]?.key,
      (body as { ref?: string } | undefined)?.ref?.includes('az elo fan')],
      `DEPLOYED-ANCESTOR ${r.out}`).toEqual([0, 1, 'deployed', 'ancestor', MAIN, MERGE, `deployed:t9:marveen-live:${MAIN}`, true])
  })

  it('DEPLOYED-CHERRY-PICK: on a release branch only a --commit whose patch-id is the merge\'s passes', async () => {
    const isAncestor = (a: string, b: string) => { try { g('merge-base', '--is-ancestor', a, b); return true } catch { return false } }
    // the fixture is a real cherry-pick: another commit, and the merge NOT in the release branch
    expect([PICK === MERGE, isAncestor(MERGE, 'release'), isAncestor(PICK, 'release')]).toEqual([false, false, true])
    fakeTimeline([merged()])
    const none = await run(['deployed', 'marveen', 't9'], undefined, live('release'))
    const noneWrites = posts().length
    fakeTimeline([merged()])
    const ok = await run(['deployed', 'marveen', 't9', '--commit', PICK], undefined, live('release'))
    const okBody = posts()[0]?.body as { data: Record<string, unknown> } | undefined
    fakeTimeline([merged()])
    // a real cherry-pick of ANOTHER change, an ancestor of the live HEAD: refused
    const wrong = await run(['deployed', 'marveen', 't9', '--commit', OTHER_PICK], undefined, live('release-wrong'))
    expect([none.code, noneWrites, ok.code, okBody?.data.evidence, okBody?.data.deployed_sha, wrong.code, posts().length, /patch-id/.test(wrong.out)],
      'DEPLOYED-CHERRY-PICK').toEqual([5, 0, 0, 'cherry-pick', PICK, 5, 0, true])
  })

  it('DEPLOYED-STOPS: no merged event 4, another repo 4, a merge not in the tree 3, --nez writes nothing', async () => {
    fakeTimeline([])
    const noMerged = await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    fakeTimeline([merged({ repo: 'KratoBal/acropora-os' })])
    const otherRepo = await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    fakeTimeline([merged({ merge_sha: 'f'.repeat(40) })])
    const absent = await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    fakeTimeline([merged()])
    const nez = await run(['deployed', '--nez', 'marveen', 't9'], undefined, live('main'))
    expect([noMerged.code, otherRepo.code, absent.code, nez.code, /NEZ \(nem irok\)/.test(nez.out), posts().length], 'DEPLOYED-STOPS')
      .toEqual([4, 4, 3, 0, true, 0])
  })

  it('DEPLOYED-REPEAT: the same deployment twice sends the same key (the server keeps one row)', async () => {
    fakeTimeline([merged()])
    await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    await run(['deployed', 'marveen', 't9'], undefined, live('main'))
    const keys = posts().map((p) => p.key)
    expect([keys.length, new Set(keys).size], 'DEPLOYED-REPEAT').toEqual([2, 1])
  })

  it('DEPLOYED-IMAGE: acropora reads the image tags; every named app must contain the merge, or nothing is written', async () => {
    const ps = (api: string, web: string) => {
      writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' 't9gxx94ecwekwruxngps5i6v-1|t9gxx94ecwekwruxngps5i6v:${api}|Up 1 hour' 'dnt6jzza68wnuamvi93whn28-1|dnt6jzza68wnuamvi93whn28:${web}|Up 1 hour'\n`)
      chmodSync(join(bin, 'ssh'), 0o755)
    }
    const env = { PATH: `${bin}:${process.env.PATH}`, DEPLOYED_OS_CLONE: repo, ELES_KEY: '/dev/null' }
    const os = merged({ repo: 'KratoBal/acropora-os' })
    g('checkout', '-q', 'main')
    ps(MAIN, MAIN)
    fakeTimeline([os])
    const both = await run(['deployed', 'acropora', 't9', '--app', 'api', '--app', 'web'], undefined, env)
    const bothApps = posts().map((p) => (p.body as { data: { app: string; evidence: string } }).data)
    ps(MAIN, BASE) // the web image is older than the merge
    fakeTimeline([os])
    const partial = await run(['deployed', 'acropora', 't9', '--app', 'api', '--app', 'web'], undefined, env)
    const partialWrites = posts().length
    fakeTimeline([merged()]) // a marveen merge against an OS app
    const wrongRepo = await run(['deployed', 'acropora', 't9', '--app', 'api'], undefined, env)
    expect([both.code, bothApps.map((d) => `${d.app}:${d.evidence}`), partial.code, partialWrites, /web.*NEM tartalmazza/.test(partial.out), wrongRepo.code, posts().length],
      `DEPLOYED-IMAGE ${both.out}`).toEqual([0, ['api:image-tag', 'web:image-tag'], 5, 0, true, 4, 0])
  })

  /*
    THE PINNED HOST KEY (Security Baseline, task ssh-hostkulcs-rogzites). MI PIROSÍT: the
    deployed read reaches the production machine without StrictHostKeyChecking=yes and the
    pinned file (or with the global known_hosts on); a machine whose key is not pinned still
    produces an event. The fake ssh plays ssh's own rule: it answers only if the pinned file
    carries the host, else it fails the way ssh does (255, host key verification failed);
    the real behaviour was measured once by hand (a foreign pinned key stops at the handshake).
  */
  it('DEPLOYED-HOSTKEY: an unpinned machine key fails the read, and no event is written', async () => {
    const pinned = join(root, 'pinned_known_hosts')
    const argsFile = join(root, 'ssh-args')
    writeFileSync(join(bin, 'ssh'), [
      '#!/bin/bash',
      'printf "%s\\n" "$@" > "$SSH_ARGS_FILE"',
      'kh=""; strict=""',
      'for a in "$@"; do case "$a" in UserKnownHostsFile=*) kh="${a#UserKnownHostsFile=}";; StrictHostKeyChecking=yes) strict=1;; esac; done',
      'host="${@: -2:1}"; host="${host#*@}"',
      'if [ -z "$strict" ] || [ -z "$kh" ] || ! grep -q "^$host " "$kh" 2>/dev/null; then echo "Host key verification failed." >&2; exit 255; fi',
      'printf "%s\\n" "t9gxx94ecwekwruxngps5i6v-1|t9gxx94ecwekwruxngps5i6v:$MAIN_SHA|Up 1 hour"',
    ].join('\n') + '\n')
    chmodSync(join(bin, 'ssh'), 0o755)
    const os = merged({ repo: 'KratoBal/acropora-os' })
    const env = (khContent: string) => {
      writeFileSync(pinned, khContent)
      return { PATH: `${bin}:${process.env.PATH}`, DEPLOYED_OS_CLONE: repo, ELES_KEY: '/dev/null', FLEET_KNOWN_HOSTS: pinned, MAIN_SHA: MAIN, SSH_ARGS_FILE: argsFile }
    }
    g('checkout', '-q', 'main')
    fakeTimeline([os])
    const foreign = await run(['deployed', 'acropora', 't9', '--app', 'api'], undefined, env('203.0.113.9 ssh-ed25519 AAAA\n'))
    const foreignWrites = posts().length
    fakeTimeline([os])
    const ok = await run(['deployed', 'acropora', 't9', '--app', 'api'], undefined, env('162.55.216.28 ssh-ed25519 AAAA\n'))
    const args = readFileSync(argsFile, 'utf-8').split('\n')
    expect([
      foreign.code, foreignWrites, /Host key verification failed/.test(foreign.out),
      ok.code, posts().length,
      args.includes('StrictHostKeyChecking=yes'), args.includes(`UserKnownHostsFile=${pinned}`), args.includes('GlobalKnownHostsFile=/dev/null'), args.includes('HostKeyAlgorithms=ssh-ed25519'),
      args.some((a) => /StrictHostKeyChecking=no/.test(a)),
    ], `DEPLOYED-HOSTKEY ${foreign.out} ${ok.out}`).toEqual([1, 0, true, 0, 1, true, true, true, true, false])
  })

  it('DEPLOYED-OVERLAP: during a deployment the old and the new container run under one app id; while the old one lives, nothing is written', async () => {
    // barracuda, #121: the first matching line could be the NEW container before it took the traffic
    const lines = (...imgs: string[]) => {
      const out = imgs.map((sha, i) => `t9gxx94ecwekwruxngps5i6v-${i}|t9gxx94ecwekwruxngps5i6v:${sha}|Up`).join("' '")
      writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' '${out}'\n`)
      chmodSync(join(bin, 'ssh'), 0o755)
    }
    const env = { PATH: `${bin}:${process.env.PATH}`, DEPLOYED_OS_CLONE: repo, ELES_KEY: '/dev/null' }
    const os = merged({ repo: 'KratoBal/acropora-os' })
    lines(MAIN, BASE) // the new one first, the old one still up
    fakeTimeline([os])
    const overlap = await run(['deployed', 'acropora', 't9', '--app', 'api'], undefined, env)
    const overlapWrites = posts().length
    lines(MAIN, MAIN) // both carry the merge
    fakeTimeline([os])
    const done = await run(['deployed', 'acropora', 't9', '--app', 'api'], undefined, env)
    const ref = (posts()[0]?.body as { ref: string } | undefined)?.ref
    expect([overlap.code, overlapWrites, done.code, posts().length, ref?.includes('eles kepben')], `DEPLOYED-OVERLAP ${overlap.out}`)
      .toEqual([5, 0, 0, 1, true])
  })
})

// Projektek V1, PR C (task t-20261014-acroveliiq-projektkezeles-d3f1). WHAT TURNS THIS RED:
//   - task-new creates a NEW task without a project (it would fall under acropora and the os
//     filter would stay empty: barracuda, 30541), or stops an EXISTING task's update for it;
//   - the server's project_warning is swallowed;
//   - task-project does not go to POST /api/tasks/:id/project;
//   - project-repo stays silent on a repo outside the project, or does not say an unknown project.
describe('fleet-api.sh, Projektek V1', () => {
  const PROJ = [
    { id: 'acropora', name: 'Flotta és közös', repos: ['KratoBal/marveen', 'KratoBal/acropora-os'], aliases: [], legacy_mixed: true },
    { id: 'os', name: 'Acropora OS', repos: ['KratoBal/acropora-os'], aliases: [], legacy_mixed: false },
  ]
  const fake = (exists: boolean, fields: Record<string, unknown> = {}, postBody: unknown = { id: 'p1', ignored: [] }) => {
    requests = []
    router = (method, path) => {
      if (method === 'GET' && path === '/api/tasks/p1/timeline') return exists ? [200, { task: 'p1', fields, items: [] }] : [404, { error: 'no task p1' }]
      if (method === 'GET' && path === '/api/projects') return [200, PROJ]
      if (method === 'POST' && path === '/api/tasks') return [201, postBody]
      if (method === 'POST' && path === '/api/tasks/p1/project') return [200, { id: 'p1', project: 'os', from: 'acropora' }]
      return [599, { error: `unexpected ${method} ${path}` }]
    }
  }
  const posts = () => requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body])
  afterAll(() => { router = null })

  it('PROJ-TASK-NEW: a new task needs a project, in both forms; an existing one does not; the warning reaches stderr', async () => {
    fake(false)
    const json = await run(['task-new', 'p1', '-'], JSON.stringify({ title: 'x' }))
    const jsonPosts = posts().length
    fake(false)
    const positional = await run(['task-new', 'p1'])
    const positionalPosts = posts().length
    fake(false)
    const ok = await run(['task-new', 'p1', '-'], JSON.stringify({ title: 'x', project: 'os' }))
    const okBody = posts()[0]?.[1] as Record<string, unknown> | undefined
    fake(true, {}, { id: 'p1', ignored: [], project_warning: 'project kept: the task is os' })
    const existing = await run(['task-new', 'p1', '-'], JSON.stringify({ title: 'y' }))
    expect([json.code, jsonPosts, /projekt kell.*acropora\|os/.test(json.out), positional.code, positionalPosts, ok.code, okBody?.project, existing.code, /FIGYELEM \(projekt\): project kept/.test(existing.out)],
      'PROJ-TASK-NEW').toEqual([4, 0, true, 4, 0, 0, 'os', 0, true])
  })

  it('PROJ-TASK-PROJECT and PROJ-REPO: the change goes to its route; the repo check says in, out and unknown', async () => {
    fake(true)
    const change = await run(['task-project', 'p1', 'os', 'OS munka'])
    const changePost = posts()
    fake(true, { project: 'os', project_id: 'os' })
    const inside = await run(['project-repo', 'p1', 'KratoBal/acropora-os'])
    fake(true, { project: 'os', project_id: 'os' })
    const outside = await run(['project-repo', 'p1', 'KratoBal/marveen'])
    fake(true, { project: 'webshop', project_id: null })
    const unknown = await run(['project-repo', 'p1', 'KratoBal/marveen'])
    fake(false)
    const down = await run(['project-repo', 'p1', 'KratoBal/marveen'])
    expect([change.code, changePost, /^PROJEKT rendben: a KratoBal\/acropora-os a\(z\) os projekte$/m.test(inside.out), /FIGYELEM.*NEM a\(z\) os projekte/.test(outside.out), outside.code, /webshop\) nincs a nyilvantartasban/.test(unknown.out), down.code],
      'PROJ-TASK-PROJECT / PROJ-REPO').toEqual([
      0, [['/api/tasks/p1/project', { project: 'os', reason: 'OS munka' }]], true, true, 0, true, 1,
    ])
  })
})
