// The access check at the dispatcher (acrovelIQ P0-1, PR 3b): the matrix of
// route-access.ts applied to a live request.
//
// The setting (ACCESS_MODE) has three positions and no fourth (the brief:
// "the old shared token with full rights" is reachable in none of them):
//   naplo             nothing is denied; what would be denied is logged
//   legacy-szukitett  the shared token (L) is held to its column; the others are logged
//   kikenyszerit      every caller is held to its column, L included
// A missing setting is `naplo`. A value that is none of the three is taken as
// `kikenyszerit`, the strictest, and said aloud at start: a typo must not
// open what it meant to close.
//
// Denials (enforced or not) go to access_decisions, a per-day count like
// request_actors; scripts/access-preflight.ts lists them before the setting
// is turned (barracuda, #22: the switch does not turn while that list holds
// anything).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import type Database from 'better-sqlite3'
import { ACTOR_LOG_DAYS, DEFAULT_PROJECT, localDay, type Principal } from './auth-principals.js'
import { json, primeBody } from './http-helpers.js'
import { logger } from '../logger.js'
import { accessOf, BASH_COMMAND_CATEGORY, decide, type Caller, type Decision, type OwnerSource } from './route-access.js'
import { matchRouteRule, ruleParams, unknownRouteKey } from './route-match.js'
import type { RouteRule } from './route-rules.js'
import { safeJoin, sanitizeScheduleName } from './sanitize.js'

export const ACCESS_MODES = ['naplo', 'legacy-szukitett', 'kikenyszerit'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

/** The setting's position; `problem` is set when the raw value was not one of the three. */
export function parseAccessMode(raw: string | undefined): { mode: AccessMode; problem: string | null } {
  // case is not a typo: `NAPLO` is naplo (barracuda, #25)
  const value = raw?.trim().toLowerCase() ?? ''
  if (!value) return { mode: 'naplo', problem: null }
  if ((ACCESS_MODES as readonly string[]).includes(value)) return { mode: value as AccessMode, problem: null }
  return {
    mode: 'kikenyszerit',
    problem: `ACCESS_MODE=${JSON.stringify(value)} is none of ${ACCESS_MODES.join(', ')}: enforcing, the strictest`,
  }
}

/** Whether a caller's denial is enforced in a mode (otherwise only logged). */
export function enforces(mode: AccessMode, column: Caller['column']): boolean {
  if (mode === 'kikenyszerit') return true
  if (mode === 'legacy-szukitett') return column === 'L'
  return false
}

/** The auth result fields the check reads (a structural subset of AuthResult). */
export type CallerSource =
  | { kind: 'token'; principal?: Principal }
  | { kind: 'device'; device: string }
  | { kind: 'session'; user: string }
  | { kind: 'federation'; peer: string }
  | { kind: 'none' }

/**
 * The matrix column of a caller. An agent token is A when it is the main
 * agent's, G otherwise; a token of another project is G under a name that
 * owns nothing here. Null without a credential (only public routes are
 * reached that way, and those the auth gate already guards).
 */
export function callerOf(auth: CallerSource, mainAgent: string): Caller | null {
  switch (auth.kind) {
    case 'session':
      return { column: 'S', name: `session:${auth.user}` }
    case 'device':
      return { column: 'D', name: `device:${auth.device}` }
    case 'federation':
      return { column: 'F', name: auth.peer }
    case 'token': {
      const p = auth.principal
      if (!p) return { column: 'L', name: 'legacy' }
      if (p.project !== DEFAULT_PROJECT) return { column: 'G', name: `${p.project}/${p.actor}` }
      return { column: p.actor === mainAgent ? 'A' : 'G', name: p.actor }
    }
    default:
      return null
  }
}

export interface OwnerDeps {
  db: Database.Database
  mainAgent: string
  /** The agent a scheduled task runs as, by its name; null when there is no such task. */
  scheduleAgent: (name: string) => string | null
}

/** A scheduled task's agent from its task-config.json (the same resolution as routes/schedules.ts). */
export function scheduleAgentFrom(tasksDir: string, mainAgent: string): (name: string) => string | null {
  return (raw) => {
    const name = sanitizeScheduleName(raw)
    if (!name) return null
    try {
      const file = join(safeJoin(tasksDir, name), 'task-config.json')
      if (!existsSync(file)) return null
      const agent: unknown = (JSON.parse(readFileSync(file, 'utf-8')) as { agent?: unknown }).agent
      // the runner's own default: a task without an agent is the main agent's
      return typeof agent === 'string' && agent ? agent : agent ? null : mainAgent
    } catch {
      return null
    }
  }
}

/** A body field as the handlers read it: `value || main` when it defaults to the main agent. */
function bodyField(body: unknown, name: string, defaultsToMain: boolean, mainAgent: string): string | null {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
  if (typeof value === 'string' && value) return value
  if (value) return null // a non-string the handler would not take as a name
  return defaultsToMain ? mainAgent : null
}

async function parsedBody(req: http.IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await primeBody(req)).toString())
  } catch {
    return undefined
  }
}

/**
 * The owner of a request: one name, or the names any of which is the
 * caller's own; null when it cannot be found (then `own` denies).
 */
export async function resolveOwner(
  source: OwnerSource,
  rule: RouteRule,
  req: http.IncomingMessage,
  url: URL,
  path: string,
  deps: OwnerDeps,
): Promise<string | string[] | null> {
  const params = ruleParams(rule.path, path) ?? {}
  if (source.from === 'param') return params[source.name] ?? null
  if (source.from === 'query') return url.searchParams.get(source.name) || null
  if (source.from === 'body') return bodyField(await parsedBody(req), source.name, source.defaultsToMain ?? false, deps.mainAgent)

  // the id by its name: a later route with two parameters takes the right one (barracuda, #25)
  const id = params[source.param]
  if (!id) return null
  switch (source.record) {
    case 'kanban-card': {
      const row = deps.db.prepare('SELECT assignee FROM kanban_cards WHERE id = ?').get(id) as { assignee: string | null } | undefined
      const assignee = row?.assignee ?? null
      if (!assignee || req.method !== 'PUT') return assignee
      // assigning is the main agent's job (acrobot 28671): on its own card an
      // agent may hand it only to the main agent, the escalation the kanban
      // dispatch prompt itself asks for (routes/kanban.ts); any other assignee,
      // or none, is not its own
      const body = await parsedBody(req)
      if (!body || typeof body !== 'object' || !('assignee' in body)) return assignee
      const next = (body as Record<string, unknown>).assignee
      return next === assignee || next === deps.mainAgent ? assignee : null
    }
    case 'message-closer': {
      // THE SENDER MAY WITHDRAW ITS OWN MESSAGE WHILE IT IS PENDING (acrobot 34258; P0-1 preflight
      // 2026-10-21: murena closed its own, still pending message to a mistyped recipient, the
      // documented message-close, and the rule would have refused it). A delivered message is closed
      // by its recipient only: closing writes the completion report into the sender's pane in the
      // recipient's name, so a sender closing a delivered message would answer for the recipient.
      const row = deps.db.prepare('SELECT from_agent, to_agent, status FROM agent_messages WHERE id = ?').get(id) as
        | { from_agent: string; to_agent: string; status: string }
        | undefined
      if (!row) return null
      return row.status === 'pending' ? [row.from_agent, row.to_agent] : row.to_agent
    }
    case 'message-participants':
    case 'message-recipient': {
      const row = deps.db.prepare('SELECT from_agent, to_agent FROM agent_messages WHERE id = ?').get(id) as
        | { from_agent: string; to_agent: string }
        | undefined
      if (!row) return null
      return source.record === 'message-recipient' ? row.to_agent : [row.from_agent, row.to_agent]
    }
    case 'approval-decider': {
      // WHO MAY DECIDE AN APPROVAL ROW BESIDE THE SESSION: the main agent, on a sub-agent's bash_command row only (owner
      // decision 2026-10-27 09:17 UTC, #311; acrobot 38009). Its own row is the owner's (the self guard in the handler
      // holds it too), and every other category stays with the session, so no owner there and the main agent is refused.
      const row = deps.db.prepare('SELECT agent_id, category FROM approvals WHERE id = ?').get(id) as
        | { agent_id: string; category: string }
        | undefined
      return row && row.category === BASH_COMMAND_CATEGORY && row.agent_id !== deps.mainAgent ? deps.mainAgent : null
    }
    case 'memory': {
      const row = deps.db.prepare('SELECT agent_id FROM memories WHERE id = ?').get(id) as { agent_id: string } | undefined
      if (!row) return null
      if (req.method !== 'PUT') return row.agent_id
      // an update that names another writer moves the memory: not the caller's own
      const moved = bodyField(await parsedBody(req), 'agent_id', false, deps.mainAgent)
      return moved === null || moved === row.agent_id ? row.agent_id : null
    }
    case 'schedule': {
      const agent = deps.scheduleAgent(id)
      if (!agent || req.method !== 'PUT') return agent
      // an update that names another agent moves the task: not the caller's own
      const moved = bodyField(await parsedBody(req), 'agent', false, deps.mainAgent)
      return moved === null || moved === agent ? agent : null
    }
  }
}

export interface AccessVerdict {
  rule: RouteRule | null
  caller: Caller
  decision: Decision
  /** True when the denial is enforced in the current mode (a 403), false when only logged. */
  enforced: boolean
  /** The request's path, for the family of a route no rule answers; never logged itself. */
  requestPath?: string
}

/** Only the API and the fleet manifest are checked, the same scope as the actor log. */
export const inAccessScope = (path: string) => path.startsWith('/api/') || path === '/.well-known/fleetq'

/**
 * The decision for one request; null outside the API or without a
 * credential. The owner is looked up only when the caller's grant is `own`.
 */
export async function checkAccess(
  request: { auth: CallerSource; method: string; path: string; url: URL; req: http.IncomingMessage },
  mode: AccessMode,
  deps: OwnerDeps,
): Promise<AccessVerdict | null> {
  if (!inAccessScope(request.path)) return null
  const caller = callerOf(request.auth, deps.mainAgent)
  if (!caller) return null
  const rule = matchRouteRule(request.method, request.path)
  let owner: string | string[] | null = null
  if (rule && caller.column !== 'F') {
    const access = accessOf(rule)
    if (access.grants[caller.column] === 'own' && access.owner) {
      owner = await resolveOwner(access.owner, rule, request.req, request.url, request.path, deps)
    }
  }
  const decision = decide(rule, caller, owner)
  return { rule, caller, decision, enforced: !decision.allowed && enforces(mode, caller.column), requestPath: request.path }
}

export function ensureAccessDecisionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_decisions (
      day TEXT NOT NULL,
      project TEXT NOT NULL,
      actor TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('denied', 'would-deny')),
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (day, project, actor, method, path, outcome)
    )
  `)
}

let lastPrunedDay = ''

/** The reason without the owner: an owner can come from a request body, and no request value is kept; nor does a 403 name whose record it is. */
const logReason = (reason: string) => reason.replace(/ \(owner [^)]*\)$/, '')

/**
 * Counts one denial, enforced (`denied`) or logged (`would-deny`). The path
 * is the rule's pattern (`:ismeretlen` when no rule, with the route family
 * where the rules know it), never a value from the path. Must never throw: the log describes the request, it cannot fail it.
 */
export function recordAccessDenial(db: Database.Database, verdict: AccessVerdict, mode: AccessMode, method: string, now: number): void {
  try {
    const day = localDay(now)
    if (day !== lastPrunedDay) {
      lastPrunedDay = day
      db.prepare('DELETE FROM access_decisions WHERE day < ?').run(localDay(now - ACTOR_LOG_DAYS * 86400))
    }
    const [project, actor] = verdict.caller.name.includes('/') ? verdict.caller.name.split('/', 2) : [DEFAULT_PROJECT, verdict.caller.name]
    const label = verdict.caller.column === 'F' ? `federation:${actor}` : actor
    db.prepare(
      `INSERT INTO access_decisions (day, project, actor, method, path, outcome, mode, reason, count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (day, project, actor, method, path, outcome)
       DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, mode = excluded.mode, reason = excluded.reason`,
    ).run(day, project, label, method, verdict.rule?.path ?? unknownRouteKey(verdict.requestPath ?? ''), verdict.enforced ? 'denied' : 'would-deny', mode, logReason(verdict.decision.reason), now, now)
  } catch {
    // the log is a measurement, not a gate
  }
}

/**
 * The check as the dispatcher runs it, before any handler: true when it has
 * answered (a 403), false to go on. A denial is logged in every mode. A
 * check that fails (a database error) fails closed where it would be
 * enforced, except for the session: Balázs's login is the way back in every
 * phase (plan 5, step 4).
 */
export async function accessGate(
  request: { auth: CallerSource; method: string; path: string; url: URL; req: http.IncomingMessage; res: http.ServerResponse },
  mode: AccessMode,
  deps: OwnerDeps,
): Promise<boolean> {
  try {
    const verdict = await checkAccess(request, mode, deps)
    if (!verdict || verdict.decision.allowed) return false
    recordAccessDenial(deps.db, verdict, mode, request.method, Math.floor(Date.now() / 1000))
    if (!verdict.enforced) return false
    // without the owner: a 403 must not tell an outsider whose record it is (barracuda, #25)
    json(request.res, { error: 'Forbidden', reason: logReason(verdict.decision.reason) }, 403)
    return true
  } catch (err) {
    logger.error({ err, method: request.method, path: request.path }, 'access check failed')
    const column = callerOf(request.auth, deps.mainAgent)?.column
    if (!column || column === 'S' || !enforces(mode, column)) return false
    json(request.res, { error: 'Forbidden', reason: 'access check failed' }, 403)
    return true
  }
}
