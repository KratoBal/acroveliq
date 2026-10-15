// A message typed into a pane keeps its semicolons (splitForSendKeys, busy-pane-emit.ts; the idle
// path in sendPromptToSession uses the same chunks). tmux 3.3a, measured 2026-10-15 on a throwaway
// server: an argument that ENDS in ';' is a command separator, so `E;` types `E`; `A\;` types
// `A;`; a lone `\;` types `;`; a ';' inside an argument is typed as is. Before this fix a message
// whose 80-character chunk ended in ';' was delivered without it (barracuda, #185 review).
//
// WHAT TURNS THIS RED:
//   - a chunk other than the lone escaped one ends in ';';
//   - the text tmux types (the measured rule, simulated) differs from the message, on the idle
//     path or the busy path;
//   - the dash rule (slide, leading space) changes.
import { describe, it, expect, vi } from 'vitest'

const typedByTmux: string[] = []
/** What tmux 3.3a types for one `send-keys -l` argument (the measured rule). */
function tmuxTypes(arg: string): string {
  const m = /^([\s\S]*?)(\\*);$/.exec(arg)
  return m ? m[1]! + (m[2] ? ';' : '') : arg
}

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  const SEP = '─'.repeat(80)
  const idle = ['● kesz', '', SEP, '❯ ', SEP, '  Opus 5 · ctx 40%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n')
  return {
    ...orig,
    execFileSync: vi.fn((_file: string, args: readonly string[]) => {
      const a = [...args]
      const i = a.indexOf('-l')
      if (a.includes('send-keys') && i >= 0) typedByTmux.push(tmuxTypes(a[i + 1]!))
      if (a.includes('capture-pane')) return idle
      return ''
    }),
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, listAgentNames: () => [] }
})

import { emitIntoBusyPane, splitForSendKeys, typedFromChunks, SEND_KEYS_SEMICOLON } from '../web/busy-pane-emit.js'
import { sendPromptToSession } from '../web/agent-process.js'

// chunk boundaries (every 80) land on ';', ';;', a backslash before a ';', and the end
const MSG = 'a'.repeat(79) + ';' + 'b'.repeat(78) + ';;' + 'c'.repeat(78) + '\\;' + 'd'.repeat(10) + ' vege;'

describe('semicolons at chunk ends', () => {
  it('SEMI-SPLIT: no chunk ends in ";" except the lone escaped piece, and the chunks type back to the message', () => {
    const chunks = splitForSendKeys(MSG)
    expect([chunks.every((c) => !c.endsWith(';') || c === SEND_KEYS_SEMICOLON), typedFromChunks(chunks), chunks.map(tmuxTypes).join('')]).toEqual([true, MSG, MSG])
    expect([splitForSendKeys('E;'), splitForSendKeys(';;'), splitForSendKeys('a;b')]).toEqual([['E', '\\;'], ['\\;', '\\;'], ['a;b']])
  })

  it('SEMI-DASH: the dash rule is unchanged', () => {
    expect([splitForSendKeys('a'.repeat(80) + '-szal es tovabb'), splitForSendKeys('b'.repeat(80) + '-'.repeat(10) + 'c')]).toEqual([
      ['a'.repeat(80) + '-', 'szal es tovabb'], ['b'.repeat(80) + '-'.repeat(8), ' --c'],
    ])
  })

  it('SEMI-IDLE: the idle path types the message exactly (tmux rule simulated)', async () => {
    typedByTmux.length = 0
    await sendPromptToSession('agent-semi', MSG, null, { waitForIdle: false })
    expect(typedByTmux.join('')).toBe(MSG)
  })

  it('SEMI-BUSY: the busy path types the message exactly, and what it reports typed is the text, not the escapes', async () => {
    const typed: string[] = []
    let abandoned = ''
    const SEP = '─'.repeat(80)
    const pane = (box: string) => ['✳ Forming… (3m 7s · ↓ 6.1k tokens)', '', SEP, `❯ ${box}`, SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n')
    let n = 0
    await emitIntoBusyPane(MSG, {
      // a dialog after the 4th look: the send stops and reports what it typed so far
      capture: () => (++n > 4 ? ' Do you want to proceed?\n ❯ 1. Yes\n ↑/↓ to navigate · Esc to cancel' : pane(typed.join('').slice(0, 70))),
      typeChunk: (c) => typed.push(tmuxTypes(c)),
      enter: () => {},
      delay: async () => {},
      abandon: (t) => { abandoned = t },
    }, { chunkGapMs: 0, pollMs: 0, maxRetries: 1 })
    expect([abandoned, abandoned === typed.join(''), MSG.startsWith(abandoned), abandoned.includes('\\')]).toEqual([typed.join(''), true, true, false])
  })
})
