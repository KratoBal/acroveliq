
import { readTokenSource } from '../../github-token.js'
import { getDb } from '../../db.js'
import {
  githubProbe,
  handoffRequiredFields,
  insertTaskHandoff,
  latestTaskHandoff,
  validateHandoffRecord,
  verifyCodeState,
  type CodeStateProbe,
} from '../../task-handoff.js'
import { projectResolver, repoFits } from '../../projects.js'
import { json, readBody } from '../http-helpers.js'
import { taskCoreSettings } from './task-usage.js'
import { claimActor } from '../actor-claims.js'
import type { RouteContext } from './types.js'

// Structured task handoff (acrovelIQ token brief, item 3). See
// src/task-handoff.ts for the record and the rules.
//
//   POST /api/tasks/<task>/handoffs                 write a record (400 names the missing fields)
//   GET  /api/tasks/<task>/handoffs/latest          the latest record
//   GET  /api/tasks/<task>/handoffs/latest?verify=1 the latest record and the re-measured code state
//
// The code state is measured HERE, on the server, with the fleet's GitHub
// token: an agent reading its handoff needs no credential of its own.

const PATH = /^\/api\/tasks\/([^/]+)\/handoffs(\/latest)?$/

function fleetProbe(): CodeStateProbe {
  // no token answers "not measurable", never agreement (src/github-token.ts, FLEET_GITHUB_APP)
  return githubProbe(readTokenSource)
}

/** Replaceable in tests; the route never talks to GitHub in a unit test. */
export const handoffProbe = { make: fleetProbe }

export async function tryHandleTaskHandoffs(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const match = PATH.exec(path)
  if (!match) return false
  const taskId = decodeURIComponent(match[1]!)

  if (!match[2] && method === 'POST') {
    let body: { agent?: unknown; record?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    // the writer is the token's owner, not the body's (acrovelIQ P0-1; barracuda, #22)
    const agent = claimActor(ctx.auth, ctx.accessMode ?? 'naplo', body.agent, 'task-handoffs.agent').value
    if (!agent) {
      json(res, { error: 'agent required' }, 400)
      return true
    }
    // a coordination task holds its handoff to the four fields, whatever the record says
    const taskType = (getDb().prepare('SELECT type FROM tasks WHERE id = ?').get(taskId) as { type: string | null } | undefined)?.type
    const coordinationTask = taskType === 'coordination'
    const checked = validateHandoffRecord(body.record, { coordinationTask })
    if (!checked.ok) {
      const asCoordination = coordinationTask || (body.record as { kind?: unknown } | null)?.kind === 'coordination'
      json(res, { error: 'missing required fields', missing: checked.missing, required: handoffRequiredFields(asCoordination) }, 400)
      return true
    }
    // the path names the task: a record for another task is a mistake, not a write
    if (checked.record.task.id !== taskId) {
      json(res, { error: `record.task.id (${checked.record.task.id}) is not ${taskId}` }, 400)
      return true
    }
    // PROJEKTEK V1: the record's project is its task's, and its code.repo one of that project's
    // repos. A record that names no project takes its task's (the validator's default would
    // say acropora); one that names another is the measured case (a task acropora, its handoff
    // acroveliq) and is said: naplo marks it in the answer, kenyszerit refuses it.
    const task = getDb().prepare('SELECT project FROM tasks WHERE id = ?').get(taskId) as { project: string } | undefined
    const warnings: string[] = []
    if (task) {
      const resolve = projectResolver(getDb())
      const rawProject = (body.record as { project?: unknown } | null)?.project
      if (typeof rawProject !== 'string' || !rawProject.trim()) checked.record.project = task.project
      else if (resolve(rawProject) !== resolve(task.project))
        warnings.push(`record.project ${rawProject} is not the task's project (${task.project})`)
      const repo = checked.record.code?.repo
      const repoReason = typeof repo === 'string' && repo ? repoFits(getDb(), task.project, repo) : null
      if (repoReason) warnings.push(`code.repo: ${repoReason}`)
    }
    if (warnings.length && taskCoreSettings.projectMode === 'kenyszerit') {
      json(res, { error: 'handoff refused', reasons: warnings }, 409)
      return true
    }
    const id = insertTaskHandoff(getDb(), agent, checked.record, Math.floor(Date.now() / 1000))
    json(res, warnings.length && taskCoreSettings.projectMode !== 'off' ? { id, project_warnings: warnings } : { id }, 201)
    return true
  }

  if (match[2] && method === 'GET') {
    const stored = latestTaskHandoff(getDb(), taskId)
    if (!stored) {
      json(res, { error: `no handoff for task ${taskId}` }, 404)
      return true
    }
    if (url.searchParams.get('verify') !== '1') {
      json(res, stored)
      return true
    }
    const check = await verifyCodeState(stored.record.code, handoffProbe.make())
    json(res, { ...stored, check })
    return true
  }

  return false
}
