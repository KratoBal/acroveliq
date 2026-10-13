import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// every tmux call (and every other subprocess) of agent-process goes through
// execFileSync: counting it is counting "did anything start or stop"
const subprocessCalls: string[][] = []
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFileSync: vi.fn((file: string, args: string[] = []) => {
      subprocessCalls.push([file, ...args])
      throw new Error('no subprocess in this test')
    }),
    // the real --help probe (asynchronous): answers with whatever asyncHelp holds
    execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      asyncProbeCalls.push([file, ...args])
      setTimeout(() => cb(null, asyncHelp.text), 0)
    }),
  }
})
const asyncProbeCalls: string[][] = []
const asyncHelp = { text: '' }

import { agentDir } from '../web/agent-config.js'
import {
  claudeSupportsSessionId,
  launchSessionFlag,
  restartAgentProcess,
  sessionIdLaunchError,
  SESSION_ID_RE,
  setClaudeHelpProbeForTests,
  startAgentProcess,
} from '../web/agent-process.js'

/*
  A SESSION ID FOR A FRESH LAUNCH (TC-Lite L2). What turns these red: a
  session id reaching tmux with a resumed launch, with a malformed id, on a
  remote agent, or with a CLI that has no --session-id flag; a refused restart
  stopping the agent first; the launch flag changing for a launch WITHOUT a
  session id (the regression the plan names: byte for byte today's); the flag
  not standing where --continue stood.
*/

const AGENT = 'tcl-l2-proba-local'
const REMOTE = 'tcl-l2-proba-remote'
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const HELP_WITH = '  -c, --continue   Continue\n  --session-id <uuid>   Use a specific session ID\n'
const HELP_WITHOUT = '  -c, --continue   Continue\n  --resume   Resume\n'

beforeAll(() => {
  mkdirSync(agentDir(AGENT), { recursive: true })
  writeFileSync(join(agentDir(AGENT), 'agent-config.json'), '{}')
  mkdirSync(agentDir(REMOTE), { recursive: true })
  writeFileSync(join(agentDir(REMOTE), 'agent-config.json'), JSON.stringify({ remoteHost: 'laptop.example', remoteWorkdir: '/home/user/proj' }))
})
afterAll(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(agentDir(REMOTE), { recursive: true, force: true })
})
beforeEach(() => {
  subprocessCalls.length = 0
  setClaudeHelpProbeForTests(() => HELP_WITH)
})

describe('the flag at the --continue position', () => {
  it('without a session id it is byte for byte the old expression, for every combination', () => {
    const old = (hasPriorSession: boolean, fresh: boolean, hasChannel: boolean) =>
      (hasPriorSession && !fresh && !hasChannel) ? '--continue ' : ''
    for (const hasPriorSession of [false, true])
      for (const fresh of [false, true])
        for (const hasChannel of [false, true])
          expect(launchSessionFlag({ hasPriorSession, fresh, hasChannel })).toBe(old(hasPriorSession, fresh, hasChannel))
  })

  it('with a session id it is --session-id <uuid>, and never --continue', () => {
    for (const hasPriorSession of [false, true])
      for (const hasChannel of [false, true]) {
        const flag = launchSessionFlag({ hasPriorSession, fresh: true, hasChannel, sessionId: UUID })
        expect(flag).toBe(`--session-id ${UUID} `)
        expect(flag).not.toContain('--continue')
      }
  })

  it('stands exactly where --continue stood in the launch command', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf8')
    expect(src).toContain('const continueFlag = launchSessionFlag({ hasPriorSession, fresh: opts.fresh, hasChannel, sessionId: opts.sessionId })')
    expect(src).toContain('${claudeBin()} ${continueFlag}${skipFlag}--model ${shSingleQuote(model)} ${channelFlag}')
  })

  it('the server-made id (crypto.randomUUID) has the accepted shape; others do not', () => {
    expect(SESSION_ID_RE.test(crypto.randomUUID())).toBe(true)
    for (const bad of [UUID.toUpperCase(), `${UUID} --dangerously-skip-permissions`, UUID.slice(1), '', 'x'])
      expect(SESSION_ID_RE.test(bad)).toBe(false)
  })
})

describe('a launch with a session id is refused before anything starts or stops', () => {
  it.each([
    ['a resumed launch', { fresh: false, sessionId: UUID }, 'needs fresh'],
    ['a malformed id', { fresh: true, sessionId: 'not-a-uuid' }, 'lowercase UUID'],
    ['an id with a flag behind it', { fresh: true, sessionId: `${UUID} --resume x` }, 'lowercase UUID'],
  ])('start: %s', async (_name, opts, part) => {
    const r = await startAgentProcess(AGENT, opts)
    expect(r.ok).toBe(false)
    expect(r.error).toContain(part)
    expect(subprocessCalls).toEqual([])
  })

  it('restart: refused BEFORE the stop, so the agent is not left stopped', async () => {
    const r = await restartAgentProcess(AGENT, { fresh: false, sessionId: UUID })
    expect(r.error).toContain('needs fresh')
    expect(subprocessCalls).toEqual([])
  })

  it('a remote agent: an error, not a silently dropped id', async () => {
    for (const run of [() => startAgentProcess(REMOTE, { fresh: true, sessionId: UUID }), () => restartAgentProcess(REMOTE, { fresh: true, sessionId: UUID })]) {
      const r = await run()
      expect(r.error).toContain('remote')
    }
    expect(subprocessCalls).toEqual([])
  })

  it('a CLI without --session-id: refused instead of an agent that dies in tmux', async () => {
    setClaudeHelpProbeForTests(() => HELP_WITHOUT)
    const r = await startAgentProcess(AGENT, { fresh: true, sessionId: UUID })
    expect(r.error).toContain('no --session-id flag')
    expect(subprocessCalls).toEqual([])
  })

  it('a valid request passes the check (and only then would the launch go on)', async () => {
    expect(await sessionIdLaunchError(AGENT, { fresh: true, sessionId: UUID })).toBeNull()
    expect(await sessionIdLaunchError(AGENT, { fresh: true })).toBeNull()
    expect(await sessionIdLaunchError(AGENT, {})).toBeNull()
  })
})

describe('the --help probe', () => {
  it('a positive answer is cached; a failed probe is asked again next time', async () => {
    let calls = 0
    setClaudeHelpProbeForTests(() => {
      calls++
      throw new Error('timeout')
    })
    expect(await claudeSupportsSessionId()).toBe(false)
    expect(await claudeSupportsSessionId()).toBe(false)
    expect(calls).toBe(2)
    setClaudeHelpProbeForTests(() => {
      calls++
      return HELP_WITH
    })
    expect(await claudeSupportsSessionId()).toBe(true)
    expect(await claudeSupportsSessionId()).toBe(true)
    expect(calls).toBe(3)
  })

  it('the flag must be an option line, not a word in some description', async () => {
    setClaudeHelpProbeForTests(() => '  --resume   Resume; see also --session-id in the docs\n')
    expect(await claudeSupportsSessionId()).toBe(false)
  })

  it('the real probe is asynchronous: execFile, never execFileSync', async () => {
    asyncProbeCalls.length = 0
    asyncHelp.text = HELP_WITH
    setClaudeHelpProbeForTests(null)
    expect(await claudeSupportsSessionId()).toBe(true)
    expect(asyncProbeCalls).toEqual([['claude-test-bin', '--help']])
    expect(subprocessCalls).toEqual([])
  })

  it('launches that arrive while a probe runs share that one probe', async () => {
    const pending: Array<(text: string) => void> = []
    const answerAll = (text: string) => pending.splice(0).forEach((r) => r(text))
    setClaudeHelpProbeForTests(() => new Promise<string>((r) => pending.push(r)))
    const first = claudeSupportsSessionId()
    const second = claudeSupportsSessionId()
    expect(pending.length).toBe(1)
    answerAll(HELP_WITHOUT)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    // the failed probe is not cached: the next launch asks again
    const third = claudeSupportsSessionId()
    expect(pending.length).toBe(1)
    answerAll(HELP_WITHOUT)
    expect(await third).toBe(false)
  })
})
