// A local pane takes `send-keys -l -- <chunk>` (measured on the container's tmux 3.3a, 2026-10-15),
// so the router types a message exactly: no dash slide, no leading space. A remote agent's tmux is
// not measured, so its chunks keep the old dash rule (acrobot 31187; barracuda, #186 note). Today no
// agent is remote (store/agent-remote-hosts.json does not exist, measured the same day).
//
// WHAT TURNS THIS RED:
//   - a local text chunk goes without `--`, or a chunk that would need it (leading '-') goes
//     without it on either path;
//   - a run of more than 8 dashes, or a dash at a chunk start, is not typed exactly on the local
//     idle path;
//   - the remote rule changes (its chunks must stay safe WITHOUT `--`);
//   - the semicolon rule is lost in the terminated split.
import { describe, it, expect, vi } from 'vitest'

const sent: string[][] = []
/** What tmux 3.3a types for one literal argument (the measured trailing-';' rule). */
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
      if (a.includes('send-keys') && a.includes('-l')) sent.push(a.slice(a.indexOf('-l')))
      return a.includes('capture-pane') ? idle : ''
    }),
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, listAgentNames: () => [] }
})

import { emitIntoBusyPane, sendKeysLiteralArgs, splitForSendKeys, typedFromChunks } from '../web/busy-pane-emit.js'
import { sendPromptToSession } from '../web/agent-process.js'

// a dash run longer than the old slide cap, a chunk boundary on a dash, and a trailing ';'
const MSG = 'Kotojelek: ' + '-'.repeat(120) + ' es ' + 'x'.repeat(63) + '-szal vege;'

describe('the option terminator', () => {
  it('TERM-SPLIT: terminated chunks are plain slices (a leading dash stays), the ";" rule holds, and they type back exactly', () => {
    const chunks = splitForSendKeys(MSG, 80, true)
    expect([chunks.some((c) => c.startsWith('-')), chunks.every((c) => !c.endsWith(';') || c === '\\;'), typedFromChunks(chunks)]).toEqual([true, true, MSG])
    expect([sendKeysLiteralArgs('-x', true), sendKeysLiteralArgs('x', false)]).toEqual([['-l', '--', '-x'], ['-l', 'x']])
  })

  it('TERM-REMOTE: without the terminator (a remote agent) no chunk starts with "-": the old rule, unchanged', () => {
    const chunks = splitForSendKeys(MSG)
    expect([chunks.some((c) => c.startsWith('-')), chunks.join('').replace(/\\;/g, ';').replace(/ (?=-)/g, '').length >= MSG.length - 2]).toEqual([false, true])
  })

  it('TERM-IDLE: the local idle path sends every chunk after `--`, and the message is typed exactly', async () => {
    sent.length = 0
    await sendPromptToSession('agent-term', MSG, null, { waitForIdle: false })
    expect([sent.every((a) => a[1] === '--' && a.length === 3), sent.map((a) => tmuxTypes(a[2]!)).join('')]).toEqual([true, MSG])
  })

  it('TERM-BUSY: the busy path splits for the terminator only when told, and a "-" chunk then needs `--`', async () => {
    const typed: string[] = []
    const SEP = '─'.repeat(80)
    const pane = () => ['✳ Forming… (3m 7s · ↓ 6.1k tokens)', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n')
    const io = { capture: pane, typeChunk: (c: string) => typed.push(c), enter: () => {}, delay: async () => {} }
    await emitIntoBusyPane(MSG, io, { chunkGapMs: 0, pollMs: 0, maxRetries: 0, terminated: true })
    const local = [...typed]
    typed.length = 0
    await emitIntoBusyPane(MSG, io, { chunkGapMs: 0, pollMs: 0, maxRetries: 0 })
    expect([local.some((c) => c.startsWith('-')), typed.some((c) => c.startsWith('-')), typedFromChunks(local)]).toEqual([true, false, MSG])
  })
})
