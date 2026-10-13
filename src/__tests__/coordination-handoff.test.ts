import { describe, expect, it } from 'vitest'

import { validateHandoffRecord } from '../task-handoff.js'

/*
  A COORDINATION UNIT'S HANDOFF (koord-munkamenet, plan item 2; the four fields: acrobot
  2026-10-13, msg 29863). What turns these red: a record with kind 'coordination' passing
  without any of the four (state as a phase and a sentence, decisions with a looked-up
  id and Balazs's words verbatim, ordered next steps with whose step, open questions
  with whom we wait on); and a development handoff (no kind) being held to them.
*/

const valid = () => ({
  task: { id: 'koord-1', goal: 'a #57 atvetele', brief: 'terv' },
  kind: 'coordination',
  status: 'in_progress',
  state: { phase: 'reszben', summary: 'a review lefutott, a beolvasztas var' },
  decisions: [
    { what: 'a #57 mehet', who: 'Balazs', where: 'msg 1559638247641194638', quote: 'Rendben, mehet' },
    { what: 'deny sor a profilba', who: 'acrobot', where: 'msg 29830' },
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

  it('2. decisions: a where with no id, and a decision of Balazs without his words', () => {
    const d = valid(); d.decisions[1].where = 'a fo csatornan'
    expect(missingOf(d)).toContain('decisions[1].where (a message id)')
    const q = valid(); delete (q.decisions[0] as { quote?: string }).quote
    expect(missingOf(q)).toContain("decisions[0].quote (Balazs's words, verbatim)")
    const a = valid(); a.decisions[0].who = 'Balázs'; delete (a.decisions[0] as { quote?: string }).quote
    expect(missingOf(a)).toContain("decisions[0].quote (Balazs's words, verbatim)")
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
