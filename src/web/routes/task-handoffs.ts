import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STORE_DIR } from '../../config.js'
import { getDb } from '../../db.js'
import {
  githubProbe,
  insertTaskHandoff,
  latestTaskHandoff,
  validateHandoffRecord,
  verifyCodeState,
  type CodeStateProbe,
} from '../../task-handoff.js'
import { json, readBody } from '../http-helpers.js'
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
  let token: string | null = null
  try {
    token = readFileSync(join(STORE_DIR, '.github-token'), 'utf-8').trim() || null
  } catch {
    token = null // the check then reports "not measurable", never agreement
  }
  return githubProbe(token)
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
    const checked = validateHandoffRecord(body.record)
    if (!checked.ok) {
      json(res, { error: 'missing required fields', missing: checked.missing }, 400)
      return true
    }
    // the path names the task: a record for another task is a mistake, not a write
    if (checked.record.task.id !== taskId) {
      json(res, { error: `record.task.id (${checked.record.task.id}) is not ${taskId}` }, 400)
      return true
    }
    const id = insertTaskHandoff(getDb(), agent, checked.record, Math.floor(Date.now() / 1000))
    json(res, { id }, 201)
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
