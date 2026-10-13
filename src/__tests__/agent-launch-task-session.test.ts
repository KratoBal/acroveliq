import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const launches: { kind: 'start' | 'restart'; name: string; opts: Record<string, unknown> }[] = []
let launchOk = true
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...orig,
    startAgentProcess: vi.fn(async (name: string, opts: Record<string, unknown> = {}) => {
      launches.push({ kind: 'start', name, opts })
      return launchOk ? { ok: true } : { ok: false, error: 'launch failed' }
    }),
    restartAgentProcess: vi.fn(async (name: string, opts: Record<string, unknown> = {}) => {
      launches.push({ kind: 'restart', name, opts })
      return launchOk ? { ok: true } : { ok: false, error: 'launch failed' }
    }),
  }
})
const mainRestarts: number[] = []
vi.mock('../web/channel-monitor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/channel-monitor.js')>()
  return { ...orig, hardRestartMarveenChannels: vi.fn(() => (mainRestarts.push(1), { ok: true })) }
})

import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { getDb, initDatabase } from '../db.js'
import { agentDir } from '../web/agent-config.js'
import { removeDesiredAgent } from '../web/agent-desired-state.js'
import { parseLaunchBody, tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

/*
  THE SERVER-CHOSEN SESSION ID, REGISTERED FOR ITS TASK (TC-Lite L2). What
  turns these red: the task_sessions row naming the CALLER (the main agent,
  who restarts others) instead of the agent of the route; a task_id without
  fresh, or a malformed one, reaching a launch; the id in the answer not being
  the one the agent was launched with; a launch WITHOUT task_id changing in
  its options or its answer; the main agent's service-managed restart
  swallowing a task_id; a failed launch still registering a session.
*/

const AGENT = 'tcl-l2-proba-route'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function call(path: string, body: unknown, actor = 'acrobot') {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req,
    res,
    path: url.pathname,
    method: 'POST',
    url,
    // the caller is the main agent's own token: it must NOT end up as the session's agent
    auth: { kind: 'token', actor },
    accessMode: 'naplo',
  } as unknown as RouteContext
  return tryHandleAgents(ctx, join(PROJECT_ROOT, 'web')).then(() => out)
}

const sessionRows = () => getDb().prepare('SELECT agent, session_id, task_id FROM task_sessions ORDER BY rowid').all() as {
  agent: string
  session_id: string
  task_id: string
}[]

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(agentDir(AGENT), { recursive: true })
  writeFileSync(join(agentDir(AGENT), 'agent-config.json'), '{}')
})
afterAll(() => {
  // /start records the operator's intent (agents-desired.json): leave nothing behind
  removeDesiredAgent(AGENT)
  rmSync(agentDir(AGENT), { recursive: true, force: true })
})
beforeEach(() => {
  launches.length = 0
  mainRestarts.length = 0
  launchOk = true
  getDb().prepare('DELETE FROM task_sessions').run()
})

describe.each(['start', 'restart'] as const)('POST /api/agents/:name/%s', (kind) => {
  const path = `/api/agents/${AGENT}/${kind}`

  it('with task_id: launched with a server-made id, registered for the ROUTE agent, the id answered', async () => {
    const out = await call(path, { fresh: true, task_id: 'tcl-l2' })
    expect(out.status).toBe(200)
    const sid = out.body!.session_id as string
    expect(sid).toMatch(UUID_RE)
    expect(out.body).toEqual({ ok: true, session_id: sid })
    expect(launches).toEqual([{ kind, name: AGENT, opts: { fresh: true, sessionId: sid } }])
    expect(sessionRows()).toEqual([{ agent: AGENT, session_id: sid, task_id: 'tcl-l2' }])
  })

  it('two launches get two different ids', async () => {
    const a = (await call(path, { fresh: true, task_id: 'tcl-l2' })).body!.session_id
    const b = (await call(path, { fresh: true, task_id: 'tcl-l2' })).body!.session_id
    expect(a).not.toBe(b)
  })

  it.each([
    ['without fresh', { task_id: 'tcl-l2' }, 'needs fresh'],
    ['with fresh false', { fresh: false, task_id: 'tcl-l2' }, 'needs fresh'],
    ['free text', { fresh: true, task_id: 'a tegnapi feladat' }, 'task_id must match'],
    ['a number', { fresh: true, task_id: 1199 }, 'task_id must match'],
  ])('task_id %s: 400, no launch, no row', async (_n, body, part) => {
    const out = await call(path, body)
    expect(out.status).toBe(400)
    expect(String(out.body!.error)).toContain(part)
    expect(launches).toEqual([])
    expect(sessionRows()).toEqual([])
  })

  it('a failed launch registers nothing', async () => {
    launchOk = false
    const out = await call(path, { fresh: true, task_id: 'tcl-l2' })
    expect(out.status).toBe(400)
    expect(sessionRows()).toEqual([])
  })

  it.each([
    ['no body', ''],
    ['fresh only', { fresh: true }],
    ['an unreadable body', '{nem json'],
  ])('without task_id (%s) the options and the answer are as before', async (_n, body) => {
    const out = await call(path, body)
    expect(out).toEqual({ status: 200, body: { ok: true } })
    expect(launches).toEqual([{ kind, name: AGENT, opts: { fresh: body !== '' && typeof body === 'object' } }])
    expect(sessionRows()).toEqual([])
  })
})

describe('the main agent', () => {
  it('a restart with task_id is refused, not done without it', async () => {
    const out = await call(`/api/agents/${MAIN_AGENT_ID}/restart`, { fresh: true, task_id: 'tcl-l2' })
    expect(out.status).toBe(400)
    expect(mainRestarts).toEqual([])
  })

  it('a plain restart still goes the service-managed way', async () => {
    const out = await call(`/api/agents/${MAIN_AGENT_ID}/restart`, '')
    expect(out).toEqual({ status: 200, body: { ok: true } })
    expect(mainRestarts).toEqual([1])
  })
})

describe('parseLaunchBody', () => {
  it('reads fresh as before and task_id only with fresh', () => {
    expect(parseLaunchBody('')).toEqual({ fresh: false, taskId: null })
    expect(parseLaunchBody('[]')).toEqual({ fresh: false, taskId: null })
    expect(parseLaunchBody('{"fresh":"true"}')).toEqual({ fresh: false, taskId: null })
    expect(parseLaunchBody('{"fresh":true,"task_id":null}')).toEqual({ fresh: true, taskId: null })
    expect(parseLaunchBody('{"fresh":true,"task_id":"sb1-vegrehajto"}')).toEqual({ fresh: true, taskId: 'sb1-vegrehajto' })
  })
})
