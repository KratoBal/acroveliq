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
//   - admin:  from the actor's `assigned` to the task's `merged` or `done`.
// An opened window with no close runs to the query time.

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
] as const
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number]

export const CAPACITY_KINDS = ['work', 'review', 'fix', 'admin', 'repeat'] as const
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (${TASK_EVENT_KINDS.map((k) => `'${k}'`).join(',')})),
      actor TEXT NOT NULL,
      at INTEGER NOT NULL,
      ref TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, at)`)
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
}

export interface TaskEvent {
  task_id: string
  kind: TaskEventKind
  actor: string
  /** Seconds, like `token_usage.timestamp`. */
  at: number
  ref: string | null
}

export function upsertTask(
  db: Database.Database,
  task: Omit<TaskRow, 'created_at' | 'project'> & { project?: string },
  now: number,
): void {
  db.prepare(
    `INSERT INTO tasks (id, project, type, parent_task, variant, brief_ref, created_at)
     VALUES (@id, @project, @type, @parent_task, @variant, @brief_ref, @now)
     ON CONFLICT(id) DO UPDATE SET
       project = excluded.project, type = excluded.type, parent_task = excluded.parent_task,
       variant = excluded.variant, brief_ref = excluded.brief_ref`,
  ).run({ ...task, project: task.project?.trim() || DEFAULT_PROJECT, now })
}

export function addTaskEvent(db: Database.Database, event: TaskEvent, now: number): number {
  const result = db
    .prepare(
      'INSERT INTO task_events (task_id, kind, actor, at, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(event.task_id, event.kind, event.actor, event.at, event.ref, now)
  return Number(result.lastInsertRowid)
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

export type WindowRole = 'work' | 'review' | 'admin'

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
    if (kind === 'assigned' && !openAdmin.has(actor)) {
      const window: TaskWindow = { task_id, agent: actor, role: 'admin', from: at, to: null }
      openAdmin.set(actor, window)
      windows.push(window)
    }
    // the task's end closes every open window, whoever writes it: acrobot
    // usually merges, and a worker who wrote no close of its own would keep
    // its window open into its next task (barracuda, #18)
    if (kind === 'merged' || kind === 'done') {
      for (const window of [...openAdmin.values(), ...openWork.values()]) window.to ??= at
      openAdmin.clear()
      openWork.clear()
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
}): { assigned: CallAssignment[]; overlaps: Overlap[]; unassigned: { call: UsageCall; role: 'admin' | 'review' }[] } {
  const assigned: CallAssignment[] = []
  const overlaps: Overlap[] = []
  const unassigned: { call: UsageCall; role: 'admin' | 'review' }[] = []
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
  return { assigned, overlaps, unassigned }
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

  const { assigned, overlaps, unassigned } = assignCalls({
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
  return {
    task,
    valid: overlaps.length === 0,
    overlaps,
    unassigned: unassignedTotals,
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
