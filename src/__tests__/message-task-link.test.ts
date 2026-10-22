import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MAIN_AGENT_ID } from '../config.js'
import { getAgentMessage, getDb, initDatabase, MESSAGE_TASK_ID } from '../db.js'
import { taskTimeline, upsertTask } from '../task-usage.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

/*
  A MESSAGE LINKED TO ITS TASK (TC-Lite L3). What turns these red: a task_id
  that is free text, empty, too long or not a string being stored instead of
  refused with 400; a refused message leaving a row behind; a valid task_id
  not stored, or not on the task's timeline; the timeline carrying the
  message text; the envelope a recipient gets changing because a message has
  a task; agent-msg.sh --task not sending the field, sending it when not
  asked, or letting a malformed id reach the server.
*/

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) {
      state.statusCode = code
      return res
    },
    end(data?: unknown) {
      state.body = String(data ?? '')
    },
    setHeader() {},
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} }
}

const rows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/messages with a task_id', () => {
  it('stores a valid task id and returns it', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'review kesz', task_id: 'tcl-l3' })
    expect(r.statusCode).toBe(200)
    expect(r.json.task_id).toBe('tcl-l3')
    expect(getAgentMessage(r.json.id as number)!.task_id).toBe('tcl-l3')
  })

  it('without one, the message is stored as before, with task_id null', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'sima uzenet' })
    expect(r.statusCode).toBe(200)
    expect(getAgentMessage(r.json.id as number)!.task_id).toBeNull()
    const n = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'null is semmi', task_id: null })
    expect(getAgentMessage(n.json.id as number)!.task_id).toBeNull()
  })

  it.each([
    ['free text', 'ez a review a tegnapi PR-rol'],
    ['empty', ''],
    ['a path', '../tasks/x'],
    ['a leading dash', '-x'],
    ['too long', `a${'b'.repeat(100)}`],
    ['a number', 1199],
    ['an object', { id: 'tcl-l3' }],
  ])('refuses %s with 400 and stores nothing', async (_name, taskId) => {
    const before = rows()
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'x', task_id: taskId })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('task_id')
    expect(rows()).toBe(before)
  })

  it('accepts the shapes task ids really have', () => {
    for (const id of ['tcl-l3', 'sb1-vegrehajto', '06b4f873', 't19-szerzodes-beszerzes-egyseg', 'meres-murena-futtat', 'A.b_c-1']) {
      expect(MESSAGE_TASK_ID.test(id)).toBe(true)
    }
  })
})

describe('the task timeline', () => {
  it('shows the linked message (ids, sender, recipient, state), without its text', async () => {
    const now = Math.floor(Date.now() / 1000)
    upsertTask(getDb(), { id: 'tcl-l3-idovonal', verification_profile: 'code' } as Parameters<typeof upsertTask>[1], now)
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'TITKOS-SZOVEG-NEM-KELL', task_id: 'tcl-l3-idovonal' })
    await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'mas feladat', task_id: 'mas-feladat' })
    const items = taskTimeline(getDb(), 'tcl-l3-idovonal')
    const messages = items.filter((i) => i.source === 'message')
    expect(messages).toEqual([{ at: expect.any(Number), source: 'message', id: r.json.id, from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, status: 'pending' }])
    expect(JSON.stringify(items)).not.toContain('TITKOS-SZOVEG-NEM-KELL')
  })
})

describe('the envelope is byte for byte what it was', () => {
  it('a message with a task and one without wrap to the same text', async () => {
    const a = getAgentMessage((await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'azonos' })).json.id as number)!
    const b = getAgentMessage((await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'azonos', task_id: 'tcl-l3' })).json.id as number)!
    expect(b.task_id).toBe('tcl-l3')
    // the router's own two calls, with the row's fields, the id held equal
    const wrap = (m: typeof a) => {
      const cls = classifyAgentMessage(m.from_agent, m.to_agent)!
      return wrapAgentMessageForDelivery(cls.category, cls.safeFrom, m.from_agent, m.content, 1, m.origin_note)
    }
    expect(wrap(b)).toEqual(wrap(a))
  })
})

describe('agent-msg.sh --task', () => {
  let base: string
  let server: Server
  let port: number
  const seen: Record<string, unknown>[] = []

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'agent-msg-task-'))
    mkdirSync(join(base, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(base, 'store'))
    const repo = join(__dirname, '..', '..', 'scripts')
    for (const f of ['agent-msg.sh', 'local-now.sh', 'lib/dashboard-token.sh']) cpSync(join(repo, f), join(base, 'scripts', f))
    writeFileSync(join(base, 'store', '.dashboard-token'), 'proba-token\n', { mode: 0o600 })
    // the caller is the install's owner here: the resolver needs the main agent's name and its own token file
    // (scripts/lib/dashboard-token.sh: no .env or no own token is an error, not a shared-token fallback)
    writeFileSync(join(base, '.env'), 'MAIN_AGENT_ID=proba-fo\n')
    mkdirSync(join(base, 'store', 'tokens'))
    writeFileSync(join(base, 'store', 'tokens', 'proba-fo.token'), 'proba-token\n', { mode: 0o600 })
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push(JSON.parse(body) as Record<string, unknown>)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: seen.length, status: 'pending' }))
      })
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()))
    rmSync(base, { recursive: true, force: true })
  })

  // async on purpose: the fake dashboard answers from THIS process, so a
  // blocking spawnSync would leave curl waiting on a server that cannot run
  const send = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const p = spawn('bash', [join(base, 'scripts', 'agent-msg.sh'), ...args], {
        env: { ...process.env, MARVEEN_WEB_PORT: String(port) },
      })
      let stdout = ''
      p.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
      p.on('close', (status) => resolve({ status, stdout }))
    })

  it('sends task_id with the message, before or after --felulir', async () => {
    const n = seen.length
    expect((await send(['--task', 'tcl-l3', 'murena', 'acrobot', 'kesz'])).stdout).toMatch(/^OK id=/)
    expect((await send(['--felulir', '42', '--task', 'tcl-l3', 'murena', 'acrobot', 'kesz'])).stdout).toMatch(/^OK id=/)
    expect((await send(['--task', 'tcl-l3', '--felulir', '42', 'murena', 'acrobot', 'kesz'])).stdout).toMatch(/^OK id=/)
    expect(seen.slice(n).map((b) => b.task_id)).toEqual(['tcl-l3', 'tcl-l3', 'tcl-l3'])
    expect(String(seen[n + 1]!.content)).toMatch(/^FELULIRJA A\(Z\) 42 SZAMU UZENETET/)
  })

  it('without --task the body has no task_id at all', async () => {
    const n = seen.length
    expect((await send(['murena', 'acrobot', 'sima'])).stdout).toMatch(/^OK id=/)
    expect(Object.keys(seen[n]!).sort()).toEqual(['content', 'from', 'to'])
  })

  it('a malformed task id stops before anything is sent', async () => {
    const n = seen.length
    for (const bad of ['ket szo', '../x', '-x', '']) {
      const r = await send(['--task', bad, 'murena', 'acrobot', 'x'])
      expect(r.status).not.toBe(0)
    }
    expect(seen.length).toBe(n)
  })
})
