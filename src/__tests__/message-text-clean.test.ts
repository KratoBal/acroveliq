// The sender side (acrobot 31076, barracuda 31074): a message is stored without what a display
// or a terminal reads as a line break or a command. WHAT TURNS THIS RED:
//   - a Unicode line separator (U+2028, U+2029, U+0085) or a CR stored raw, or turned into a
//     space instead of a line break (the lines must stay);
//   - a C0 control (but tab and LF), DEL or C1 stored raw;
//   - the tab or the LF changed;
//   - a writer that goes through createAgentMessage storing the raw text.
import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, createAgentMessage, getAgentMessage } from '../db.js'
import { cleanMessageText } from '../prompt-safety.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const RAW = 'egy \u2028ketto \u2029harom \x85negy \r\not \r hat \t tab \x1b[31mszin \x00 nul \x7f del \x9b csi \x0b vt \x0c ff vege'
const CLEAN = 'egy \nketto \nharom \nnegy \not \n hat \t tab  [31mszin   nul   del   csi   vt   ff vege'

describe('the stored message text', () => {
  it('MSG-CLEAN: line separators become a line break, the other controls a space, tab and LF stay', () => {
    expect(cleanMessageText(RAW)).toBe(CLEAN)
  })

  it('MSG-CLEAN-STORED: createAgentMessage stores and returns the cleaned text', () => {
    const msg = createAgentMessage('barracuda', 'nautilus', RAW)
    expect([msg.content, getAgentMessage(msg.id)?.content]).toEqual([CLEAN, CLEAN])
  })
})
