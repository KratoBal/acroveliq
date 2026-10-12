// Structured task handoff (acrovelIQ token brief, item 3). WHAT TURNS THIS RED:
//   - a record with a missing required field is stored, or the refusal does not
//     name every missing field;
//   - a read returns an older record than the latest;
//   - a stale branch head, a PR that merged since, or a state that could not be
//     measured reads as "in order";
//   - the route stores a record for a different task than its path names.
import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureTaskHandoffSchema,
  insertTaskHandoff,
  latestTaskHandoff,
  validateHandoffRecord,
  verifyCodeState,
  type CodeStateProbe,
  type HandoffCodeState,
} from '../task-handoff.js'
import { initDatabase } from '../db.js'
import { handoffProbe, tryHandleTaskHandoffs } from '../web/routes/task-handoffs.js'
import type { RouteContext } from '../web/routes/types.js'
import { M3_HANDOFF } from './fixtures/task-handoff-m3.js'

describe('validateHandoffRecord', () => {
  it('HANDOFF-VALIDATE: names every missing field, allows an honestly empty list, defaults the project', () => {
    const valid = validateHandoffRecord(M3_HANDOFF)
    const empty = validateHandoffRecord({})
    const partial = validateHandoffRecord({
      ...M3_HANDOFF,
      decisions: [{ what: 'x', where: 'y' }],
      code: { ...M3_HANDOFF.code, head: 'main' },
      next_step: '  ',
    })
    expect([
      valid.ok && valid.record.project,
      empty.ok ? null : empty.missing,
      partial.ok ? null : partial.missing,
    ], 'HANDOFF-VALIDATE').toEqual([
      'acropora',
      [
        'task', 'status', 'decisions', 'prohibitions',
        'code (null if the task touched no code)', 'files', 'next_step', 'open_questions',
      ],
      ['decisions[0].who', 'code.head (a sha, at least 7 hex digits)', 'next_step'],
    ])
  })
})

describe('the task_handoffs table', () => {
  it('HANDOFF-STORE: a read returns the latest record of the task, not an older one or another task\'s', () => {
    const db = new Database(':memory:')
    ensureTaskHandoffSchema(db)
    const first = validateHandoffRecord(M3_HANDOFF)
    const later = validateHandoffRecord({ ...M3_HANDOFF, next_step: 'a later next step' })
    const other = validateHandoffRecord({ ...M3_HANDOFF, task: { ...M3_HANDOFF.task, id: 'other' } })
    if (!first.ok || !later.ok || !other.ok) throw new Error('fixture invalid')
    insertTaskHandoff(db, 'murena', first.record, 100)
    insertTaskHandoff(db, 'murena', later.record, 100) // same second: the id breaks the tie
    insertTaskHandoff(db, 'nautilus', other.record, 200)
    const latest = latestTaskHandoff(db, 'hetfoi-lista-M3')
    const row = db.prepare('SELECT project, repo, pr_number FROM task_handoffs WHERE id = ?').get(latest!.id)
    expect([latest?.record.next_step, latest?.agent, row, latestTaskHandoff(db, 'missing')], 'HANDOFF-STORE').toEqual([
      'a later next step',
      'murena',
      { project: 'acropora', repo: 'KratoBal/acropora-os', pr_number: 1660 },
      null,
    ])
  })
})

/** A probe answering from a fixed table; `undefined` means "could not measure". */
function fakeProbe(state: {
  head?: string | null
  pr?: { state: string; merged: boolean; headSha: string } | null
}): CodeStateProbe {
  return {
    branchHead: async () => state.head,
    pullRequest: async () => state.pr,
  }
}

const OPEN: HandoffCodeState = { repo: 'KratoBal/acropora-os', branch: 'feat/x', head: 'aaaaaaa1', pr: 1661, merged: false }

describe('verifyCodeState', () => {
  it('HANDOFF-VERIFY: a stale head, a PR merged since, or an unmeasurable state is never "in order"', async () => {
    const run = async (code: HandoffCodeState, state: Parameters<typeof fakeProbe>[0]) => {
      const check = await verifyCodeState(code, fakeProbe(state))
      return [check.ok, check.mismatches.length]
    }
    const openPr = { state: 'open', merged: false, headSha: 'aaaaaaa1ffff' }
    expect([
      await run(OPEN, { head: 'aaaaaaa1ffff', pr: openPr }), // as recorded
      await run(OPEN, { head: 'bbbbbbb2ffff', pr: { ...openPr, headSha: 'bbbbbbb2ffff' } }), // stale head
      await run(OPEN, { head: 'aaaaaaa1ffff', pr: { ...openPr, state: 'closed', merged: true } }), // merged since
      await run(OPEN, { head: undefined, pr: undefined }), // cannot measure
      await run(OPEN, { head: null, pr: openPr }), // branch gone
      await run({ ...OPEN, merged: true }, { head: null, pr: { ...openPr, merged: true } }), // merged, branch deleted
      await run({ ...OPEN, pr: null }, { head: 'aaaaaaa1ffff' }), // no PR yet
    ], 'HANDOFF-VERIFY').toEqual([
      [true, 0],
      [false, 2],
      [false, 1],
      [false, 2],
      [false, 1],
      [true, 0],
      [true, 0],
    ])
  })

  it('names both heads, so the reader knows what to measure', async () => {
    const check = await verifyCodeState({ ...OPEN, pr: null }, fakeProbe({ head: 'bbbbbbb2ffff' }))
    expect(check.mismatches).toEqual([
      'A feat/x ág feje bbbbbbb2, a rekordé aaaaaaa1: azóta került rá munka, amit a rekord nem ismer.',
    ])
  })
})

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(event: string, handler: (arg?: unknown) => void) {
      if (event === 'data' && raw) handler(Buffer.from(raw))
      if (event === 'end') handler()
      return req
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('the task handoff route', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('HANDOFF-ROUTE: refuses with the missing fields, refuses another task\'s record, stores, and reads back with the check', async () => {
    const task = 'route-test-' + Date.now()
    const record = { ...M3_HANDOFF, task: { ...M3_HANDOFF.task, id: task } }
    const missing = fakeCtx(`/api/tasks/${task}/handoffs`, 'POST', { agent: 'murena', record: { ...record, next_step: '' } })
    const foreign = fakeCtx(`/api/tasks/${task}/handoffs`, 'POST', { agent: 'murena', record: M3_HANDOFF })
    const stored = fakeCtx(`/api/tasks/${task}/handoffs`, 'POST', { agent: 'murena', record })
    for (const call of [missing, foreign, stored]) await tryHandleTaskHandoffs(call.ctx)

    handoffProbe.make = () => fakeProbe({ head: null, pr: { state: 'closed', merged: true, headSha: '5bd5231affff' } })
    const read = fakeCtx(`/api/tasks/${task}/handoffs/latest?verify=1`, 'GET')
    await tryHandleTaskHandoffs(read.ctx)
    expect([
      [missing.out.status, missing.out.body.missing],
      [foreign.out.status, foreign.out.body.error],
      stored.out.status,
      [read.out.status, read.out.body.record.next_step, read.out.body.check.ok],
    ], 'HANDOFF-ROUTE').toEqual([
      [400, ['next_step']],
      [400, `record.task.id (hetfoi-lista-M3) is not ${task}`],
      201,
      [200, M3_HANDOFF.next_step, true],
    ])
  })
})
