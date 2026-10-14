import { DECISION_OWNER_USER, MAIN_AGENT_ID } from '../../config.js'
import { getDb } from '../../db.js'
import { decisionOwner } from '../../decisions.js'
import { TASK_ACTIONS, createOwnerTask, ownerTaskAction, type TaskAction } from '../../task-actions.js'
import { isKnownAgent } from '../agent-config.js'
import { callerOfContext } from '../field-gate.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Feladatkezelés V1 (task feladatkezeles-v1-backend). See src/task-actions.ts.
//
//   POST /api/task-actions        {title, goal, assignee?, priority?, brief_ref?}
//        a new task; the Idempotency-Key header is required (one per form)
//   POST /api/task-actions/:id    {action: assign|priority|pause|resume, assignee?, priority?, reason?}
//        one action on a task
//
// ONLY the logged-in session of the configured owner (DECISION_OWNER_USER; unset: nobody),
// in every access mode and on both surfaces: another dashboard user, a device key, an agent
// token or the shared token gets a 403 even where the access mode only logs. These two are
// the writes the AcrovelIQ host lets through besides the decision (Balázs's decision B for
// Feladatkezelés V1, 2026-10-14 10:12:09 UTC, msg 1559871429544120323). Agents keep their
// own routes (POST /api/tasks, POST /api/tasks/:id/events), which the host does not serve.

const PATH = /^\/api\/task-actions(?:\/([^/]+))?$/

async function body(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse((await readBody(ctx.req)).toString())
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function tryHandleTaskActions(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  const m = PATH.exec(path)
  if (!m || method !== 'POST') return false

  const who = decisionOwner(ctx.auth, callerOfContext(ctx.auth)?.column, DECISION_OWNER_USER)
  if (!who.ok) {
    json(res, { error: who.error.replace('a decision is made', 'a task action is made') }, 403)
    return true
  }
  const b = await body(ctx)
  if (!b) {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }
  const now = Math.floor(Date.now() / 1000)

  if (!m[1]) {
    const header = ctx.req.headers['idempotency-key']
    const key = (Array.isArray(header) ? header[0] : header)?.trim() || null
    const out = createOwnerTask(getDb(), b, key, who.user, now, MAIN_AGENT_ID, isKnownAgent)
    json(res, out.body, out.status)
    return true
  }

  const action = typeof b.action === 'string' ? b.action : ''
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) {
    json(res, { error: `action: one of ${TASK_ACTIONS.join(', ')}` }, 400)
    return true
  }
  const out = ownerTaskAction(getDb(), decodeURIComponent(m[1]), action as TaskAction, b, who.user, now, MAIN_AGENT_ID, isKnownAgent)
  json(res, out.body, out.status)
  return true
}
