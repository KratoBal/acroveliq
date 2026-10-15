// startAgentProcess with the fleet-pane broker on (B48 (2), the second PR; task
// t-20261015-b48-fleet-pane). WHAT TURNS THIS RED: with the switch on, an agent under its own
// user is started by anything but `generate` + `start` (a new-session with the router's command
// string, through the broker or the old sudo line); the launch choice reaches the broker as
// anything but the closed list; a refused generate still starts, or reads as ok.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Call = { file: string; args: string[] }
const calls: Call[] = []
let brokerAnswer: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: 'ok' })

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  const answer = (args: readonly string[]) => {
    const a = [...args]
    // the agent is not running until started: `status` exits 1
    if (a[1] === '/usr/local/sbin/fleet-pane' && a[2] === 'status') return { code: 1, out: '' }
    if (a[1] === '/usr/local/sbin/fleet-pane') return brokerAnswer(a.slice(2))
    return { code: 0, out: '' }
  }
  return {
    ...orig,
    execFileSync: vi.fn((file: string, args: readonly string[] = []) => {
      calls.push({ file, args: [...args] })
      const r = answer(args)
      if (r.code !== 0) throw Object.assign(new Error('exit'), { status: r.code, stdout: r.out })
      return r.out
    }),
    execFile: vi.fn((file: string, args: readonly string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
      calls.push({ file, args: [...args] })
      const r = answer(args)
      const child = { stdin: { end: () => setImmediate(() => cb(r.code === 0 ? null : Object.assign(new Error('exit'), { code: r.code }), r.out, '')) } }
      return child
    }),
  }
})

const AGENT = 'fp-start-proba'
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    listAgentNames: () => [AGENT],
    readAgentRunAsUser: (n: string) => (n === AGENT ? `agent-${AGENT}` : null),
    readAgentRunIdentity: () => ({ ok: true, runAsUser: `agent-${AGENT}` }),
  }
})

import { agentDir } from '../web/agent-config.js'
import { setClaudeHelpProbeForTests, startAgentProcess } from '../web/agent-process.js'
import { _setFleetPaneBrokerForTest, FLEET_PANE_BIN } from '../web/fleet-pane.js'

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const brokerCalls = () => calls.filter((c) => c.file === 'sudo' && c.args[1] === FLEET_PANE_BIN).map((c) => c.args.slice(2))

// the router resolves claude and tmux on PATH before the launch; CI has neither: inert stand-ins
const BIN = mkdtempSync(join(tmpdir(), 'fp-start-bin-'))
for (const b of ['claude', 'tmux']) {
  writeFileSync(join(BIN, b), '#!/bin/sh\nexit 0\n')
  chmodSync(join(BIN, b), 0o755)
}
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
// the launch stamps trust and consent into $HOME/.claude.json when there is no fleet token: not ours
process.env.HOME = mkdtempSync(join(tmpdir(), 'fp-start-home-'))
const HOME = process.env.HOME

beforeAll(() => {
  mkdirSync(agentDir(AGENT), { recursive: true })
  writeFileSync(join(agentDir(AGENT), 'agent-config.json'), JSON.stringify({ model: 'claude-opus-5-5', securityProfile: 'reviewer' }))
})
afterAll(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(BIN, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
})
beforeEach(() => {
  calls.length = 0
  brokerAnswer = () => ({ code: 0, out: 'ok' })
  setClaudeHelpProbeForTests(() => '  --session-id <uuid>   Use a specific session ID\n')
  _setFleetPaneBrokerForTest(true)
})
afterEach(() => _setFleetPaneBrokerForTest(null))

describe('startAgentProcess with the broker on', () => {
  it.each([
    ['fresh', { fresh: true }, []],
    ['with a session id', { fresh: true, sessionId: UUID }, ['--session-id', UUID]],
  ])('FPS-START %s: generate, then start with the closed list; no new-session leaves the router', async (_n, opts, launch) => {
    const r = await startAgentProcess(AGENT, opts)
    expect(r).toEqual({ ok: true })
    const verbs = brokerCalls().filter((a) => a[0] === 'generate' || a[0] === 'start')
    expect(verbs).toEqual([['generate', AGENT], ['start', AGENT, ...launch]])
    expect(calls.some((c) => c.args.includes('new-session'))).toBe(false)
    expect(calls.some((c) => c.file === 'sudo' && c.args.includes('-u'))).toBe(false)
  }, 15_000)

  it('FPS-REFUSED: a refused generate is a failed start with the reason, and nothing is started', async () => {
    brokerAnswer = (a) => (a[0] === 'generate' ? { code: 10, out: 'model-not-allowed' } : { code: 0, out: 'ok' })
    const r = await startAgentProcess(AGENT, { fresh: true })
    expect(r).toEqual({ ok: false, error: 'fleet-pane generate refused: model-not-allowed' })
    expect(brokerCalls().some((a) => a[0] === 'start')).toBe(false)
  }, 15_000)
})
