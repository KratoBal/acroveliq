// Per-task token measurement (acrovelIQ token brief, item 1), and the task
// record of TC-Lite L1. WHAT TURNS THIS RED:
//   - the M1 window (#1657, murena, 07:03-07:18 UTC) does not give its 43 calls
//     and their cache read, or takes a call from the window's edge or another agent;
//   - a call in two tasks' windows is assigned to either, or the tasks still read
//     as valid;
//   - a registered session's calls are not the task's whole, or a window claims
//     another task's session, or one session goes to two tasks;
//   - work, fix, review, admin and repeated work are not told apart by the events;
//   - a kanban move by someone other than the card's assignee opens a window;
//   - the variants are not side by side;
//   - the route accepts an unknown event kind or an event of an unknown task;
//   - L1: the rebuild of an old task_events loses or changes a row, an id or the
//     AUTOINCREMENT counter, leaves foreign_keys changed, or does anything on a
//     second run; a new closing kind is refused;
//   - L1: a repeated key gives a second row, or two different keys (two fix
//     rounds) or two keyless events give one;
//   - L1: a `done` without the evidence its profile asks for is accepted
//     unmarked (naplo) or accepted at all (kenyszerit); a merge sha that is not
//     on main, or that belongs to another PR, passes;
//   - L1: a task's verification profile can be replaced (code_app -> docs) and
//     its `done` then skips the re-measure (barracuda, #46);
//   - L1: the timeline is out of order, or an agent stays busy after it asked
//     for review;
//   - the AcrovelIQ list (acroveliq-vp-v1): a task is missing, its last event is
//     not the latest one (same second: the higher id), it is out of newest-first
//     order, or a misspelt filter answers with the whole list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  addTaskEvent,
  addTaskSession,
  allTasks,
  assigneeTasks,
  doneGuard,
  ensureTaskUsageSchema,
  loadTaskEvents,
  parseTaskCoreMode,
  taskTimeline,
  taskUsage,
  taskUsageWithVariants,
  upsertTask,
  type MergeProbe,
  type TaskEventKind,
} from '../task-usage.js'
import { ensureTaskHandoffSchema } from '../task-handoff.js'
import { getDb, initDatabase } from '../db.js'
import { eventTime, taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
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

function fakeCtx(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    headers,
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

// ---------------------------------------------------------------------------
// TC-Lite L1
// ---------------------------------------------------------------------------

const OLD_TASK_EVENTS = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project TEXT NOT NULL DEFAULT 'acropora', type TEXT, parent_task TEXT,
    variant TEXT, brief_ref TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('assigned','started','review_requested','verdict','fix_started','done','merged')),
    actor TEXT NOT NULL,
    at INTEGER NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_task_events_task ON task_events(task_id, at);
`

describe('TC-Lite L1: the schema', () => {
  it('TCL-REBUILD: an old task_events keeps every row, id and the counter; a new kind fits; the second run does nothing', () => {
    const d = new Database(':memory:')
    d.pragma('foreign_keys = ON')
    d.exec(OLD_TASK_EVENTS)
    const ins = d.prepare('INSERT INTO task_events (task_id, kind, actor, at, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('t1', 'started', 'murena', 100, null, 100)
    ins.run('t1', 'started', 'murena', 100, null, 100) // the live duplicate `started`
    ins.run('t1', 'review_requested', 'murena', 200, 'PR #5', 200)
    ins.run('t2', 'assigned', 'acrobot', 50, null, 50)
    ins.run('t2', 'done', 'acrobot', 60, null, 60)
    d.exec('DELETE FROM task_events WHERE id = 5') // the counter now stands above the highest id
    const rows = () => d.prepare('SELECT id, task_id, kind, actor, at, ref, created_at FROM task_events ORDER BY id').all()
    const seq = () => (d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'task_events'").get() as { seq: number }).seq
    const before = rows()

    ensureTaskUsageSchema(d)
    const after = rows()
    const seqAfter = seq()
    const fk = d.pragma('foreign_keys', { simple: true })
    const indexes = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_events' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    const keys = d.prepare('SELECT count(*) AS n FROM task_events WHERE idem_key IS NULL AND data IS NULL').get() as { n: number }
    const newKind = addTaskEvent(d, { task_id: 't1', kind: 'blocked', actor: 'murena', at: 300, ref: null }, 300)
    const taskColumns = (d.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)

    const schemaBefore = d.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
    ensureTaskUsageSchema(d)
    const schemaAgain = d.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()

    expect([after, seqAfter, fk, indexes, keys.n, newKind, rows().length,
      ['title', 'goal', 'acceptance', 'assignee', 'reviewer', 'authorization_ref', 'verification_profile', 'kanban_card_id', 'updated_at'].every((c) => taskColumns.includes(c)),
      schemaAgain], 'TCL-REBUILD').toEqual([
      before, 5, 1, ['idx_task_events_idem', 'idx_task_events_task'], 4,
      // the new row takes 6, not 5: the counter survived the rebuild
      { id: 6, created: true }, 5, true, schemaBefore,
    ])
  })

  it('a fresh database gets the new shape directly, and the task fields keep what a later write leaves out', () => {
    task('t')
    upsertTask(db, { id: 't', type: null, parent_task: null, variant: null, brief_ref: null, title: 'Cím', verification_profile: 'code_fleet' }, 2)
    upsertTask(db, { id: 't', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'murena' }, 3)
    expect(db.prepare('SELECT title, verification_profile, assignee, updated_at FROM tasks WHERE id = ?').get('t')).toEqual({
      title: 'Cím', verification_profile: 'code_fleet', assignee: 'murena', updated_at: 3,
    })
  })
})

describe('TC-Lite L1: idempotency', () => {
  it('TCL-IDEM: one key one row; two keys two rows, even when the events are byte-identical; no key, no deduplication', () => {
    task('t')
    const started = { task_id: 't', kind: 'started' as const, actor: 'murena', at: 100, ref: null }
    const first = addTaskEvent(db, { ...started, idem_key: 'kulcs-0001' }, 100)
    const again = addTaskEvent(db, { ...started, idem_key: 'kulcs-0001' }, 101)
    const other = addTaskEvent(db, { ...started, kind: 'done', idem_key: 'kulcs-0001' }, 102)
    // a second fix round is the same bytes as the first (barracuda, review 1)
    const fix = { task_id: 't', kind: 'fix_started' as const, actor: 'murena', at: 200, ref: 'PR #5', data: { round: 'x' } }
    addTaskEvent(db, { ...fix, idem_key: 'fix-kor-1' }, 200)
    addTaskEvent(db, { ...fix, idem_key: 'fix-kor-2' }, 200)
    addTaskEvent(db, { ...started, at: 300 }, 300)
    addTaskEvent(db, { ...started, at: 300 }, 300)
    const count = (kind: string) => (db.prepare('SELECT count(*) AS n FROM task_events WHERE kind = ?').get(kind) as { n: number }).n
    expect([first, again, other, count('fix_started'), count('started'), count('done')], 'TCL-IDEM').toEqual([
      { id: 1, created: true }, { id: 1, created: false, same: true }, { id: 1, created: false, same: false }, 2, 3, 0,
    ])
  })

  it('TCL-IDEM-ROUTE: the header or the field; a repeat is 200 with the old id, a different event on the same key 409', async () => {
    initDatabase(':memory:')
    const id = 'idem-' + Date.now()
    const send = async (body: unknown, headers: Record<string, string> = {}) => {
      const { ctx, out } = fakeCtx(`/api/tasks/${id}/events`, 'POST', body, headers)
      await tryHandleTaskUsage(ctx)
      return out
    }
    const make = fakeCtx('/api/tasks', 'POST', { id })
    await tryHandleTaskUsage(make.ctx)
    const a = await send({ kind: 'started', actor: 'murena' }, { 'idempotency-key': 'futas-0001' })
    const b = await send({ kind: 'started', actor: 'murena' }, { 'idempotency-key': 'futas-0001' })
    const c = await send({ kind: 'started', actor: 'murena', idem_key: 'futas-0001' })
    const d = await send({ kind: 'review_requested', actor: 'murena' }, { 'idempotency-key': 'futas-0001' })
    const e = await send({ kind: 'started', actor: 'murena', idem_key: 'rovid' })
    const f = await send({ kind: 'started', actor: 'murena', data: [1, 2] })
    const rows = getDb().prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get(id) as { n: number }
    expect([a.status, b.status, b.body.id === a.body.id, c.status, d.status, e.status, f.status, rows.n], 'TCL-IDEM-ROUTE').toEqual([
      201, 200, true, 200, 409, 400, 400, 1,
    ])
  })
})

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function fakeProbe(prs: Record<number, { merged: boolean; mergeCommitSha: string | null } | null | undefined>, main: string[] | undefined): MergeProbe {
  return {
    pullRequest: async (_repo, pr) => prs[pr],
    onMain: async (_repo, sha) => (main === undefined ? undefined : main.includes(sha)),
  }
}

describe('TC-Lite L1: the done guard', () => {
  const saved = { ...taskCoreSettings }
  afterEach(() => Object.assign(taskCoreSettings, saved))

  /** A task with a profile and, when given, a `merged` event; then a `done`. */
  async function done(mode: 'off' | 'naplo' | 'kenyszerit', profile: string | null, merged: Record<string, unknown> | null, probe = fakeProbe({}, [])) {
    initDatabase(':memory:')
    taskCoreSettings.mode = mode
    taskCoreSettings.probe = () => probe
    const id = `done-${Math.random().toString(36).slice(2)}`
    const post = async (path: string, body: unknown) => {
      const { ctx, out } = fakeCtx(path, 'POST', body)
      await tryHandleTaskUsage(ctx)
      return out
    }
    await post('/api/tasks', { id, ...(profile ? { verification_profile: profile } : {}) })
    if (merged) await post(`/api/tasks/${id}/events`, { kind: 'merged', actor: 'acrobot', data: merged })
    const out = await post(`/api/tasks/${id}/events`, { kind: 'done', actor: 'acrobot' })
    const stored = getDb().prepare("SELECT data FROM task_events WHERE task_id = ? AND kind = 'done'").get(id) as { data: string | null } | undefined
    return { status: out.status, wouldReject: out.body?.would_reject === true, reason: String(out.body?.reason ?? ''), stored: stored ? JSON.parse(stored.data ?? 'null') : 'nincs sor' }
  }
  const claim = (pr: number, sha: string) => ({ repo: 'KratoBal/marveen', pr, merge_sha: sha })

  it('TCL-DONE-MODES: code profile without merged: naplo marks, kenyszerit refuses, off is the old behaviour; docs passes', async () => {
    const naplo = await done('naplo', 'code_app', null)
    const enforce = await done('kenyszerit', 'code_app', null)
    const off = await done('off', 'code_app', null)
    const docs = await done('kenyszerit', 'docs', null)
    const noProfile = await done('kenyszerit', null, null)
    expect([naplo.status, naplo.wouldReject, naplo.stored?.would_reject, enforce.status, enforce.stored,
      off.status, off.wouldReject, off.stored, docs.status, docs.wouldReject, noProfile.status], 'TCL-DONE-MODES').toEqual([
      201, true, true, 409, 'nincs sor', 201, false, null, 201, false, 409,
    ])
  })

  it('TCL-DONE-VERIFY: a sha not on main, and a real on-main sha of ANOTHER PR, are both refused; the right one passes', async () => {
    // PR 41 merged as SHA_A; SHA_B is real and on main, but it is PR 40's merge
    const prs = { 41: { merged: true, mergeCommitSha: SHA_A }, 40: { merged: true, mergeCommitSha: SHA_B } }
    const notOnMain = await done('kenyszerit', 'code_fleet', claim(41, SHA_A), fakeProbe(prs, [SHA_B]))
    const otherPr = await done('kenyszerit', 'code_fleet', claim(41, SHA_B), fakeProbe(prs, [SHA_A, SHA_B]))
    const right = await done('kenyszerit', 'code_fleet', claim(41, SHA_A), fakeProbe(prs, [SHA_A, SHA_B]))
    const unmerged = await done('kenyszerit', 'code_fleet', claim(41, SHA_A), fakeProbe({ 41: { merged: false, mergeCommitSha: null } }, [SHA_A]))
    const badData = await done('kenyszerit', 'code_fleet', { repo: 'KratoBal/marveen', pr: 41 }, fakeProbe(prs, [SHA_A]))
    expect([notOnMain.status, /nincs a KratoBal\/marveen fő ágán/.test(notOnMain.reason), otherPr.status, /nem ennek a PR-nek/.test(otherPr.reason),
      right.status, right.wouldReject, unmerged.status, badData.status, /merge_sha/.test(badData.reason)], 'TCL-DONE-VERIFY').toEqual([
      409, true, 409, true, 201, false, 409, 409, true,
    ])
  })

  it('TCL-PROFILE-FIXED: a written profile cannot be swapped for docs before the done; the guard still measures', async () => {
    initDatabase(':memory:')
    taskCoreSettings.mode = 'kenyszerit'
    taskCoreSettings.probe = () => fakeProbe({}, [])
    const id = `profil-${Math.random().toString(36).slice(2)}`
    const post = async (path: string, body: unknown) => {
      const { ctx, out } = fakeCtx(path, 'POST', body)
      await tryHandleTaskUsage(ctx)
      return out
    }
    await post('/api/tasks', { id, verification_profile: 'code_app' })
    const swap = await post('/api/tasks', { id, verification_profile: 'docs' })
    const same = await post('/api/tasks', { id, verification_profile: 'code_app', title: 'Cím' })
    const omitted = await post('/api/tasks', { id, assignee: 'murena' })
    // the function itself keeps it too, whoever calls it
    upsertTask(getDb(), { id, type: null, parent_task: null, variant: null, brief_ref: null, verification_profile: 'docs' }, 9)
    const profile = (getDb().prepare('SELECT verification_profile FROM tasks WHERE id = ?').get(id) as { verification_profile: string }).verification_profile
    const finish = await post(`/api/tasks/${id}/events`, { kind: 'done', actor: 'murena' })
    expect([swap.status, same.status, omitted.status, profile, finish.status], 'TCL-PROFILE-FIXED').toEqual([409, 201, 201, 'code_app', 409])
  })

  it('TCL-DONE-UNMEASURABLE: GitHub out of reach: kenyszerit 409 "nem mérhető", naplo accepts and marks', async () => {
    const unreachable = fakeProbe({ 41: undefined }, undefined)
    const enforce = await done('kenyszerit', 'migration', claim(41, SHA_A), unreachable)
    const naplo = await done('naplo', 'migration', claim(41, SHA_A), unreachable)
    expect([enforce.status, /^nem mérhető/.test(enforce.reason), naplo.status, naplo.wouldReject, /^nem mérhető/.test(naplo.stored?.would_reject_reason)], 'TCL-DONE-UNMEASURABLE').toEqual([
      409, true, 201, true, true,
    ])
  })

  it('the setting: empty is naplo, the three words are themselves, anything else the strictest, loudly', () => {
    expect(['', 'off', 'NAPLO', 'kenyszerit', 'ki'].map((v) => parseTaskCoreMode(v))).toEqual([
      { mode: 'naplo', problem: null }, { mode: 'off', problem: null }, { mode: 'naplo', problem: null },
      { mode: 'kenyszerit', problem: null }, { mode: 'kenyszerit', problem: expect.stringContaining('the strictest') },
    ])
  })

  it('doneGuard reads the LATEST merged event', () => {
    task('t')
    event('t', 'merged', 'acrobot', 10)
    addTaskEvent(db, { task_id: 't', kind: 'merged', actor: 'acrobot', at: 20, ref: null, data: claim(7, SHA_A) }, 20)
    expect(doneGuard(loadTaskEvents(db, 't'), 'code_app')).toEqual({ need: 'verify', claim: claim(7, SHA_A) })
  })
})

describe('TC-Lite L1: the timeline and busy', () => {
  it('TCL-TIMELINE: events, handoffs and sessions in time order; same second: session, event, handoff', () => {
    ensureTaskHandoffSchema(db)
    upsertTask(db, { id: 't', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'murena' }, 1)
    event('t', 'review_requested', 'murena', 200)
    db.prepare(
      "INSERT INTO task_handoffs (task_id, agent, status, record, created_at) VALUES ('t', 'murena', 'in_progress', ?, 150)",
    ).run(JSON.stringify({ next_step: 'teszt' }))
    event('t', 'started', 'murena', 100)
    addTaskSession(db, 't', 'murena', 'sess-1', 100)
    event('t', 'assigned', 'acrobot', 50)
    db.prepare(
      "INSERT INTO task_handoffs (task_id, agent, status, record, created_at) VALUES ('t', 'murena', 'done', '{}', 100)",
    ).run()
    const items = taskTimeline(db, 't').map((i) => `${i.at}:${i.source}:${'kind' in i ? i.kind : 'status' in i ? i.status : i.session_id}`)
    expect(items, 'TCL-TIMELINE').toEqual([
      '50:event:assigned', '100:session:sess-1', '100:event:started', '100:handoff:done', '150:handoff:in_progress', '200:event:review_requested',
    ])
  })

  it('TCL-BUSY: assigned and started keep an agent busy, review_requested frees it, fix_started takes it again', () => {
    upsertTask(db, { id: 'a', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'murena' }, 1)
    upsertTask(db, { id: 'b', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'murena' }, 2)
    upsertTask(db, { id: 'c', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'nautilus' }, 3)
    event('a', 'started', 'murena', 10)
    event('b', 'assigned', 'acrobot', 10)
    event('c', 'started', 'nautilus', 10)
    const busy = () => assigneeTasks(db, 'murena').filter((t) => t.busy).map((t) => t.id)
    const atStart = busy()
    event('a', 'review_requested', 'murena', 20)
    const afterReview = busy()
    event('a', 'fix_started', 'murena', 30)
    expect([atStart, afterReview, busy()], 'TCL-BUSY').toEqual([['a', 'b'], ['b'], ['a', 'b']])
  })

  it('TASK-LIST: every task with its latest event, newest activity first; an event-less task by its creation', () => {
    upsertTask(db, { id: 'regi', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'murena', title: 'Régi' }, 1)
    upsertTask(db, { id: 'uj', type: null, parent_task: null, variant: null, brief_ref: null, assignee: 'nautilus', reviewer: 'barracuda' }, 2)
    upsertTask(db, { id: 'ures', type: null, parent_task: null, variant: null, brief_ref: null }, 25)
    event('regi', 'started', 'murena', 10)
    event('regi', 'review_requested', 'murena', 20)
    event('uj', 'started', 'nautilus', 30)
    // same second as the start: the later row is the last event
    event('uj', 'blocked', 'nautilus', 30)
    const list = allTasks(db).map((t) => [t.id, t.last_kind, t.last_actor, t.busy, t.events, t.assignee])
    expect(list, 'TASK-LIST').toEqual([
      ['uj', 'blocked', 'nautilus', false, 2, 'nautilus'],
      ['ures', null, null, false, 0, null],
      ['regi', 'review_requested', 'murena', false, 2, 'murena'],
    ])
  })

  it('TASK-LIST-ROUTE: the bare GET is the list; a misspelt filter or busy without assignee is 400, never the list', async () => {
    initDatabase(':memory:')
    const id = 'lista-' + Date.now()
    const call = async (path: string, method: string, body?: unknown) => {
      const { ctx, out } = fakeCtx(path, method, body)
      await tryHandleTaskUsage(ctx)
      return out
    }
    await call('/api/tasks', 'POST', { id, assignee: 'murena', title: 'Lista' })
    await call(`/api/tasks/${id}/events`, 'POST', { kind: 'started', actor: 'murena' })
    const list = await call('/api/tasks', 'GET')
    const typo = await call('/api/tasks?agent=murena', 'GET')
    const busyOnly = await call('/api/tasks?busy=1', 'GET')
    const emptyAssignee = await call('/api/tasks?assignee=', 'GET')
    const row = list.body.find((t: { id: string }) => t.id === id)
    expect([list.status, row && [row.title, row.last_kind, row.busy], typo.status, typo.body.unknown, busyOnly.status, emptyAssignee.status],
      'TASK-LIST-ROUTE').toEqual([200, ['Lista', 'started', true], 400, ['agent'], 400, 400])
  })

  it('the two reads on the route: ?assignee&busy=1 and the timeline; an unknown task is 404', async () => {
    initDatabase(':memory:')
    const id = 'tl-' + Date.now()
    const call = async (path: string, method: string, body?: unknown) => {
      const { ctx, out } = fakeCtx(path, method, body)
      const handled = await tryHandleTaskUsage(ctx)
      return { handled, ...out }
    }
    await call('/api/tasks', 'POST', { id, assignee: 'polip-' + id, title: 'Cím', acceptance: ['zöld kapu'] })
    await call(`/api/tasks/${id}/events`, 'POST', { kind: 'started', actor: 'polip' })
    const busy = await call(`/api/tasks?assignee=polip-${id}&busy=1`, 'GET')
    const timeline = await call(`/api/tasks/${id}/timeline`, 'GET')
    const unknown = await call('/api/tasks/nincs-ilyen/timeline', 'GET')
    const noAssignee = await call('/api/tasks?busy=1', 'GET')
    const badProfile = await call('/api/tasks', 'POST', { id, verification_profile: 'kod' })
    const acceptance = getDb().prepare('SELECT acceptance FROM tasks WHERE id = ?').get(id) as { acceptance: string }
    expect([busy.status, busy.body.map((t: { id: string }) => t.id), timeline.status, timeline.body.items.length, unknown.status,
      noAssignee.status, badProfile.status, JSON.parse(acceptance.acceptance), timeline.body.fields]).toEqual([
      200, [id], 200, 1, 404, 400, 400, ['zöld kapu'],
      { title: 'Cím', goal: null, assignee: 'polip-' + id, reviewer: null, authorization_ref: null, verification_profile: null },
    ])
  })
})

/*
  THE COORDINATION WINDOW (koord-munkamenet, acrobot msg 29883). What turns these red:
  the channel session's calls between its coord_open and coord_close not assigned to the
  task while a dozen other tasks' admin windows are open for the same agent (the reason
  they were unattributable before); a call outside the marks assigned; the concurrent
  other tasks not counted or not named; a call in TWO tasks' coord windows assigned.
*/
describe('the coord window', () => {
  it('TASK-USAGE-COORD: the marked span is the task\'s, the concurrent other tasks are said, the rest is not taken', () => {
    task('masik'); event('masik', 'assigned', 'acrobot', T('08:00:00'))   // a broad admin window, open all day
    task('koord'); event('koord', 'assigned', 'acrobot', T('08:30:00'))
    event('koord', 'coord_open', 'acrobot', T('09:00:00'))
    event('koord', 'coord_close', 'acrobot', T('09:10:00'))
    call('acrobot', T('08:59:59'), 7)     // before the open: in two tasks' admin windows, not taken
    call('acrobot', T('09:00:00'), 100)   // in the window
    call('acrobot', T('09:05:00'), 200)   // in the window
    call('acrobot', T('09:10:00'), 9)     // the close is exclusive
    call('murena', T('09:05:00'), 5)      // another agent
    const u = taskUsage(db, 'koord', NOW)!
    expect([u.by_capacity.coord.calls, u.by_capacity.coord.cache_read], 'TASK-USAGE-COORD').toEqual([2, 300])
    expect(u.coordination.concurrent.calls).toBe(2)
    expect(u.coordination.concurrent_tasks).toEqual(['masik'])
    expect(u.unassigned.admin.calls).toBe(2)   // 08:59:59 and 09:10:00, in both admin windows
    expect(u.valid).toBe(true)
  })

  it('a second open by the same actor reopens after a close; without any other window nothing is concurrent', () => {
    task('k2')
    event('k2', 'coord_open', 'acrobot', T('10:00:00')); event('k2', 'coord_close', 'acrobot', T('10:05:00'))
    event('k2', 'coord_open', 'acrobot', T('11:00:00')); event('k2', 'coord_close', 'acrobot', T('11:05:00'))
    call('acrobot', T('10:01:00')); call('acrobot', T('10:30:00')); call('acrobot', T('11:01:00'))
    const u = taskUsage(db, 'k2', NOW)!
    expect(u.by_capacity.coord.calls).toBe(2)
    expect(u.coordination.concurrent.calls).toBe(0)
    expect(u.coordination.concurrent_tasks).toEqual([])
  })

  it('two tasks\' coord windows at once: the call is not guessed, it stays unassigned', () => {
    task('ka'); task('kb')
    event('ka', 'coord_open', 'acrobot', T('12:00:00'))
    event('kb', 'coord_open', 'acrobot', T('12:01:00'))
    call('acrobot', T('12:02:00'))
    const a = taskUsage(db, 'ka', NOW)!
    expect([a.by_capacity.coord.calls, a.unassigned.admin.calls]).toEqual([0, 1])
  })

  it('the same call, asked from the OTHER task with a work window open: not an overlap, not that task\'s', () => {
    task('fejl'); event('fejl', 'started', 'acrobot', T('14:00:00'))
    task('k4'); event('k4', 'coord_open', 'acrobot', T('14:10:00')); event('k4', 'coord_close', 'acrobot', T('14:20:00'))
    call('acrobot', T('14:05:00'), 1); call('acrobot', T('14:15:00'), 2)
    const f = taskUsage(db, 'fejl', NOW)!
    expect([f.valid, f.overlaps.length, f.by_capacity.work.calls, f.by_capacity.work.cache_read]).toEqual([true, 0, 1, 1])
    const k = taskUsage(db, 'k4', NOW)!
    expect([k.by_capacity.coord.calls, k.coordination.concurrent_tasks]).toEqual([1, ['fejl']])
  })

  it('done closes an open coord window', () => {
    task('k3')
    event('k3', 'coord_open', 'acrobot', T('13:00:00'))
    event('k3', 'done', 'acrobot', T('13:10:00'))
    call('acrobot', T('13:05:00')); call('acrobot', T('13:20:00'))
    expect(taskUsage(db, 'k3', NOW)!.by_capacity.coord.calls).toBe(1)
  })
})

describe('a live task_events table without the coord kinds', () => {
  it('TASK-EVENTS-REBUILD-COORD: is rebuilt in place, rows kept, and then takes coord_open', () => {
    const d = new Database(':memory:')
    const old = ['assigned', 'started', 'review_requested', 'verdict', 'fix_started', 'done', 'merged', 'blocked', 'cancelled', 'failed', 'partial']
    d.exec(`CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (${old.map((k) => `'${k}'`).join(',')})), actor TEXT NOT NULL, at INTEGER NOT NULL,
      ref TEXT, created_at INTEGER NOT NULL, data TEXT, idem_key TEXT)`)
    d.prepare("INSERT INTO task_events (task_id, kind, actor, at, created_at) VALUES ('t', 'started', 'murena', 1, 1)").run()
    expect(() => d.prepare("INSERT INTO task_events (task_id, kind, actor, at, created_at) VALUES ('t', 'coord_open', 'acrobot', 2, 2)").run()).toThrow()
    ensureTaskUsageSchema(d)
    d.prepare("INSERT INTO task_events (task_id, kind, actor, at, created_at) VALUES ('t', 'coord_open', 'acrobot', 2, 2)").run()
    expect((d.prepare('SELECT kind FROM task_events ORDER BY id').all() as { kind: string }[]).map((r) => r.kind), 'TASK-EVENTS-REBUILD-COORD').toEqual(['started', 'coord_open'])
  })
})
