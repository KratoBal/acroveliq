// Who did it, as the server stores it (acrovelIQ P0-1, PR 3c): the handlers
// run for real behind an HTTP server, on an in-memory database and a
// temporary HOME. WHAT TURNS THIS RED:
//   - an agent token's message, approval decision or request, handoff,
//     token-usage event or session is stored under the name in the body,
//     not the token's (`from` forging; a decision as "balazs");
//   - the shared token keeps a self-declared name outside `naplo`, or loses
//     it in `naplo` (the fleet still runs on it there);
//   - an agent approves its own request by writing someone else's name;
//   - a scheduled task's author comes from the body, or survives a new prompt;
//   - a task an agent wrote runs with the operator frame, or one the
//     operator wrote (on disk or from the session) with the peer frame.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const home = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'actor-claims-'))
  process.env.HOME = dir
  return dir
})

// no message leaves the test: the approval request notifies the owner on Telegram
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => null) }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, isKnownAgent: (name: string) => ['acrobot', 'murena', 'nautilus'].includes(name) }
})

import { createServer, type Server } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { initDatabase, getDb, createApproval, getApproval, getAgentMessage } from '../db.js'
import { LEGACY_ACTOR, authorOf, claimActor } from '../web/actor-claims.js'
import type { AccessMode } from '../web/access-enforcement.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { tryHandleTaskHandoffs } from '../web/routes/task-handoffs.js'
import { tryHandleTaskUsage } from '../web/routes/task-usage.js'
import { tryHandleSchedules } from '../web/routes/schedules.js'
import { SCHEDULED_TASKS_DIR, readScheduledTask } from '../web/scheduled-tasks-io.js'
import { scheduledTaskPrompt } from '../web/schedule-runner.js'
import { SCHEDULED_TASK_PREAMBLE, TRUSTED_PEER_PREAMBLE } from '../prompt-safety.js'
import type { RouteContext } from '../web/routes/types.js'
import { M3_HANDOFF } from './fixtures/task-handoff-m3.js'

type Auth = RouteContext['auth']
const L: Auth = { kind: 'token', actor: 'legacy', project: 'acropora' }
const G: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }
const S: Auth = { kind: 'session', user: 'balazs', actor: 'session:balazs', project: 'acropora' }
const D: Auth = { kind: 'device', device: 'telefon', actor: 'device:telefon', project: 'acropora' }

let server: Server
let port = 0
let auth: Auth = L
let mode: AccessMode = 'naplo'

beforeAll(async () => {
  initDatabase(':memory:')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const ctx: RouteContext = { req, res, path: url.pathname, method: req.method ?? 'GET', url, auth, accessMode: mode }
    void (async () => {
      for (const handle of [tryHandleMessages, tryHandleApprovals, tryHandleTaskHandoffs, tryHandleTaskUsage, tryHandleSchedules]) {
        if (await handle(ctx)) return
      }
      res.writeHead(404)
      res.end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server?.close()
  rmSync(home, { recursive: true, force: true })
})

async function call(as: Auth, method: string, path: string, body: unknown, inMode: AccessMode = 'naplo') {
  auth = as
  mode = inMode
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

describe('actor claims: the rule', () => {
  it('CLAIM-RULE: an agent token names the caller; the shared token keeps its claim only in naplo; the session and a device keep theirs', () => {
    const other: Auth = { kind: 'token', actor: 'acrobot', project: 'masik' }
    expect(
      [
        claimActor(G, 'naplo', 'acrobot', 'f'),
        claimActor(G, 'kikenyszerit', undefined, 'f'),
        claimActor(other, 'naplo', 'acrobot', 'f'),
        claimActor(L, 'naplo', 'nautilus', 'f'),
        claimActor(L, 'legacy-szukitett', 'nautilus', 'f'),
        claimActor(L, 'kikenyszerit', 'nautilus', 'f'),
        claimActor(S, 'kikenyszerit', 'balazs', 'f'),
        claimActor(D, 'kikenyszerit', 'balazs', 'f'),
        [G, S, D, L, undefined].map(authorOf),
      ],
      'CLAIM-RULE',
    ).toEqual([
      { value: 'murena', verified: true },
      { value: 'murena', verified: true },
      { value: 'masik/acrobot', verified: true },
      { value: 'nautilus', verified: false },
      { value: LEGACY_ACTOR, verified: false },
      { value: LEGACY_ACTOR, verified: false },
      { value: 'balazs', verified: true },
      { value: 'balazs', verified: false },
      ['murena', 'session:balazs', 'device:telefon', LEGACY_ACTOR, LEGACY_ACTOR],
    ])
  })
})

describe('actor claims: through the handlers', () => {
  it('CLAIM-MESSAGE: the stored sender is the token\'s; the shared token is unverified outside naplo', async () => {
    const forged = await call(G, 'POST', '/api/messages', { from: 'acrobot', to: 'nautilus', content: 'x' })
    const missing = await call(G, 'POST', '/api/messages', { to: 'nautilus', content: 'x' })
    const legacyNaplo = await call(L, 'POST', '/api/messages', { from: 'nautilus', to: 'murena', content: 'x' })
    const legacyEnforced = await call(L, 'POST', '/api/messages', { from: 'nautilus', to: 'murena', content: 'x', origin_note: 'kartya 7' }, 'kikenyszerit')
    const stored = (r: { body: Record<string, unknown> }) => getAgentMessage(Number(r.body.id))
    expect(
      [
        stored(forged)?.from_agent,
        stored(missing)?.from_agent,
        stored(legacyNaplo)?.from_agent,
        stored(legacyNaplo)?.origin_note,
        stored(legacyEnforced)?.from_agent,
        stored(legacyEnforced)?.origin_note,
      ],
      'CLAIM-MESSAGE',
    ).toEqual(['murena', 'murena', 'nautilus', null, LEGACY_ACTOR, 'nem ellenőrzött feladó: a régi közös token; kartya 7'])
  })

  it('CLAIM-APPROVAL: the decider and the requester are the credential\'s; an agent cannot approve its own request by naming someone else', async () => {
    const make = (id: string, agent: string) =>
      createApproval({ id, agent_id: agent, category: 'proba', action_description: 'x', action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600 })
    make('sajat', 'murena')
    make('masike', 'nautilus')
    make('ulesbol', 'nautilus')
    const own = await call(G, 'PATCH', '/api/approvals/sajat', { status: 'approved', resolved_by: 'balazs' })
    const other = await call(G, 'PATCH', '/api/approvals/masike', { status: 'approved', resolved_by: 'balazs' })
    const session = await call(S, 'PATCH', '/api/approvals/ulesbol', { status: 'approved', resolved_by: 'valaki-mas' })
    const asked = await call(G, 'POST', '/api/approvals', { agent_id: 'nautilus', category: 'proba', action_description: 'x' })
    expect(
      [own.status, getApproval('sajat')?.status, other.status, getApproval('masike')?.resolved_by, session.status, getApproval('ulesbol')?.resolved_by, asked.status, asked.body.agent_id],
      'CLAIM-APPROVAL',
    ).toEqual([403, 'pending', 200, 'murena', 200, 'balazs', 201, 'murena'])
  })

  it('CLAIM-TASK: a handoff\'s writer, a token-usage event\'s actor and a session\'s agent are the token\'s', async () => {
    getDb().prepare("INSERT INTO tasks (id, project, created_at) VALUES ('hetfoi-lista-M3', 'acropora', 0)").run()
    const handoff = await call(G, 'POST', '/api/tasks/hetfoi-lista-M3/handoffs', { agent: 'nautilus', record: M3_HANDOFF })
    const event = await call(G, 'POST', '/api/tasks/hetfoi-lista-M3/events', { kind: 'started', actor: 'acrobot' })
    const session = await call(G, 'POST', '/api/tasks/hetfoi-lista-M3/sessions', { agent: 'nautilus', session_id: 'm-1' })
    const db = getDb()
    expect(
      [
        handoff.status,
        (db.prepare('SELECT agent FROM task_handoffs WHERE id = ?').get(handoff.body.id) as { agent: string }).agent,
        event.status,
        (db.prepare('SELECT actor FROM task_events WHERE id = ?').get(event.body.id) as { actor: string }).actor,
        session.status,
        (db.prepare("SELECT agent FROM task_sessions WHERE session_id = 'm-1'").get() as { agent: string }).agent,
      ],
      'CLAIM-TASK',
    ).toEqual([201, 'murena', 201, 'murena', 201, 'murena'])
  })

  it('CLAIM-SCHEDULE-AUTHOR: a task\'s author is the credential\'s, never the body\'s; a new prompt takes the new writer', async () => {
    const created = await call(G, 'POST', '/api/schedules', { name: 'murena-uj', prompt: 'p', schedule: '0 8 * * *', agent: 'murena', author: 'session:balazs' })
    const afterCreate = readScheduledTask('murena-uj')?.author
    await call(G, 'PUT', '/api/schedules/murena-uj', { schedule: '0 9 * * *', author: 'session:balazs' })
    const afterReschedule = readScheduledTask('murena-uj')?.author
    await call(S, 'PUT', '/api/schedules/murena-uj', { prompt: 'q' })
    const afterSession = readScheduledTask('murena-uj')?.author
    await call(L, 'PUT', '/api/schedules/murena-uj', { prompt: 'r' })
    const afterLegacy = readScheduledTask('murena-uj')?.author
    const raw = JSON.parse(readFileSync(join(SCHEDULED_TASKS_DIR, 'murena-uj', 'task-config.json'), 'utf-8')) as Record<string, unknown>
    expect([created.status, afterCreate, afterReschedule, afterSession, afterLegacy, raw.author], 'CLAIM-SCHEDULE-AUTHOR').toEqual([
      200, 'murena', 'murena', 'session:balazs', LEGACY_ACTOR, LEGACY_ACTOR,
    ])
  })

  it('CLAIM-SCHEDULE-FRAME: the operator frame only for a task the operator wrote; an agent\'s task is a peer\'s request, named', () => {
    const frame = (author?: string) => scheduledTaskPrompt({ name: 'f', author }, '[Utemezett feladat: f]', 'csinald meg')
    const disk = frame(undefined)
    const session = frame('session:balazs')
    const agent = frame('murena')
    const legacy = frame(LEGACY_ACTOR)
    const odd = frame('device:te"le fon')
    const operator = (p: string) => p.startsWith(SCHEDULED_TASK_PREAMBLE) && p.includes('<scheduled-task source="scheduled-task:f">')
    const peer = (p: string, who: string) =>
      p.startsWith(TRUSTED_PEER_PREAMBLE) && !p.includes(SCHEDULED_TASK_PREAMBLE) && p.includes(`<trusted-peer source="agent:${who}">`) && p.includes(`@${who}`)
    expect(
      [operator(disk), operator(session), peer(agent, 'murena'), peer(legacy, LEGACY_ACTOR), peer(odd, 'device:telefon'), operator(agent)],
      'CLAIM-SCHEDULE-FRAME',
    ).toEqual([true, true, true, true, true, false])
  })
})
