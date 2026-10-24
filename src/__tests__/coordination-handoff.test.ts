import { beforeAll, describe, expect, it } from 'vitest'

import { getDb, initDatabase } from '../db.js'
import { validateHandoffRecord } from '../task-handoff.js'
import { upsertTask } from '../task-usage.js'
import { tryHandleTaskHandoffs } from '../web/routes/task-handoffs.js'
import { TASK_BODY_KEYS, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

/*
  A COORDINATION UNIT'S HANDOFF (koord-munkamenet, plan item 2; the four fields: acrobot
  2026-10-13, msg 29863). What turns these red: a record with kind 'coordination' passing
  without any of the four (state as a phase and a sentence, decisions with a looked-up
  id and Balazs's words verbatim, ordered next steps with whose step, open questions
  with whom we wait on); a handoff on a task of type `coordination` passing as a
  development one because the record left `kind` out (barracuda, review of #72); and a
  development handoff on an ordinary task being held to them.
*/

const valid = () => ({
  task: { id: 'koord-1', goal: 'a #57 atvetele', brief: 'terv' },
  kind: 'coordination',
  status: 'in_progress',
  state: { phase: 'reszben', summary: 'a review lefutott, a beolvasztas var' },
  decisions: [
    { what: 'a #57 mehet', who: 'Balazs', where: 'msg 1559638247641194638', quote: 'Rendben, mehet' },
    { what: 'deny sor a profilba', who: 'acrobot', where: 'msg 29830', quote: 'a deny listara a task-event ag' },
  ],
  prohibitions: [],
  code: null,
  files: [],
  next_steps: [{ what: 'beolvasztas', who: 'acrobot' }, { what: 'done esemeny', who: 'murena' }],
  open_questions: [{ from: 'Balazs', what: 'elesites ma este?' }],
})
const missingOf = (rec: unknown): string[] => {
  const r = validateHandoffRecord(rec)
  return r.ok ? [] : r.missing
}

describe('a coordination handoff: the four mandatory fields', () => {
  it('a complete record passes; next_step carries the first step for the old readers', () => {
    const r = validateHandoffRecord(valid())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.record.kind).toBe('coordination')
      expect(r.record.next_step).toBe('acrobot: beolvasztas')
      expect(r.record.state).toEqual({ phase: 'reszben', summary: 'a review lefutott, a beolvasztas var' })
      expect(r.record.open_questions).toEqual([{ from: 'Balazs', what: 'elesites ma este?' }])
    }
  })

  it('1. state: missing, a word instead of a sentence, an unknown phase', () => {
    expect(missingOf({ ...valid(), state: undefined })).toContain('state')
    expect(missingOf({ ...valid(), state: { phase: 'reszben', summary: 'fut' } })).toContain('state.summary (a sentence, not a word)')
    expect(missingOf({ ...valid(), state: { phase: 'majdnem', summary: 'a review lefutott, a beolvasztas var' } })[0]).toMatch(/^state\.phase/)
  })

  it('2. decisions: a where with no id, and a decision without the decider\'s words (whoever it names)', () => {
    const d = valid(); d.decisions[1].where = 'a fo csatornan'
    expect(missingOf(d)).toContain('decisions[1].where (a message id)')
    const q = valid(); delete (q.decisions[0] as { quote?: string }).quote
    expect(missingOf(q)).toContain("decisions[0].quote (the decider's words, verbatim)")
    const g = valid(); g.decisions[0].who = 'a gazda'; delete (g.decisions[0] as { quote?: string }).quote
    expect(missingOf(g)).toContain("decisions[0].quote (the decider's words, verbatim)")
  })

  it('3. next steps: missing, a step without its owner, empty while not done', () => {
    expect(missingOf({ ...valid(), next_steps: undefined })).toContain('next_steps')
    expect(missingOf({ ...valid(), next_steps: [{ what: 'beolvasztas' }] })).toContain('next_steps[0].who')
    expect(missingOf({ ...valid(), next_steps: [] })).toContain('next_steps (empty only when state.phase is kesz)')
    expect(missingOf({ ...valid(), next_steps: [], state: { phase: 'kesz', summary: 'beolvasztva es lezarva, kesz' } })).toEqual([])
  })

  it('4. open questions: the field is mandatory, an empty list is valid, an item needs from and what', () => {
    expect(missingOf({ ...valid(), open_questions: undefined })).toContain('open_questions')
    expect(missingOf({ ...valid(), open_questions: [] })).toEqual([])
    expect(missingOf({ ...valid(), open_questions: ['mehet-e?'] })).toEqual(['open_questions[0].from', 'open_questions[0].what'])
  })

  it('an unknown kind is refused, not silently treated as a development handoff', () => {
    expect(missingOf({ ...valid(), kind: 'koordinacio' })).toContain("kind (only 'coordination', or leave it out)")
  })
})

describe('a development handoff (no kind) is unchanged', () => {
  it('string open questions and a single next_step, no state needed', () => {
    const { kind, state, next_steps, ...rest } = valid()
    void kind; void state; void next_steps
    expect(missingOf({ ...rest, next_step: 'review', open_questions: ['egy kerdes'] })).toEqual([])
    expect(missingOf({ ...rest, open_questions: [] })).toContain('next_step')
  })
})

function post(task: string, record: unknown): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const raw = JSON.stringify({ agent: 'acrobot', record })
  const req: any = { on(event: string, h: (arg?: unknown) => void) { if (event === 'data') h(Buffer.from(raw)); if (event === 'end') h(); return req } }
  const path = `/api/tasks/${task}/handoffs`
  const url = new URL(`http://localhost:3420${path}`)
  return tryHandleTaskHandoffs({ req, res, path, method: 'POST', url } as RouteContext).then(() => out)
}

describe('the obligation is bound to the TASK, not to the writer (barracuda, review of #72)', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('a coordination task refuses a handoff that leaves kind out, and stores the full one', async () => {
    const id = `koord-route-${Date.now()}`
    upsertTask(getDb(), { id, type: 'coordination', parent_task: null, variant: null, brief_ref: null }, 1)
    const { kind, state, next_steps, ...dev } = valid()
    void kind; void state; void next_steps
    const asDev = await post(id, { ...dev, task: { ...dev.task, id }, next_step: 'review', open_questions: ['egy kerdes'] })
    expect(asDev.status).toBe(400)
    expect(asDev.body.missing[0]).toMatch(/^kind \(this is a coordination task/)
    expect(asDev.body.missing).toContain('state')
    expect(asDev.body.missing).toContain('next_steps')
    // and the full list of what a coordination record needs, in the same answer
    expect(asDev.body.required).toContain("kind: 'coordination'")
    const full = await post(id, { ...valid(), task: { ...valid().task, id } })
    expect(full.status).toBe(201)
  })

  it('an ordinary task still takes a development handoff', async () => {
    const id = `fejl-route-${Date.now()}`
    upsertTask(getDb(), { id, type: null, parent_task: null, variant: null, brief_ref: null }, 1)
    const { kind, state, next_steps, ...dev } = valid()
    void kind; void state; void next_steps
    const r = await post(id, { ...dev, task: { ...dev.task, id }, next_step: 'review', open_questions: [] })
    expect(r.status).toBe(201)
  })
})

function postTask(body: unknown): Promise<{ status: number; body: any }> {
  // a new task names its profile (Balázs, 2026-10-24); the tests here are about other keys
  body = { verification_profile: 'docs', ...(body as Record<string, unknown>) }
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) }, setHeader() {} }
  const raw = JSON.stringify(body)
  const req: any = { headers: {}, on(event: string, h: (arg?: unknown) => void) { if (event === 'data') h(Buffer.from(raw)); if (event === 'end') h(); return req } }
  const url = new URL('http://localhost:3420/api/tasks')
  return tryHandleTaskUsage({ req, res, path: '/api/tasks', method: 'POST', url, auth: { kind: 'token', actor: 'acrobot' }, accessMode: 'naplo' } as unknown as RouteContext).then(() => out)
}

describe('a coordination task cannot lose its type on an update', () => {
  beforeAll(() => { initDatabase(':memory:') })
  it('an update without type is refused (it would clear the obligation); one with it passes', async () => {
    const id = `koord-tipus-${Date.now()}`
    expect((await postTask({ id, type: 'coordination', title: 'a' })).status).toBeLessThan(300)
    const cleared = await postTask({ id, title: 'uj cim' })
    expect(cleared.status).toBe(409)
    expect((getDb().prepare('SELECT type FROM tasks WHERE id = ?').get(id) as { type: string }).type).toBe('coordination')
    expect((await postTask({ id, type: 'coordination', title: 'uj cim' })).status).toBeLessThan(300)
  })
})

/*
  A NAMED, NOT SWALLOWED KEY (task aktualis-munka-ures, acrobot's decision 2026-10-14).
  MI PIROSÍT: a key the record does not read is dropped with no word (a "felelos" task had
  no assignee, so it never showed as current work); the English keys show up as ignored;
  the answer stops being 201 (the existing callers are not measured yet).
*/
describe('POST /api/tasks names the keys it does not store', () => {
  beforeAll(() => { initDatabase(':memory:') })
  /*
    THE LIST AGAINST THE TABLE (barracuda, #120 note; task task-body-keys-teszt).
    TASK_BODY_KEYS is kept by hand next to what the POST reads. MI PIROSÍT: a new
    column of the tasks table that the list forgets (it would come back as ignored and
    never be stored); a key on the list the table does not have; a listed key that the
    POST does not actually store.
  */
  it('TASK-BODY-KEYS: every column the caller may set is a body key, and every body key is stored', async () => {
    const SERVER_SET = ['created_at', 'updated_at']
    const columns = (getDb().prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
    const body: Record<string, unknown> = {
      id: 'bk-1', project: 'acropora', type: 'experiment', parent_task: 'bk-parent', variant: 'v1', brief_ref: 'brief.md',
      title: 'Cím', goal: 'Cél', acceptance: ['zöld'], assignee: 'murena', reviewer: 'barracuda',
      authorization_ref: 'msg 1', verification_profile: 'code_fleet', kanban_card_id: 'card-1', priority: 'high',
    }
    const r = await postTask(body)
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get('bk-1') as Record<string, unknown>
    expect([
      columns.filter((c) => !SERVER_SET.includes(c)).sort(),
      Object.keys(body).sort(),
      r,
      Object.entries(row).filter(([k, v]) => !SERVER_SET.includes(k) && (v === null || v === undefined)).map(([k]) => k),
    ]).toEqual([[...TASK_BODY_KEYS].sort(), [...TASK_BODY_KEYS].sort(), { status: 201, body: { id: 'bk-1', ignored: [] } }, []])
  })

  it('TASK-IGNORED: Hungarian keys come back as ignored with 201; the English ones store and ignore nothing', async () => {
    // a project, so the answer is about the ignored keys only (Projektek V1 names a missing project)
    const hu = await postTask({ id: 'ign-hu', project: 'acropora', cim: 'Cím', cel: 'Cél', felelos: 'murena' })
    const huRow = getDb().prepare('SELECT title, assignee FROM tasks WHERE id = ?').get('ign-hu')
    const en = await postTask({ id: 'ign-en', project: 'acropora', title: 'Cím', goal: 'Cél', assignee: 'murena' })
    const enRow = getDb().prepare('SELECT title, assignee FROM tasks WHERE id = ?').get('ign-en')
    expect([hu.status, hu.body, huRow, en.status, en.body, enRow]).toEqual([
      201, { id: 'ign-hu', ignored: ['cim', 'cel', 'felelos'] }, { title: null, assignee: null },
      201, { id: 'ign-en', ignored: [] }, { title: 'Cím', assignee: 'murena' },
    ])
  })
})

