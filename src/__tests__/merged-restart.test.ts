import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_AGENT_ID } from '../config.js'
import { getDb, initDatabase } from '../db.js'
import { afterMergedEvent, decideMergedRestart, liveWork, type MergedRestartInputs } from '../merged-restart.js'
import { ensureTaskHandoffSchema } from '../task-handoff.js'
import { addTaskEvent, upsertTask } from '../task-usage.js'
import { mergedRestart, startedSession, taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

/*
  THE FRESH SESSION AFTER A MERGE, AND THE TWO TASK-RECORD RULES (Balázs, Token thread
  2026-10-24 18:04 UTC, via acrobot 35964): a merged task's author with no other open task
  is restarted fresh when the task has a handoff, told about otherwise; a running session
  is never cut (the 2026-10-13 rule); a new task names its verification profile; an agent's
  own `started` binds its session.
*/

const IDLE: NonNullable<MergedRestartInputs['live']> = {
  paneState: 'idle',
  hasChildProcesses: false,
  msSinceTranscriptWrite: 10 * 60_000,
  pendingOutboundCount: 0,
  hasOpenQuestion: false,
  hardGuardPhase: 'idle',
}
const base: MergedRestartInputs = { agent: 'nautilus', isMainAgent: false, otherOpenTasks: [], hasHandoff: true, live: IDLE }

describe('the decision', () => {
  it('MR-DECIDE: restart only when merged, alone, with a handoff, and idle', () => {
    expect(decideMergedRestart(base).action).toBe('restart')
    expect(decideMergedRestart({ ...base, agent: null }).action).toBe('skip')
    expect(decideMergedRestart({ ...base, isMainAgent: true }).action).toBe('skip')
    expect(decideMergedRestart({ ...base, otherOpenTasks: ['t2'] })).toEqual({ action: 'skip', reason: 'other open task: t2' })
    expect(decideMergedRestart({ ...base, hasHandoff: false })).toMatchObject({ action: 'notify', agent: 'nautilus' })
    expect(decideMergedRestart({ ...base, live: { ...IDLE, paneState: 'busy' } })).toMatchObject({ action: 'notify' })
  })

  it('MR-LIVE: every live-work signal holds, and an unmeasurable one holds too (fail-closed)', () => {
    expect(liveWork(IDLE)).toBeNull()
    for (const live of [
      null,
      { ...IDLE, hardGuardPhase: 'await-handoff' },
      { ...IDLE, paneState: 'typing' as const },
      { ...IDLE, paneState: null },
      { ...IDLE, hasChildProcesses: true },
      { ...IDLE, hasChildProcesses: null },
      { ...IDLE, msSinceTranscriptWrite: null },
      { ...IDLE, msSinceTranscriptWrite: 30_000 },
      { ...IDLE, pendingOutboundCount: 1 },
      { ...IDLE, hasOpenQuestion: true },
    ])
      expect(liveWork(live), JSON.stringify(live)).not.toBeNull()
  })
})

function seed(taskId: string, opts: { handoff: boolean; other?: 'started' | 'review_requested' | 'merged' }) {
  initDatabase(':memory:')
  const db = getDb()
  ensureTaskHandoffSchema(db)
  const now = Math.floor(Date.now() / 1000)
  upsertTask(db, { id: taskId, type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'nautilus', verification_profile: 'code_app' }, now)
  addTaskEvent(db, { task_id: taskId, kind: 'started', actor: 'nautilus', at: now - 60, ref: null, data: null }, now)
  addTaskEvent(db, { task_id: taskId, kind: 'merged', actor: 'acrobot', at: now, ref: null, data: null }, now)
  if (opts.other) {
    upsertTask(db, { id: 'other', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'nautilus', verification_profile: 'code_app' }, now)
    addTaskEvent(db, { task_id: 'other', kind: opts.other, actor: 'nautilus', at: now - 30, ref: null, data: null }, now)
  }
  if (opts.handoff)
    db.prepare("INSERT INTO task_handoffs (task_id, agent, status, record, created_at) VALUES (?, 'nautilus', 'done', '{}', ?)").run(taskId, now)
  return db
}

function deps(db: ReturnType<typeof getDb>) {
  const restarted: string[] = []
  const notes: string[] = []
  return {
    restarted,
    notes,
    deps: {
      db,
      mainAgent: 'acrobot',
      isMainAgent: (n: string) => n === 'acrobot',
      gatherLive: () => IDLE,
      restart: async (n: string) => {
        restarted.push(n)
        return { ok: true }
      },
      notify: (_from: string, to: string, text: string) => void notes.push(`${to}: ${text}`),
    },
  }
}

describe('after a merged event', () => {
  it('MR-RUN: alone with a handoff: restarted fresh, the main agent told where the handoff is', async () => {
    const d = deps(seed('t1', { handoff: true }))
    expect((await afterMergedEvent('t1', d.deps)).action).toBe('restart')
    expect(d.restarted).toEqual(['nautilus'])
    expect(d.notes).toEqual([expect.stringMatching(/^acrobot: nautilus ujrainditva .* handoff-read t1$/)])
  })

  it('MR-RUN-HOLD: another open task (even one waiting for review) keeps the session; no handoff only tells', async () => {
    for (const other of ['started', 'review_requested'] as const) {
      const d = deps(seed('t1', { handoff: true, other }))
      expect((await afterMergedEvent('t1', d.deps)).action, other).toBe('skip')
      expect(d.restarted).toEqual([])
    }
    // an ended task is no open work
    const ended = deps(seed('t1', { handoff: true, other: 'merged' }))
    expect((await afterMergedEvent('t1', ended.deps)).action).toBe('restart')
    const none = deps(seed('t1', { handoff: false }))
    expect((await afterMergedEvent('t1', none.deps)).action).toBe('notify')
    expect(none.restarted).toEqual([])
    expect(none.notes).toEqual(['acrobot: nautilus: a t1 beolvadt, no handoff record: not restarted.'])
  })
})

function fakeCtx(path: string, method: string, body: unknown, actor: string | null): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const raw = JSON.stringify(body)
  const req: any = { headers: {}, on(e: string, h: (arg?: unknown) => void) { if (e === 'data') h(Buffer.from(raw)); if (e === 'end') h(); return req } }
  const url = new URL(`http://localhost:3420${path}`)
  const auth = actor ? { kind: 'token', actor, project: 'acropora' } : undefined
  return { ctx: { req, res, path: url.pathname, method, url, auth } as unknown as RouteContext, out }
}
const post = async (path: string, body: unknown, actor: string | null = 'acrobot') => {
  const { ctx, out } = fakeCtx(path, 'POST', body, actor)
  await tryHandleTaskUsage(ctx)
  return out
}

const saved = { ...taskCoreSettings }
const savedFind = startedSession.find
const savedRestart = { ...mergedRestart }
afterEach(() => {
  Object.assign(taskCoreSettings, saved)
  startedSession.find = savedFind
  Object.assign(mergedRestart, savedRestart)
})

describe('the route', () => {
  it('ROUTE-PROFILE: a new task without a profile is 400; an update without one keeps the stored; off is the old way', async () => {
    initDatabase(':memory:')
    taskCoreSettings.mode = 'naplo'
    const missing = await post('/api/tasks', { id: 'p1', title: 'x' })
    expect([missing.status, String(missing.body.missing)]).toEqual([400, expect.stringMatching(/^verification_profile/)])
    expect((await post('/api/tasks', { id: 'p1', verification_profile: 'docs' })).status).toBe(201)
    expect((await post('/api/tasks', { id: 'p1', title: 'update' })).status).toBe(201)
    taskCoreSettings.mode = 'off'
    expect((await post('/api/tasks', { id: 'p2' })).status).toBe(201)
  })

  it("ROUTE-STARTED: the agent's own started binds its session; the shared token and the main agent do not; a session of another task is marked or refused", async () => {
    initDatabase(':memory:')
    taskCoreSettings.mode = 'naplo'
    startedSession.find = (agent) => `sess-${agent}`
    for (const id of ['s1', 's2', 's3']) await post('/api/tasks', { id, verification_profile: 'docs', assignee: 'murena' })
    const own = await post('/api/tasks/s1/events', { kind: 'started', actor: 'murena' }, 'murena')
    // the shared token names nobody's session, and the main agent's spans every task
    const byShared = await post('/api/tasks/s2/events', { kind: 'started', actor: 'murena' }, null)
    const byMain = await post('/api/tasks/s2/events', { kind: 'started', actor: MAIN_AGENT_ID, idem_key: 'main-0001' }, MAIN_AGENT_ID)
    const sessions = () => getDb().prepare('SELECT task_id, agent, session_id FROM task_sessions ORDER BY task_id').all()
    expect([own.status, own.body.would_reject, byShared.status, byMain.status, byMain.body.would_reject, sessions()]).toEqual([
      201, undefined, 201, 201, undefined, [{ task_id: 's1', agent: 'murena', session_id: 'sess-murena' }],
    ])
    // the same session for a second task: naplo marks it, kenyszerit refuses
    const marked = await post('/api/tasks/s3/events', { kind: 'started', actor: 'murena' }, 'murena')
    expect([marked.status, marked.body.would_reject, String(marked.body.reason)]).toEqual([201, true, expect.stringMatching(/already belongs to task s1/)])
    taskCoreSettings.mode = 'kenyszerit'
    const refused = await post('/api/tasks/s3/events', { kind: 'started', actor: 'murena', idem_key: 'refused-0001' }, 'murena')
    expect(refused.status).toBe(409)
    startedSession.find = () => null
    const noSession = await post('/api/tasks/s2/events', { kind: 'started', actor: 'murena' }, 'murena')
    expect([noSession.status, String(noSession.body.reason)]).toEqual([409, expect.stringMatching(/no readable session/)])
  })

  it('ROUTE-MERGED: a merged event reaches the restart only when the server turned it on', async () => {
    initDatabase(':memory:')
    ensureTaskHandoffSchema(getDb())
    await post('/api/tasks', { id: 'm1', verification_profile: 'docs', assignee: 'nautilus' })
    const d = deps(getDb())
    mergedRestart.deps = () => d.deps
    mergedRestart.enabled = false
    await post('/api/tasks/m1/events', { kind: 'merged', actor: 'acrobot' })
    expect(d.notes).toEqual([])
    mergedRestart.enabled = true
    await post('/api/tasks/m1/events', { kind: 'merged', actor: 'acrobot', idem_key: 'merged-0002' })
    await new Promise((r) => setTimeout(r, 0))
    // no handoff on m1: told, not restarted
    expect([d.restarted, d.notes.length]).toEqual([[], 1])
  })
})
