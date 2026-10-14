// Feladatkezelés V1, the backend (task feladatkezeles-v1-backend). Balázs's decision B,
// 2026-10-14 10:12:09 UTC (msg 1559871429544120323): the owner's session check, the
// repeat protection and the Task Core events are kept; a pause never interrupts running
// work; starting an agent stays acrobot's. A refusal is checked by what did NOT happen
// (the task, its events, the message queue), not only by its status code.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { getDb, getPendingMessages, initDatabase } from '../db.js'
import { waitsOn } from '../open-matters.js'
import { newTaskId } from '../task-actions.js'
import { addTaskEvent, addTaskSession, allTasks, assigneeTasks, isTaskPaused, taskTimeline, upsertTask, type TaskEventKind } from '../task-usage.js'
import { acroveliqAllows } from '../web/acroveliq-host.js'
import { ACCESS_MODES } from '../web/access-enforcement.js'
import { tryHandleTaskActions } from '../web/routes/task-actions.js'
import { taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const SESSION: Auth = { kind: 'session', user: 'balazs' }
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
const NOBODY = 'nobody' as const
const OTHERS: (Auth | typeof NOBODY)[] = [
  { kind: 'token', actor: 'acrobot', project: 'acropora' },
  { kind: 'token', actor: 'nautilus', project: 'acropora' },
  { kind: 'token', actor: 'legacy' },
  { kind: 'token' },
  { kind: 'device', device: 'telefon' },
  { kind: 'federation', peer: 'masik' },
  { kind: 'session', user: '' },
  { kind: 'session', user: 'luca' },
  { kind: 'session', user: 'Balazs' },
  NOBODY,
]

async function call(
  handler: (ctx: RouteContext) => Promise<boolean>,
  method: string,
  path: string,
  body: unknown,
  who: Auth | typeof NOBODY,
  extra: Partial<RouteContext> = {},
  headers: Record<string, string> = {},
): Promise<{ handled: boolean; status: number; body: any }> {
  const auth = who === NOBODY ? undefined : who
  let status = 200
  let text = ''
  const res: any = {
    statusCode: 200,
    setHeader() { return res },
    writeHead(code: number) { status = code; return res },
    end(chunk?: string | Buffer) { if (chunk) text += chunk.toString() },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    headers,
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && raw) cb(Buffer.from(raw))
      if (event === 'end') cb()
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth, ...extra } as unknown as RouteContext
  const handled = await handler(ctx)
  return { handled, status, body: text ? JSON.parse(text) : null }
}

const NOW = () => Math.floor(Date.now() / 1000)
const create = (body: Record<string, unknown>, key: string | null = 'kulcs-0001', who: Auth | typeof NOBODY = SESSION, extra: Partial<RouteContext> = {}) =>
  call(tryHandleTaskActions, 'POST', '/api/task-actions', body, who, extra, key ? { 'idempotency-key': key } : {})
const act = (id: string, body: Record<string, unknown>, who: Auth | typeof NOBODY = SESSION, extra: Partial<RouteContext> = {}) =>
  call(tryHandleTaskActions, 'POST', `/api/task-actions/${id}`, body, who, extra)
const agentEvent = (id: string, kind: string, actor = 'murena', who: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }) =>
  call(tryHandleTaskUsage, 'POST', `/api/tasks/${id}/events`, { kind, actor }, who)

const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n
const events = (id: string) => getDb().prepare('SELECT kind, actor, ref, data FROM task_events WHERE task_id = ? ORDER BY id').all(id) as any[]
const existing = (id: string, assignee: string | null = 'murena') =>
  upsertTask(getDb(), { id, type: null, parent_task: null, variant: null, brief_ref: null, title: id, goal: 'cel', assignee, priority: 'normal' }, NOW() - 100)
const ev = (id: string, kind: TaskEventKind, actor: string, at = NOW() - 50) =>
  addTaskEvent(getDb(), { task_id: id, kind, actor, at, ref: null }, at)

beforeEach(() => {
  initDatabase(':memory:')
  taskCoreSettings.mode = 'naplo'
})

describe('only the owner\'s session acts, in every access mode, on both surfaces', () => {
  it('every other caller gets a 403 on create and on each action, and nothing is written', async () => {
    existing('t1', null)
    const before = { tasks: count('SELECT count(*) AS n FROM tasks'), events: count('SELECT count(*) AS n FROM task_events'), msgs: getPendingMessages('acrobot').length }
    for (const mode of ACCESS_MODES) for (const surface of ['dashboard', 'acroveliq'] as const) for (const auth of OTHERS) {
      const extra = { accessMode: mode, surface }
      const label = `${mode} ${surface} ${JSON.stringify(auth)}`
      expect((await create({ title: 'x', goal: 'y' }, `k-${mode}-${surface}`, auth, extra)).status, label).toBe(403)
      for (const body of [{ action: 'assign', assignee: 'acrobot' }, { action: 'priority', priority: 'high' }, { action: 'pause' }, { action: 'resume' }])
        expect((await act('t1', body, auth, extra)).status, `${label} ${body.action}`).toBe(403)
    }
    expect({ tasks: count('SELECT count(*) AS n FROM tasks'), events: count('SELECT count(*) AS n FROM task_events'), msgs: getPendingMessages('acrobot').length })
      .toEqual(before)
  })

  it('the owner\'s session acts in every mode and on both surfaces', async () => {
    let n = 0
    for (const mode of ACCESS_MODES) for (const surface of ['dashboard', 'acroveliq'] as const) {
      const r = await create({ title: `t ${n}`, goal: 'g' }, `kulcs-000${n++}`, SESSION, { accessMode: mode, surface })
      expect(r.status, `${mode} ${surface} ${JSON.stringify(r.body)}`).toBe(201)
    }
  })

  it('the AcrovelIQ host lets the two task writes through, and not the agents\' task routes', () => {
    expect([
      acroveliqAllows('POST', '/api/task-actions'), acroveliqAllows('POST', '/api/task-actions/t1'),
      acroveliqAllows('POST', '/api/tasks'), acroveliqAllows('POST', '/api/tasks/t1/events'), acroveliqAllows('POST', '/api/agents/murena/restart'),
    ]).toEqual([true, true, false, false, false])
  })
})

describe('create: a task, one event, one message; the hand-out stays acrobot\'s', () => {
  it('makes the task with the server\'s id, the owner\'s fields and a traceable authorization', async () => {
    const r = await create({ title: 'Árvíztűrő tükörfúrógép', goal: 'a cel', assignee: 'acrobot', priority: 'high', brief_ref: 'https://discord.com/channels/1/2/3' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const t = r.body.task
    // the hand-out's id shape (fleet-api.sh kiadas)
    expect(t.id).toMatch(/^t-\d{8}-arvizturo-tukorfurogep-[0-9a-f]{4}$/)
    expect(t.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    expect([t.title, t.goal, t.assignee, t.priority, t.brief_ref, t.verification_profile, t.paused])
      .toEqual(['Árvíztűrő tükörfúrógép', 'a cel', 'acrobot', 'high', 'https://discord.com/channels/1/2/3', null, false])
    // the authorization points at records one can open: the task and the message (barracuda, msg 30316)
    expect(t.authorization_ref).toBe(`acroveliq:balazs:task ${t.id}:msg ${r.body.message_id}`)
    expect(events(t.id).map((e) => [e.kind, e.actor, JSON.parse(e.data).action])).toEqual([['owner_action', 'balazs', 'create']])
    const msgs = getPendingMessages('acrobot')
    expect(msgs.map((m) => [m.id, m.task_id])).toEqual([[r.body.message_id, t.id]])
    expect(msgs[0]!.content).toContain('[FELADAT_UJ]')
    // nothing hands it out: no assigned event, no session
    expect(count("SELECT count(*) AS n FROM task_events WHERE kind = 'assigned'") + count('SELECT count(*) AS n FROM task_sessions')).toBe(0)
  })

  it('without an assignee it is acrobot\'s to assign; the default priority is normal', async () => {
    const t = (await create({ title: 'x', goal: 'y' })).body.task
    expect([t.assignee, t.priority]).toEqual([null, 'normal'])
    expect(getPendingMessages('acrobot')[0]!.content).toContain('felelos=acrobot osztja ki')
  })

  it('needs an idempotency key; the same key gives back the same task, once', async () => {
    const none = await create({ title: 'x', goal: 'y' }, null)
    expect(none.status).toBe(400)
    const a = await create({ title: 'x', goal: 'y' }, 'kulcs-AAAA')
    const b = await create({ title: 'x', goal: 'y' }, 'kulcs-AAAA')
    expect([a.status, b.status, b.body.repeated, b.body.task.id]).toEqual([201, 200, true, a.body.task.id])
    expect([count('SELECT count(*) AS n FROM tasks'), count('SELECT count(*) AS n FROM task_events'), getPendingMessages('acrobot').length]).toEqual([1, 1, 1])
  })

  it('a missing or bad field is a 400 that names it, and makes nothing', async () => {
    const r = await create({ title: '', goal: 'y', priority: 'kritikus', assignee: '../etc' })
    expect(r.status).toBe(400)
    expect(r.body.missing).toEqual([
      'title (1-200 characters)',
      'priority (low|normal|high|urgent)',
      'assignee: an agent of the fleet, or empty for "acrobot assigns"',
    ])
    expect((await create({ title: 'x', goal: 'y', assignee: 'nincs-ilyen-agens' }, 'kulcs-0002')).status).toBe(400)
    expect(count('SELECT count(*) AS n FROM tasks')).toBe(0)
  })

  it('newTaskId: the title without accents, cut at 40, dated; an empty slug is "feladat"', () => {
    const at = Date.parse('2026-10-14T10:00:00Z') / 1000
    expect(newTaskId('Új feladat: a Döntéseim oldal!', at, () => 'beef')).toBe('t-20261014-uj-feladat-a-donteseim-oldal-beef')
    expect(newTaskId('???', at, () => '0001')).toBe('t-20261014-feladat-0001')
    expect(newTaskId('a'.repeat(80), at, () => '0001')).toBe(`t-20261014-${'a'.repeat(40)}-0001`)
  })
})

describe('assign and priority: an event and a message each; a repeat changes nothing', () => {
  it('priority: changed with its event; the same again is repeated; a bad value is 400', async () => {
    existing('t1')
    const r = await act('t1', { action: 'priority', priority: 'urgent' })
    const again = await act('t1', { action: 'priority', priority: 'urgent' })
    const bad = await act('t1', { action: 'priority', priority: 'P0' })
    expect([r.status, r.body.task.priority, again.body.repeated, bad.status]).toEqual([200, 'urgent', true, 400])
    expect(events('t1').map((e) => e.ref)).toEqual(['priority normal -> urgent'])
    expect(getPendingMessages('acrobot')).toHaveLength(1)
    expect(allTasks(getDb()).find((t) => t.id === 't1')?.priority).toBe('urgent')
  })

  it('assign before the hand-out: to an agent and back to "acrobot assigns"', async () => {
    existing('t1', null)
    const a = await act('t1', { action: 'assign', assignee: 'acrobot' })
    const b = await act('t1', { action: 'assign', assignee: null })
    expect([a.status, a.body.task.assignee, b.status, b.body.task.assignee]).toEqual([200, 'acrobot', 200, null])
    expect(events('t1').map((e) => e.ref)).toEqual(['assign acrobot osztja ki -> acrobot', 'assign acrobot -> acrobot osztja ki'])
  })

  it('assign after the hand-out is 409 and changes nothing; while paused it goes', async () => {
    existing('t1', 'acrobot')
    ev('t1', 'assigned', 'acrobot')
    const refused = await act('t1', { action: 'assign', assignee: null })
    expect([refused.status, events('t1').length]).toEqual([409, 1])
    // a task handed out and now waiting for review can be paused, then reassigned
    ev('t1', 'review_requested', 'acrobot', NOW() - 40)
    expect((await act('t1', { action: 'pause' })).status).toBe(200)
    const paused = await act('t1', { action: 'assign', assignee: null })
    expect([paused.status, paused.body.task.assignee]).toEqual([200, null])
  })

  it('POST /api/tasks takes a priority too, and refuses an unknown one', async () => {
    const ok = await call(tryHandleTaskUsage, 'POST', '/api/tasks', { id: 'tp', priority: 'high' }, ACRO)
    const bad = await call(tryHandleTaskUsage, 'POST', '/api/tasks', { id: 'tq', priority: 'P0' }, ACRO)
    expect([ok.status, bad.status, bad.body.missing]).toEqual([201, 400, ['priority (low|normal|high|urgent)']])
    expect(allTasks(getDb()).map((t) => [t.id, t.priority])).toEqual([['tp', 'high']])
  })

  it('open-matters: a paused task waits on the owner, whatever its last state', async () => {
    existing('t1')
    ev('t1', 'started', 'murena', NOW() - 60)
    ev('t1', 'review_requested', 'murena', NOW() - 55)
    await act('t1', { action: 'pause' })
    const t = allTasks(getDb()).find((x) => x.id === 't1')!
    expect([t.last_kind, waitsOn(t)]).toEqual(['paused', 'Balazs (szunetel, a folytatas az ove)'])
  })

  it('the agents cannot write the owner\'s kinds through the events route', async () => {
    existing('t1')
    for (const kind of ['paused', 'resumed', 'owner_action'])
      expect((await agentEvent('t1', kind, 'acrobot', ACRO)).status, kind).toBe(403)
    expect(events('t1')).toEqual([])
  })
})

describe('pause and resume: never over running work; while paused no new work starts', () => {
  it('refused while the assignee works: started, fix_started, assigned with its session', async () => {
    for (const [id, kinds, session] of [
      ['w1', ['started'], false], ['w2', ['started', 'review_requested', 'fix_started'], false], ['w3', ['assigned'], true],
    ] as const) {
      existing(id)
      kinds.forEach((k, i) => ev(id, k, k === 'assigned' ? 'acrobot' : 'murena', NOW() - 50 + i))
      if (session) addTaskSession(getDb(), id, 'murena', `s-${id}`, NOW() - 40)
      const r = await act(id, { action: 'pause' })
      expect([r.status, isTaskPaused(getDb(), id)], id).toEqual([409, false])
    }
    expect(count("SELECT count(*) AS n FROM task_events WHERE kind = 'paused'")).toBe(0)
  })

  it('allowed with no event, before the session, waiting for review, after a verdict, blocked', async () => {
    const cases: [string, TaskEventKind[]][] = [['p0', []], ['p1', ['assigned']], ['p2', ['started', 'review_requested']], ['p3', ['started', 'review_requested', 'verdict']], ['p4', ['started', 'blocked']]]
    for (const [id, kinds] of cases) {
      existing(id)
      kinds.forEach((k, i) => ev(id, k, k === 'verdict' ? 'barracuda' : 'murena', NOW() - 50 + i))
      const r = await act(id, { action: 'pause', reason: 'varjon' })
      expect([r.status, r.body.task.paused], id).toEqual([200, true])
    }
    expect((await act('p0', { action: 'pause' })).body.repeated).toBe(true)
  })

  it('while paused: started and fix_started are 409 in every mode; a review is recorded and the pause stays; resume opens it', async () => {
    existing('t1')
    ev('t1', 'assigned', 'acrobot', NOW() - 60)
    await act('t1', { action: 'pause' })
    for (const mode of ['off', 'naplo', 'kenyszerit'] as const) {
      taskCoreSettings.mode = mode
      for (const kind of ['started', 'fix_started'])
        expect((await agentEvent('t1', kind)).status, `${mode} ${kind}`).toBe(409)
    }
    taskCoreSettings.mode = 'naplo'
    // a running review finishes: recorded, and the task is still paused, its assignee not busy
    expect((await agentEvent('t1', 'review_requested')).status).toBe(201)
    expect((await agentEvent('t1', 'verdict', 'barracuda', { kind: 'token', actor: 'barracuda', project: 'acropora' })).status).toBe(201)
    expect([isTaskPaused(getDb(), 't1'), allTasks(getDb()).find((t) => t.id === 't1')?.paused]).toEqual([true, true])
    const r = await act('t1', { action: 'resume' })
    expect([r.status, r.body.task.paused, (await act('t1', { action: 'resume' })).body.repeated]).toEqual([200, false, true])
    expect((await agentEvent('t1', 'started')).status).toBe(201)
    expect(events('t1').map((e) => e.kind)).toEqual(['assigned', 'paused', 'review_requested', 'verdict', 'resumed', 'started'])
  })

  it('a paused task keeps nobody busy, even when its last state was assigned', async () => {
    existing('t1')
    ev('t1', 'assigned', 'acrobot')
    expect(assigneeTasks(getDb(), 'murena').map((t) => t.busy)).toEqual([true])
    await act('t1', { action: 'pause' })
    expect(assigneeTasks(getDb(), 'murena').map((t) => [t.paused, t.busy])).toEqual([[true, false]])
  })

  it('resume on a task never paused is 409; an ended task takes no action', async () => {
    existing('t1')
    expect((await act('t1', { action: 'resume' })).status).toBe(409)
    ev('t1', 'done', 'murena')
    for (const body of [{ action: 'pause' }, { action: 'priority', priority: 'low' }, { action: 'assign', assignee: null }])
      expect((await act('t1', body)).status, body.action).toBe(409)
    expect((await act('nincs', { action: 'pause' })).status).toBe(404)
  })

  it('every action is on the task\'s timeline, by the owner, with a message linked to the task', async () => {
    existing('t1', null)
    await act('t1', { action: 'priority', priority: 'high' })
    await act('t1', { action: 'assign', assignee: 'acrobot' })
    await act('t1', { action: 'pause' })
    await act('t1', { action: 'resume' })
    const tl = taskTimeline(getDb(), 't1')
    expect(tl.filter((i) => i.source === 'event').map((i) => (i as any).kind + ':' + (i as any).actor))
      .toEqual(['owner_action:balazs', 'owner_action:balazs', 'paused:balazs', 'resumed:balazs'])
    expect(tl.filter((i) => i.source === 'message')).toHaveLength(4)
  })
})
