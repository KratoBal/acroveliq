import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildOpenMatters, DECISION_TAG, waitsOn } from '../open-matters.js'
import { ensureTaskHandoffSchema, insertTaskHandoff, validateHandoffRecord } from '../task-handoff.js'
import { addTaskEvent, ensureTaskUsageSchema, upsertTask } from '../task-usage.js'

/*
  THE OPEN-MATTERS SUMMARY (koord-munkamenet, plan item 1). What turns these red: a
  closed task listed, an open one missing; the wrong party named as the one a task
  waits on; a question of the latest handoff missing; an untagged hot memory, another
  agent's memory or a near-miss tag counted as waiting on a decision; an archived or
  non-waiting card listed; and, Balazs's condition, an item that is neither in the text
  nor in the omitted list once the budget runs out.
*/

let db: Database.Database
const NOW = 1_800_000_000

function task(id: string, extra: { assignee?: string; reviewer?: string; title?: string } = {}) {
  upsertTask(db, { id, type: null, parent_task: null, variant: null, brief_ref: null, title: extra.title ?? `cim ${id}`,
    assignee: extra.assignee ?? 'murena', reviewer: extra.reviewer ?? 'barracuda' }, NOW - 1000)
}
const ev = (task_id: string, kind: string, ref: string | null = null, at = NOW - 100) =>
  addTaskEvent(db, { task_id, kind: kind as never, actor: 'murena', at, ref }, at)

beforeEach(() => {
  db = new Database(':memory:')
  ensureTaskUsageSchema(db)
  ensureTaskHandoffSchema(db)
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, agent_id TEXT, category TEXT, keywords TEXT, content TEXT, created_at INTEGER)`)
  db.exec(`CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, priority TEXT, updated_at INTEGER, archived_at INTEGER)`)
})

describe('who a task waits on', () => {
  it('review request: the reviewer; CHANGES: the assignee; APPROVE: whoever merges', () => {
    const base = { assignee: 'murena', reviewer: 'barracuda' }
    expect(waitsOn({ ...base, last_kind: 'review_requested', last_ref: 'PR #1' })).toBe('barracuda')
    expect(waitsOn({ ...base, last_kind: 'verdict', last_ref: 'CHANGES #1' })).toBe('murena')
    expect(waitsOn({ ...base, last_kind: 'verdict', last_ref: 'APPROVE #1' })).toBe('beolvaszto')
    expect(waitsOn({ ...base, last_kind: 'started', last_ref: null })).toBe('murena')
    expect(waitsOn({ ...base, last_kind: 'verdict', last_ref: 'hmm' })).toBe('?')
    expect(waitsOn({ ...base, last_kind: 'blocked', last_ref: null })).toMatch(/^murena .*\?$/)
  })
})

describe('the four sources', () => {
  it('lists open tasks only, with their open questions, tagged hot memories and waiting cards', () => {
    task('nyitott'); ev('nyitott', 'review_requested', 'PR #5')
    task('lezart'); ev('lezart', 'merged'); ev('lezart', 'done', null, NOW - 50)
    task('esemeny-nelkul')
    const rec = validateHandoffRecord({
      task: { id: 'nyitott', goal: 'cel', brief: 'b' }, kind: 'coordination', status: 'in_progress',
      state: { phase: 'reszben', summary: 'a review fut, a javitas kesz' },
      decisions: [], prohibitions: [], code: null, files: [],
      next_steps: [{ what: 'review', who: 'barracuda' }],
      open_questions: [{ from: 'Balazs', what: 'mehet-e elesbe' }],
    })
    if (!rec.ok) throw new Error(rec.missing.join(','))
    insertTaskHandoff(db, 'acrobot', rec.record, NOW - 90)
    const ins = db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)')
    ins.run(1, 'acrobot', 'hot', `domain, ${DECISION_TAG}`, 'DONTESRE VAR: a domain', NOW - 10)
    ins.run(2, 'acrobot', 'hot', 'domain', 'csak egy hot emlek', NOW - 10)
    ins.run(3, 'acrobot', 'hot', `${DECISION_TAG}-nem`, 'majdnem cimke', NOW - 10)
    ins.run(4, 'murena', 'hot', DECISION_TAG, 'mas agense', NOW - 10)
    ins.run(5, 'acrobot', 'warm', DECISION_TAG, 'nem hot', NOW - 10)
    const card = db.prepare('INSERT INTO kanban_cards VALUES (?,?,?,?,?,?,?)')
    card.run('aaaaaaaa-1', 'var valamire', 'waiting', 'murena', 'high', NOW, null)
    card.run('bbbbbbbb-2', 'archivalt', 'waiting', null, 'normal', NOW, NOW)
    card.run('cccccccc-3', 'tervezett', 'planned', null, 'normal', NOW, null)

    const out = buildOpenMatters(db, { now: NOW })
    expect(out.counts).toEqual({ tasks: 2, questions: 1, decisions: 1, cards: 1 })
    expect(out.text).toContain('[nyitott]')
    expect(out.text).toMatch(/\[nyitott\].*var: barracuda/)
    expect(out.text).toContain('[esemeny-nelkul]')
    db.prepare("UPDATE tasks SET title = NULL, goal = NULL WHERE id = 'esemeny-nelkul'").run()
    expect(buildOpenMatters(db, { now: NOW }).text).toContain('[esemeny-nelkul] (nincs cim) |')
    expect(out.text).not.toContain('[lezart]')
    expect(out.text).toMatch(/\[nyitott, atadas \d+\] Balazs: mehet-e elesbe/)
    expect(out.text).toContain('[emlek 1]')
    for (const id of [2, 3, 4, 5]) expect(out.text).not.toContain(`[emlek ${id}]`)
    expect(out.text).toContain('[aaaaaaaa]')
    expect(out.text).not.toContain('[bbbbbbbb]')
    expect(out.text).not.toContain('[cccccccc]')
    expect(out.text).toMatch(/## Kimaradt a keretbol \(0\)\n- semmi/)
  })
})

describe('an omitted question names its place in THAT task\'s handoff (barracuda, #72)', () => {
  it('the index is per task, not the global one', () => {
    const rec = (id: string, qs: string[]) => {
      const r = validateHandoffRecord({ task: { id, goal: 'g', brief: 'b' }, status: 'in_progress', decisions: [], prohibitions: [],
        code: null, files: [], next_step: 'x', open_questions: qs })
      if (!r.ok) throw new Error(r.missing.join(','))
      return r.record
    }
    task('a-feladat'); ev('a-feladat', 'started', null, NOW - 200)
    task('b-feladat'); ev('b-feladat', 'started', null, NOW - 100)
    insertTaskHandoff(db, 'murena', rec('a-feladat', ['a0 '.repeat(40), 'a1 '.repeat(40)]), NOW - 50)
    insertTaskHandoff(db, 'murena', rec('b-feladat', ['b0 '.repeat(40), 'b1 '.repeat(40)]), NOW - 50)
    const out = buildOpenMatters(db, { now: NOW, budgetChars: 1100 })
    expect(out.omitted.questions.length).toBeGreaterThan(0)
    for (const q of out.omitted.questions) expect(q).toMatch(/^(a|b)-feladat#[01]$/)
  })
})

describe('the budget loses nothing (Balazs, 18:45:34 UTC)', () => {
  it('every item is either in the text or among the omitted ids, and the text keeps the budget', () => {
    for (let i = 0; i < 40; i++) { task(`feladat-${i}`, { title: 'hosszu cim '.repeat(6) }); ev(`feladat-${i}`, 'started') }
    const card = db.prepare('INSERT INTO kanban_cards VALUES (?,?,?,?,?,?,?)')
    for (let i = 0; i < 60; i++) card.run(`k${String(i).padStart(7, '0')}-x`, 'kartya '.repeat(10), 'waiting', null, 'normal', NOW - i, null)
    const ins = db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)')
    for (let i = 1; i <= 20; i++) ins.run(i, 'acrobot', 'hot', DECISION_TAG, 'dontes '.repeat(30), NOW - i)

    const out = buildOpenMatters(db, { now: NOW, budgetChars: 4000 })
    expect(out.text.length).toBeLessThanOrEqual(4000)
    expect(out.omitted.tasks.length + out.omitted.cards.length + out.omitted.decisions.length).toBeGreaterThan(0)
    for (let i = 0; i < 40; i++) {
      const id = `feladat-${i}`
      expect(out.text.includes(`[${id}]`) || out.omitted.tasks.includes(id), id).toBe(true)
    }
    for (let i = 0; i < 60; i++) {
      const id = `k${String(i).padStart(7, '0')}`
      expect(out.text.includes(`[${id}]`) || out.omitted.cards.includes(id), id).toBe(true)
    }
    for (let i = 1; i <= 20; i++) expect(out.text.includes(`[emlek ${i}]`) || out.omitted.decisions.includes(i)).toBe(true)
    // the omitted ids are in the TEXT too, not only in the JSON beside it
    for (const id of out.omitted.cards) expect(out.text).toContain(id)
    for (const id of out.omitted.tasks) expect(out.text).toContain(id)
  })

  it('long task ids (up to 100 characters): the reserve is taken from the real ids, the text keeps the budget', () => {
    for (let i = 0; i < 30; i++) { const id = `${'hosszu-azonosito-'.repeat(5)}${i}`.slice(0, 100); task(id); ev(id, 'started') }
    const out = buildOpenMatters(db, { now: NOW, budgetChars: 6000 })
    expect(out.omitted.tasks.length).toBeGreaterThan(0)
    expect(out.text.length).toBeLessThanOrEqual(6000)
  })
})
