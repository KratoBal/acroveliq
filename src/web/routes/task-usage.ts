import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROJECT_CHECK_MODE_SETTING, STORE_DIR, TASK_CORE_MODE_SETTING } from '../../config.js'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import {
  REVIEW_REF_KINDS,
  TASK_EVENT_KINDS,
  TASK_PRIORITIES,
  VERIFICATION_PROFILES,
  addTaskEvent,
  addTaskSession,
  allTasks,
  assigneeTasks,
  doneGuard,
  eventRepo,
  REPO_KINDS,
  setTaskProject,
  githubMergeProbe,
  isTaskPaused,
  loadTaskEvents,
  parseTaskCoreMode,
  reviewRefGuard,
  taskTimeline,
  taskUsageWithVariants,
  upsertTask,
  verifyMerge,
  type MergeProbe,
  type TaskCoreMode,
  type TaskEventKind,
} from '../../task-usage.js'
import { CLOSED_KINDS, waitsOn } from '../../open-matters.js'
import { DECISION_OWNER_USER } from '../../config.js'
import { decisionOwner } from '../../decisions.js'
import { DEFAULT_PROJECT_ID, listProjects, projectRepos, projectResolver, repoFits } from '../../projects.js'
import { callerOfContext } from '../field-gate.js'
import { json, readBody } from '../http-helpers.js'
import { claimActor } from '../actor-claims.js'
import type { RouteContext } from './types.js'

// Per-task token measurement (acrovelIQ token brief, item 1). See
// src/task-usage.ts for the rules.
//
//   POST /api/tasks                       a task: {id, project?, type?, parent_task?, variant?, brief_ref?,
//                                         title?, goal?, acceptance?, assignee?, reviewer?, authorization_ref?,
//                                         verification_profile?, kanban_card_id?, priority?}
//   GET  /api/tasks?assignee=<a>[&busy=1] an agent's tasks; with busy=1 only those that keep it busy
//   GET  /api/tasks                       every task with its last event, whom it waits on (waits_on) and
//                                         whether it is closed (closed: open-matters' CLOSED_KINDS; the
//                                         AcrovelIQ list); an unknown query parameter is 400, not the list
//   POST /api/tasks/<task>/events         an event: {kind, actor, at?, ref?, data?, idem_key?} (at: seconds or
//                                         ISO, default now; the key also as an Idempotency-Key header)
//   POST /api/tasks/<task>/sessions       a session of the task: {agent, session_id}
//   GET  /api/tasks/<task>/usage          the task's usage; with ?variants=1 its variants beside it
//   GET  /api/tasks/<task>/timeline       events, handoff records and sessions, in time order;
//                                         `fields`: the task's title, goal, assignee, reviewer,
//                                         authorization_ref, verification_profile and priority;
//                                         `paused`: whether the task is paused
//
// THE OWNER'S KINDS (Feladatkezelés V1): paused, resumed and owner_action are written by
// POST /api/task-actions only (src/task-actions.ts), like decision by its route. And while
// a task is paused, started and fix_started are refused with 409 in EVERY mode: the pause
// is the owner's decision, not a logging guard (barracuda msg 30316). A review may still
// be recorded; it does not end the pause (isTaskPaused).
//
// THE `done` GUARD (TC-Lite L1), by TASK_CORE_MODE: `off` is the behaviour
// before L1; `naplo` (the default) accepts every `done` and marks the one it
// would refuse (`data.would_reject`); `kenyszerit` refuses it with 409. What
// it asks for is in doneGuard and verifyMerge (src/task-usage.ts).
//
// THE REVIEW REF GUARD, by the same setting: a review_requested or verdict
// names its PR (owner/repo#N in the ref, or data.repo + data.pr); a docs or ops
// task may name the file. `naplo` marks the event, `kenyszerit` refuses it with
// 409. Events already stored are not touched. See reviewRefGuard.

const TASK_PATH = /^\/api\/tasks\/([^/]+)\/(events|sessions|usage|timeline|project)$/

const IDEM_KEY = /^[\x21-\x7e]{8,200}$/
const MAX_DATA = 16 * 1024

function readGithubToken(): string | null {
  try {
    return readFileSync(join(STORE_DIR, '.github-token'), 'utf-8').trim() || null
  } catch {
    return null // the guard then reports "not measurable", never agreement
  }
}

const startMode = parseTaskCoreMode(TASK_CORE_MODE_SETTING)
if (startMode.problem) logger.error(startMode.problem)

/** Replaceable in tests; the route never talks to GitHub in a unit test. */
const startProjectMode = parseTaskCoreMode(PROJECT_CHECK_MODE_SETTING)
if (startProjectMode.problem) logger.error(startProjectMode.problem.replace('TASK_CORE_MODE', 'PROJECT_CHECK_MODE'))

export const taskCoreSettings: { mode: TaskCoreMode; projectMode: TaskCoreMode; probe: () => MergeProbe } = {
  mode: startMode.mode,
  projectMode: startProjectMode.mode,
  probe: () => githubMergeProbe(readGithubToken()),
}

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

/** The body keys POST /api/tasks reads; any other is reported back as `ignored`. */
export const TASK_BODY_KEYS = [
  'id', 'project', 'type', 'parent_task', 'variant', 'brief_ref', 'title', 'goal', 'acceptance',
  'assignee', 'reviewer', 'authorization_ref', 'verification_profile', 'kanban_card_id', 'priority',
] as const

export async function tryHandleTaskUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  const now = Math.floor(Date.now() / 1000)

  // Projektek V1: the registry, the repos expanded (`acropora` covers every registered repo)
  if (path === '/api/projects' && method === 'GET') {
    if ([...url.searchParams.keys()].length) {
      json(res, { error: 'no query parameters' }, 400)
      return true
    }
    json(res, listProjects(getDb()).map((p) => ({
      id: p.id, name: p.name, repos: projectRepos(getDb(), p.id), aliases: p.aliases, legacy_mixed: p.legacyMixed,
    })))
    return true
  }

  if (path === '/api/tasks' && method === 'GET') {
    // a misspelt filter (`agent`, `assignee_id`) must not answer with the whole
    // list: a caller would read every task as its own (the /api/messages rule)
    const unknown = [...url.searchParams.keys()].filter((k) => k !== 'assignee' && k !== 'busy' && k !== 'project')
    if (unknown.length) {
      json(res, { error: 'unknown query parameter', unknown, known: ['assignee', 'busy', 'project'] }, 400)
      return true
    }
    // Projektek V1: the server filters, by the registry id, its aliases included; an unknown
    // id is a 400, not an empty list a page would read as "no tasks"
    const wantProject = text(url.searchParams.get('project'))
    if (url.searchParams.has('project') && (!wantProject || !listProjects(getDb()).some((p) => p.id === wantProject))) {
      json(res, { error: 'unknown project', known: listProjects(getDb()).map((p) => p.id) }, 400)
      return true
    }
    const resolve = projectResolver(getDb())
    const assignee = text(url.searchParams.get('assignee'))
    if (!assignee) {
      if (url.searchParams.has('assignee') || url.searchParams.has('busy')) {
        json(res, { error: 'assignee required' }, 400)
        return true
      }
      // waits_on and closed: the open-matters reading (one place, not a copy on the page). A task the
      // page shows closed is exactly one open-matters does not list as open (barracuda, #116).
      // project_id: the registry project the stored value means (null: an unknown free value)
      json(res, allTasks(getDb())
        .map((t) => ({ ...t, project_id: resolve(t.project), waits_on: waitsOn(t), closed: t.last_kind !== null && CLOSED_KINDS.has(t.last_kind) }))
        .filter((t) => !wantProject || t.project_id === wantProject))
      return true
    }
    // the project filter holds here too: a caller asking ?assignee=x&project=os must not get all of
    // x's tasks and read them as filtered (barracuda, #125); the busy check (kiadas) reads this branch
    const projectOf = new Map((getDb().prepare('SELECT id, project FROM tasks WHERE assignee = ?').all(assignee) as { id: string; project: string }[])
      .map((r) => [r.id, resolve(r.project)] as const))
    const tasks = assigneeTasks(getDb(), assignee)
      .map((t) => ({ ...t, project_id: projectOf.get(t.id) ?? null }))
      .filter((t) => !wantProject || t.project_id === wantProject)
    json(res, url.searchParams.get('busy') === '1' ? tasks.filter((t) => t.busy) : tasks)
    return true
  }

  if (path === '/api/tasks' && method === 'POST') {
    const b = await body(ctx)
    // A KEY THE RECORD DOES NOT READ IS NAMED, NOT SWALLOWED (task aktualis-munka-ures,
    // acrobot's decision 2026-10-14): fleet-api.sh's help once said "cim, cel, felelos",
    // and a task posted that way had no assignee, so it never showed as the agent's
    // current work. Still 201 -- the existing callers are not measured yet; refusing comes
    // in a separate PR once `ignored` is empty everywhere.
    const id = text(b?.id)
    if (!b || !id) {
      json(res, { error: 'id required' }, 400)
      return true
    }
    const profile = text(b.verification_profile)
    if (profile && !(VERIFICATION_PROFILES as readonly string[]).includes(profile)) {
      json(res, { error: 'invalid task', missing: [`verification_profile (${VERIFICATION_PROFILES.join('|')})`] }, 400)
      return true
    }
    const priority = text(b.priority)
    if (priority && !(TASK_PRIORITIES as readonly string[]).includes(priority)) {
      json(res, { error: 'invalid task', missing: [`priority (${TASK_PRIORITIES.join('|')})`] }, 400)
      return true
    }
    // the profile decides what `done` must prove: a different one on an
    // existing task is refused, not ignored (barracuda, #46)
    const stored = getDb().prepare('SELECT verification_profile, type, project FROM tasks WHERE id = ?').get(id) as
      | { verification_profile: string | null; type: string | null; project: string }
      | undefined
    if (profile && stored?.verification_profile && stored.verification_profile !== profile) {
      json(res, { error: `verification_profile is ${stored.verification_profile} and cannot be changed` }, 409)
      return true
    }
    // a coordination task holds its handoffs to the four fields (task-handoffs.ts); an
    // update that left `type` out would CLEAR it (the original fields are written as
    // given), and with it the obligation. So the type stays (koord-munkamenet, #72).
    if (stored?.type === 'coordination' && text(b.type) !== 'coordination') {
      json(res, { error: 'type is coordination and cannot be changed (send type: coordination with the update)' }, 409)
      return true
    }
    // PROJEKTEK V1, the project rule (TASK_CORE_MODE: naplo names it, kenyszerit refuses).
    // A new task names a registry project (an alias is stored as its id); an existing task's
    // project never changes here: upsertTask keeps it, and a different one is said, not
    // swallowed (the change is POST /api/tasks/:id/project, with its event).
    const givenProject = text(b.project)
    const resolveP = projectResolver(getDb())
    const projectId = resolveP(givenProject)
    const known = listProjects(getDb()).map((p) => p.id).join('|')
    const projectWarning = !stored
      ? !givenProject
        ? `project missing: the task goes under ${DEFAULT_PROJECT_ID} (Flotta és közös); name one of ${known}`
        : !projectId ? `project ${givenProject} is not in the registry (${known})` : null
      : givenProject && projectId !== resolveP(stored.project)
        ? `project kept: the task is ${stored.project}; a change is POST /api/tasks/${id}/project`
        : null
    if (projectWarning && taskCoreSettings.projectMode === 'kenyszerit') {
      json(res, { error: 'project refused', reason: projectWarning }, stored ? 409 : 400)
      return true
    }
    upsertTask(
      getDb(),
      {
        id,
        project: projectId ?? givenProject ?? undefined,
        type: text(b.type),
        parent_task: text(b.parent_task),
        variant: text(b.variant),
        brief_ref: text(b.brief_ref),
        title: text(b.title),
        goal: text(b.goal),
        acceptance: b.acceptance === undefined || b.acceptance === null ? null : JSON.stringify(b.acceptance),
        assignee: text(b.assignee),
        reviewer: text(b.reviewer),
        authorization_ref: text(b.authorization_ref),
        verification_profile: profile,
        kanban_card_id: text(b.kanban_card_id),
        priority,
      },
      now,
    )
    const ignored = Object.keys(b).filter((key) => !(TASK_BODY_KEYS as readonly string[]).includes(key))
    json(res, projectWarning && taskCoreSettings.projectMode !== 'off' ? { id, ignored, project_warning: projectWarning } : { id, ignored }, 201)
    return true
  }

  const match = TASK_PATH.exec(path)
  if (!match) return false
  const taskId = decodeURIComponent(match[1]!)
  const exists = getDb().prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)

  if (match[2] === 'timeline' && method === 'GET') {
    if (!exists) {
      json(res, { error: `no task ${taskId}` }, 404)
      return true
    }
    // the fields too: the hand-out (fleet-api.sh kiadas, L5) checks them before it acts
    const fields = getDb()
      .prepare('SELECT title, goal, assignee, reviewer, authorization_ref, verification_profile, priority, project FROM tasks WHERE id = ?')
      .get(taskId) as Record<string, unknown>
    fields.project_id = projectResolver(getDb())(fields.project as string)
    json(res, { task: taskId, fields, paused: isTaskPaused(getDb(), taskId), items: taskTimeline(getDb(), taskId) })
    return true
  }

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

  // PROJEKTEK V1, the one way a task's project changes (Balázs: "ne változhasson meg
  // észrevétlenül"): the main agent's own token, or the owner's session; a registry id only;
  // the field and a project_changed event in one transaction. Not on the AcrovelIQ host.
  if (match[2] === 'project') {
    const caller = callerOfContext(ctx.auth)
    const owner = decisionOwner(ctx.auth, caller?.column, DECISION_OWNER_USER)
    if (caller?.column !== 'A' && !owner.ok) {
      json(res, { error: 'a project is changed by the main agent\'s own token or the owner\'s session only' }, 403)
      return true
    }
    const to = text(b.project)
    const ids = listProjects(getDb()).map((p) => p.id)
    if (!to || !ids.includes(to)) {
      json(res, { error: 'project: a registry id', known: ids }, 400)
      return true
    }
    const reason = text(b.reason)
    const actor = owner.ok ? owner.user : caller!.name
    const out = setTaskProject(getDb(), taskId, to, actor, reason, now)
    json(res, out.changed ? { id: taskId, project: to, from: out.from } : { id: taskId, project: to, repeated: true })
    return true
  }

  if (match[2] === 'events') {
    const kind = text(b.kind)
    // who did it is the token's owner, not the body's: #18's measure counts these events (barracuda, #22)
    const actor = claimActor(ctx.auth, ctx.accessMode ?? 'naplo', b.actor, 'task-events.actor').value
    const at = eventTime(b.at, now)
    const header = ctx.req.headers['idempotency-key']
    const idemKey = text(Array.isArray(header) ? header[0] : header) ?? text(b.idem_key)
    const data = b.data === undefined || b.data === null ? null : b.data
    const dataOk = data === null || (typeof data === 'object' && !Array.isArray(data) && JSON.stringify(data).length <= MAX_DATA)
    const missing = [
      ...(kind && (TASK_EVENT_KINDS as readonly string[]).includes(kind) ? [] : [`kind (${TASK_EVENT_KINDS.join('|')})`]),
      ...(actor ? [] : ['actor']),
      ...(at === null ? ['at (seconds or ISO time)'] : []),
      ...(dataOk ? [] : [`data (a JSON object, at most ${MAX_DATA} bytes)`]),
      ...(idemKey === null || IDEM_KEY.test(idemKey) ? [] : ['idem_key (8-200 printable characters)']),
    ]
    if (missing.length) {
      json(res, { error: 'invalid event', missing }, 400)
      return true
    }
    // the owner's decision is written by the decision route only, in the same transaction
    // as the row's state: from here anyone could put one on a timeline in the owner's name
    if (kind === 'decision') {
      json(res, { error: 'a decision event is written by POST /api/decisions/:id only' }, 403)
      return true
    }
    if (kind === 'project_changed') {
      json(res, { error: 'a project_changed event is written by POST /api/tasks/:id/project only' }, 403)
      return true
    }
    if (kind === 'paused' || kind === 'resumed' || kind === 'owner_action') {
      json(res, { error: `a ${kind} event is written by POST /api/task-actions only` }, 403)
      return true
    }
    const db = getDb()
    // a repeat is answered before the guard: the first one was already judged
    if (idemKey) {
      const earlier = db.prepare('SELECT id, task_id, kind, actor FROM task_events WHERE idem_key = ?').get(idemKey) as
        | { id: number; task_id: string; kind: string; actor: string }
        | undefined
      if (earlier) {
        if (earlier.task_id === taskId && earlier.kind === kind && earlier.actor === actor) json(res, { id: earlier.id, repeated: true }, 200)
        else json(res, { error: `idem_key already used by event ${earlier.id}, a different event`, id: earlier.id }, 409)
        return true
      }
    }
    // after the repeat check: a started recorded before the pause answers its retry as before
    if ((kind === 'started' || kind === 'fix_started') && isTaskPaused(db, taskId)) {
      json(res, { error: 'a feladat szunetel (the task is paused): no new work until the owner resumes it', paused: true }, 409)
      return true
    }
    let stored = data as Record<string, unknown> | null
    let wouldReject: string | null = null
    if (kind === 'done' && taskCoreSettings.mode !== 'off') {
      const task = db.prepare('SELECT verification_profile FROM tasks WHERE id = ?').get(taskId) as { verification_profile: string | null }
      const check = doneGuard(loadTaskEvents(db, taskId), task.verification_profile)
      let reason: string | null = check.need === 'missing' ? check.reason : null
      if (check.need === 'verify') {
        const verdict = await verifyMerge(check.claim, taskCoreSettings.probe())
        if (!verdict.ok) reason = verdict.measurable ? verdict.reason : `nem mérhető: ${verdict.reason}`
      }
      if (reason && taskCoreSettings.mode === 'kenyszerit') {
        json(res, { error: 'done refused', reason }, 409)
        return true
      }
      if (reason) {
        wouldReject = reason
        stored = { ...(stored ?? {}), would_reject: true, would_reject_reason: reason }
      }
    }
    if (REVIEW_REF_KINDS.has(kind!) && taskCoreSettings.mode !== 'off') {
      const task = db.prepare('SELECT verification_profile FROM tasks WHERE id = ?').get(taskId) as { verification_profile: string | null }
      const reason = reviewRefGuard(kind!, text(b.ref), data as Record<string, unknown> | null, task.verification_profile)
      if (reason && taskCoreSettings.mode === 'kenyszerit') {
        json(res, { error: `${kind} refused`, reason }, 409)
        return true
      }
      if (reason) {
        wouldReject = reason
        stored = { ...(stored ?? {}), would_reject: true, would_reject_reason: reason }
      }
    }
    // PROJEKTEK V1, the repo rule: an event that names a repo names one of its task's project.
    // The wide `acropora` project covers every registered repo, so today's tasks are not marked;
    // the rule bites on os, commerce and reefclub (barracuda, 30541). naplo marks, kenyszerit refuses.
    if (REPO_KINDS.has(kind!) && taskCoreSettings.projectMode !== 'off') {
      const task = db.prepare('SELECT project FROM tasks WHERE id = ?').get(taskId) as { project: string }
      const repo = eventRepo(text(b.ref), data as Record<string, unknown> | null)
      const reason = repo ? repoFits(db, task.project, repo) : null
      if (reason && taskCoreSettings.projectMode === 'kenyszerit') {
        json(res, { error: `${kind} refused`, reason }, 409)
        return true
      }
      if (reason) {
        wouldReject = wouldReject ? `${wouldReject}; ${reason}` : reason
        stored = { ...(stored ?? {}), would_reject: true, would_reject_reason: wouldReject }
      }
    }
    const added = addTaskEvent(
      db,
      { task_id: taskId, kind: kind as TaskEventKind, actor: actor!, at: at!, ref: text(b.ref), data: stored, idem_key: idemKey },
      now,
    )
    if (!added.created) {
      // the same key arrived twice at once: the other request won
      json(res, added.same ? { id: added.id, repeated: true } : { error: `idem_key already used by event ${added.id}, a different event`, id: added.id }, added.same ? 200 : 409)
      return true
    }
    json(res, wouldReject ? { id: added.id, would_reject: true, reason: wouldReject } : { id: added.id }, 201)
    return true
  }

  const agent = claimActor(ctx.auth, ctx.accessMode ?? 'naplo', b.agent, 'task-sessions.agent').value
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
