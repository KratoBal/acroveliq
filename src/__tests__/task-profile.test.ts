// A task's verification profile, the one way it changes (task task-core-doc-would-reject, kanban
// ae046312). Two measured tasks ended as a document under a profile that asks for a PR: murena's
// t-20261015-caparium-2 (no profile: review_requested 1455 and done marked, msg 31737) and
// nautilus's p01-kikenyszerit-keszseg (code_fleet: done marked, msg 39265). WHAT TURNS THIS RED:
//   - a document task, its profile set to docs, still gets would_reject on review_requested or done
//     (or a 409 in kenyszerit);
//   - a code task that named its PR (a ref or data.repo) can leave its code profile, or its done
//     stops asking for the merge: the PR rule must not loosen (Task Core V1, memory 2271);
//   - the task's own agent changes it, a change goes without a reason or without its event, or
//     anyone writes a profile_changed event by hand.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { getDb, initDatabase } from '../db.js'
import { NON_STATE_KINDS, addTaskEvent, upsertTask } from '../task-usage.js'
import { acroveliqAllows } from '../web/acroveliq-host.js'
import { taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
const MURENA: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }
const SESSION: Auth = { kind: 'session', user: 'balazs' }

async function call(method: string, path: string, body: unknown, who: Auth): Promise<{ status: number; body: any }> {
  let status = 200
  let text = ''
  const res: any = { statusCode: 200, setHeader() { return res }, writeHead(code: number) { status = code; return res }, end(c?: string) { if (c) text += c } }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers: {}, on(e: string, cb: (c?: Buffer) => void) { if (e === 'data' && raw) cb(Buffer.from(raw)); if (e === 'end') cb() } }
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleTaskUsage({ req, res, path: url.pathname, method, url, auth: who } as unknown as RouteContext)
  return { status, body: text ? JSON.parse(text) : null }
}
const NOW = () => Math.floor(Date.now() / 1000)
const task = (id: string, profile?: string) =>
  upsertTask(getDb(), { id, project: 'acropora', type: null, parent_task: null, variant: null, brief_ref: null, title: id, goal: 'g', assignee: 'murena', verification_profile: profile ?? null }, NOW() - 100)
const profileOf = (id: string) => (getDb().prepare('SELECT verification_profile FROM tasks WHERE id = ?').get(id) as { verification_profile: string | null }).verification_profile
const changes = (id: string) =>
  (getDb().prepare("SELECT actor, ref, data FROM task_events WHERE task_id = ? AND kind = 'profile_changed' ORDER BY id").all(id) as any[])
    .map((e) => [e.actor, e.ref, JSON.parse(e.data)])
const event = (id: string, kind: string, ref: string, data?: Record<string, unknown>) =>
  call('POST', `/api/tasks/${id}/events`, { kind, actor: 'murena', ref, ...(data ? { data } : {}) }, MURENA)
const marked = (r: { status: number; body: any }) => (r.status === 201 ? r.body.would_reject === true : `http ${r.status}`)
const setProfile = (id: string, verification_profile: string, who: Auth = ACRO, reason: string | null = 'a vegtermek dokumentum') =>
  call('POST', `/api/tasks/${id}/profile`, { verification_profile, ...(reason === null ? {} : { reason }) }, who)

beforeEach(() => {
  initDatabase(':memory:')
  taskCoreSettings.mode = 'naplo'
  taskCoreSettings.projectMode = 'naplo'
})

describe('a document task under the wrong profile', () => {
  it('PROFILE-DOC: the two measured shapes are marked, and pass once the profile says docs', async () => {
    // murena's: no profile, a review of six files, then done
    task('cap')
    const capBefore = [marked(await event('cap', 'review_requested', 'exchange/caparium/caparium-review.md')), marked(await event('cap', 'done', 'hat kimenet'))]
    const capChange = await setProfile('cap', 'docs')
    const capAfter = [marked(await event('cap', 'review_requested', 'exchange/caparium/caparium-review.md')), marked(await event('cap', 'done', 'hat kimenet'))]
    // nautilus's: code_fleet, the end product a card comment
    task('p01', 'code_fleet')
    const p01Before = marked(await event('p01', 'done', 'kanban 809a2f48 komment 6331'))
    const p01Change = await setProfile('p01', 'docs')
    const p01After = marked(await event('p01', 'done', 'kanban 809a2f48 komment 6331'))
    expect([capBefore, capChange.status, capChange.body.from, capAfter, p01Before, p01Change.body, p01After, profileOf('p01')])
      .toEqual([[true, true], 200, null, [false, false], true, { id: 'p01', verification_profile: 'docs', from: 'code_fleet' }, false, 'docs'])
    // the change is said on the timeline, with who and why; the earlier marks stay as they were written
    expect(changes('p01')).toEqual([['acrobot', 'profile code_fleet -> docs', { from: 'code_fleet', to: 'docs', reason: 'a vegtermek dokumentum' }]])
    const p01Done = getDb().prepare("SELECT data FROM task_events WHERE task_id = 'p01' AND kind = 'done' ORDER BY id").all() as { data: string | null }[]
    expect(p01Done.map((r) => (r.data ? JSON.parse(r.data).would_reject === true : false))).toEqual([true, false])
  })

  it('PROFILE-DOC-KENYSZERIT: in the refusing mode the done is 409 before and 201 after', async () => {
    taskCoreSettings.mode = 'kenyszerit'
    task('d1', 'code_fleet')
    const before = await event('d1', 'done', 'kartya-komment')
    await setProfile('d1', 'docs')
    const after = await event('d1', 'done', 'kartya-komment')
    expect([before.status, after.status]).toEqual([409, 201])
  })
})

describe('a code task keeps its PR rule', () => {
  it('PROFILE-CODE: once a review, a verdict, a merge or a deploy named a repo, the code profile is not left', async () => {
    const shapes: [string, string, Record<string, unknown> | undefined][] = [
      ['review_requested', 'KratoBal/acroveliq#76 fej abc1234', undefined],
      ['verdict', 'APPROVE KratoBal/acropora-os#1950 fej abc1234', undefined],
      ['merged', 'beolvasztva', { repo: 'KratoBal/acroveliq', pr: 76, merge_sha: 'a'.repeat(40) }],
      ['deployed', 'KratoBal/acroveliq#76 elo fa', undefined],
    ]
    const out: unknown[] = []
    for (const [i, [kind, ref, data]] of shapes.entries()) {
      const id = `c${i}`
      task(id, 'code_fleet')
      // stored directly: a verdict, a merged and a deployed are other callers' to write, and
      // the rule reads what is stored, whoever wrote it
      addTaskEvent(getDb(), { task_id: id, kind: kind as never, actor: 'acrobot', at: NOW() - 50, ref, data: data ?? null }, NOW())
      const stored = (getDb().prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ? AND kind = ?').get(id, kind) as { n: number }).n
      const r = await setProfile(id, 'docs', SESSION)
      out.push([kind, stored, r.status, /kódos feladat PR-követelménye nem lazul/.test(r.body.reason ?? ''), profileOf(id), changes(id).length])
    }
    expect(out).toEqual(shapes.map(([kind]) => [kind, 1, 409, true, 'code_fleet', 0]))
    // and its done still asks for the merge
    task('c9', 'code_fleet')
    await event('c9', 'review_requested', 'KratoBal/acroveliq#76 fej abc1234')
    await setProfile('c9', 'ops')
    expect([profileOf('c9'), marked(await event('c9', 'done', 'kesz'))]).toEqual(['code_fleet', true])
  })

  it('PROFILE-CODE-NONE: a task without a profile that named a repo is held to the code rule: docs is 409, a code profile goes', async () => {
    task('n1')
    await event('n1', 'review_requested', 'KratoBal/acroveliq#76 fej abc1234')
    const toDocs = await setProfile('n1', 'docs')
    const toOps = await setProfile('n1', 'ops')
    const toCode = await setProfile('n1', 'code_fleet')
    expect([toDocs.status, /profil nélküli, és a \d+\. esemény \(review_requested\)/.test(toDocs.body.reason ?? ''), toOps.status, toCode.status, profileOf('n1'), marked(await event('n1', 'done', 'kesz'))])
      .toEqual([409, true, 409, 200, 'code_fleet', true])
  })

  it('PROFILE-CODE-OTHER: a change between code profiles, or towards one, is not a loosening and goes', async () => {
    task('k1', 'code_fleet')
    await event('k1', 'review_requested', 'KratoBal/acropora-os#1950 fej abc1234')
    const between = await setProfile('k1', 'code_app')
    task('k2', 'docs')
    await event('k2', 'review_requested', 'exchange/terv.md')
    const towards = await setProfile('k2', 'code_fleet')
    expect([between.status, profileOf('k1'), towards.status, profileOf('k2'), marked(await event('k2', 'done', 'kesz'))])
      .toEqual([200, 'code_app', 200, 'code_fleet', true])
  })
})

describe('who changes it, and how', () => {
  it('PROFILE-WHO: the main agent or the owner\'s session, a profile and a reason; the event only from the route', async () => {
    task('w1', 'code_fleet')
    const byAgent = await setProfile('w1', 'docs', MURENA)
    const noReason = await setProfile('w1', 'docs', ACRO, null)
    const badProfile = await setProfile('w1', 'dokumentum')
    const missingTask = await setProfile('nincs', 'docs')
    const owner = await setProfile('w1', 'docs', SESSION)
    const again = await setProfile('w1', 'docs')
    const byHand = await event('w1', 'profile_changed', 'x')
    expect([byAgent.status, noReason.status, noReason.body.missing, badProfile.status, missingTask.status, owner.status, again.body.repeated, changes('w1').map((c) => c[0]), byHand.status, byHand.body.error])
      .toEqual([403, 400, ['reason (why the profile was wrong)'], 400, 404, 200, true, ['balazs'], 403, 'a profile_changed event is written by POST /api/tasks/:id/profile only'])
    // not a state of the task, and not on the AcrovelIQ host
    expect([NON_STATE_KINDS.includes('profile_changed'), acroveliqAllows('POST', '/api/tasks/w1/profile')]).toEqual([true, false])
  })
})
