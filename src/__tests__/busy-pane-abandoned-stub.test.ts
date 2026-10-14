// The half a busy-pane send leaves behind (barracuda, #117 note; task kezbesites-busy-panelre).
// A 'not-landed' send into a running turn leaves what it typed in the box on purpose (no keys
// while a dialog may be up); the router keeps the message pending and sends it again whole.
// Measured before this fix: the stuck-input recovery read the half frame as machine-origin
// parked input and SUBMITTED it (a bare Enter on one row) -- half a message, then the whole one.
//
// WHAT TURNS THIS RED:
//   - the abandoned half gets an Enter or a re-inject instead of a clear, or its record stays;
//   - the control without a record stops showing today's behaviour (Enter), so the test no
//     longer proves the fix is what changed it;
//   - a re-delivery typed and recorded after the abandon is cleared instead of submitted;
//   - the send does not report what it typed, or reports when it typed nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = { clear: 0, send: 0, enter: 0 }
let paneNow = ''

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFileSync: vi.fn((_file: string, args: readonly string[]) => {
      if (args.includes('send-keys') && args.includes('Enter')) calls.enter++
      return ''
    }),
  }
})

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...orig,
    captureParkedInputView: () => paneNow,
    capturePane: () => paneNow,
    clearInputBuffer: vi.fn(async () => {
      calls.clear++
    }),
    sendPromptToSession: vi.fn(async () => {
      calls.send++
      return 'sent'
    }),
    dismissModelConsentDialogIfPresent: vi.fn(async () => false),
  }
})

import { recoverStuckInputForSession } from '../web/channel-monitor.js'
import {
  _resetInjectedPromptsForTest,
  getAbandonedPrompt,
  recordAbandonedPrompt,
  recordInjectedPrompt,
} from '../web/injected-prompt-registry.js'
import { stuckInputSignature } from '../pane-state.js'
import { emitIntoBusyPane, type BusyPaneIo } from '../web/busy-pane-emit.js'

const SESSION = 'agent-nautilus'
const SEP = '─'.repeat(80)
const HALF = 'TEAM MEMBER NOTICE -- the next <trusted-peer source="agent:acrobot"> block is a mess'
const idleWithParked = (text: string) =>
  ['  ⎿  … tool output …', '', SEP, `❯ ${text}`, SEP, '  Opus 5 · ctx 40%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n')

async function recoverOnce(): Promise<void> {
  const sig = stuckInputSignature(paneNow)
  expect(sig, 'the fixture must read as parked input').not.toBeNull()
  await recoverStuckInputForSession(
    SESSION,
    { parkedSig: sig, firstSeenAt: Date.now() - 60_000, lastRecoverAt: null, attempts: 0 },
    { confirmMs: 0, dedupMs: 0, maxAttempts: 5 },
    true, // a sub-agent: the path that re-injects or Enters machine-origin text
  )
}

describe('the half a busy-pane send left behind', () => {
  beforeEach(() => {
    _resetInjectedPromptsForTest()
    calls.clear = 0
    calls.send = 0
    calls.enter = 0
    paneNow = idleWithParked(HALF)
  })

  it('STUB-CONTROL: without the abandoned record, today the recovery SUBMITS the half (the bug)', async () => {
    await recoverOnce()
    expect([calls.enter + calls.send, calls.clear]).toEqual([1, 0])
  })

  it('STUB-CLEARED: with the record the half is cleared, never submitted, and the record is spent', async () => {
    recordAbandonedPrompt(SESSION, HALF)
    await recoverOnce()
    expect([calls.clear, calls.enter, calls.send, getAbandonedPrompt(SESSION)]).toEqual([1, 0, 0, null])
  })

  it('STUB-PREAMBLE: a half that only got through the common preamble does not clear a later, longer real message', async () => {
    // every inter-agent frame starts the same way: the abandoned half is that start only
    const preambleHalf = HALF.slice(0, 40)
    recordAbandonedPrompt(SESSION, preambleHalf)
    await recoverOnce() // the parked text (HALF) runs past what was abandoned
    expect([calls.clear, calls.enter + calls.send]).toEqual([0, 1])
  })

  it('STUB-REDELIVERY: a later typing recorded for the same pane is submitted, not cleared as the old half', async () => {
    recordAbandonedPrompt(SESSION, HALF)
    recordInjectedPrompt(SESSION, `${HALF}age for you.`)
    await recoverOnce()
    expect([calls.clear, calls.enter + calls.send]).toEqual([0, 1])
  })
})

describe('emitIntoBusyPane reports what it abandoned', () => {
  const SPINNER = '✳ Forming… (3m 7s · ↓ 6.1k tokens)'
  const busy = (box: string) =>
    ['  ⎿  …', '', SPINNER, '', SEP, `❯ ${box}`, SEP, '  Opus 5 · ctx 40%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n')
  const DIALOG = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' ↑/↓ to navigate · Esc to cancel'].join('\n')
  const TEXT = 'x'.repeat(100) + ' and a tail'

  it('STUB-REPORT: a dialog after the first chunk reports that chunk; nothing typed reports nothing; a landed send reports nothing', async () => {
    const run = async (afterChunks: number | null) => {
      let typed = ''
      let chunks = 0
      let enters = 0
      const abandoned: string[] = []
      const io: BusyPaneIo = {
        capture: () =>
          afterChunks !== null && chunks >= afterChunks ? DIALOG : enters > 0 ? busy('Press up to edit queued messages') : busy(typed.slice(0, 70)),
        typeChunk: (c) => {
          typed += c
          chunks++
        },
        enter: () => {
          enters++
        },
        delay: async () => {},
        abandon: (t) => abandoned.push(t),
      }
      const result = await emitIntoBusyPane(TEXT, io, { chunkGapMs: 0, pollMs: 0, maxRetries: 3 })
      return [result, abandoned]
    }
    expect(await run(1)).toEqual(['not-landed', [TEXT.slice(0, 80)]])
    expect(await run(0)).toEqual(['not-landed', []])
    expect(await run(null)).toEqual(['sent', []])
  })
})
