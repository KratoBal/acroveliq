// The router leg of task kezbesites-busy-panelre: a pane that is not idle but takes a queued
// message gets it, typed with no idle wait and the busy-aware landing check; one that does
// not take it keeps the message pending. WHAT TURNS THIS RED:
//   - a queue-ready busy pane is skipped (the 2026-10-14 symptom: 39 minutes, 7 waiting);
//   - the send waits for idle, or runs the idle-target landing check (no busyTarget);
//   - a pane that takes neither path gets keystrokes or a delivered mark;
//   - a send that typed nothing ('skipped-locked') is marked delivered or failed;
//   - (diagnostics, acrobot 30621) an attempt leaves no line, a line misses its path, result
//     or refusing look, a waiting message writes a line every tick instead of once per
//     reason, or a line carries the message text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockIsReady = vi.fn(async () => false)
const mockQueueRefusal = vi.fn(async (): Promise<string | null> => 'not-busy')
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
  queuedPromptRefusalForSession: (...a: unknown[]) => mockQueueRefusal(...(a as [])),
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
    mockQueueRefusal.mockResolvedValue('not-busy')
    mockSendPrompt.mockResolvedValue('sent')
  })

  it('ROUTER-QUEUE: a busy pane that takes a queued message gets it: no idle wait, busy-aware landing, delivered', async () => {
    mockGetPendingMessages.mockReturnValue([msg(1)])
    mockQueueRefusal.mockResolvedValue(null)
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt.mock.calls[0]![0]).toBe('agent-nautilus')
    expect(mockSendPrompt.mock.calls[0]![3]).toMatchObject({ waitForIdle: false, busyTarget: true })
    expect([mockMarkDelivered.mock.calls.map((c) => c[0]), mockMarkFailed.mock.calls.length]).toEqual([[1], 0])
  })

  it('ROUTER-IDLE-UNCHANGED: an idle pane takes the normal send (no busyTarget)', async () => {
    mockGetPendingMessages.mockReturnValue([msg(2)])
    mockIsReady.mockResolvedValue(true)
    await runMessageRouterTick()
    expect(mockQueueRefusal).not.toHaveBeenCalled()
    // the normal send: no busyTarget, no waitForIdle override; only the report callback (the broker's reason and the
    // takeover's note reach the idle diagnostic row, task kezbesites-enter-parkol)
    const opts = mockSendPrompt.mock.calls[0]![3] as { busyTarget?: boolean; waitForIdle?: boolean; onBusyReport?: unknown } | undefined
    expect([opts?.busyTarget, opts?.waitForIdle, typeof opts?.onBusyReport]).toEqual([undefined, undefined, 'function'])
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })

  it('ROUTER-HOLD: a pane that takes neither gets no keystrokes; the message stays pending, not failed', async () => {
    mockGetPendingMessages.mockReturnValue([msg(3)])
    await runMessageRouterTick()
    expect(mockQueueRefusal).toHaveBeenCalled()
    expect([mockSendPrompt.mock.calls.length, mockMarkDelivered.mock.calls.length, mockMarkFailed.mock.calls.length]).toEqual([0, 0, 0])
  })

  it('ROUTER-TYPED-NOTHING: a send that typed nothing, or did not land (a dialog came up), is neither delivered nor failed', async () => {
    for (const outcome of ['skipped-locked', 'not-landed']) {
      vi.clearAllMocks()
      mockGetPendingMessages.mockReturnValue([msg(4)])
      mockIsReady.mockResolvedValue(false)
      mockQueueRefusal.mockResolvedValue(null)
      mockSendPrompt.mockResolvedValue(outcome)
      await runMessageRouterTick()
      expect([outcome, mockSendPrompt.mock.calls.length, mockMarkDelivered.mock.calls.length, mockMarkFailed.mock.calls.length]).toEqual([outcome, 1, 0, 0])
    }
  })
})

describe('message router: delivery diagnostics', () => {
  let dir = ''
  const lines = () => {
    try {
      return readFileSync(join(dir, 'd.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  const strip = (l: Record<string, unknown>) => {
    const { ts, ...rest } = l
    expect(typeof ts).toBe('string')
    return rest
  }
  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'router-diag-'))
    process.env.DELIVERY_DIAG_LOG = join(dir, 'd.log')
    mockIsReady.mockResolvedValue(false)
    mockQueueRefusal.mockResolvedValue('not-busy')
    mockSendPrompt.mockResolvedValue('sent')
    return () => {
      delete process.env.DELIVERY_DIAG_LOG
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DIAG-QUEUED: a queued send writes path, result and the report the send handed back', async () => {
    mockGetPendingMessages.mockReturnValue([msg(11)])
    mockQueueRefusal.mockResolvedValue(null)
    mockSendPrompt.mockImplementation(async (...a: unknown[]) => {
      const opts = a[3] as { onBusyReport?: (r: unknown) => void }
      opts.onBusyReport?.({ result: 'not-landed', reason: 'permission-question', stage: 'chunk', chunk: 3, chunks: 40, retries: 0 })
      return 'not-landed'
    })
    await runMessageRouterTick()
    expect(lines().map(strip)).toEqual([
      { agent: 'nautilus', msg: 11, path: 'queued', result: 'not-landed', reason: 'permission-question', stage: 'chunk', chunk: 3, chunks: 40, retries: 0 },
    ])
  })

  it('DIAG-IDLE: an idle send writes its result, with no refusal', async () => {
    mockGetPendingMessages.mockReturnValue([msg(12)])
    mockIsReady.mockResolvedValue(true)
    await runMessageRouterTick()
    expect(lines().map(strip)).toEqual([{ agent: 'nautilus', msg: 12, path: 'idle', result: 'sent' }])
  })

  it('DIAG-SKIP-ONCE: a waiting message writes one line per refusing look, not one per tick', async () => {
    mockGetPendingMessages.mockReturnValue([msg(13)])
    for (const r of ['box-not-free', 'box-not-free', 'box-not-free', 'permission-question', 'permission-question']) {
      mockQueueRefusal.mockResolvedValue(r)
      await runMessageRouterTick()
    }
    expect(lines().map(strip)).toEqual([
      { agent: 'nautilus', msg: 13, path: 'skipped', result: 'waiting', reason: 'box-not-free' },
      { agent: 'nautilus', msg: 13, path: 'skipped', result: 'waiting', reason: 'permission-question' },
    ])
  })

  it('DIAG-NO-CONTENT: no line carries the message text', async () => {
    mockGetPendingMessages.mockReturnValue([msg(14)])
    mockQueueRefusal.mockResolvedValue('box-not-free')
    await runMessageRouterTick()
    mockQueueRefusal.mockResolvedValue(null)
    await runMessageRouterTick()
    const raw = readFileSync(join(dir, 'd.log'), 'utf8')
    expect([lines().length, raw.includes('feladat'), raw.includes('acrobot')]).toEqual([2, false, false])
  })
})
