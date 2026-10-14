// Dontéseim V1, the backend (task dontesek-v1-backend; survey:
// agents/nautilus/FELMERES-dontesek-v1-2026-10-14.md, section 4; Balázs's decision B,
// 2026-10-14 08:52:26 UTC, msg 1559851364950220852, with six requirements).
//
// A decision that waits on Balázs is ONE row of the approvals table, category `dontes`.
// Its action_payload is a JSON object naming the Task Core task and the three texts
// the page shows: summary, reason, consequence. Before this there was no single mark
// for "waits on Balázs": a memory tag stayed on decided matters, a question named its
// own task as the addressee, and a step stood among the questions (survey, section 1).
// A row has a state, so a decided matter stops being shown as open.
//
// The six requirements, and where each one is held:
//   1. only the owner's logged-in session decides: the route refuses every other caller,
//      in every access mode (routes/decisions.ts); the Discord-code path never sees these
//      rows (db.ts, pendingDiscordApprovals) and PATCH /api/approvals/:id hands them here;
//   2. a decision is bound to one approval row and is idempotent: the same answer again
//      is 200 and changes nothing, another answer on a decided row is 409 (decide below);
//   3. it reaches the Task Core timeline (a `decision` event, written in the same
//      transaction as the state, keyed by the row so it cannot be written twice) and the
//      durable memory (one warm memory of the main agent);
//   4. a decision made on Discord makes no second item: the Discord message attached to a
//      row is unique across rows (a unique index), and the recent list drops a handoff
//      decision whose message is a row's already (discordMessageIds below);
//   5. "discuss it" is not an approval and starts nothing: the row stays pending, only a
//      mark and a message to the main agent, who takes it to the Discord thread;
//   6. the AcrovelIQ host lets exactly POST /api/decisions/:id through as a write
//      (acroveliq-host.ts), and the handler refuses there everything but these rows.
//
// Executing a decision is not here: an approved row only changes state; the agent that
// acts reads it and stays within its own profile (the level-2 autonomy flow).

import type Database from 'better-sqlite3'

import { createAgentMessage, saveAgentMemory, type Approval } from './db.js'
import { addTaskEvent } from './task-usage.js'
import { latestTaskHandoff } from './task-handoff.js'

export const DECISION_CATEGORY = 'dontes'

/** A decision row lives a week (the approvals cap); an expired one is shown apart, not dropped. */
export const DECISION_TIMEOUT_SECONDS = 7 * 24 * 3600

/** How far back a decided or expired row stays on the page. */
export const RECENT_SECONDS = 14 * 24 * 3600

export type DecisionAction = 'approve' | 'reject' | 'discuss'
export const DECISION_ACTIONS: readonly DecisionAction[] = ['approve', 'reject', 'discuss']

export interface DecisionPayload {
  task_id: string
  summary: string
  reason: string
  consequence: string
}

const PAYLOAD_FIELDS = ['task_id', 'summary', 'reason', 'consequence'] as const

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/**
 * The payload of a NEW decision row: all four fields, and a task that exists. The
 * answer names what is missing, the way a handoff record's check does.
 */
export function checkDecisionPayload(
  db: Database.Database,
  raw: unknown,
): { ok: true; payload: DecisionPayload } | { ok: false; missing: string[] } {
  let obj: unknown = null
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { obj = null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    return { ok: false, missing: ['action_payload (a JSON object: task_id, summary, reason, consequence)'] }
  const o = obj as Record<string, unknown>
  const missing: string[] = PAYLOAD_FIELDS.filter((f) => !isText(o[f])).map((f) => `action_payload.${f}`)
  if (isText(o.task_id) && !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(o.task_id.trim()))
    missing.push(`action_payload.task_id (no task ${o.task_id.trim()}: the decision must be bound to a Task Core task)`)
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    payload: {
      task_id: (o.task_id as string).trim(),
      summary: (o.summary as string).trim(),
      reason: (o.reason as string).trim(),
      consequence: (o.consequence as string).trim(),
    },
  }
}

/** The payload of a STORED row, read leniently: a missing field is null, shown as missing, never invented. */
export function readDecisionPayload(raw: string | null): { [K in keyof DecisionPayload]: string | null } {
  let o: Record<string, unknown> = {}
  try {
    const v = raw ? JSON.parse(raw) : null
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>
  } catch { /* not JSON: every field missing */ }
  const pick = (k: keyof DecisionPayload) => (isText(o[k]) ? (o[k] as string).trim() : null)
  return { task_id: pick('task_id'), summary: pick('summary'), reason: pick('reason'), consequence: pick('consequence') }
}

/** A Discord message id: 17-20 digits (a snowflake). Shorter numbers are other ids (msg_id:30213 is an inter-agent message). */
export const DISCORD_MESSAGE_ID = /^\d{17,20}$/

/**
 * The Discord MESSAGE ids a free-text reference names. Only two shapes: a number after
 * `msg`/`message_id`, and the LAST number of a Discord link (the middle one is the
 * channel or thread: matched bare, a thread id reads as a message; survey, section 3).
 */
export function discordMessageIds(text: string | null | undefined): string[] {
  const out = new Set<string>()
  const s = text ?? ''
  for (const m of s.matchAll(/discord(?:app)?\.com\/channels\/[^/\s]+\/\d+\/(\d{17,20})(?!\d)/g)) out.add(m[1]!)
  for (const m of s.matchAll(/\b(?:msg|message)(?:_id)?\s*[:=]?\s*(\d{17,20})(?!\d)/gi)) out.add(m[1]!)
  return [...out]
}

export interface DecisionResult {
  status: number
  body: Record<string, unknown>
}

const getRow = (db: Database.Database, id: string): Approval | undefined =>
  db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined

const TARGET: Record<'approve' | 'reject', 'approved' | 'rejected'> = { approve: 'approved', reject: 'rejected' }

/**
 * The owner's answer on a decision row. `user` is the session's user: the caller check is
 * the route's, this function trusts it. Approve and reject decide (once); discuss marks.
 */
export function decide(
  db: Database.Database,
  id: string,
  action: DecisionAction,
  user: string,
  now: number,
  mainAgent: string,
): DecisionResult {
  const row = getRow(db, id)
  if (!row) return { status: 404, body: { error: 'no such approval' } }
  if (row.category !== DECISION_CATEGORY)
    return { status: 409, body: { error: `not a decision row (category ${row.category}): this route decides category ${DECISION_CATEGORY} only` } }

  if (action === 'discuss') {
    if (row.status !== 'pending') return { status: 409, body: { error: `already ${row.status}: there is nothing to discuss`, approval: row } }
    if (row.discuss_requested_at) return { status: 200, body: { approval: row, repeated: true } }
    const marked = db
      .prepare('UPDATE approvals SET discuss_requested_at = ? WHERE id = ? AND status = ? AND discuss_requested_at IS NULL')
      .run(now, id, 'pending').changes > 0
    const after = getRow(db, id)!
    if (!marked) return after.status === 'pending' ? { status: 200, body: { approval: after, repeated: true } }
      : { status: 409, body: { error: `already ${after.status}`, approval: after } }
    const p = readDecisionPayload(row.action_payload)
    try {
      createAgentMessage('system', mainAgent, [
        '[DONTES_MEGBESZELES]',
        `id=${id}`,
        `task=${p.task_id ?? '?'}`,
        `Balazs megbeszelest ker: ${p.summary ?? row.action_description}.`,
        'Ez nem jovahagyas, es nem indit vegrehajtast: a sor fuggo marad. A beszelgetes a Discord-szalban folyik.',
      ].join(' '))
    } catch { /* the mark stands; the page shows it either way */ }
    return { status: 200, body: { approval: after } }
  }

  const target = TARGET[action]
  if (row.status === target) return { status: 200, body: { approval: row, repeated: true } }
  if (row.status !== 'pending')
    return { status: 409, body: { error: row.status === 'timeout' ? 'expired: the row timed out without a decision' : `already ${row.status}`, approval: row } }

  const p = readDecisionPayload(row.action_payload)
  const evidence = row.discord_reply_ref ?? null
  const decided = db.transaction((): boolean => {
    const changed = db
      .prepare(`UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, decision_ref = coalesce(?, decision_ref)
                WHERE id = ? AND status = 'pending'`)
      .run(target, now, user, evidence, id).changes > 0
    if (!changed) return false
    if (p.task_id && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(p.task_id)) {
      addTaskEvent(db, {
        task_id: p.task_id,
        kind: 'decision',
        actor: user,
        at: now,
        ref: `${action === 'approve' ? 'APPROVE' : 'REJECT'} ${DECISION_CATEGORY} ${id}${evidence ? ` msg ${evidence}` : ''}`,
        data: { approval: id, status: target, summary: p.summary, discord_message: evidence },
        idem_key: `dontes:${id}`,
      }, now)
    }
    saveAgentMemory(
      mainAgent,
      [
        `DONTES (${user}, ${new Date(now * 1000).toISOString()}): ${target === 'approved' ? 'JOVAHAGYVA' : 'ELUTASITVA'}.`,
        `Targy: ${p.summary ?? row.action_description}.`,
        `Indoklas: ${p.reason ?? 'nincs megadva'}.`,
        `Kovetkezmeny: ${p.consequence ?? 'nincs megadva'}.`,
        `Feladat: ${p.task_id ?? 'nincs megadva'}. Jovahagyasi sor: ${id}.`,
        evidence ? `Discord-valasz: msg ${evidence}.` : 'A dontes a Dontéseim oldalon szuletett.',
      ].join(' '),
      'warm',
      ['dontes', target === 'approved' ? 'jovahagyva' : 'elutasitva', p.task_id, `approval ${id}`, evidence ? `msg ${evidence}` : null]
        .filter(Boolean).join(', '),
    )
    return true
  })()
  const after = getRow(db, id)!
  if (!decided) return after.status === target ? { status: 200, body: { approval: after, repeated: true } }
    : { status: 409, body: { error: `already ${after.status}`, approval: after } }
  return { status: 200, body: { approval: after } }
}

/**
 * The main agent attaches the Discord message the owner answered a row in. It decides
 * nothing (P0-1: a language model does not turn words into a decision); the row shows
 * "answered on Discord" until the owner confirms it on the page.
 */
export function attachDiscordReply(db: Database.Database, id: string, messageId: string): DecisionResult {
  if (!DISCORD_MESSAGE_ID.test(messageId)) return { status: 400, body: { error: 'message_id: a Discord message id, 17-20 digits' } }
  const row = getRow(db, id)
  if (!row) return { status: 404, body: { error: 'no such approval' } }
  if (row.category !== DECISION_CATEGORY) return { status: 409, body: { error: `not a decision row (category ${row.category})` } }
  if (row.discord_reply_ref === messageId) return { status: 200, body: { approval: row, repeated: true } }
  if (row.status !== 'pending') return { status: 409, body: { error: `already ${row.status}`, approval: row } }
  if (row.discord_reply_ref) return { status: 409, body: { error: `another message is attached already: ${row.discord_reply_ref}` } }
  const other = db.prepare('SELECT id FROM approvals WHERE discord_reply_ref = ? OR decision_ref = ?').get(messageId, messageId) as
    | { id: string } | undefined
  if (other) return { status: 409, body: { error: `message ${messageId} belongs to approval ${other.id} already: one message, one item` } }
  try {
    db.prepare('UPDATE approvals SET discord_reply_ref = ? WHERE id = ? AND discord_reply_ref IS NULL').run(messageId, id)
  } catch {
    return { status: 409, body: { error: `message ${messageId} was attached elsewhere meanwhile` } }
  }
  return { status: 200, body: { approval: getRow(db, id) } }
}

export interface DecisionView {
  id: string
  task_id: string | null
  summary: string | null
  reason: string | null
  consequence: string | null
  status: Approval['status']
  requested_at: number
  timeout_at: number | null
  resolved_at: number | null
  resolved_by: string | null
  discuss_requested_at: number | null
  discord_message: string | null
}

export interface HandoffDecisionView {
  task: string
  handoff: number
  what: string
  quote: string | null
  discord_message: string
  at: number
}

export interface DecisionItems {
  /** waits on the owner, nothing else on it */
  pending: DecisionView[]
  /** the owner asked to talk it over: still pending, not approved */
  discuss: DecisionView[]
  /** answered on Discord, waits for the owner's confirmation on the page */
  discord_replied: DecisionView[]
  /** timed out without a decision, last RECENT_SECONDS */
  expired: DecisionView[]
  /** decided rows, last RECENT_SECONDS */
  recent: DecisionView[]
  /** the owner's decisions in the open tasks' latest handoffs, one per Discord message, none a row has */
  recent_discord: HandoffDecisionView[]
}

const normalizedWho = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function decisionItems(db: Database.Database, now: number, openTaskIds: readonly string[]): DecisionItems {
  const rows = db
    .prepare(`SELECT * FROM approvals WHERE category = ? AND (status = 'pending' OR resolved_at >= ?)
              ORDER BY requested_at DESC, id`)
    .all(DECISION_CATEGORY, now - RECENT_SECONDS) as Approval[]
  const view = (r: Approval): DecisionView => {
    const p = readDecisionPayload(r.action_payload)
    return {
      id: r.id, task_id: p.task_id, summary: p.summary ?? r.action_description, reason: p.reason, consequence: p.consequence,
      status: r.status, requested_at: r.requested_at, timeout_at: r.timeout_at, resolved_at: r.resolved_at,
      resolved_by: r.resolved_by, discuss_requested_at: r.discuss_requested_at ?? null,
      discord_message: r.discord_reply_ref ?? r.decision_ref ?? null,
    }
  }
  const out: DecisionItems = { pending: [], discuss: [], discord_replied: [], expired: [], recent: [], recent_discord: [] }
  const seen = new Set<string>()
  for (const r of rows) {
    for (const m of [r.discord_reply_ref, r.decision_ref]) if (m && DISCORD_MESSAGE_ID.test(m)) seen.add(m)
    const v = view(r)
    if (r.status === 'pending') {
      if (r.discord_reply_ref) out.discord_replied.push(v)
      else if (r.discuss_requested_at) out.discuss.push(v)
      else out.pending.push(v)
    } else if (r.status === 'timeout') out.expired.push(v)
    else out.recent.push(v)
  }
  out.recent.sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))

  const tableExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_handoffs'").get()
  if (tableExists) {
    for (const task of openTaskIds) {
      const h = latestTaskHandoff(db, task)
      if (!h || h.created_at < now - RECENT_SECONDS || !Array.isArray(h.record.decisions)) continue
      for (const d of h.record.decisions as unknown[]) {
        if (!d || typeof d !== 'object') continue
        const o = d as Record<string, unknown>
        if (!isText(o.who) || !normalizedWho(o.who).includes('balazs') || !isText(o.what)) continue
        // the decision's own message: the first one its reference names; none, no dedup key, not listed
        const msg = discordMessageIds(isText(o.where) ? o.where : '')[0]
        if (!msg || seen.has(msg)) continue
        seen.add(msg)
        out.recent_discord.push({ task, handoff: h.id, what: o.what.trim(), quote: isText(o.quote) ? o.quote.trim() : null, discord_message: msg, at: h.created_at })
      }
    }
    out.recent_discord.sort((a, b) => b.at - a.at)
  }
  return out
}
