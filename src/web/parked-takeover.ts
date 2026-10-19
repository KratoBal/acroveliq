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
//   - `parked`: `submit` (an Enter) up to TAKEOVER_MAX_PRESSES times, a settle between; the look AFTER an Enter of ours
//     says what happened: an EMPTY box, or a turn running, means it LANDED (the message is delivered and is NOT sent
//     again). An empty box BEFORE any Enter of ours is NOT proof (barracuda, #264 review): the Enter may have been late,
//     or somebody else (the main agent's clear, the stuck-input recovery, a hand) emptied the box and the message never
//     arrived; that is `unknown`, loud, the message stays pending. (The measured cases parked for 24 seconds to 20
//     minutes: the Enter did not go in, it was not late.)
//   - `not-in-box`, `placeholder`, `box-changed`, `placeholder-stuck`: the box may hold our text (cut short, or folded by the
//     TUI into a `[Pasted text #N]` stub). The broker's `clear --expect` compares the CONTENT (task broker-beillesztes-helyorzo):
//     it empties a box that holds exactly our text, or our text folded around a stub with a verbatim run of it beside the
//     stub, and answers `not-ours` (nothing pressed) for anything else: a person's typing, the main agent's panel message, a bare
//     stub. `cleared` then, and the message goes again; `not-ours` is `left`, loud.
//   - `no-echo`, `placeholder-cleared`, `deliver-timeout`: the broker itself emptied what it typed (or typed nothing visible):
//     `cleared`, no call. A text a slow TUI draws LATER is caught by the next deliver of the same message (box-not-free, see
//     sendPromptViaBroker), through the same content gate.
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
  /** one broker call for this agent; `input` goes to its stdin (the expected text of `--expect`) */
  broker: (verbArgs: readonly string[], input?: string) => Promise<BrokerResult>
  delay: (ms: number) => Promise<void>
  /** the text this delivery typed (the line as typed): the content gate of `submit --expect` and `clear --expect` */
  text: string
}

type Look = 'empty' | 'running' | 'dialog' | 'cleared' | 'not-cleared' | 'not-ours' | 'placeholder' | 'old-broker' | 'other'

/** What a `submit` or `clear` answer says about the pane. */
function read(r: BrokerResult): Look {
  if (r.code === 12 && r.out === 'box-empty') return 'empty'
  if (r.code === 12 && r.out === 'not-idle') return 'running'
  if (r.code === 12 && r.out.startsWith('dialog:')) return 'dialog'
  if (r.code === 12 && r.out === 'not-ours') return 'not-ours'
  if (r.code === 12 && r.out === 'placeholder') return 'placeholder'
  // a broker installed before `--expect` (the router can be deployed before the broker is reinstalled)
  if (r.code === 2 && r.out === 'bad-option') return 'old-broker'
  if (r.code === 0) return 'cleared'
  if (r.code === 11) return 'not-cleared'
  return 'other'
}

const done = (outcome: TakeoverOutcome, presses: number, detail: string): TakeoverResult => ({ outcome, presses, note: `takeover:${outcome}(${detail})` })

/** Reasons after which the box may hold our text, cut short or folded: the content-gated clear decides. */
const CLEARABLE = new Set(['not-in-box', 'placeholder', 'box-changed', 'placeholder-stuck'])
/** Reasons for which the broker already emptied what it typed. */
const BROKER_EMPTIED = new Set(['no-echo', 'placeholder-cleared', 'deliver-timeout'])

/** `clear --expect`: the answer as a takeover result for `reason`. */
async function clearOurs(agent: string, reason: string, presses: number, deps: TakeoverDeps): Promise<TakeoverResult> {
  const look = read(await deps.broker(['clear', agent, '--expect'], deps.text))
  if (look === 'cleared') return done('cleared', presses, `${reason}: the box held our text, emptied`)
  if (look === 'empty') return done('cleared', presses, `${reason}: the box is already empty`)
  if (look === 'not-ours') return done('left', presses, `${reason}: the box does not hold our text; nothing pressed, nothing cleared`)
  if (look === 'running') return done('left', presses, `${reason}: a turn is running; nothing cleared`)
  if (look === 'dialog') return done('left', presses, `${reason}: a dialog appeared; nothing more pressed`)
  return done('unknown', presses, `${reason}: the box could not be emptied`)
}

/**
 * The takeover for a deliver that answered 11 with `reason`. `agent` is passed to the broker verbs by the caller's
 * `broker` closure; this function only decides, from the answers, what to press next.
 */
export async function takeOverParkedDelivery(agent: string, reason: string, deps: TakeoverDeps): Promise<TakeoverResult> {
  if (reason.startsWith('dialog')) return done('left', 0, `a dialog is up (${reason}); nothing pressed`)

  if (reason === 'parked') {
    let presses = 0
    let gated = true
    for (let i = 0; i < TAKEOVER_MAX_PRESSES; i++) {
      let look = read(await (gated ? deps.broker(['submit', agent, '--expect'], deps.text) : deps.broker(['submit', agent])))
      if (look === 'old-broker') {
        // the old broker's `parked` already meant: the box holds ONLY our text after the Enters. Its plain verbs are as safe as before.
        gated = false
        look = read(await deps.broker(['submit', agent]))
      }
      if (look === 'empty') {
        // an empty box counts as delivery only AFTER an Enter of ours: before it, somebody else may have emptied it
        return presses === 0
          ? done('unknown', 0, 'the box was empty before any Enter of ours: not proof of delivery (someone else may have emptied it)')
          : done('landed', presses, `empty box after ${presses} press(es)`)
      }
      if (look === 'running') return presses > 0 ? done('landed', presses, 'a turn started') : done('unknown', 0, 'a turn is running and the box was not seen empty')
      if (look === 'dialog') return done('left', presses, 'a dialog appeared; nothing more pressed')
      if (look === 'not-ours') {
        return presses === 0
          ? done('left', 0, 'the box no longer holds exactly our text; nothing pressed')
          : done('unknown', presses, 'after our Enter the box holds something that is not our text')
      }
      // the TUI folded our text into a stub since the broker looked: an Enter would only unfold it
      if (look === 'placeholder') return clearOurs(agent, 'placeholder', presses, deps)
      if (look !== 'cleared') return done('unknown', presses, 'the broker refused the Enter')
      // `submit` answered 0: it pressed Enter
      presses += 1
      await deps.delay(TAKEOVER_SETTLE_MS)
    }
    // still parked after the presses: `clear` is the look (its gate answers empty, running or dialog without pressing)
    let last = read(await (gated ? deps.broker(['clear', agent, '--expect'], deps.text) : deps.broker(['clear', agent])))
    if (last === 'old-broker') last = read(await deps.broker(['clear', agent]))
    if (last === 'empty') return done('landed', presses, `empty box after ${presses} press(es)`)
    if (last === 'running') return done('landed', presses, 'a turn started')
    if (last === 'cleared') return done('cleared', presses, `still parked after ${presses} presses: cleared`)
    if (last === 'dialog') return done('left', presses, 'a dialog appeared; nothing more pressed')
    if (last === 'not-ours') return done('unknown', presses, 'still parked after the presses, but the box holds something that is not our text; nothing cleared')
    return done('unknown', presses, 'the box could not be emptied')
  }

  if (BROKER_EMPTIED.has(reason)) return done('cleared', 0, `${reason}: the broker emptied what it typed; nothing pressed`)
  if (CLEARABLE.has(reason)) return clearOurs(agent, reason, 0, deps)

  // a reason this router does not know: not safely ours to submit, and not safely ours to clear
  return done('left', 0, `${reason}: unknown reason; nothing pressed, nothing cleared`)
}
