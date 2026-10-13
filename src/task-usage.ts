// Per-task token measurement (acrovelIQ token brief, item 1, 2026-10-12).
//
// A task's full resource use (input, output, cache read, cache write, call
// count, duration) can be asked for by task, project, agent and session, and by
// capacity kind: work, review, fix, administration, repeated work.
//
// THE PRINCIPLE: nothing is classified when a call is recorded. A call is a
// `token_usage` row as the collector wrote it; which task it belongs to and
// what kind of capacity it was is DERIVED here, at query time, from the task's
// events. A wrong rule can be fixed later and every past task recomputes.
// That is why the call-to-task assignment (the plan's `hivas_feladat`) is a
// function, not a table.
//
// THE ASSIGNMENT, in this order:
//   1. by session: a session registered to a task (`task_sessions`, the V3
//      case) belongs to that task, whole;
//   2. by time window: an agent's call that falls in exactly one task's window
//      for that agent. A call that falls in the windows of TWO OR MORE tasks
//      is not guessed: it is assigned to none. A WORK call there makes every
//      such task not valid; an admin or review call stays unassigned, named
//      on its own line, and the task stays valid (acrobot 28588).
//
// THE WINDOWS come from the events (`task_events`, plus the kanban card's own
// moves when the task id is a card id):
//   - work:   from the actor's `started` or `fix_started` to its own next
//             `review_requested`, or the task's `done` or `merged` by anyone;
//   - review: from a `review_requested` to the `verdict` that answers it, for
//             the verdict's actor;
//   - admin:  from the actor's `assigned` to the task's `merged` or `done`;
//   - coord:  from the actor's `coord_open` to its own `coord_close` (or the task's
//             `done`/`merged`). The channel session marks the hand-out and the
//             take-over of a coordination unit this way (koord-munkamenet, acrobot
//             msg 29883). A registered SESSION would claim the whole long channel
//             session, so the mark is a window, not a session.
// An opened window with no close runs to the query time.
//
// A coord window is EXPLICIT, like a registered session: a call in it belongs to its
// task even when another task's admin, review or work window is open for the same
// agent, because the broad admin windows (assigned -> done) of a dozen tasks are open
// all the time. What cannot be separated is only SAID: those calls are counted again
// as `coordination.concurrent`, with the other tasks named (the channel session may
// have done other work in the window). Two tasks' coord windows at once: unassigned.

import type Database from 'better-sqlite3'

export const DEFAULT_PROJECT = 'acropora'

export const TASK_EVENT_KINDS = [
  'assigned',
  'started',
  'review_requested',
  'verdict',
  'fix_started',
  'done',
  'merged',
  // TC-Lite L1: a task can end without `done`
  'blocked',
  'cancelled',
  'failed',
  'partial',
  // koord-munkamenet: the channel session's start and end mark of a coordination unit
  'coord_open',
  'coord_close',
] as const
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number]

/** How a task's `done` is verified (TC-Lite L1). */
export const VERIFICATION_PROFILES = ['docs', 'code_fleet', 'code_app', 'migration', 'prod_data_write', 'ops'] as const
export type VerificationProfile = (typeof VERIFICATION_PROFILES)[number]
/** The profiles whose `done` needs a merged, re-measured PR. */
export const CODE_PROFILES: ReadonlySet<string> = new Set(['code_fleet', 'code_app', 'migration'])

/** The task fields added by TC-Lite L1, in the order of the schema. */
const TASK_FIELDS = [
  'title',
  'goal',
  'acceptance',
  'assignee',
  'reviewer',
  'authorization_ref',
  'verification_profile',
  'kanban_card_id',
] as const
type TaskField = (typeof TASK_FIELDS)[number]

const taskEventsTable = (name: string) => `
  CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${TASK_EVENT_KINDS.map((k) => `'${k}'`).join(',')})),
    actor TEXT NOT NULL,
    at INTEGER NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL,
    data TEXT,
    idem_key TEXT
  )`

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/**
 * A CHECK constraint cannot be altered in SQLite: a table whose `kind` list
 * lacks a kind is rebuilt, in one transaction, keeping every row and id and
 * the AUTOINCREMENT counter. Nothing happens when the list is already whole.
 * Returns whether it rebuilt.
 */
export function rebuildTaskEventsIfNeeded(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_events'")
    .get() as { sql: string } | undefined
  if (!row || TASK_EVENT_KINDS.every((k) => row.sql.includes(`'${k}'`))) return false
  const keep = columns(db, 'task_events').filter((c) =>
    ['id', 'task_id', 'kind', 'actor', 'at', 'ref', 'created_at', 'data', 'idem_key'].includes(c),
  )
  const list = keep.join(', ')
  // foreign_keys cannot change inside a transaction; nothing references this
  // table, but the setting is put back as it was either way
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number
  if (foreignKeys) db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      const seq = (
        db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'task_events'").get() as { seq: number } | undefined
      )?.seq
      db.exec(taskEventsTable('task_events__rebuild'))
      db.exec(`INSERT INTO task_events__rebuild (${list}) SELECT ${list} FROM task_events`)
      db.exec('DROP TABLE task_events')
      db.exec('ALTER TABLE task_events__rebuild RENAME TO task_events')
      // the copy sets the counter to the highest id; a deleted last row had a higher one
      if (seq !== undefined)
        db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'task_events'").run(seq)
    })()
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON')
  }
  return true
}

export const CAPACITY_KINDS = ['work', 'review', 'fix', 'admin', 'repeat', 'coord'] as const
export type CapacityKind = (typeof CAPACITY_KINDS)[number]

export function ensureTaskUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}',
      type TEXT,
      parent_task TEXT,
      variant TEXT,
      brief_ref TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  // TC-Lite L1: added, never rebuilt; the old code reads none of them
  const taskColumns = columns(db, 'tasks')
  for (const field of [...TASK_FIELDS, 'updated_at'])
    if (!taskColumns.includes(field))
      db.exec(`ALTER TABLE tasks ADD COLUMN ${field} ${field === 'updated_at' ? 'INTEGER' : 'TEXT'}`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)`)
  if (!rebuildTaskEventsIfNeeded(db)) db.exec(taskEventsTable('IF NOT EXISTS task_events'))
  const eventColumns = columns(db, 'task_events')
  for (const field of ['data', 'idem_key'])
    if (!eventColumns.includes(field)) db.exec(`ALTER TABLE task_events ADD COLUMN ${field} TEXT`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, at)`)
  // a NULL key never collides with another NULL: an event without a key is not deduplicated
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_idem ON task_events(idem_key)`)
  // a session belongs to one task at most: the primary key says so
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_sessions (
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id)
    )
  `)
}

export interface TaskRow {
  id: string
  project: string
  type: string | null
  parent_task: string | null
  variant: string | null
  brief_ref: string | null
  created_at: number
  title?: string | null
  goal?: string | null
  /** JSON text. */
  acceptance?: string | null
  assignee?: string | null
  reviewer?: string | null
  authorization_ref?: string | null
  verification_profile?: string | null
  kanban_card_id?: string | null
  updated_at?: number | null
}

export interface TaskEvent {
  task_id: string
  kind: TaskEventKind
  actor: string
  /** Seconds, like `token_usage.timestamp`. */
  at: number
  ref: string | null
}

export type TaskInput = Pick<TaskRow, 'id' | 'type' | 'parent_task' | 'variant' | 'brief_ref'> & {
  project?: string
} & Partial<Record<TaskField, string | null>>

/**
 * A task, created or updated. The original fields are written as given (an
 * update without them clears them, as before L1); an L1 field left out keeps
 * its stored value, so a later partial write does not erase a title. The
 * verification profile is written once and never replaced here: a `code_app`
 * task turned `docs` before its `done` would skip the GitHub re-measure.
 */
export function upsertTask(db: Database.Database, task: TaskInput, now: number): void {
  const fields = Object.fromEntries(TASK_FIELDS.map((f) => [f, task[f] ?? null]))
  db.prepare(
    `INSERT INTO tasks (id, project, type, parent_task, variant, brief_ref, created_at, updated_at,
                        ${TASK_FIELDS.join(', ')})
     VALUES (@id, @project, @type, @parent_task, @variant, @brief_ref, @now, @now,
             ${TASK_FIELDS.map((f) => `@${f}`).join(', ')})
     ON CONFLICT(id) DO UPDATE SET
       project = excluded.project, type = excluded.type, parent_task = excluded.parent_task,
       variant = excluded.variant, brief_ref = excluded.brief_ref, updated_at = excluded.updated_at,
       ${TASK_FIELDS.map((f) =>
         // the profile decides what `done` must prove: once written it stays (barracuda, #46)
         f === 'verification_profile' ? `${f} = coalesce(tasks.${f}, excluded.${f})` : `${f} = coalesce(excluded.${f}, tasks.${f})`,
       ).join(', ')}`,
  ).run({
    id: task.id,
    type: task.type,
    parent_task: task.parent_task,
    variant: task.variant,
    brief_ref: task.brief_ref,
    ...fields,
    project: task.project?.trim() || DEFAULT_PROJECT,
    now,
  })
}

export interface NewTaskEvent extends TaskEvent {
  /** Stored as JSON text. */
  data?: Record<string, unknown> | null
  /** The CALLER's key (barracuda, review 1): without one, no deduplication. */
  idem_key?: string | null
}

export type AddedEvent =
  | { id: number; created: true }
  /** The key was used before: the earlier event, and whether it is the same event. */
  | { id: number; created: false; same: boolean }

export function addTaskEvent(db: Database.Database, event: NewTaskEvent, now: number): AddedEvent {
  const key = event.idem_key ?? null
  const result = db
    .prepare(
      `INSERT INTO task_events (task_id, kind, actor, at, ref, created_at, data, idem_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idem_key) DO NOTHING`,
    )
    .run(event.task_id, event.kind, event.actor, event.at, event.ref, now,
      event.data == null ? null : JSON.stringify(event.data), key)
  if (result.changes === 1) return { id: Number(result.lastInsertRowid), created: true }
  const earlier = db
    .prepare('SELECT id, task_id, kind, actor FROM task_events WHERE idem_key = ?')
    .get(key) as { id: number; task_id: string; kind: string; actor: string }
  return {
    id: earlier.id,
    created: false,
    same: earlier.task_id === event.task_id && earlier.kind === event.kind && earlier.actor === event.actor,
  }
}

/** A session to a task. A session already registered to ANOTHER task is refused. */
export function addTaskSession(
  db: Database.Database,
  taskId: string,
  agent: string,
  sessionId: string,
  now: number,
): { ok: true } | { ok: false; owner: string } {
  const owner = db
    .prepare('SELECT task_id FROM task_sessions WHERE agent = ? AND session_id = ?')
    .get(agent, sessionId) as { task_id: string } | undefined
  if (owner && owner.task_id !== taskId) return { ok: false, owner: owner.task_id }
  db.prepare(
    'INSERT OR IGNORE INTO task_sessions (agent, session_id, task_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(agent, sessionId, taskId, now)
  return { ok: true }
}

/** The kanban card's moves as task events: in_progress is `started`, done is `done`. */
const KANBAN_KIND: Partial<Record<string, TaskEventKind>> = {
  in_progress: 'started',
  done: 'done',
}

/** Every event of every task, its own and its kanban card's, ordered by time. */
export function loadEvents(db: Database.Database): TaskEvent[] {
  const own = db
    .prepare('SELECT task_id, kind, actor, at, ref FROM task_events')
    .all() as TaskEvent[]
  const hasKanban = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'kanban_card_events'")
    .get() as { n: number }
  const kanban = hasKanban.n
    ? (db
        .prepare(
          // only the card's own assignee moving it opens a window: acrobot moving
          // murena's card says nothing about whose calls are the task's
          `SELECT e.card_id, e.to_status, e.actor, e.created_at, e.id FROM kanban_card_events e
           JOIN tasks t ON t.id = e.card_id
           JOIN kanban_cards c ON c.id = e.card_id AND c.assignee = e.actor`,
        )
        .all() as { card_id: string; to_status: string; actor: string | null; created_at: number; id: number }[])
    : []
  const fromKanban = kanban.flatMap((row) => {
    const kind = KANBAN_KIND[row.to_status]
    // a move without an actor opens no window: whose calls would it claim?
    if (!kind || !row.actor) return []
    return [{
      task_id: row.card_id,
      kind,
      actor: row.actor,
      // kanban_card_events.created_at is in milliseconds
      at: Math.floor(row.created_at / 1000),
      ref: `kanban_card_events:${row.id}`,
    }]
  })
  return [...own, ...fromKanban].sort((a, b) => a.at - b.at)
}

export type WindowRole = 'work' | 'review' | 'admin' | 'coord'

export interface TaskWindow {
  task_id: string
  agent: string
  role: WindowRole
  from: number
  /** Exclusive; null while still open. */
  to: number | null
}

const WORK_OPEN: ReadonlySet<TaskEventKind> = new Set(['started', 'fix_started'])
const WORK_CLOSE: ReadonlySet<TaskEventKind> = new Set(['review_requested', 'done', 'merged'])

/** The windows of one task's events (already in time order). */
export function taskWindows(events: readonly TaskEvent[]): TaskWindow[] {
  const windows: TaskWindow[] = []
  const openWork = new Map<string, TaskWindow>()
  const openAdmin = new Map<string, TaskWindow>()
  const openCoord = new Map<string, TaskWindow>()
  let lastReviewRequest: number | null = null
  for (const event of events) {
    const { task_id, actor, at, kind } = event
    if (WORK_OPEN.has(kind) && !openWork.has(actor)) {
      const window: TaskWindow = { task_id, agent: actor, role: 'work', from: at, to: null }
      openWork.set(actor, window)
      windows.push(window)
    } else if (WORK_CLOSE.has(kind) && openWork.has(actor)) {
      openWork.get(actor)!.to = at
      openWork.delete(actor)
    }
    if (kind === 'review_requested') lastReviewRequest = at
    if (kind === 'verdict' && lastReviewRequest !== null) {
      windows.push({ task_id, agent: actor, role: 'review', from: lastReviewRequest, to: at })
      lastReviewRequest = null
    }
    if (kind === 'coord_open' && !openCoord.has(actor)) {
      const window: TaskWindow = { task_id, agent: actor, role: 'coord', from: at, to: null }
      openCoord.set(actor, window)
      windows.push(window)
    } else if (kind === 'coord_close' && openCoord.has(actor)) {
      openCoord.get(actor)!.to = at
      openCoord.delete(actor)
    }
    if (kind === 'assigned' && !openAdmin.has(actor)) {
      const window: TaskWindow = { task_id, agent: actor, role: 'admin', from: at, to: null }
      openAdmin.set(actor, window)
      windows.push(window)
    }
    // the task's end closes every open window, whoever writes it: acrobot
    // usually merges, and a worker who wrote no close of its own would keep
    // its window open into its next task (barracuda, #18)
    if (kind === 'merged' || kind === 'done') {
      for (const window of [...openAdmin.values(), ...openWork.values(), ...openCoord.values()]) window.to ??= at
      openAdmin.clear()
      openWork.clear()
      openCoord.clear()
    }
  }
  return windows
}

export interface UsageCall {
  id: number
  agent: string
  session_id: string
  /** Seconds. */
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

export interface CallAssignment {
  call: UsageCall
  mode: 'session' | 'window'
  role: WindowRole
}

export interface Overlap {
  call_id: number
  agent: string
  timestamp: number
  tasks: string[]
}

const inWindow = (w: TaskWindow, t: number, now: number) => t >= w.from && t < (w.to ?? now + 1)

/**
 * THE ASSIGNMENT OF ONE TASK'S CALLS. `calls` are the candidate calls (the
 * agents and the time span the task's windows touch); `windows` are EVERY
 * task's windows, so a call in two tasks' windows is seen as an overlap.
 */
export function assignCalls(input: {
  taskId: string
  calls: readonly UsageCall[]
  windows: readonly TaskWindow[]
  /** `agent|session` -> task id, every registered session. */
  sessions: ReadonlyMap<string, string>
  now: number
}): {
  assigned: CallAssignment[]
  overlaps: Overlap[]
  unassigned: { call: UsageCall; role: 'admin' | 'review' }[]
  /** Coord calls of this task made while another task's window was open too. */
  concurrent: { call: UsageCall; tasks: string[] }[]
} {
  const assigned: CallAssignment[] = []
  const overlaps: Overlap[] = []
  const unassigned: { call: UsageCall; role: 'admin' | 'review' }[] = []
  const concurrent: { call: UsageCall; tasks: string[] }[] = []
  for (const call of input.calls) {
    const sessionOwner = input.sessions.get(`${call.agent}|${call.session_id}`)
    const hits = input.windows.filter((w) => w.agent === call.agent && inWindow(w, call.timestamp, input.now))
    const own = hits.filter((w) => w.task_id === input.taskId)
    if (sessionOwner !== undefined) {
      // a registered session is explicit: it is its task's, and no window argues
      if (sessionOwner === input.taskId)
        assigned.push({ call, mode: 'session', role: own[0]?.role ?? 'work' })
      continue
    }
    if (own.length === 0) continue
    // A coord window decides the call for EVERY task, not only for its own: queried from
    // another task with a work window open at the same time, the call is the coord
    // task's, not an overlap that would make that other task invalid.
    const coordTasks = new Set(hits.filter((w) => w.role === 'coord').map((w) => w.task_id))
    if (coordTasks.size > 1) { unassigned.push({ call, role: 'admin' }); continue }
    if (coordTasks.size === 1) {
      if (!coordTasks.has(input.taskId)) continue
      assigned.push({ call, mode: 'window', role: 'coord' })
      const others = [...new Set(hits.filter((w) => w.task_id !== input.taskId).map((w) => w.task_id))].sort()
      if (others.length) concurrent.push({ call, tasks: others })
      continue
    }
    // two windows of the same task (work and review by one agent): review wins
    const role = own.some((w) => w.role === 'review')
      ? 'review'
      : own.some((w) => w.role === 'work')
        ? 'work'
        : 'admin'
    const tasks = [...new Set(hits.map((w) => w.task_id))]
    if (tasks.length > 1) {
      /*
        INVALID BY CAPACITY KIND, NOT BY TASK (acrobot 28588). A developer works
        on one task at a time: a work call in two tasks' windows is a real
        fault, and the task is not valid. Admin and review windows overlap as a
        matter of course (seven tasks handed out at once, reviews queued); such
        a call is not shared out and not guessed, it stays UNASSIGNED, and the
        task names it on its own line.
      */
      if (role === 'work' || hits.some((w) => w.role === 'work'))
        overlaps.push({ call_id: call.id, agent: call.agent, timestamp: call.timestamp, tasks: tasks.sort() })
      else unassigned.push({ call, role })
      continue
    }
    assigned.push({ call, mode: 'window', role })
  }
  return { assigned, overlaps, unassigned, concurrent }
}

export interface TokenTotals {
  calls: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  first_call: number | null
  last_call: number | null
}

const emptyTotals = (): TokenTotals => ({
  calls: 0,
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  first_call: null,
  last_call: null,
})

function add(totals: TokenTotals, call: UsageCall): void {
  totals.calls++
  totals.input += call.input_tokens
  totals.output += call.output_tokens
  totals.cache_read += call.cache_read_tokens
  totals.cache_write += call.cache_creation_tokens
  totals.first_call = totals.first_call === null ? call.timestamp : Math.min(totals.first_call, call.timestamp)
  totals.last_call = totals.last_call === null ? call.timestamp : Math.max(totals.last_call, call.timestamp)
}

/**
 * THE CAPACITY KIND OF AN ASSIGNED CALL: review and admin by their window;
 * a worker's call is `fix` after the task's first `fix_started`, else `work`;
 * work and fix of a task that repeats an earlier task's brief are `repeat`.
 */
export function capacityKind(
  assignment: CallAssignment,
  firstFixStart: number | null,
  repeated: boolean,
): CapacityKind {
  if (assignment.role === 'review') return 'review'
  if (assignment.role === 'admin') return 'admin'
  if (assignment.role === 'coord') return 'coord'
  if (repeated) return 'repeat'
  return firstFixStart !== null && assignment.call.timestamp >= firstFixStart ? 'fix' : 'work'
}

export interface TaskUsage {
  task: TaskRow
  /** False when a WORK call fell in another task's window too. */
  valid: boolean
  overlaps: Overlap[]
  /**
   * Admin and review calls in overlapping windows: not shared out between
   * the tasks, and not making the task invalid (acrobot 28588).
   */
  unassigned: Record<'admin' | 'review', TokenTotals>
  /**
   * The channel session's coord windows (coord_open -> coord_close): their calls are in
   * `by_capacity.coord`; `concurrent` counts those of them made while another task's
   * window was open too, and `concurrent_tasks` names those tasks. Not separable, only said.
   */
  coordination: { concurrent: TokenTotals; concurrent_tasks: string[] }
  totals: TokenTotals
  by_capacity: Record<CapacityKind, TokenTotals>
  by_agent: Record<string, TokenTotals>
  by_session: Record<string, TokenTotals>
  by_mode: Record<'session' | 'window', number>
  /** First event to last event, seconds; null without two events. */
  duration_seconds: number | null
  repeated_of: string | null
}

/** One task's usage. `now` closes the still-open windows. */
export function taskUsage(db: Database.Database, taskId: string, now: number): TaskUsage | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
  if (!task) return null
  const events = loadEvents(db)
  const byTask = new Map<string, TaskEvent[]>()
  for (const event of events) byTask.set(event.task_id, [...(byTask.get(event.task_id) ?? []), event])
  const windows = [...byTask.values()].flatMap(taskWindows)
  const own = windows.filter((w) => w.task_id === taskId)
  const sessionRows = db.prepare('SELECT agent, session_id, task_id FROM task_sessions').all() as {
    agent: string
    session_id: string
    task_id: string
  }[]
  const sessions = new Map(sessionRows.map((r) => [`${r.agent}|${r.session_id}`, r.task_id]))
  const ownSessions = sessionRows.filter((r) => r.task_id === taskId)

  // the candidate calls: the task's sessions, and its agents inside its windows
  const calls = new Map<number, UsageCall>()
  const select = `SELECT id, agent, session_id, timestamp, input_tokens, output_tokens,
                         cache_read_tokens, cache_creation_tokens FROM token_usage`
  for (const s of ownSessions)
    for (const row of db.prepare(`${select} WHERE agent = ? AND session_id = ?`).all(s.agent, s.session_id) as UsageCall[])
      calls.set(row.id, row)
  for (const w of own)
    for (const row of db
      .prepare(`${select} WHERE agent = ? AND timestamp >= ? AND timestamp < ?`)
      .all(w.agent, w.from, w.to ?? now + 1) as UsageCall[])
      calls.set(row.id, row)

  const { assigned, overlaps, unassigned, concurrent } = assignCalls({
    taskId,
    calls: [...calls.values()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
    windows,
    sessions,
    now,
  })
  const ownEvents = byTask.get(taskId) ?? []
  const firstFixStart = ownEvents.find((e) => e.kind === 'fix_started')?.at ?? null
  // an experiment's variants share their brief on purpose: neither the parent
  // nor a sibling makes a variant repeated work (barracuda, #18)
  const repeatedOf = task.brief_ref
    ? ((db
        .prepare(
          `SELECT id FROM tasks
           WHERE brief_ref = @brief AND created_at < @created
             AND id <> coalesce(@parent, '')
             AND (@parent IS NULL OR parent_task IS NULL OR parent_task <> @parent)
           ORDER BY created_at LIMIT 1`,
        )
        .get({ brief: task.brief_ref, created: task.created_at, parent: task.parent_task }) as
        | { id: string }
        | undefined)?.id ?? null)
    : null

  const totals = emptyTotals()
  const byCapacity = Object.fromEntries(CAPACITY_KINDS.map((k) => [k, emptyTotals()])) as Record<CapacityKind, TokenTotals>
  const byAgent: Record<string, TokenTotals> = {}
  const bySession: Record<string, TokenTotals> = {}
  const byMode = { session: 0, window: 0 }
  for (const a of assigned) {
    add(totals, a.call)
    add(byCapacity[capacityKind(a, firstFixStart, repeatedOf !== null)], a.call)
    add((byAgent[a.call.agent] ??= emptyTotals()), a.call)
    add((bySession[a.call.session_id] ??= emptyTotals()), a.call)
    byMode[a.mode]++
  }
  const unassignedTotals = { admin: emptyTotals(), review: emptyTotals() }
  for (const u of unassigned) add(unassignedTotals[u.role], u.call)
  const concurrentTotals = emptyTotals()
  for (const c of concurrent) add(concurrentTotals, c.call)
  return {
    task,
    valid: overlaps.length === 0,
    overlaps,
    unassigned: unassignedTotals,
    coordination: { concurrent: concurrentTotals, concurrent_tasks: [...new Set(concurrent.flatMap((c) => c.tasks))].sort() },
    totals,
    by_capacity: byCapacity,
    by_agent: byAgent,
    by_session: bySession,
    by_mode: byMode,
    duration_seconds:
      ownEvents.length >= 2 ? ownEvents[ownEvents.length - 1]!.at - ownEvents[0]!.at : null,
    repeated_of: repeatedOf,
  }
}

/** The task and its variants (the tasks whose parent it is), side by side. */
export function taskUsageWithVariants(
  db: Database.Database,
  taskId: string,
  now: number,
): { task: TaskUsage; variants: TaskUsage[] } | null {
  const task = taskUsage(db, taskId, now)
  if (!task) return null
  const children = db
    .prepare('SELECT id FROM tasks WHERE parent_task = ? ORDER BY variant, id')
    .all(taskId) as { id: string }[]
  return {
    task,
    variants: children.flatMap((c) => {
      const usage = taskUsage(db, c.id, now)
      return usage ? [usage] : []
    }),
  }
}

// ---------------------------------------------------------------------------
// TC-Lite L1: the `done` guard, the busy query and the timeline.
// ---------------------------------------------------------------------------

/** The setting of the `done` guard: off is the behaviour before L1. */
export const TASK_CORE_MODES = ['off', 'naplo', 'kenyszerit'] as const
export type TaskCoreMode = (typeof TASK_CORE_MODES)[number]

/** Like the access setting: empty is `naplo`, an unknown value the strictest. */
export function parseTaskCoreMode(raw: string | undefined): { mode: TaskCoreMode; problem: string | null } {
  const value = raw?.trim().toLowerCase() ?? ''
  if (!value) return { mode: 'naplo', problem: null }
  if ((TASK_CORE_MODES as readonly string[]).includes(value)) return { mode: value as TaskCoreMode, problem: null }
  return {
    mode: 'kenyszerit',
    problem: `TASK_CORE_MODE=${JSON.stringify(value)} is none of ${TASK_CORE_MODES.join(', ')}: enforcing, the strictest`,
  }
}

export interface StoredTaskEvent extends TaskEvent {
  id: number
  data: Record<string, unknown> | null
}

/** One task's own events, in time order (ties by id), with their data. */
export function loadTaskEvents(db: Database.Database, taskId: string): StoredTaskEvent[] {
  const rows = db
    .prepare('SELECT id, task_id, kind, actor, at, ref, data FROM task_events WHERE task_id = ? ORDER BY at, id')
    .all(taskId) as (Omit<StoredTaskEvent, 'data'> & { data: string | null })[]
  return rows.map((row) => {
    let data: Record<string, unknown> | null = null
    try {
      const parsed: unknown = row.data === null ? null : JSON.parse(row.data)
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      data = null
    }
    return { ...row, data }
  })
}

/** What a `merged` event must carry for its merge to be measured. */
export interface MergeClaim {
  repo: string
  pr: number
  merge_sha: string
}

export type DoneCheck =
  /** The profile asks for no evidence. */
  | { need: 'none' }
  /** Evidence is missing or malformed: the reason, in one sentence. */
  | { need: 'missing'; reason: string }
  /** The latest `merged` event's claim, to be re-measured on GitHub. */
  | { need: 'verify'; claim: MergeClaim }

const REPO = /^(?!.*\.\.)[\w.-]+\/[\w.-]+$/

/**
 * THE `done` GUARD, the pure half. A code profile needs an earlier `merged`
 * event, and its data must name the repo, the PR and the merge commit, because
 * the claim is re-measured, never believed: any agent may write a `merged`
 * row (barracuda, review 2). A task without a profile cannot say what it
 * needs, so it is refused as missing, not let through.
 */
export function doneGuard(events: readonly StoredTaskEvent[], profile: string | null | undefined): DoneCheck {
  if (!profile) return { need: 'missing', reason: 'a feladatnak nincs verification_profile mezője, tehát nem mondja meg, mi kell a lezáráshoz' }
  if (!CODE_PROFILES.has(profile)) return { need: 'none' }
  const merged = [...events].reverse().find((e) => e.kind === 'merged')
  if (!merged) return { need: 'missing', reason: `${profile} profilnál a done előtt merged esemény kell` }
  const d = merged.data ?? {}
  const repo = typeof d.repo === 'string' && REPO.test(d.repo) ? d.repo : null
  const pr = typeof d.pr === 'number' && Number.isInteger(d.pr) && d.pr > 0 ? d.pr : typeof d.pr === 'string' && /^\d+$/.test(d.pr) ? Number(d.pr) : null
  const sha = typeof d.merge_sha === 'string' && /^[0-9a-f]{40}$/i.test(d.merge_sha) ? d.merge_sha.toLowerCase() : null
  if (!repo || !pr || !sha)
    return {
      need: 'missing',
      reason: `a merged esemény (${merged.id}) adatából hiányzik: ${[!repo && 'repo (owner/name)', !pr && 'pr', !sha && 'merge_sha (40 jegy)'].filter(Boolean).join(', ')}`,
    }
  return { need: 'verify', claim: { repo, pr, merge_sha: sha } }
}

/**
 * GitHub, as the guard asks it. Each answer is `undefined` when it could not
 * be measured: that is its own outcome, never agreement.
 */
export interface MergeProbe {
  pullRequest(repo: string, pr: number): Promise<{ merged: boolean; mergeCommitSha: string | null } | null | undefined>
  /** Whether the commit is on the main branch (`compare main...sha`: identical or behind). */
  onMain(repo: string, sha: string): Promise<boolean | null | undefined>
}

export type MergeVerdict = { ok: true } | { ok: false; measurable: boolean; reason: string }

/**
 * The claim re-measured, two ways (barracuda, round 2): the PR is merged AND
 * its merge commit is this sha (so a real sha of ANOTHER PR does not pass),
 * and the sha is on main (because `merged: true` alone can lie, which
 * pr-beolvaszt.sh measures too).
 */
export async function verifyMerge(claim: MergeClaim, probe: MergeProbe): Promise<MergeVerdict> {
  const pr = await probe.pullRequest(claim.repo, claim.pr)
  if (pr === undefined) return { ok: false, measurable: false, reason: `a ${claim.repo} #${claim.pr} állapota nem mérhető most` }
  if (pr === null) return { ok: false, measurable: true, reason: `a ${claim.repo} #${claim.pr} PR nem létezik` }
  if (!pr.merged) return { ok: false, measurable: true, reason: `a ${claim.repo} #${claim.pr} nincs beolvasztva` }
  if ((pr.mergeCommitSha ?? '').toLowerCase() !== claim.merge_sha)
    return {
      ok: false,
      measurable: true,
      reason: `a #${claim.pr} beolvasztó commitja ${(pr.mergeCommitSha ?? '-').slice(0, 8)}, az eseményé ${claim.merge_sha.slice(0, 8)}: nem ennek a PR-nek a beolvasztása`,
    }
  const onMain = await probe.onMain(claim.repo, claim.merge_sha)
  if (onMain === undefined) return { ok: false, measurable: false, reason: `a ${claim.merge_sha.slice(0, 8)} fő ági tagsága nem mérhető most` }
  if (!onMain) return { ok: false, measurable: true, reason: `a ${claim.merge_sha.slice(0, 8)} nincs a ${claim.repo} fő ágán` }
  return { ok: true }
}

/** The real probe: GitHub's REST API with the fleet's token, as task-handoff.ts's githubProbe. */
export function githubMergeProbe(token: string | null, fetchImpl: typeof fetch = fetch): MergeProbe {
  const call = async (path: string): Promise<any | null | undefined> => {
    if (!token) return undefined
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 404) return null
      if (!response.ok) return undefined
      return await response.json()
    } catch {
      return undefined
    }
  }
  return {
    async pullRequest(repo, pr) {
      const body = await call(`/repos/${repo}/pulls/${pr}`)
      return body === undefined || body === null
        ? body
        : { merged: body.merged === true, mergeCommitSha: typeof body.merge_commit_sha === 'string' ? body.merge_commit_sha : null }
    },
    async onMain(repo, sha) {
      const body = await call(`/repos/${repo}/compare/main...${sha}`)
      if (body === undefined) return undefined
      // a sha GitHub does not know is not on main
      if (body === null) return false
      return body.status === 'identical' || body.status === 'behind'
    },
  }
}

const BUSY_KINDS: ReadonlySet<string> = new Set(['assigned', 'started', 'fix_started'])

export interface AssigneeTask {
  id: string
  title: string | null
  last_kind: string | null
  last_at: number | null
  busy: boolean
}

/**
 * An agent's tasks, and which of them keep it busy: those whose LAST event is
 * `assigned`, `started` or `fix_started`. After `review_requested` the agent
 * is free for the next task.
 */
export function assigneeTasks(db: Database.Database, agent: string): AssigneeTask[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.title,
              (SELECT kind FROM task_events e WHERE e.task_id = t.id ORDER BY at DESC, id DESC LIMIT 1) AS last_kind,
              (SELECT at FROM task_events e WHERE e.task_id = t.id ORDER BY at DESC, id DESC LIMIT 1) AS last_at
       FROM tasks t WHERE t.assignee = ? ORDER BY t.created_at, t.id`,
    )
    .all(agent) as Omit<AssigneeTask, 'busy'>[]
  return rows.map((r) => ({ ...r, busy: r.last_kind !== null && BUSY_KINDS.has(r.last_kind) }))
}

export const busyTasks = (db: Database.Database, agent: string): AssigneeTask[] =>
  assigneeTasks(db, agent).filter((t) => t.busy)

export interface ListedTask extends AssigneeTask {
  project: string
  goal: string | null
  assignee: string | null
  reviewer: string | null
  verification_profile: string | null
  kanban_card_id: string | null
  created_at: number
  updated_at: number | null
  last_actor: string | null
  last_ref: string | null
  events: number
}

/**
 * Every task, with its last event: the read-only list of the AcrovelIQ page
 * (acroveliq-vp-v1). Newest activity first; a task with no event yet sorts by
 * its creation. `busy` means the same as in assigneeTasks.
 */
export function allTasks(db: Database.Database): ListedTask[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.project, t.title, t.goal, t.assignee, t.reviewer, t.verification_profile, t.kanban_card_id,
              t.created_at, t.updated_at,
              e.kind AS last_kind, e.at AS last_at, e.actor AS last_actor, e.ref AS last_ref,
              (SELECT count(*) FROM task_events c WHERE c.task_id = t.id) AS events
       FROM tasks t
       LEFT JOIN task_events e ON e.id = (
         SELECT id FROM task_events x WHERE x.task_id = t.id ORDER BY at DESC, id DESC LIMIT 1)
       ORDER BY coalesce(e.at, t.created_at) DESC, t.id`,
    )
    .all() as Omit<ListedTask, 'busy'>[]
  return rows.map((r) => ({ ...r, busy: r.last_kind !== null && BUSY_KINDS.has(r.last_kind) }))
}

export type TimelineItem =
  | { at: number; source: 'event'; id: number; kind: string; actor: string; ref: string | null; data: Record<string, unknown> | null }
  | { at: number; source: 'handoff'; id: number; agent: string; status: string; next_step: string | null }
  | { at: number; source: 'session'; agent: string; session_id: string }
  | { at: number; source: 'message'; id: number; from: string; to: string; status: string }

const SOURCE_ORDER = { session: 0, event: 1, handoff: 2, message: 3 } as const

/** agent_messages has task_id since TC-Lite L3; an older database has no such column. */
const messagesHaveTaskId = (db: Database.Database) =>
  tableExists(db, 'agent_messages') &&
  (db.prepare('PRAGMA table_info(agent_messages)').all() as { name: string }[]).some((c) => c.name === 'task_id')

const tableExists = (db: Database.Database, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

/**
 * Everything recorded about a task, in time order: its events, its handoff
 * records, its registered sessions and the messages linked to it (TC-Lite L3:
 * ids, sender, recipient and state; the text stays in the message itself).
 * Same second: a session first (it is registered before its work), then the
 * event, then the handoff written after, then a message about it.
 */
export function taskTimeline(db: Database.Database, taskId: string): TimelineItem[] {
  const items: TimelineItem[] = loadTaskEvents(db, taskId).map((e) => ({
    at: e.at, source: 'event' as const, id: e.id, kind: e.kind, actor: e.actor, ref: e.ref, data: e.data,
  }))
  if (tableExists(db, 'task_handoffs'))
    for (const h of db
      .prepare('SELECT id, agent, status, record, created_at FROM task_handoffs WHERE task_id = ?')
      .all(taskId) as { id: number; agent: string; status: string; record: string; created_at: number }[]) {
      let nextStep: string | null = null
      try {
        const step: unknown = JSON.parse(h.record)?.next_step
        nextStep = typeof step === 'string' ? step : null
      } catch {
        nextStep = null
      }
      items.push({ at: h.created_at, source: 'handoff', id: h.id, agent: h.agent, status: h.status, next_step: nextStep })
    }
  for (const s of db
    .prepare('SELECT agent, session_id, created_at FROM task_sessions WHERE task_id = ?')
    .all(taskId) as { agent: string; session_id: string; created_at: number }[])
    items.push({ at: s.created_at, source: 'session', agent: s.agent, session_id: s.session_id })
  if (messagesHaveTaskId(db))
    for (const m of db
      .prepare('SELECT id, from_agent, to_agent, status, created_at FROM agent_messages WHERE task_id = ?')
      .all(taskId) as { id: number; from_agent: string; to_agent: string; status: string; created_at: number }[])
      items.push({ at: m.created_at, source: 'message', id: m.id, from: m.from_agent, to: m.to_agent, status: m.status })
  return items.sort(
    (a, b) =>
      a.at - b.at ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      ('id' in a && 'id' in b ? a.id - b.id : 0),
  )
}
