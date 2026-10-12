// Per-task token measurement (acrovelIQ token brief, item 1). WHAT TURNS THIS RED:
//   - the M1 window (#1657, murena, 07:03-07:18 UTC) does not give its 43 calls
//     and their cache read, or takes a call from the window's edge or another agent;
//   - a call in two tasks' windows is assigned to either, or the tasks still read
//     as valid;
//   - a registered session's calls are not the task's whole, or a window claims
//     another task's session, or one session goes to two tasks;
//   - work, fix, review, admin and repeated work are not told apart by the events;
//   - a kanban move by someone other than the card's assignee opens a window;
//   - the variants are not side by side;
//   - the route accepts an unknown event kind or an event of an unknown task.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  addTaskEvent,
  addTaskSession,
  ensureTaskUsageSchema,
  taskUsage,
  taskUsageWithVariants,
  upsertTask,
  type TaskEventKind,
} from '../task-usage.js'
import { getDb, initDatabase } from '../db.js'
import { eventTime, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

const T = (hhmmss: string) => Math.floor(Date.parse(`2026-10-12T${hhmmss}Z`) / 1000)
const NOW = T('23:00:00')

let db: Database.Database
let usageId = 0

function schema(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, assignee TEXT);
    CREATE TABLE kanban_card_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, from_status TEXT,
      to_status TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL
    );
  `)
  ensureTaskUsageSchema(d)
  return d
}

function call(agent: string, at: number, cacheRead = 1000, session = `${agent}-s1`): void {
  usageId++
  db.prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, 10, 20, ?, 5)`,
  ).run(agent, session, at, cacheRead)
}

const task = (id: string, extra: Partial<{ parent_task: string; variant: string; brief_ref: string }> = {}, created = 1) =>
  upsertTask(db, { id, type: null, parent_task: extra.parent_task ?? null, variant: extra.variant ?? null, brief_ref: extra.brief_ref ?? null }, created)
const event = (task_id: string, kind: TaskEventKind, actor: string, at: number) =>
  addTaskEvent(db, { task_id, kind, actor, at, ref: null }, at)

beforeEach(() => {
  db = schema()
  usageId = 0
})

describe('the M1 window (#1657)', () => {
  it('TASK-USAGE-M1: 43 calls and their cache read, nothing from the edges or another agent', () => {
    task('1657')
    event('1657', 'started', 'murena', T('07:03:00'))
    event('1657', 'review_requested', 'murena', T('07:18:00'))
    // 43 calls inside, the cache read of the manual measurement (7.99 M)
    for (let i = 0; i < 43; i++) call('murena', T('07:03:00') + i * 20, i === 0 ? 7_990_000 : 0)
    call('murena', T('07:02:59'), 999) // before the window
    call('murena', T('07:18:00'), 999) // the window's end is exclusive
    call('barracuda', T('07:10:00'), 999) // another agent
    const u = taskUsage(db, '1657', NOW)!
    expect([u.valid, u.totals.calls, u.totals.cache_read, u.by_capacity.work.calls, u.by_mode.window], 'TASK-USAGE-M1').toEqual([
      true, 43, 7_990_000, 43, 43,
    ])
  })
})

describe('overlapping windows', () => {
  it('TASK-USAGE-OVERLAP: a call in two tasks\' windows goes to neither, and both are invalid', () => {
    task('a')
    task('b')
    event('a', 'started', 'murena', T('08:00:00'))
    event('a', 'done', 'murena', T('09:00:00'))
    event('b', 'started', 'murena', T('08:30:00'))
    event('b', 'done', 'murena', T('09:30:00'))
    call('murena', T('08:10:00')) // a only
    call('murena', T('08:40:00')) // a and b
    call('murena', T('09:10:00')) // b only
    const a = taskUsage(db, 'a', NOW)!
    const b = taskUsage(db, 'b', NOW)!
    expect([
      a.valid, a.totals.calls, a.overlaps.map((o) => o.tasks),
      b.valid, b.totals.calls, b.overlaps.length,
    ], 'TASK-USAGE-OVERLAP').toEqual([false, 1, [['a', 'b']], false, 1, 1])
  })
})

describe('back-to-back windows', () => {
  it('TASK-USAGE-EDGE: a call at the moment one task ends and the next starts is the next one\'s, not an overlap', () => {
    task('c')
    task('d')
    event('c', 'started', 'murena', T('10:00:00'))
    event('c', 'done', 'murena', T('11:00:00'))
    event('d', 'started', 'murena', T('11:00:00'))
    event('d', 'done', 'murena', T('12:00:00'))
    call('murena', T('11:00:00'))
    const c = taskUsage(db, 'c', NOW)!
    const d = taskUsage(db, 'd', NOW)!
    expect([c.valid, c.totals.calls, d.valid, d.totals.calls], 'TASK-USAGE-EDGE').toEqual([true, 0, true, 1])
  })
})

describe('overlapping admin and review windows (acrobot 28588)', () => {
  it('TASK-USAGE-UNASSIGNED: an admin or review call in two tasks\' windows stays unassigned, and the tasks stay valid', () => {
    task('p')
    task('q')
    event('p', 'assigned', 'acrobot', T('08:00:00'))
    event('q', 'assigned', 'acrobot', T('08:05:00'))
    event('p', 'started', 'murena', T('08:10:00'))
    event('p', 'review_requested', 'murena', T('09:00:00'))
    event('q', 'started', 'nautilus', T('08:10:00'))
    event('q', 'review_requested', 'nautilus', T('09:05:00'))
    event('p', 'verdict', 'barracuda', T('09:40:00'))
    event('q', 'verdict', 'barracuda', T('09:45:00'))
    call('acrobot', T('08:30:00')) // both admin windows
    call('barracuda', T('09:20:00')) // both review windows
    call('murena', T('08:20:00')) // p's work alone
    const p = taskUsage(db, 'p', NOW)!
    expect([p.valid, p.totals.calls, p.unassigned.admin.calls, p.unassigned.review.calls, p.overlaps.length],
      'TASK-USAGE-UNASSIGNED').toEqual([true, 1, 1, 1, 0])
  })
})

describe('a session of its own (V3)', () => {
  it('TASK-USAGE-SESSION: the whole session is the task\'s, a window does not take it, one session one task', () => {
    task('v3')
    task('other')
    expect(addTaskSession(db, 'v3', 'murena', 'sess-v3', 1)).toEqual({ ok: true })
    expect(addTaskSession(db, 'other', 'murena', 'sess-v3', 1)).toEqual({ ok: false, owner: 'v3' })
    // another task's window runs over the session's calls
    event('other', 'started', 'murena', T('10:00:00'))
    event('other', 'done', 'murena', T('12:00:00'))
    call('murena', T('10:30:00'), 1000, 'sess-v3')
    call('murena', T('13:00:00'), 1000, 'sess-v3') // outside every window
    call('murena', T('10:40:00'), 1000, 'sess-x') // the other task's own call
    const v3 = taskUsage(db, 'v3', NOW)!
    const other = taskUsage(db, 'other', NOW)!
    expect([v3.totals.calls, v3.by_mode.session, v3.valid, other.totals.calls, other.valid], 'TASK-USAGE-SESSION').toEqual([
      2, 2, true, 1, true,
    ])
  })
})

describe('capacity kinds', () => {
  it('TASK-USAGE-CAPACITY: work before the fix, fix after, review, admin, and a repeated brief', () => {
    task('t1', { brief_ref: 'exchange/brief-x.md' }, 1)
    event('t1', 'assigned', 'acrobot', T('08:00:00'))
    event('t1', 'started', 'murena', T('08:01:00'))
    event('t1', 'review_requested', 'murena', T('09:00:00'))
    event('t1', 'verdict', 'barracuda', T('09:30:00'))
    event('t1', 'fix_started', 'murena', T('09:40:00'))
    event('t1', 'done', 'murena', T('10:00:00'))
    event('t1', 'merged', 'acrobot', T('10:10:00'))
    call('acrobot', T('08:00:30'))
    call('murena', T('08:30:00'))
    call('murena', T('08:31:00'))
    call('barracuda', T('09:10:00'))
    call('murena', T('09:50:00'))
    call('murena', T('09:20:00')) // between review_requested and fix_started: no window of murena's
    const u = taskUsage(db, 't1', NOW)!
    const n = (k: keyof typeof u.by_capacity) => u.by_capacity[k].calls
    // the same brief again, later: its work is repeated work
    task('t2', { brief_ref: 'exchange/brief-x.md' }, 2)
    event('t2', 'started', 'nautilus', T('11:00:00'))
    event('t2', 'done', 'nautilus', T('12:00:00'))
    call('nautilus', T('11:30:00'))
    const again = taskUsage(db, 't2', NOW)!
    expect([n('work'), n('fix'), n('review'), n('admin'), n('repeat'), u.totals.calls, u.repeated_of,
      again.by_capacity.repeat.calls, again.repeated_of, u.duration_seconds], 'TASK-USAGE-CAPACITY').toEqual([
      2, 1, 1, 1, 0, 5, null, 1, 't1', T('10:10:00') - T('08:00:00'),
    ])
  })
})

describe('the kanban card\'s moves', () => {
  it('TASK-USAGE-KANBAN: the assignee\'s own move opens a window, someone else\'s does not', () => {
    task('card-1')
    task('card-2')
    db.prepare('INSERT INTO kanban_cards (id, assignee) VALUES (?, ?), (?, ?)').run('card-1', 'murena', 'card-2', 'murena')
    const move = (card: string, to: string, actor: string, at: number) =>
      db.prepare('INSERT INTO kanban_card_events (card_id, to_status, actor, created_at) VALUES (?, ?, ?, ?)').run(card, to, actor, at * 1000)
    move('card-1', 'in_progress', 'murena', T('14:00:00'))
    move('card-1', 'done', 'murena', T('15:00:00'))
    move('card-2', 'in_progress', 'acrobot', T('16:00:00'))
    call('murena', T('14:30:00'))
    call('acrobot', T('16:30:00'))
    call('murena', T('16:30:00'))
    expect([taskUsage(db, 'card-1', NOW)!.totals.calls, taskUsage(db, 'card-2', NOW)!.totals.calls], 'TASK-USAGE-KANBAN').toEqual([1, 0])
  })
})

describe('the task\'s end by someone else', () => {
  it('TASK-USAGE-CLOSE: acrobot\'s merge closes murena\'s window, so her next task is not an overlap', () => {
    task('m1')
    task('m2')
    event('m1', 'started', 'murena', T('08:00:00'))
    event('m1', 'merged', 'acrobot', T('09:00:00'))
    event('m2', 'started', 'murena', T('09:30:00'))
    call('murena', T('08:30:00'))
    call('murena', T('09:45:00'))
    const m1 = taskUsage(db, 'm1', NOW)!
    const m2 = taskUsage(db, 'm2', NOW)!
    expect([m1.valid, m1.totals.calls, m2.valid, m2.totals.calls], 'TASK-USAGE-CLOSE').toEqual([true, 1, true, 1])
  })
})

describe('variants', () => {
  it('TASK-USAGE-VARIANT-BRIEF: three variants of one brief are each work, not repeated work', () => {
    task('exp', { brief_ref: 'exchange/m1-brief.md' }, 1)
    for (const [i, v] of ['V1', 'V2', 'V3'].entries()) {
      task(`exp-${v}`, { parent_task: 'exp', variant: v, brief_ref: 'exchange/m1-brief.md' }, 2 + i)
      event(`exp-${v}`, 'started', 'murena', T(`0${i + 1}:00:00`))
      event(`exp-${v}`, 'done', 'murena', T(`0${i + 1}:30:00`))
      call('murena', T(`0${i + 1}:10:00`))
    }
    const r = taskUsageWithVariants(db, 'exp', NOW)!
    expect(r.variants.map((v) => [v.task.variant, v.by_capacity.work.calls, v.by_capacity.repeat.calls, v.repeated_of]),
      'TASK-USAGE-VARIANT-BRIEF').toEqual([['V1', 1, 0, null], ['V2', 1, 0, null], ['V3', 1, 0, null]])
  })

  it('TASK-USAGE-VARIANTS: the experiment\'s variants side by side, each by its own session', () => {
    task('m1-proba')
    for (const v of ['V1', 'V2', 'V3']) {
      task(`m1-${v}`, { parent_task: 'm1-proba', variant: v })
      addTaskSession(db, `m1-${v}`, 'murena', `sess-${v}`, 1)
    }
    call('murena', T('01:00:00'), 100, 'sess-V1')
    call('murena', T('02:00:00'), 200, 'sess-V2')
    call('murena', T('02:01:00'), 200, 'sess-V2')
    call('murena', T('03:00:00'), 300, 'sess-V3')
    const r = taskUsageWithVariants(db, 'm1-proba', NOW)!
    expect(r.variants.map((v) => [v.task.variant, v.totals.calls, v.totals.cache_read]), 'TASK-USAGE-VARIANTS').toEqual([
      ['V1', 1, 100], ['V2', 2, 400], ['V3', 1, 300],
    ])
  })
})

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(e: string, handler: (arg?: unknown) => void) {
      if (e === 'data' && raw) handler(Buffer.from(raw))
      if (e === 'end') handler()
      return req
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('the route', () => {
  it('TASK-USAGE-ROUTE: refuses an unknown kind and an unknown task, stores an event, reads the usage', async () => {
    initDatabase(':memory:')
    const id = 'route-' + Date.now()
    const send = async (path: string, method: string, body?: unknown) => {
      const { ctx, out } = fakeCtx(path, method, body)
      await tryHandleTaskUsage(ctx)
      return out
    }
    const unknown = await send(`/api/tasks/${id}/events`, 'POST', { kind: 'started', actor: 'murena' })
    const created = await send('/api/tasks', 'POST', { id })
    const badKind = await send(`/api/tasks/${id}/events`, 'POST', { kind: 'begun', actor: '' })
    const ok = await send(`/api/tasks/${id}/events`, 'POST', { kind: 'started', actor: 'murena', at: '1760252580' })
    const usage = await send(`/api/tasks/${id}/usage`, 'GET')
    const stored = getDb().prepare('SELECT at FROM task_events WHERE task_id = ?').get(id) as { at: number }
    expect([unknown.status, created.status, badKind.status, badKind.body.missing.length, ok.status, usage.status,
      usage.body.task.project, stored.at], 'TASK-USAGE-ROUTE').toEqual([404, 201, 400, 2, 201, 200, 'acropora', 1760252580])
  })

  it('event times: seconds, a digit string, ISO, or now; anything else refused', () => {
    expect([eventTime(undefined, 5), eventTime(1760252580, 5), eventTime('1760252580', 5),
      eventTime('2026-10-12T07:03:00Z', 5), eventTime('tegnap', 5), eventTime(-3, 5)]).toEqual([
      5, 1760252580, 1760252580, T('07:03:00'), null, null,
    ])
  })
})
