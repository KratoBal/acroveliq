// A verdict event is the review's record on the timeline, so the events route accepts one ONLY with the
// task reviewer's own agent token (barracuda, #200 review). (The GitHub approval reads root's own record
// since the D4 step list E3 (a), not this event.) WHAT TURNS
// THIS RED:
//   - the shared token writing a verdict in the reviewer's name (the body's actor in `naplo` mode);
//   - another agent's token, the owner's session, or a task with no reviewer getting a verdict stored;
//   - the reviewer's own token refused;
//   - the rule leaking onto other kinds (a started event with the shared token must still go in).
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { getDb, initDatabase } from '../db.js'
import { taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
const BARRACUDA: Auth = { kind: 'token', actor: 'barracuda', project: 'acropora' }
const MURENA: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }
const SHARED: Auth = { kind: 'token', actor: 'legacy' } as Auth
const SESSION: Auth = { kind: 'session', user: 'balazs' } as Auth

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

const verdicts = (id: string) => getDb().prepare("SELECT actor, ref FROM task_events WHERE task_id = ? AND kind = 'verdict'").all(id) as { actor: string; ref: string }[]
const verdict = (id: string, who: Auth) =>
  call('POST', `/api/tasks/${id}/events`, { kind: 'verdict', actor: 'barracuda', ref: `APPROVE KratoBal/acroveliq#200 pr-marveen200 fej ${'a'.repeat(40)}` }, who)

beforeEach(async () => {
  initDatabase(':memory:')
  taskCoreSettings.mode = 'naplo'
  taskCoreSettings.projectMode = 'naplo'
  await call('POST', '/api/tasks', { id: 't-rev', title: 't', goal: 'g', assignee: 'nautilus', reviewer: 'barracuda', project: 'acropora', verification_profile: 'docs' }, ACRO)
  await call('POST', '/api/tasks', { id: 't-norev', title: 't', goal: 'g', assignee: 'nautilus', project: 'acropora', verification_profile: 'docs' }, ACRO)
})

describe('a verdict is written with the reviewer\'s own token only', () => {
  it('VERDICT-REVIEWER: the reviewer\'s own token is accepted and stored under its name', async () => {
    const r = await verdict('t-rev', BARRACUDA)
    expect([r.status, verdicts('t-rev').map((v) => v.actor)], 'VERDICT-REVIEWER').toEqual([201, ['barracuda']])
  })

  it('VERDICT-FORGED: the shared token, another agent, the owner\'s session, or no reviewer: 403, nothing stored', async () => {
    const codes = [
      (await verdict('t-rev', SHARED)).status,
      (await verdict('t-rev', MURENA)).status,
      (await verdict('t-rev', SESSION)).status,
      (await verdict('t-norev', BARRACUDA)).status,
    ]
    expect([codes, verdicts('t-rev').length, verdicts('t-norev').length], 'VERDICT-FORGED').toEqual([[403, 403, 403, 403], 0, 0])
  })

  it('VERDICT-ONLY: other kinds are not touched (a started event with the shared token still goes in)', async () => {
    const r = await call('POST', '/api/tasks/t-rev/events', { kind: 'started', actor: 'nautilus' }, SHARED)
    expect(r.status, 'VERDICT-ONLY').toBe(201)
  })
})
