import { getDb } from '../../db.js'
import {
  TASK_EVENT_KINDS,
  addTaskEvent,
  addTaskSession,
  taskUsageWithVariants,
  upsertTask,
  type TaskEventKind,
} from '../../task-usage.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Per-task token measurement (acrovelIQ token brief, item 1). See
// src/task-usage.ts for the rules.
//
//   POST /api/tasks                       a task: {id, project?, type?, parent_task?, variant?, brief_ref?}
//   POST /api/tasks/<task>/events         an event: {kind, actor, at?, ref?} (at: seconds or ISO, default now)
//   POST /api/tasks/<task>/sessions       a session of the task: {agent, session_id}
//   GET  /api/tasks/<task>/usage          the task's usage; with ?variants=1 its variants beside it

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/(events|sessions|usage)$/

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** Seconds from a number of seconds or an ISO time; undefined is now, anything else null. */
export function eventTime(value: unknown, now: number): number | null {
  if (value === undefined || value === null) return now
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  // the shell helper sends every value as a string
  if (typeof value === 'string' && /^\d{9,11}$/.test(value)) return Number(value)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
  }
  return null
}

async function body(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBody(ctx.req)).toString())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function tryHandleTaskUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  const now = Math.floor(Date.now() / 1000)

  if (path === '/api/tasks' && method === 'POST') {
    const b = await body(ctx)
    const id = text(b?.id)
    if (!b || !id) {
      json(res, { error: 'id required' }, 400)
      return true
    }
    upsertTask(
      getDb(),
      {
        id,
        project: text(b.project) ?? undefined,
        type: text(b.type),
        parent_task: text(b.parent_task),
        variant: text(b.variant),
        brief_ref: text(b.brief_ref),
      },
      now,
    )
    json(res, { id }, 201)
    return true
  }

  const match = TASK_PATH.exec(path)
  if (!match) return false
  const taskId = decodeURIComponent(match[1]!)
  const exists = getDb().prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)

  if (match[2] === 'usage' && method === 'GET') {
    const usage = taskUsageWithVariants(getDb(), taskId, now)
    if (!usage) {
      json(res, { error: `no task ${taskId}` }, 404)
      return true
    }
    json(res, url.searchParams.get('variants') === '1' ? usage : usage.task)
    return true
  }

  if (method !== 'POST') return false
  if (!exists) {
    json(res, { error: `no task ${taskId}: create it first (POST /api/tasks)` }, 404)
    return true
  }
  const b = await body(ctx)
  if (!b) {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }

  if (match[2] === 'events') {
    const kind = text(b.kind)
    const actor = text(b.actor)
    const at = eventTime(b.at, now)
    const missing = [
      ...(kind && (TASK_EVENT_KINDS as readonly string[]).includes(kind) ? [] : [`kind (${TASK_EVENT_KINDS.join('|')})`]),
      ...(actor ? [] : ['actor']),
      ...(at === null ? ['at (seconds or ISO time)'] : []),
    ]
    if (missing.length) {
      json(res, { error: 'invalid event', missing }, 400)
      return true
    }
    const id = addTaskEvent(
      getDb(),
      { task_id: taskId, kind: kind as TaskEventKind, actor: actor!, at: at!, ref: text(b.ref) },
      now,
    )
    json(res, { id }, 201)
    return true
  }

  const agent = text(b.agent)
  const sessionId = text(b.session_id)
  if (!agent || !sessionId) {
    json(res, { error: 'agent and session_id required' }, 400)
    return true
  }
  const added = addTaskSession(getDb(), taskId, agent, sessionId, now)
  if (!added.ok) {
    json(res, { error: `session ${sessionId} already belongs to task ${added.owner}` }, 409)
    return true
  }
  json(res, { ok: true }, 201)
  return true
}
