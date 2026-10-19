// Projektek V1, the backend (task t-20261014-acroveliiq-projektkezeles-d3f1; Balázs's approval,
// variant A, 2026-10-14 13:11:32 UTC, message_id 1559916572984737814). WHAT TURNS THIS RED:
//   - a later update changes a task's project, or a project-less update resets it to acropora
//     (acrobot's measured overwrite, msg 30539);
//   - the project changes any other way than POST /api/tasks/:id/project, or without its event;
//   - today's tasks get marked: an `acropora` task with an acropora-os PR, an alias value;
//   - an `os` task's event naming another repo is not marked (naplo) or not refused (kenyszerit);
//   - the filter is not the server's: ?project= misses an alias, or an unknown id is an empty list;
//   - a handoff naming another project, or another project's repo, passes unsaid.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { getDb, initDatabase, saveAgentMemory } from '../db.js'
import { buildOpenMatters } from '../open-matters.js'
import { ensureProjectsSchema, listProjects, projectRepos, repoFits, resolveProject } from '../projects.js'
import { addTaskEvent, upsertTask } from '../task-usage.js'
import { acroveliqAllows } from '../web/acroveliq-host.js'
import { tryHandleOpenMatters } from '../web/routes/open-matters.js'
import { tryHandleTaskActions } from '../web/routes/task-actions.js'
import { tryHandleTaskHandoffs } from '../web/routes/task-handoffs.js'
import { taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'
import { M3_HANDOFF } from './fixtures/task-handoff-m3.js'

type Auth = RouteContext['auth']
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
const MURENA: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }
const SESSION: Auth = { kind: 'session', user: 'balazs' }

async function call(handler: (ctx: RouteContext) => Promise<boolean>, method: string, path: string, body: unknown, who: Auth,
  extra: Partial<RouteContext> = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  let status = 200
  let text = ''
  const res: any = { statusCode: 200, setHeader() { return res }, writeHead(code: number) { status = code; return res }, end(c?: string) { if (c) text += c } }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers, on(e: string, cb: (c?: Buffer) => void) { if (e === 'data' && raw) cb(Buffer.from(raw)); if (e === 'end') cb() } }
  const url = new URL(`http://localhost:3420${path}`)
  await handler({ req, res, path: url.pathname, method, url, auth: who, ...extra } as unknown as RouteContext)
  return { status, body: text ? JSON.parse(text) : null }
}
const NOW = () => Math.floor(Date.now() / 1000)
const task = (id: string, project?: string) =>
  upsertTask(getDb(), { id, project, type: null, parent_task: null, variant: null, brief_ref: null, title: id, goal: 'g', assignee: 'murena' }, NOW() - 100)
const projectOf = (id: string) => (getDb().prepare('SELECT project FROM tasks WHERE id = ?').get(id) as { project: string }).project
const events = (id: string, kind: string) => getDb().prepare('SELECT * FROM task_events WHERE task_id = ? AND kind = ?').all(id, kind) as any[]
const postTask = (b: Record<string, unknown>, who: Auth = ACRO) => call(tryHandleTaskUsage, 'POST', '/api/tasks', b, who)
const event = (id: string, kind: string, ref: string, data?: Record<string, unknown>) =>
  call(tryHandleTaskUsage, 'POST', `/api/tasks/${id}/events`, { kind, actor: 'murena', ref, ...(data ? { data } : {}) }, MURENA)

beforeEach(() => {
  initDatabase(':memory:')
  taskCoreSettings.mode = 'naplo'
  taskCoreSettings.projectMode = 'naplo'
})

describe('the registry', () => {
  it('four starting projects, seeded once; today\'s seven free values all resolve; acropora covers every registered repo', () => {
    ensureProjectsSchema(getDb())
    expect(listProjects(getDb()).map((p) => [p.id, p.name, p.legacyMixed])).toEqual([
      ['acropora', 'Flotta és közös', true], ['os', 'Acropora OS', false], ['commerce', 'Acropora Commerce', false], ['reefclub', 'ReefClub', false], ['caparium', 'Cápárium nAPPló', false],
    ])
    // acrobot's measurement: acropora 101, marveen 11, seo 6, seo-p1 2, acroveliq 1, acropora-os 1, token-proba 1
    expect(['acropora', 'marveen', 'seo', 'seo-p1', 'acroveliq', 'acropora-os', 'token-proba', 'nincs-ilyen', ''].map((v) => resolveProject(getDb(), v)))
      .toEqual(['acropora', 'acropora', 'acropora', 'acropora', 'acropora', 'os', 'acropora', null, null])
    // the fleet repo was renamed KratoBal/marveen -> KratoBal/acroveliq (2026-10-15): both names, old records keep the old
    expect(projectRepos(getDb(), 'acropora').sort()).toEqual(['KratoBal/Acrobot', 'KratoBal/acropora-ai-agent', 'KratoBal/acropora-commerce', 'KratoBal/acropora-os', 'KratoBal/acroveliq', 'KratoBal/marveen'])
    // a customer project's repo is not the wide project's (Caparium, 2026-10-19), and is its own project's
    expect([projectRepos(getDb(), 'caparium'), repoFits(getDb(), 'acropora', 'KratoBal/caparium-napplo') !== null, repoFits(getDb(), 'caparium', 'KratoBal/acropora-os') !== null])
      .toEqual([['KratoBal/caparium-napplo'], true, true])
    expect([repoFits(getDb(), 'acropora', 'KratoBal/acroveliq'), repoFits(getDb(), 'acropora', 'KratoBal/marveen'), repoFits(getDb(), 'os', 'KratoBal/acroveliq') !== null])
      .toEqual([null, null, true])
    expect([projectRepos(getDb(), 'reefclub'), repoFits(getDb(), 'os', 'KratoBal/marveen') !== null, repoFits(getDb(), 'acropora-os', 'KratoBal/acropora-os')])
      .toEqual([['KratoBal/acropora-commerce', 'KratoBal/acropora-os'], true, null])
  })

  it('GET /api/projects: the four, repos expanded; the AcrovelIQ host reads it, and the change route is not on it', async () => {
    const r = await call(tryHandleTaskUsage, 'GET', '/api/projects', undefined, SESSION)
    expect([r.status, r.body.map((p: { id: string }) => p.id), r.body[0].legacy_mixed, r.body[0].repos.length]).toEqual([200, ['acropora', 'os', 'commerce', 'reefclub', 'caparium'], true, 6])
    expect([acroveliqAllows('GET', '/api/projects'), acroveliqAllows('POST', '/api/tasks/x/project')]).toEqual([true, false])
  })
})

describe('the reefclub repos on an existing database (barracuda, #237 review)', () => {
  it('REEFCLUB-OS-MIGRATION: a row with exactly the old repos gets acropora-os, once and logged; a row changed by hand is left alone', () => {
    const db = getDb()
    ensureProjectsSchema(db)
    const reef = () => (db.prepare("SELECT repos FROM projects WHERE id = 'reefclub'").get() as { repos: string }).repos
    const logged = () => (db.prepare("SELECT COUNT(*) AS n FROM config_change_log WHERE key = 'projects.reefclub.repos'").get() as { n: number }).n
    // the live database's state before this change: the row the old SEED wrote
    db.prepare("UPDATE projects SET repos = ? WHERE id = 'reefclub'").run(JSON.stringify(['KratoBal/acropora-commerce']))
    const before = logged()
    ensureProjectsSchema(db)
    const migrated = [JSON.parse(reef()), logged() - before]
    ensureProjectsSchema(db) // a second start: nothing more to do, nothing logged again
    const again = logged() - before
    const byHand = JSON.stringify(['KratoBal/acropora-commerce', 'KratoBal/valami-mas'])
    db.prepare("UPDATE projects SET repos = ? WHERE id = 'reefclub'").run(byHand)
    ensureProjectsSchema(db)
    expect([migrated, again, reef(), logged() - before], 'REEFCLUB-OS-MIGRATION').toEqual([
      [['KratoBal/acropora-commerce', 'KratoBal/acropora-os'], 1], 1, byHand, 1,
    ])
  })
})

describe('the project is durable', () => {
  it('an update with another project keeps it and says so; one without a project does not reset it to acropora', async () => {
    task('t1', 'os')
    const other = await postTask({ id: 't1', project: 'acroveliq', title: 'x' })
    const none = await postTask({ id: 't1', title: 'y' })
    expect([other.status, other.body.project_warning, none.status, none.body.project_warning, projectOf('t1')])
      .toEqual([201, 'project kept: the task is os; a change is POST /api/tasks/t1/project', 201, undefined, 'os'])
    // and below the route: upsertTask itself never changes a stored project
    upsertTask(getDb(), { id: 't1', project: 'commerce', type: null, parent_task: null, variant: null, brief_ref: null }, NOW())
    expect(projectOf('t1')).toBe('os')
  })

  it('a new task: an alias is stored as its id; missing goes under acropora with a warning; unknown is said; kenyszerit refuses both', async () => {
    const alias = await postTask({ id: 'n1', project: 'acropora-os' })
    const missing = await postTask({ id: 'n2' })
    const unknown = await postTask({ id: 'n3', project: 'webshop' })
    expect([alias.body.project_warning, projectOf('n1'), missing.body.project_warning?.startsWith('project missing'), projectOf('n2'), unknown.body.project_warning?.includes('not in the registry')])
      .toEqual([undefined, 'os', true, 'acropora', true])
    taskCoreSettings.projectMode = 'kenyszerit'
    const [m, u, kept] = [await postTask({ id: 'n4' }), await postTask({ id: 'n5', project: 'webshop' }), await postTask({ id: 'n1', project: 'commerce' })]
    expect([m.status, u.status, kept.status, getDb().prepare("SELECT count(*) AS n FROM tasks WHERE id IN ('n4','n5')").get()]).toEqual([400, 400, 409, { n: 0 }])
    // the done guard's mode does not turn this on: two settings
    taskCoreSettings.projectMode = 'naplo'
    taskCoreSettings.mode = 'kenyszerit'
    expect((await postTask({ id: 'n6' })).status).toBe(201)
  })

  it('the one way to change it: the main agent or the owner\'s session, a registry id, with a project_changed event', async () => {
    task('t1')
    const path = '/api/tasks/t1/project'
    const byAgent = await call(tryHandleTaskUsage, 'POST', path, { project: 'os' }, MURENA)
    const bad = await call(tryHandleTaskUsage, 'POST', path, { project: 'acropora-os' }, ACRO)
    const ok = await call(tryHandleTaskUsage, 'POST', path, { project: 'os', reason: 'OS munka' }, ACRO)
    const again = await call(tryHandleTaskUsage, 'POST', path, { project: 'os' }, ACRO)
    const owner = await call(tryHandleTaskUsage, 'POST', path, { project: 'commerce' }, SESSION)
    const ev = events('t1', 'project_changed').map((e) => [e.actor, JSON.parse(e.data).from, JSON.parse(e.data).to])
    expect([byAgent.status, bad.status, ok.status, again.body.repeated, owner.status, projectOf('t1'), ev])
      .toEqual([403, 400, 200, true, 200, 'commerce', [['acrobot', 'acropora', 'os'], ['balazs', 'os', 'commerce']]])
    // nobody writes the event by hand, and the refusal names the real way
    const byHand = await event('t1', 'project_changed', 'x')
    expect([byHand.status, byHand.body.error]).toEqual([403, 'a project_changed event is written by POST /api/tasks/:id/project only'])
  })
})

describe('the repo rule', () => {
  it('an os task\'s event naming another repo: naplo marks it, kenyszerit refuses; today\'s acropora tasks and the aliases are not marked', async () => {
    task('os1', 'os')
    task('old', 'acropora')
    task('seo', 'seo')
    task('rc', 'reefclub')
    const wrong = await event('os1', 'review_requested', 'KratoBal/marveen#5 fej abc')
    const right = await event('os1', 'review_requested', 'KratoBal/acropora-os#6 fej abc')
    const oldTask = await event('old', 'review_requested', 'KratoBal/acropora-os#7 fej abc')
    const seoTask = await event('seo', 'merged', 'x', { repo: 'KratoBal/acropora-commerce', pr: 9, merge_sha: 'a'.repeat(40) })
    const reef = await event('rc', 'review_requested', 'KratoBal/acropora-commerce#8 fej abc')
    // the approved v6.1 plan builds ReefClub in the OS API (2026-10-19)
    const reefOs = await event('rc', 'review_requested', 'KratoBal/acropora-os#10 fej abc')
    const reefOther = await event('rc', 'review_requested', 'KratoBal/acroveliq#11 fej abc')
    expect([wrong.status, wrong.body.would_reject, right.body.would_reject, oldTask.body.would_reject, seoTask.body.would_reject, reef.body.would_reject, reefOs.body.would_reject, reefOther.body.would_reject])
      .toEqual([201, true, undefined, undefined, undefined, undefined, undefined, true])
    expect(JSON.parse(events('os1', 'review_requested')[0].data).would_reject_reason).toContain('nem a(z) os projekté')
    taskCoreSettings.projectMode = 'kenyszerit'
    // a verdict is written with the task reviewer's own token only (#200): the reviewer here is the token's agent
    getDb().prepare("UPDATE tasks SET reviewer = 'murena' WHERE id = 'os1'").run()
    expect((await event('os1', 'verdict', 'APPROVE KratoBal/marveen#5 fej abc')).status).toBe(409)
  })
})

describe('the handoff', () => {
  const post = (taskId: string, record: Record<string, unknown>) =>
    call(tryHandleTaskHandoffs, 'POST', `/api/tasks/${taskId}/handoffs`, { agent: 'murena', record: { ...record, task: { ...(M3_HANDOFF.task as object), id: taskId } } }, MURENA)
  it('no project: it takes the task\'s; another project or another project\'s repo is said; kenyszerit refuses', async () => {
    task('h1', 'os')
    task('h2', 'commerce')
    const none = await post('h1', { ...M3_HANDOFF })
    const stored = getDb().prepare("SELECT project FROM task_handoffs WHERE task_id = 'h1'").get() as { project: string }
    const other = await post('h1', { ...M3_HANDOFF, project: 'acroveliq' })
    const repo = await post('h2', { ...M3_HANDOFF }) // an acropora-os repo on a commerce task
    expect([none.status, none.body.project_warnings, stored.project, other.body.project_warnings, repo.body.project_warnings?.[0]?.startsWith('code.repo')])
      .toEqual([201, undefined, 'os', ['record.project acroveliq is not the task\'s project (os)'], true])
    taskCoreSettings.projectMode = 'kenyszerit'
    expect((await post('h2', { ...M3_HANDOFF })).status).toBe(409)
  })
})

describe('the server filters', () => {
  it('GET /api/tasks?project=: the registry id with its aliases, project_id on every row; an unknown id is a 400', async () => {
    task('a', 'acropora')
    task('b', 'acropora-os')
    task('c', 'os')
    task('d', 'marveen')
    const os = await call(tryHandleTaskUsage, 'GET', '/api/tasks?project=os', undefined, ACRO)
    const all = await call(tryHandleTaskUsage, 'GET', '/api/tasks', undefined, ACRO)
    const bad = await call(tryHandleTaskUsage, 'GET', '/api/tasks?project=acropora-os', undefined, ACRO)
    expect([os.body.map((t: { id: string }) => t.id).sort(), Object.fromEntries(all.body.map((t: { id: string; project_id: string }) => [t.id, t.project_id])), bad.status])
      .toEqual([['b', 'c'], { a: 'acropora', b: 'os', c: 'os', d: 'acropora' }, 400])
    // the assignee branch filters too, busy included (barracuda, #125): not all of murena's tasks
    addTaskEvent(getDb(), { task_id: 'a', kind: 'started', actor: 'murena', at: NOW(), ref: null }, NOW())
    addTaskEvent(getDb(), { task_id: 'c', kind: 'started', actor: 'murena', at: NOW(), ref: null }, NOW())
    const mine = await call(tryHandleTaskUsage, 'GET', '/api/tasks?assignee=murena&project=os', undefined, ACRO)
    const busy = await call(tryHandleTaskUsage, 'GET', '/api/tasks?assignee=murena&busy=1&project=os', undefined, ACRO)
    const allMine = await call(tryHandleTaskUsage, 'GET', '/api/tasks?assignee=murena', undefined, ACRO)
    expect([mine.body.map((t: { id: string; project_id: string }) => `${t.id}:${t.project_id}`).sort(), busy.body.map((t: { id: string }) => t.id), allMine.body.length])
      .toEqual([['b:os', 'c:os'], ['c'], 4])
  })

  it('open-matters ?project=: that project\'s open tasks and decision rows; memories and cards only under Flotta és közös; unknown 400', async () => {
    task('o1', 'os')
    task('a1', 'acropora')
    addTaskEvent(getDb(), { task_id: 'o1', kind: 'started', actor: 'murena', at: NOW(), ref: null }, NOW())
    // a memory has no project: it belongs to Flotta és közös, not to os
    saveAgentMemory('acrobot', 'dontesre var: egy regi ugy', 'hot', 'dontesre-var')
    const os = buildOpenMatters(getDb(), { now: NOW(), project: 'os' })
    const fleet = buildOpenMatters(getDb(), { now: NOW(), project: 'acropora' })
    expect([os.counts.tasks, fleet.counts.tasks, os.text.includes('[o1]'), os.text.includes('[a1]'), os.counts.decisions, fleet.counts.decisions])
      .toEqual([1, 1, true, false, 0, 1])
    const bad = await call(tryHandleOpenMatters, 'GET', '/api/open-matters?project=webshop', undefined, ACRO)
    const ok = await call(tryHandleOpenMatters, 'GET', '/api/open-matters?project=os&format=json', undefined, ACRO)
    expect([bad.status, ok.status, ok.body.counts.tasks]).toEqual([400, 200, 1])
  })
})

describe('the owner\'s new task', () => {
  it('names its project (required), stored as the registry id, on the create event and in acrobot\'s message', async () => {
    const r = await call(tryHandleTaskActions, 'POST', '/api/task-actions', { title: 'x', goal: 'y', project: 'acropora-os' }, SESSION, {}, { 'idempotency-key': 'kulcs-proj-1' })
    const none = await call(tryHandleTaskActions, 'POST', '/api/task-actions', { title: 'x', goal: 'y' }, SESSION, {}, { 'idempotency-key': 'kulcs-proj-2' })
    const ev = events(r.body.task.id, 'owner_action')[0]
    expect([r.status, r.body.task.project, JSON.parse(ev.data).project, none.status]).toEqual([201, 'os', 'os', 400])
  })
})
