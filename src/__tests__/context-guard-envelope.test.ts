import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Card 02068ee2: every text the context guard writes straight into a pane
// (handoff request, idle-flush routine, stale-handoff refresh, resume prompt)
// is unauthenticated -- send-keys bypasses the message queue, so the
// recipient's provenance gate sees a bare prompt. The panel write stays, and an
// identical copy must follow on the inter-agent queue, where the router stamps
// a provenance envelope on it. This suite drives checkAgent through each of the
// four panel branches with a scripted decision and pins the pairing, the
// sender choice, the ordering, and the restart-time cleanup.

const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-envelope-'))
const AGENTS = join(SANDBOX, 'agents')

const calls: string[] = []
let nextMsgId = 100
let remoteHost: string | null = null
let panelFails = false
let decision: { action: string; reason: string; nextState: Record<string, unknown> } = {
  action: 'none', reason: '', nextState: {},
}

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn((from: string, to: string) => {
    calls.push(`message ${from}->${to}`)
    return { id: nextMsgId++ }
  }),
  closeMessagesWithoutDelivery: vi.fn((ids: number[]) => {
    calls.push(`close ${ids.join(',')}`)
    return ids.length
  }),
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => {
    calls.push('restart main')
    return { ok: true }
  }),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: vi.fn(async (n: string) => { calls.push(`restart ${n}`) }),
  capturePane: () => 'pane',
  sendPromptToSession: vi.fn(async (session: string) => {
    if (panelFails) throw new Error('tmux gone')
    calls.push(`panel ${session}`)
  }),
  isSessionReadyForPrompt: async () => true,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, readAgentRemoteHost: () => remoteHost, readAgentModel: () => 'claude-opus-5-5' }
})
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => 900_000,
  readActiveModelFromProjectDir: () => 'claude-opus-5-5',
  readTranscriptMtimeFromProjectDir: () => Date.now(),
}))
vi.mock('../web/context-guard-store.js', async () => {
  const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
  return { readContextGuardConfig: () => ({ ...DEFAULT_CONTEXT_GUARD, enabled: true }) }
})
vi.mock('../context-guard.js', async (orig) => {
  const actual = await orig<typeof import('../context-guard.js')>()
  return { ...actual, decideGuard: () => decision }
})

const runner = await import('../web/context-guard-runner.js')
const db = await import('../db.js')
const agentProcess = await import('../web/agent-process.js')
const { INITIAL_GUARD_STATE, IDLE_FLUSH_REASON_PREFIX, STALE_REFRESH_REASON_PREFIX } = await import('../context-guard.js')
const { classifyAgentMessage } = await import('../web/agent-message-wrap.js')

const createMsg = vi.mocked(db.createAgentMessage)
const sendPanel = vi.mocked(agentProcess.sendPromptToSession)

function decide(action: string, reason: string, phase: string): void {
  decision = { action, reason, nextState: { ...INITIAL_GUARD_STATE, phase } }
}

// The panel text and the envelope content as the guard actually sent them.
function sentPair(): { panel: string; envelope: string; from: string; to: string; origin: unknown } {
  expect(sendPanel).toHaveBeenCalledTimes(1)
  expect(createMsg).toHaveBeenCalledTimes(1)
  const [from, to, envelope, origin] = createMsg.mock.calls[0]
  return { panel: String(sendPanel.mock.calls[0][1]), envelope: String(envelope), from, to, origin }
}

beforeEach(() => {
  // The queued-copy registry is module state; earlier cases must not leak ids.
  runner.closeQueuedEnvelopes('samu')
  runner.closeQueuedEnvelopes('marveen')
  calls.length = 0
  remoteHost = null
  panelFails = false
  createMsg.mockClear()
  sendPanel.mockClear()
  vi.mocked(db.closeMessagesWithoutDelivery).mockClear()
  rmSync(AGENTS, { recursive: true, force: true })
  for (const n of ['marveen', 'samu']) mkdirSync(join(AGENTS, n), { recursive: true })
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('every panel branch is followed by an identical envelope copy', () => {
  const branches: Array<[string, string, string, string]> = [
    ['critical handoff request', 'request-handoff', 'pct 0.91 >= act 0.9', 'HANDOFF.md-t'],
    ['idle-flush routine', 'request-handoff', `${IDLE_FLUSH_REASON_PREFIX}: quiet 25m`, 'Rutin karbantartás'],
    ['stale-handoff refresh', 'request-handoff', `${STALE_REFRESH_REASON_PREFIX}: 12m`, 'frissítsd a HANDOFF.md-t'],
    ['resume prompt', 'inject-resume', 'session ready', 'Friss kontextussal indultál'],
  ]
  for (const [label, action, reason, marker] of branches) {
    it(label, async () => {
      decide(action, reason, 'await-handoff')
      await runner.checkAgent('samu', Date.now())

      const { panel, envelope, from, to, origin } = sentPair()
      // The decision really took this branch -- a marker of that prompt's own
      // wording, so four passing cases are not one branch counted four times.
      expect(panel).toContain(marker)
      expect(to).toBe('samu')
      expect(origin).toBe(runner.GUARD_ENVELOPE_ORIGIN)
      // Identical content: the full panel text rides inside the envelope.
      expect(envelope).toContain(panel)
      expect(envelope.startsWith('[CONTEXT-GUARD BORÍTÉK]')).toBe(true)
      // The panel announces the copy and names its sender, so a panel prompt
      // with no matching envelope is itself recognisable.
      expect(panel).toContain(`feladó: ${from}`)
      // Panel first, then the copy.
      expect(calls).toEqual(['panel agent-samu', 'message marveen->samu'])
    })
  }
})

describe('envelope sender, measured against the real classifier', () => {
  it('a sub-agent receives the copy as <trusted-peer> (sender = main agent)', () => {
    expect(runner.guardEnvelopeSender('samu')).toBe('marveen')
    expect(classifyAgentMessage(runner.guardEnvelopeSender('samu'), 'samu')?.category).toBe('trusted-peer')
  })

  it('a made-up guard sender would arrive as <untrusted> -- the reason it is not used', () => {
    expect(classifyAgentMessage(runner.GUARD_ENVELOPE_ORIGIN, 'samu')?.category).toBe('untrusted')
  })

  it('the main agent cannot get <trusted-peer> from itself; it gets the router-style system sender', async () => {
    expect(classifyAgentMessage('marveen', 'marveen')?.category).toBe('untrusted')
    expect(runner.guardEnvelopeSender('marveen')).toBe('system')

    decide('request-handoff', 'pct 0.91 >= act 0.9', 'await-handoff')
    await runner.checkAgent('marveen', Date.now())
    const { from, to, panel } = sentPair()
    expect([from, to]).toEqual(['system', 'marveen'])
    expect(panel).toContain('feladó: system')
    expect(calls).toEqual(['panel marveen-channels', 'message system->marveen'])
  })
})

describe('failure paths', () => {
  it('no envelope when the panel write failed: a copy without its original would be unexplained', async () => {
    panelFails = true
    decide('request-handoff', 'pct 0.91 >= act 0.9', 'await-handoff')
    await runner.checkAgent('samu', Date.now())
    expect(createMsg).not.toHaveBeenCalled()
  })

  it('a failing queue write does not throw out of the guard', async () => {
    createMsg.mockImplementationOnce(() => { throw new Error('db locked') })
    await expect(runner.sendGuardPrompt('samu', 'agent-samu', 'x')).resolves.toBeUndefined()
    expect(calls).toEqual(['panel agent-samu'])
  })

  it('a remote-host agent gets neither a panel prompt nor an envelope', async () => {
    remoteHost = 'remote.example'
    decide('request-handoff', 'pct 0.91 >= act 0.9', 'await-handoff')
    await runner.checkAgent('samu', Date.now())
    expect(sendPanel).not.toHaveBeenCalled()
    expect(createMsg).not.toHaveBeenCalled()
  })
})

describe('restart closes the copies addressed to the previous session', () => {
  it('a pending handoff-request copy is closed BEFORE the restart, never handed to the fresh session', async () => {
    decide('request-handoff', 'pct 0.91 >= act 0.9', 'await-handoff')
    await runner.checkAgent('samu', Date.now())
    const queuedId = (createMsg.mock.results[0].value as { id: number }).id

    calls.length = 0
    decide('restart', 'handoff written', 'await-ready')
    await runner.checkAgent('samu', Date.now())
    expect(calls.slice(0, 2)).toEqual([`close ${queuedId}`, 'restart samu'])

    // Closed once: a second restart has nothing left to close.
    calls.length = 0
    expect(runner.closeQueuedEnvelopes('samu')).toBe(0)
    expect(calls).toEqual([])
  })
})
