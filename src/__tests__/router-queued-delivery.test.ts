// The router leg of task kezbesites-busy-panelre: a pane that is not idle but takes a queued
// message gets it, typed with no idle wait and the busy-aware landing check; one that does
// not take it keeps the message pending. WHAT TURNS THIS RED:
//   - a queue-ready busy pane is skipped (the 2026-10-14 symptom: 39 minutes, 7 waiting);
//   - the send waits for idle, or runs the idle-target landing check (no busyTarget);
//   - a pane that takes neither path gets keystrokes or a delivered mark;
//   - a send that typed nothing ('skipped-locked') is marked delivered or failed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockIsReady = vi.fn(async () => false)
const mockIsQueueReady = vi.fn(async () => false)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent')

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  isKnownAgent: () => true,
  agentDir: () => '/tmp/none-agentdir',
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsReady(...(a as [])),
  isSessionReadyForQueuedPrompt: (...a: unknown[]) => mockIsQueueReady(...(a as [])),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
}))

vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))

import { runMessageRouterTick } from '../web/message-router.js'

const msg = (id: number) => ({
  id, from_agent: 'acrobot', to_agent: 'nautilus', content: 'a feladat folytatasa', status: 'pending',
  created_at: Math.floor(Date.now() / 1000),
})

describe('message router: delivery into a busy pane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsReady.mockResolvedValue(false)
    mockIsQueueReady.mockResolvedValue(false)
    mockSendPrompt.mockResolvedValue('sent')
  })

  it('ROUTER-QUEUE: a busy pane that takes a queued message gets it: no idle wait, busy-aware landing, delivered', async () => {
    mockGetPendingMessages.mockReturnValue([msg(1)])
    mockIsQueueReady.mockResolvedValue(true)
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt.mock.calls[0]![0]).toBe('agent-nautilus')
    expect(mockSendPrompt.mock.calls[0]![3]).toEqual({ waitForIdle: false, busyTarget: true })
    expect([mockMarkDelivered.mock.calls.map((c) => c[0]), mockMarkFailed.mock.calls.length]).toEqual([[1], 0])
  })

  it('ROUTER-IDLE-UNCHANGED: an idle pane takes the normal send (no busyTarget)', async () => {
    mockGetPendingMessages.mockReturnValue([msg(2)])
    mockIsReady.mockResolvedValue(true)
    await runMessageRouterTick()
    expect(mockIsQueueReady).not.toHaveBeenCalled()
    expect(mockSendPrompt.mock.calls[0]![3]).toBeUndefined()
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })

  it('ROUTER-HOLD: a pane that takes neither gets no keystrokes; the message stays pending, not failed', async () => {
    mockGetPendingMessages.mockReturnValue([msg(3)])
    await runMessageRouterTick()
    expect(mockIsQueueReady).toHaveBeenCalled()
    expect([mockSendPrompt.mock.calls.length, mockMarkDelivered.mock.calls.length, mockMarkFailed.mock.calls.length]).toEqual([0, 0, 0])
  })

  it('ROUTER-TYPED-NOTHING: a send that typed nothing, or did not land (a dialog came up), is neither delivered nor failed', async () => {
    for (const outcome of ['skipped-locked', 'not-landed']) {
      vi.clearAllMocks()
      mockGetPendingMessages.mockReturnValue([msg(4)])
      mockIsReady.mockResolvedValue(false)
      mockIsQueueReady.mockResolvedValue(true)
      mockSendPrompt.mockResolvedValue(outcome)
      await runMessageRouterTick()
      expect([outcome, mockSendPrompt.mock.calls.length, mockMarkDelivered.mock.calls.length, mockMarkFailed.mock.calls.length]).toEqual([outcome, 1, 0, 0])
    }
  })
})
