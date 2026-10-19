// A delivery that typed the message but did not LAND it (task kezbesites-enter-parkol, card e406512f).
//
// Measured 2026-10-19: ten idle-path deliveries since 10-16 ended `not-landed` (barracuda 32315, 32387, 32562, 32601,
// 32993; nautilus 32218, 32430; murena 32324), the typed text stayed in the agent's input box, the router only kept
// the message pending, and the box stayed parked for 24 seconds to 20 minutes until the session-stuck alert, a janitor
// or the main agent's `fleet-pane submit` moved it. Worse, 32993 was then DELIVERED TWICE: the parked text was
// submitted (by the main agent's Enter) and the router, which had kept the message pending, typed it again.
//
// The broker's `deliver` (scripts/root/fleet-pane.py) answers 11 for a text that was typed and not landed, with the
// reason in its output: `parked` (the box still holds ONLY our text after the Enter and its three retries, 1.6 s),
// `not-in-box`, `placeholder`, `box-changed`, `dialog-*`. The router used to log that and continue. Now it takes the
// pane over, inside the same send lane, with the broker's own verbs (each looks before it presses a key):
//   - `parked`: `submit` (an Enter) up to TAKEOVER_MAX_PRESSES times, a settle between; the next look says what
//     happened: an EMPTY box after our Enter, or a turn running, means it LANDED (the Enter was only late: the
//     message is delivered and is NOT sent again); an empty box before any press of ours means the same.
//   - any other typed-not-landed reason: `clear` (the text is not safely ours to submit: a placeholder, a box that
//     holds something else), so it does not sit parked; the message stays pending and goes again.
//   - a dialog: nothing is touched (an Enter or a clear could answer it); loud.
// What it could not settle (`left`, `unknown`) is reported loudly by the caller; it never claims `landed` without the
// pane saying so.
import type { BrokerResult } from './fleet-pane.js'

export const TAKEOVER_MAX_PRESSES = 3
export const TAKEOVER_SETTLE_MS = 1500

export type TakeoverOutcome = 'landed' | 'cleared' | 'left' | 'unknown'

export interface TakeoverResult {
  outcome: TakeoverOutcome
  /** Enters this takeover pressed */
  presses: number
  /** what to write after the reason in the diagnostic row: `takeover:<outcome>` plus a short detail */
  note: string
}

export interface TakeoverDeps {
  /** one broker call for this agent: the verb args after the agent name are the caller's business */
  broker: (verbArgs: readonly string[]) => Promise<BrokerResult>
  delay: (ms: number) => Promise<void>
}

type Look = 'empty' | 'running' | 'dialog' | 'cleared' | 'not-cleared' | 'other'

/** What a `submit` or `clear` answer says about the pane. */
function read(r: BrokerResult): Look {
  if (r.code === 12 && r.out === 'box-empty') return 'empty'
  if (r.code === 12 && r.out === 'not-idle') return 'running'
  if (r.code === 12 && r.out.startsWith('dialog:')) return 'dialog'
  if (r.code === 0) return 'cleared'
  if (r.code === 11) return 'not-cleared'
  return 'other'
}

const done = (outcome: TakeoverOutcome, presses: number, detail: string): TakeoverResult => ({ outcome, presses, note: `takeover:${outcome}(${detail})` })

/**
 * The takeover for a deliver that answered 11 with `reason`. `agent` is passed to the broker verbs by the caller's
 * `broker` closure; this function only decides, from the answers, what to press next.
 */
export async function takeOverParkedDelivery(agent: string, reason: string, deps: TakeoverDeps): Promise<TakeoverResult> {
  if (reason.startsWith('dialog')) return done('left', 0, `a dialog is up (${reason}); nothing pressed`)

  if (reason === 'parked') {
    let presses = 0
    for (let i = 0; i < TAKEOVER_MAX_PRESSES; i++) {
      const look = read(await deps.broker(['submit', agent]))
      if (look === 'empty') return done('landed', presses, presses === 0 ? 'the Enter was only late' : `empty box after ${presses} press(es)`)
      if (look === 'running') return presses > 0 ? done('landed', presses, 'a turn started') : done('unknown', 0, 'a turn is running and the box was not seen empty')
      if (look === 'dialog') return done('left', presses, 'a dialog appeared; nothing more pressed')
      if (look !== 'cleared') return done('unknown', presses, 'the broker refused the Enter')
      // `submit` answered 0: it pressed Enter
      presses += 1
      await deps.delay(TAKEOVER_SETTLE_MS)
    }
    // still parked after the presses: `clear` is the look (its gate answers empty, running or dialog without pressing)
    const last = read(await deps.broker(['clear', agent]))
    if (last === 'empty') return done('landed', presses, `empty box after ${presses} press(es)`)
    if (last === 'running') return done('landed', presses, 'a turn started')
    if (last === 'cleared') return done('cleared', presses, `still parked after ${presses} presses: cleared`)
    if (last === 'dialog') return done('left', presses, 'a dialog appeared; nothing more pressed')
    return done('unknown', presses, 'the box could not be emptied')
  }

  // typed, but not safely ours to submit (not-in-box, placeholder, box-changed, anything new): empty the box
  const look = read(await deps.broker(['clear', agent]))
  if (look === 'cleared' || look === 'empty') return done('cleared', 0, `${reason}: box emptied`)
  if (look === 'dialog') return done('left', 0, 'a dialog is up; nothing pressed')
  if (look === 'running') return done('unknown', 0, 'a turn is running; the box was not touched')
  return done('unknown', 0, `${reason}: the box could not be emptied`)
}
