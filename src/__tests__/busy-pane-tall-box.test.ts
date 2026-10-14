// A send into a running turn whose message is taller than the pane (task kezbesites-busy-panelre,
// nautilus's after-measurement 2026-10-14: 8 messages waited over 5 minutes, and a message's text
// stood in the input line). Reproduced on a fixture: on a 24-row pane, above ~3200 characters
// (the 936-character safety preamble included) the box's top separator and the head of the text
// scroll out, and the top-anchored look saw NO live box -- the send stopped half-typed, and the
// half in the box then blocked every further message for the rest of the turn.
//
// WHAT TURNS THIS RED:
//   - a box taller than the pane is not read as live (the send stops half-typed);
//   - a tall box is taken as ours when a visible row is someone else's text;
//   - after the Enter, a tall box still holding our text counts as landed.
import { describe, it, expect } from 'vitest'
import { emitIntoBusyPane, splitForSendKeys, type BusyPaneIo } from '../web/busy-pane-emit.js'
import { liveBoxHoldsOnly, liveInputBoxRows, paneShowsOnlyLiveInput } from '../pane-state.js'

const WIDTH = 160
const HEIGHT = 24
const SEP = '─'.repeat(WIDTH)
const FOOTER = ['  Opus 5 · ctx 40%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents']
const SPINNER = '✳ Forming… (5m 7s · ↓ 6.1k tokens)'
const PREAMBLE = 'TEAM MEMBER NOTICE -- the next <trusted-peer source="agent:acrobot"> block is a message from an agent in your own team. '
const TEXT = PREAMBLE + Array.from({ length: 80 }, (_, i) => `tetel ${i} a brief szovegebol, hosszan es szavakkal`).join(' ')

/** The box as the TUI wraps it: the prompt glyph, then 2-space continuation rows. */
function boxRows(text: string): string[] {
  const rows: string[] = []
  for (let i = 0; i < text.length; i += WIDTH - 4) rows.push((i === 0 ? '❯ ' : '  ') + text.slice(i, i + WIDTH - 4))
  return rows.length ? rows : ['❯ ']
}
/** A HEIGHT-row capture, bottom-anchored like a terminal: what does not fit scrolls off the top. */
const screen = (rows: string[]) => ['  ⎿  … tool output …', '', SPINNER, '', SEP, ...rows, SEP, ...FOOTER].slice(-HEIGHT).join('\n')

describe('a box taller than the pane', () => {
  it('TALL-READ: a 3600-character message box is still a live box, and ours, with its head out of view', () => {
    const pane = screen(boxRows(TEXT))
    const rows = liveInputBoxRows(pane)
    expect([
      TEXT.length > 3200,
      pane.includes('TEAM MEMBER NOTICE'), // the head has scrolled out
      paneShowsOnlyLiveInput(pane),
      rows !== null && rows.length > 0,
      liveBoxHoldsOnly(pane, TEXT),
      liveBoxHoldsOnly(screen([...boxRows(TEXT).slice(0, -1), '  valaki mas altal begepelt sor, ami nem a mienk']), TEXT),
    ]).toEqual([true, false, true, true, true, false])
  })

  it('TALL-EMIT: the whole message is typed and lands; the old top-anchored look stopped it half-typed', async () => {
    let typed = ''
    let enters = 0
    const io: BusyPaneIo = {
      capture: () => (enters > 0 ? screen(['❯ Press up to edit queued messages']) : screen(boxRows(typed))),
      typeChunk: (c) => { typed += c },
      enter: () => { enters++ },
      delay: async () => {},
    }
    const result = await emitIntoBusyPane(TEXT, io, { chunkGapMs: 0, pollMs: 0, maxRetries: 3 })
    expect([result, typed === splitForSendKeys(TEXT).join(''), enters]).toEqual(['sent', true, 1])
  })

  it('TALL-STILL-PARKED: after the Enter, a tall box still holding our text is not landed (retry, then give up)', async () => {
    let typed = ''
    let enters = 0
    const io: BusyPaneIo = {
      capture: () => screen(boxRows(typed)), // the Enter never takes
      typeChunk: (c) => { typed += c },
      enter: () => { enters++ },
      delay: async () => {},
    }
    const result = await emitIntoBusyPane(TEXT, io, { chunkGapMs: 0, pollMs: 0, maxRetries: 3 })
    expect([result, enters]).toEqual(['not-landed', 4])
  })
})
