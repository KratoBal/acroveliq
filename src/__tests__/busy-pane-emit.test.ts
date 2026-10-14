// Typing into a BUSY pane with a look before every key (busy-pane-emit.ts; barracuda, #117
// review: a permission question can appear mid-typing in a running turn, and then a digit
// picks an option and the closing Enter confirms "yes"). A scripted pane plays the turn.
//
// WHAT TURNS THIS RED:
//   - a chunk, an Enter or a retry Enter goes out after the pane turned into a permission
//     question or a menu, or the result is 'sent' then;
//   - the Enter goes out while the head of our text is not in the live box;
//   - a dialog that shows up after the Enter counts as landed;
//   - the happy path does not type every chunk and submit once, or does not end 'sent';
//   - the chunking differs from the idle path's dash rule.
import { describe, it, expect } from 'vitest'
import { emitIntoBusyPane, splitForSendKeys, type BusyPaneIo } from '../web/busy-pane-emit.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const SPINNER = '✳ Forming… (3m 7s · ↓ 6.1k tokens)'
const busyWithBox = (box: string) => ['  ⎿  … tool output …', '', SPINNER, '', SEP, `❯ ${box}`, SEP, '  Opus 5 · ctx 40%', FOOTER].join('\n')
const PERMISSION = [
  '  ⎿  … tool output …',
  ' Bash command',
  '   git push origin main',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for git push commands",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' ↑/↓ to navigate · Esc to cancel',
].join('\n')

// A message with digits in it, long enough for several chunks.
const TEXT =
  'TEAM MEMBER NOTICE -- msg 30413, PR #117, 2 pontban: 1) a teszt 2) a review; ' +
  'a kuldes ideje 2026-10-14 13:10:42, kerlek nezd at a 3 fajlt es a 12 kalibraciot, koszonom.'

type Step = 'chunk' | 'enter'

/** A pane that follows the typing, and can be told to show the permission dialog from a point on. */
function scriptedPane(opts: { dialogAfterChunks?: number; dialogAfterEnters?: number; dialogFromCapture?: number; boxKeepsTextAfterEnters?: number }) {
  let typed = ''
  let chunks = 0
  let enters = 0
  let captures = 0
  const steps: Array<[Step, string]> = []
  const dialog = () =>
    (opts.dialogAfterChunks !== undefined && chunks >= opts.dialogAfterChunks) ||
    (opts.dialogAfterEnters !== undefined && enters >= opts.dialogAfterEnters) ||
    (opts.dialogFromCapture !== undefined && captures >= opts.dialogFromCapture)
  const io: BusyPaneIo = {
    capture: () => {
      captures++
      if (dialog()) return PERMISSION
      // after an Enter the line leaves the box (queued), unless told to stay for N Enters
      const keep = enters > 0 && enters <= (opts.boxKeepsTextAfterEnters ?? 0)
      if (enters > 0 && !keep) return busyWithBox('Press up to edit queued messages')
      return busyWithBox(typed.slice(0, 70))
    },
    typeChunk: (c) => {
      if (dialog()) steps.push(['chunk', `INTO-DIALOG:${c}`])
      else steps.push(['chunk', c])
      typed += c
      chunks++
    },
    enter: () => {
      steps.push(['enter', dialog() ? 'INTO-DIALOG' : 'box'])
      enters++
    },
    delay: async () => {},
  }
  return { io, steps }
}
const CFG = { chunkGapMs: 0, pollMs: 0, maxRetries: 3 }

describe('emitIntoBusyPane', () => {
  it('BUSY-EMIT-OK: every chunk typed, one Enter into the box, then the line leaves the box: sent', async () => {
    const { io, steps } = scriptedPane({})
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('sent')
    expect(steps.filter(([k]) => k === 'chunk').map(([, c]) => c).join('')).toBe(TEXT)
    expect(steps.filter(([k]) => k === 'enter')).toEqual([['enter', 'box']])
  })

  it('BUSY-EMIT-DIALOG-MIDWAY: the dialog appears after the first chunk: nothing more is typed, no Enter, not landed', async () => {
    const { io, steps } = scriptedPane({ dialogAfterChunks: 1 })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('not-landed')
    expect(steps.map(([k]) => k)).toEqual(['chunk'])
    expect(steps.some(([, v]) => v.startsWith('INTO-DIALOG'))).toBe(false)
  })

  it('BUSY-EMIT-DIALOG-BEFORE-ENTER: the dialog appears once the text is typed: no Enter, not landed', async () => {
    const chunks = splitForSendKeys(TEXT).length
    const { io, steps } = scriptedPane({ dialogAfterChunks: chunks })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('not-landed')
    expect([steps.filter(([k]) => k === 'chunk').length, steps.filter(([k]) => k === 'enter').length]).toEqual([chunks, 0])
  })

  it('BUSY-EMIT-RETRY-LOOKS-AGAIN: text still in the box after the Enter, then a dialog: no retry Enter, not landed', async () => {
    const { io, steps } = scriptedPane({ boxKeepsTextAfterEnters: 9, dialogAfterEnters: 1 })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('not-landed')
    expect(steps.filter(([k]) => k === 'enter')).toEqual([['enter', 'box']])
  })

  it('BUSY-EMIT-RETRY-LOOK-ITSELF: the follow-up still sees our text, the dialog comes up just before the retry Enter: no retry Enter', async () => {
    // captures: one before each chunk, one before the Enter, one follow-up (text still in
    // the box), then the look before the retry Enter -- the dialog appears exactly there
    const k = splitForSendKeys(TEXT).length
    const { io, steps } = scriptedPane({ boxKeepsTextAfterEnters: 9, dialogFromCapture: k + 3 })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('not-landed')
    expect(steps.filter(([k]) => k === 'enter')).toEqual([['enter', 'box']])
  })

  it('BUSY-EMIT-RETRY: text still in the box after the first Enter, gone after the second: two Enters, sent', async () => {
    const { io, steps } = scriptedPane({ boxKeepsTextAfterEnters: 1 })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('sent')
    expect(steps.filter(([k]) => k === 'enter')).toEqual([['enter', 'box'], ['enter', 'box']])
  })

  it('BUSY-EMIT-STUCK: the text never leaves the box: the retries stop at the budget, not landed', async () => {
    const { io, steps } = scriptedPane({ boxKeepsTextAfterEnters: 99 })
    expect(await emitIntoBusyPane(TEXT, io, CFG)).toBe('not-landed')
    expect(steps.filter(([k]) => k === 'enter').length).toBe(1 + CFG.maxRetries)
  })

  it('BUSY-EMIT-NO-CAPTURE: an unreadable pane types nothing', async () => {
    const steps: string[] = []
    const io: BusyPaneIo = { capture: () => null, typeChunk: () => steps.push('chunk'), enter: () => steps.push('enter'), delay: async () => {} }
    expect([await emitIntoBusyPane(TEXT, io, CFG), steps]).toEqual(['not-landed', []])
  })
})

// The diagnostics leg (acrobot 30621): every return reports where the send stopped, by the
// refusing look's name, with no text. RED if a return path reports nothing, reports twice,
// names the wrong look or stage, or a report carries any part of the message.
describe('emitIntoBusyPane: the report', () => {
  const run = async (io: BusyPaneIo, text = TEXT) => {
    const reports: unknown[] = []
    const result = await emitIntoBusyPane(text, { ...io, report: (r) => reports.push(r) }, CFG)
    return { result, reports }
  }
  const K = splitForSendKeys(TEXT).length

  it('BUSY-REPORT: one report per send, naming the look and the stage', async () => {
    const cases: Array<[string, BusyPaneIo, unknown]> = [
      ['ok', scriptedPane({}).io, { result: 'sent', chunks: K, retries: 0 }],
      ['retry', scriptedPane({ boxKeepsTextAfterEnters: 1 }).io, { result: 'sent', chunks: K, retries: 1 }],
      ['midway', scriptedPane({ dialogAfterChunks: 1 }).io, { result: 'not-landed', reason: 'permission-question', stage: 'chunk', chunk: 2, chunks: K, retries: 0 }],
      ['before-enter', scriptedPane({ dialogAfterChunks: K }).io, { result: 'not-landed', reason: 'permission-question', stage: 'before-enter', chunks: K, retries: 0 }],
      ['after-enter', scriptedPane({ boxKeepsTextAfterEnters: 9, dialogAfterEnters: 1 }).io, { result: 'not-landed', reason: 'permission-question', stage: 'after-enter', chunks: K, retries: 0 }],
      ['stuck', scriptedPane({ boxKeepsTextAfterEnters: 99 }).io, { result: 'not-landed', reason: 'parked-after-retries', stage: 'after-enter', chunks: K, retries: CFG.maxRetries }],
      ['no-capture', { capture: () => null, typeChunk: () => {}, enter: () => {}, delay: async () => {} }, { result: 'not-landed', reason: 'no-capture', stage: 'chunk', chunk: 1, chunks: K, retries: 0 }],
    ]
    const got = []
    for (const [name, io] of cases) {
      const { reports } = await run(io)
      got.push([name, reports])
    }
    expect(got).toEqual(cases.map(([name, , want]) => [name, [want]]))
  })

  it('BUSY-REPORT-NOT-OURS: foreign text in the box before the Enter is named not-ours', async () => {
    let typedAny = false
    const io: BusyPaneIo = {
      capture: () => busyWithBox(typedAny ? 'valaki mas szovege ami nem a mienk, hosszan' : ''),
      typeChunk: () => {
        typedAny = true
      },
      enter: () => {},
      delay: async () => {},
    }
    const { reports } = await run(io)
    expect(reports).toEqual([{ result: 'not-landed', reason: 'not-ours', stage: 'before-enter', chunks: K, retries: 0 }])
  })

  it('BUSY-REPORT-NO-TEXT: no report carries any piece of the message', async () => {
    const all: unknown[] = []
    for (const io of [scriptedPane({}).io, scriptedPane({ dialogAfterChunks: 1 }).io, scriptedPane({ boxKeepsTextAfterEnters: 99 }).io]) {
      all.push(...(await run(io)).reports)
    }
    const flat = JSON.stringify(all)
    expect(all.length).toBe(3)
    expect(['TEAM MEMBER', '30413', 'kalibraciot'].filter((w) => flat.includes(w))).toEqual([])
  })
})

describe('splitForSendKeys: the idle path dash rule', () => {
  it('CHUNK-DASH: a boundary slides past dashes; a chunk that still starts with one gets a space; the text is kept', () => {
    const line = 'a'.repeat(80) + '-szal es tovabb'
    expect(splitForSendKeys(line)).toEqual(['a'.repeat(80) + '-', 'szal es tovabb'])
    const dashes = 'b'.repeat(80) + '-'.repeat(10) + 'c'
    expect(splitForSendKeys(dashes)).toEqual(['b'.repeat(80) + '-'.repeat(8), ' --c'])
    expect(splitForSendKeys(TEXT).join('')).toBe(TEXT)
  })
})

// The wiring, read from the source (the send has no fake-tmux harness; the same way
// send-prompt-force-send-gate.test.ts pins the idle gate): inside the locked emit span, a
// busyTarget send returns the guarded emit BEFORE the idle path types anything.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('sendPromptToSession routes busyTarget to the guarded emit', () => {
  it('BUSY-EMIT-WIRED: the busyTarget branch comes first in emitToPane and returns emitIntoBusyPane', () => {
    const src = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
    const span = src.slice(src.indexOf('const emitToPane = async ()'))
    const branch = span.indexOf('if (opts.busyTarget) {\n    const outcome = await emitIntoBusyPane(')
    expect(branch).toBeGreaterThan(0)
    for (const idleStep of ['shouldClearTruncatedPreamble(', 'recordInjectedPrompt(', 'await sendChunks()'])
      expect(span.indexOf(idleStep), idleStep).toBeGreaterThan(branch)
    expect(src).toMatch(/return lockResult\.value \?\? 'sent'/)
    // a landed busy send spends an earlier abandoned record of the pane (#118)
    expect(span.slice(branch, branch + 1200)).toMatch(/if \(outcome === 'sent'\) clearAbandonedPrompt\(session\)/)
  })
})
