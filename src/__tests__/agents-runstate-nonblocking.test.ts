import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Card b8ed4f45, slice (a) (task t-20261114-agents-runstate-nonblocking, acrobot 52364): after #362 took the pane
// captures off the main thread, every local agent in /api/agents and /api/agents/activity still cost one or two
// SYNCHRONOUS tmux children per request (`list-sessions` for the run state, `display-message` for the start time), each
// a `sudo fleet-pane` on the broker. Measured on the live host after #362: /api/agents 0.69-0.76 s, activity
// 0.42-0.48 s. WHAT TURNS THIS RED: a dashboard list request that starts a synchronous tmux child again; a run state
// or start time that is no longer shared between concurrent readers; an agent shown as running that is not.
const tmux = vi.hoisted(() => ({
  syncCalls: [] as string[],
  sessions: [] as string[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((file: string, args: string[], ...rest: unknown[]) => {
      const verb = ['list-sessions', 'display-message', 'capture-pane'].find((v) => args?.includes(v))
      if (!verb) return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, ...rest)
      tmux.syncCalls.push(verb)
      return tmuxAnswer(args)
    }) as typeof actual.execFileSync,
  }
})

const IDLE_PANE = ['some output', '❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
function tmuxAnswer(args: string[]): string {
  if (args.includes('list-sessions')) return tmux.sessions.join('\n') + '\n'
  if (args.includes('display-message')) return '1700000000\n'
  return IDLE_PANE
}

import { agentDir } from '../web/agent-config.js'
import {
  agentSessionName,
  resetPaneSnapshotsForTest,
  setCaptureExecForTest,
} from '../web/agent-process.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import { PROJECT_ROOT } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'
import { join } from 'node:path'

const NAMES = ['zz-runstate-a', 'zz-runstate-b', 'zz-runstate-c', 'zz-runstate-d']
const asyncCalls: string[] = []

function slowAsyncExec(delayMs: number) {
  return ((_file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
    const verb = ['list-sessions', 'display-message', 'capture-pane'].find((v) => args.includes(v)) ?? 'other'
    asyncCalls.push(verb)
    setTimeout(() => cb(null, tmuxAnswer(args)), delayMs)
    return { stdin: { end: () => undefined } }
  }) as unknown as never
}

function call(path: string): Promise<{ status: number; rows: Array<Record<string, unknown>> }> {
  let body = ''
  const out = { status: 200 }
  const res = {
    setHeader() { return res },
    writeHead(code: number) { out.status = code; return res },
    end(chunk?: string | Buffer) { if (chunk) body += chunk.toString() },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} }, res, path: url.pathname, method: 'GET', url, surface: 'dashboard' } as unknown as RouteContext
  return tryHandleAgents(ctx, join(PROJECT_ROOT, 'web')).then(() => ({ status: out.status, rows: JSON.parse(body) }))
}

beforeEach(() => {
  for (const name of NAMES) mkdirSync(agentDir(name), { recursive: true })
  tmux.syncCalls.length = 0
  asyncCalls.length = 0
  tmux.sessions = NAMES.map((n) => agentSessionName(n))
  resetPaneSnapshotsForTest()
  setCaptureExecForTest(slowAsyncExec(5))
})
afterEach(() => {
  setCaptureExecForTest(null)
  for (const name of NAMES) rmSync(agentDir(name), { recursive: true, force: true })
})

describe('the dashboard agent list starts no synchronous tmux child', () => {
  it('GET /api/agents: four running agents, no sync tmux child, and the agents show as running with their start time', async () => {
    const { status, rows } = await call('/api/agents')
    expect(status).toBe(200)
    const mine = rows.filter((r) => NAMES.includes(r.name as string))
    expect(mine.length).toBe(NAMES.length)
    // positive control on the instrument: the fixture really made them "running", with the fixed start time
    for (const row of mine) {
      expect(row.running).toBe(true)
      expect(row.runningSince).toBe(1700000000)
    }
    expect(tmux.syncCalls).toEqual([])
  })

  it('GET /api/agents/activity: the same, and the states are read', async () => {
    const { status, rows } = await call('/api/agents/activity')
    expect(status).toBe(200)
    const mine = rows.filter((r) => NAMES.includes(r.name as string))
    expect(mine.length).toBe(NAMES.length)
    for (const row of mine) expect(row.running).toBe(true)
    expect(tmux.syncCalls).toEqual([])
  })

  it('a second request inside the snapshot window starts no new child of any kind', async () => {
    await call('/api/agents')
    const first = asyncCalls.length
    expect(first).toBeGreaterThan(0)
    await call('/api/agents')
    await call('/api/agents/activity')
    // the pane for the activity tail may be new (the list has none); the run state and start time must not be
    const again = asyncCalls.slice(first)
    expect(again.filter((v) => v === 'list-sessions' || v === 'display-message')).toEqual([])
  })

  it('an agent that is not in the session list shows as stopped', async () => {
    tmux.sessions = NAMES.slice(0, 2).map((n) => agentSessionName(n))
    const { rows } = await call('/api/agents')
    const byName = new Map(rows.map((r) => [r.name as string, r]))
    expect(byName.get(NAMES[0]!)!.running).toBe(true)
    expect(byName.get(NAMES[3]!)!.running).toBe(false)
  })
})

// Wiring the behaviour tests cannot see: /api/overview needs the database, and a start or stop cannot run here.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('wiring: the other readers and the invalidation', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const overview = readFileSync(join(root, 'routes', 'overview.ts'), 'utf8')
  const agentsRoute = readFileSync(join(root, 'routes', 'agents.ts'), 'utf8')
  const processSrc = readFileSync(join(root, 'agent-process.ts'), 'utf8')

  it('/api/overview reads the run states from the snapshots, not one sync child per agent', () => {
    expect(overview).toContain('agentRunStateSnapshot(')
    expect(overview).not.toMatch(/\bisAgentRunning\(/)
  })

  it('the agent routes call neither sync run-state reader for a list, an activity row or a detail', () => {
    expect(agentsRoute).not.toMatch(/\bagentRunState\(/)
    expect(agentsRoute).not.toMatch(/\bgetAgentRunningSince\(/)
  })

  it('a start, a stop and a restart drop the cached state of that agent when they finish', () => {
    for (const fn of ['startAgentProcess', 'stopAgentProcess', 'restartAgentProcess']) {
      const at = processSrc.indexOf(`export async function ${fn}(`)
      expect(at, fn).toBeGreaterThan(-1)
      const body = processSrc.slice(at, at + 400)
      expect(body, fn).toContain('invalidateAgentLive(name)')
      expect(body, fn).toContain('finally')
    }
  })
})
