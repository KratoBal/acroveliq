// The open-matters summary (koord-munkamenet, Balazs 2026-10-13 18:43:49 and 18:45:34
// UTC, msg 1559637807461310555 and 1559638247641194638; plan:
// exchange/acroveliq/koord-munkamenet-terv-2026-10-13.md, item 1).
//
// A short coordination session starts from this text instead of the long channel
// conversation. It is GENERATED from records that already exist, and it is not a
// second memory: every line names its source (task id, handoff id, memory id, card id),
// so the record itself is one call away.
//
// THE BUDGET MUST NOT LOSE ANYTHING (Balazs's condition). Items go in by priority until
// the budget is used; what does not fit is not dropped silently: the last section counts
// it per source and lists every omitted id, with the call that brings it back.
//
// The five sources:
//   1. hot memories of the main agent tagged `acrobot-tartozik`: what Acrobot owes Balazs
//      (a prepared step, a promised answer). Balazs 2026-10-13 20:34:46 UTC (msg
//      1559665728909475985): acroveliq.acropora.hu was missing from the status report,
//      because it lived only in a hot memory (2303: approved preparation, the next step
//      was Acrobot's) and this summary read only the decision tag. FIRST section on
//      purpose: the budget fills in order, so a long task list cannot push these out.
//   2. Task Core: every task whose last event is not a closing one, with who it waits on
//   3. open questions: the latest handoff record of each open task (a coordination
//      handoff names who the question waits on; a plain one is a bare string)
//   4. hot memories of the main agent tagged `dontesre-var` in their keywords: there was
//      no marker for "waits on a decision" before (measured 2026-10-13: 108 hot
//      memories, none machine-recognisable), so the tag is the convention from here on.
//      A memory carrying both tags is listed once, under source 1.
//   5. kanban cards in `waiting`
//
// Beside the budgeted text, `items` carries three groups in full, as records: what
// Acrobot owes Balazs, the decision memories, and the open questions that wait on
// Balazs (a coordination question's `from` is the party the answer comes from). The
// AcrovelIQ "Dontéseim" view lists these (task acroveliq-donteseim); the budget is
// for a session's context, not for a page, so nothing is cut there.
//
// Pure: `db` and `now` are passed in, so a test runs it on an in-memory database.

import type Database from 'better-sqlite3'

import { decisionItems, type DecisionItems } from './decisions.js'
import { allTasks, type ListedTask } from './task-usage.js'
import { latestTaskHandoff } from './task-handoff.js'

/** Last-event kinds after which a task is not open any more. */
export const CLOSED_KINDS = new Set(['done', 'merged', 'cancelled', 'failed', 'partial'])

/** The keyword that marks a hot memory as waiting on a decision. */
export const DECISION_TAG = 'dontesre-var'

/** The keyword that marks a hot memory as something Acrobot owes Balazs. */
export const OWES_TAG = 'acrobot-tartozik'

/** Whether a question's `from` names Balazs: case and accents do not matter, nothing else may stand there. */
export function fromBalazs(from: string): boolean {
  return from.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase() === 'balazs'
}

/** About 3-4 thousand tokens of mostly ASCII Hungarian (plan, item 1). */
export const DEFAULT_BUDGET_CHARS = 12000

export interface OpenMattersOptions {
  now: number
  budgetChars?: number
  /** Whose hot memories are read; the channel session is the main agent's. */
  memoryAgent?: string
}

export interface OpenMattersMemory { id: number; content: string; created_at: number }

export interface OpenMattersQuestion { task: string; handoff: number; index: number; from: string; what: string }

export interface OpenMatters {
  generated_at: number
  text: string
  counts: { owes: number; tasks: number; questions: number; decisions: number; cards: number }
  omitted: { owes: number[]; tasks: string[]; questions: string[]; decisions: number[]; cards: string[] }
  /** The groups that wait on Balazs or are owed to Balazs, in full (not budgeted). `dontes`: the decision rows (Dontéseim V1, src/decisions.ts). */
  items: { owes: OpenMattersMemory[]; decisions: OpenMattersMemory[]; balazs_questions: OpenMattersQuestion[]; dontes: DecisionItems }
}

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

const columnExists = (db: Database.Database, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)

const oneLine = (s: string | null | undefined, max: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})
const at = (sec: number | null): string => (sec ? TIME.format(new Date(sec * 1000)) : '-')

/**
 * Who a task waits on, from its last event: a review request waits on the reviewer, a
 * CHANGES verdict on the assignee, an APPROVE verdict on whoever merges, everything else
 * on the assignee. A guess is marked as one ('?').
 */
export function waitsOn(t: Pick<ListedTask, 'last_kind' | 'last_ref' | 'assignee' | 'reviewer'> & { paused?: boolean }): string {
  // a paused task waits on the owner whatever its last state (a review may finish during it)
  if (t.paused) return 'Balazs (szunetel, a folytatas az ove)'
  switch (t.last_kind) {
    case 'review_requested': return t.reviewer ?? '? (nincs reviewer)'
    case 'verdict':
      if (/^\s*APPROVE\b/i.test(t.last_ref ?? '')) return 'beolvaszto'
      if (/^\s*CHANGES\b/i.test(t.last_ref ?? '')) return t.assignee ?? '? (nincs felelos)'
      return '?'
    case 'blocked': return `${t.assignee ?? '?'} (blokkolt: lasd a kerdeseit, ha van atadas)?`
    default: return t.assignee ?? '? (nincs felelos)'
  }
}

type Question = OpenMattersQuestion

function questionsOf(db: Database.Database, taskId: string): Question[] {
  if (!tableExists(db, 'task_handoffs')) return []
  const h = latestTaskHandoff(db, taskId)
  if (!h || !Array.isArray(h.record.open_questions)) return []
  return (h.record.open_questions as unknown[]).flatMap((q, index): Question[] => {
    if (typeof q === 'string' && q.trim()) return [{ task: taskId, handoff: h.id, index, from: '?', what: q }]
    if (q && typeof q === 'object') {
      const o = q as Record<string, unknown>
      if (typeof o.what === 'string' && o.what.trim())
        return [{ task: taskId, handoff: h.id, index, from: typeof o.from === 'string' && o.from.trim() ? o.from : '?', what: o.what }]
    }
    return []
  })
}

export function buildOpenMatters(db: Database.Database, opts: OpenMattersOptions): OpenMatters {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS
  const memoryAgent = opts.memoryAgent ?? 'acrobot'

  const tasks = tableExists(db, 'tasks')
    ? allTasks(db).filter((t) => t.last_kind === null || !CLOSED_KINDS.has(t.last_kind))
    : []
  const questions = tasks.flatMap((t) => questionsOf(db, t.id))
  const hasMemories = tableExists(db, 'memories') && columnExists(db, 'memories', 'keywords')
  const taggedHot = (tag: string) => hasMemories
    ? (db
        .prepare(
          `SELECT id, content, created_at FROM memories
           WHERE agent_id = ? AND category = 'hot' AND (',' || replace(lower(keywords), ' ', '') || ',') LIKE ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(memoryAgent, `%,${tag},%`) as OpenMattersMemory[])
    : []
  const owes = taggedHot(OWES_TAG)
  const owedIds = new Set(owes.map((m) => m.id))
  const decisions = taggedHot(DECISION_TAG).filter((d) => !owedIds.has(d.id))
  const cards = tableExists(db, 'kanban_cards')
    ? (db
        .prepare(
          `SELECT id, title, assignee, priority, updated_at FROM kanban_cards
           WHERE status = 'waiting' AND archived_at IS NULL
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                    updated_at DESC, id`,
        )
        .all() as { id: string; title: string; assignee: string | null; priority: string; updated_at: number }[])
    : []

  const lines: string[] = []
  let used = 0
  // the omitted section is reserved up front: it must fit whatever happens above it
  // from the real id lengths: a task id may be up to 100 characters (barracuda, #72)
  const reserve = 600 +
    owes.reduce((n, m) => n + String(m.id).length + 1, 0) +
    tasks.reduce((n, t) => n + t.id.length + 1, 0) +
    questions.reduce((n, q) => n + q.task.length + 8, 0) +
    decisions.reduce((n, d) => n + String(d.id).length + 1, 0) +
    cards.length * 9
  const room = (line: string): boolean => used + line.length + 1 <= Math.max(budget - reserve, 0)
  const put = (line: string): void => { lines.push(line); used += line.length + 1 }
  const omitted: OpenMatters['omitted'] = { owes: [], tasks: [], questions: [], decisions: [], cards: [] }

  put(`# Nyitott ugyek (generalva ${at(opts.now)}, forras: Task Core, atado rekordok, hot emlekek, kanban)`)

  put('')
  put(`## Amivel Acrobot tartozik Balazsnak (${owes.length}, kulcsszo: ${OWES_TAG})`)
  for (const m of owes) {
    const line = `- [emlek ${m.id}] ${oneLine(m.content, 200)}`
    if (room(line)) put(line); else omitted.owes.push(m.id)
  }

  put('')
  put(`## Nyitott feladatok (${tasks.length})`)
  for (const t of tasks) {
    const line = `- [${t.id}] ${oneLine(t.title ?? t.goal, 90) || '(nincs cim)'} | utolso: ${t.last_kind ?? 'nincs esemeny'}` +
      `${t.last_ref ? ` (${oneLine(t.last_ref, 50)})` : ''}, ${at(t.last_at ?? t.created_at)} | var: ${waitsOn(t)}`
    if (room(line)) put(line); else omitted.tasks.push(t.id)
  }

  put('')
  put(`## Kerdesek, amikre varunk (${questions.length})`)
  for (const q of questions) {
    const line = `- [${q.task}, atadas ${q.handoff}] ${q.from}: ${oneLine(q.what, 160)}`
    // the index is the question's place in THAT task's latest handoff, the one handoff-read brings
    if (room(line)) put(line); else omitted.questions.push(`${q.task}#${q.index}`)
  }

  put('')
  put(`## Dontesre varo emlekek (${decisions.length}, kulcsszo: ${DECISION_TAG})`)
  for (const d of decisions) {
    const line = `- [emlek ${d.id}] ${oneLine(d.content, 200)}`
    if (room(line)) put(line); else omitted.decisions.push(d.id)
  }

  put('')
  put(`## Varakozo kartyak (${cards.length})`)
  for (const c of cards) {
    const line = `- [${c.id.slice(0, 8)}] ${oneLine(c.title, 90)} | ${c.priority}${c.assignee ? `, ${c.assignee}` : ''}`
    if (room(line)) put(line); else omitted.cards.push(c.id.slice(0, 8))
  }

  const n = omitted.owes.length + omitted.tasks.length + omitted.questions.length + omitted.decisions.length + omitted.cards.length
  put('')
  put(`## Kimaradt a keretbol (${n})`)
  if (n === 0) put('- semmi')
  if (omitted.owes.length)
    put(`- ${omitted.owes.length} emlek, Acrobot tartozasa (GET /api/memories/<id>): ${omitted.owes.join(' ')}`)
  if (omitted.tasks.length)
    put(`- ${omitted.tasks.length} feladat (fleet-api.sh task-timeline <id>): ${omitted.tasks.join(' ')}`)
  if (omitted.questions.length)
    put(`- ${omitted.questions.length} kerdes (fleet-api.sh handoff-read <feladat>): ${omitted.questions.join(' ')}`)
  if (omitted.decisions.length)
    put(`- ${omitted.decisions.length} emlek (GET /api/memories/<id>): ${omitted.decisions.join(' ')}`)
  if (omitted.cards.length)
    put(`- ${omitted.cards.length} kartya (fleet-api.sh kanban-comments <id>): ${omitted.cards.join(' ')}`)

  return {
    generated_at: opts.now,
    text: lines.join('\n') + '\n',
    counts: { owes: owes.length, tasks: tasks.length, questions: questions.length, decisions: decisions.length, cards: cards.length },
    omitted,
    items: {
      owes, decisions, balazs_questions: questions.filter((q) => fromBalazs(q.from)),
      dontes: tableExists(db, 'approvals')
        ? decisionItems(db, opts.now, tasks.map((t) => t.id))
        : { pending: [], discuss: [], discord_replied: [], expired: [], recent: [], recent_discord: [] },
    },
  }
}
