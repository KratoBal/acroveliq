// Typing a message into a BUSY pane (task kezbesites-busy-panelre), with no blind keystroke.
//
// barracuda, #117 review: in a RUNNING turn a permission question can appear at any moment
// (the turn starts a tool call), between the readiness check and the typing. The chunked
// send-keys stream then lands in the menu: a digit picks an option at once ("2" is "yes,
// and don't ask again", a lasting permission line -- the locked permission_change
// category, with no human), and the closing Enter confirms the highlighted default, "yes".
// An idle pane has no running turn, so the old path could not meet this; a busy one meets
// the window on every delivery.
//
// So here every keystroke is preceded by a fresh look at the pane:
//   - before each chunk: the pane still shows only the live input box (no permission
//     question, menu, feedback or consent dialog; paneShowsOnlyLiveInput);
//   - before the Enter, and before every retry Enter: the same, AND the head of our text
//     stands in the box;
//   - anything else: no more keys at all (no Enter, no Ctrl-C, no clearing), and the result
//     is 'not-landed': the message is NOT delivered and stays pending. What we typed may stay in
//     the box; the stuck-input recovery acts on it once the pane is idle.
// The window left is the few milliseconds between a capture and the key it allows; one
// chunk arrives as one input string, not as a single digit.
//
// I/O is injected (BusyPaneIo) so the decision sequence is tested against a scripted pane
// that turns into a permission dialog mid-typing.
import { decideSubmitFollowup, liveBoxHoldsOnly, paneShowsOnlyLiveInput } from '../pane-state.js'

/** Characters per send-keys write, as on the idle path. */
export const SEND_KEYS_CHUNK = 80
const MAX_SLIDE = 8

/**
 * The send-keys chunks of one line. tmux send-keys has no `--`, so a chunk starting with
 * '-' would parse as a flag ("unknown flag -s" on Hungarian suffixes like -szal): the
 * boundary slides past up to MAX_SLIDE dashes, and a chunk that still starts with one gets
 * a leading space. The same rule the idle path in sendPromptToSession applies.
 */
export function splitForSendKeys(oneLine: string, chunkSize = SEND_KEYS_CHUNK): string[] {
  const out: string[] = []
  let i = 0
  while (i < oneLine.length) {
    let end = Math.min(i + chunkSize, oneLine.length)
    let slide = 0
    while (end < oneLine.length && oneLine[end] === '-' && slide < MAX_SLIDE) {
      end++
      slide++
    }
    let chunk = oneLine.slice(i, end)
    if (chunk.startsWith('-')) chunk = ' ' + chunk
    out.push(chunk)
    i = end
  }
  return out
}

export interface BusyPaneIo {
  capture(): string | null
  typeChunk(chunk: string): void
  enter(): void
  delay(ms: number): Promise<void>
  /**
   * A 'not-landed' send that typed something: what it typed, so the stuck-input
   * recovery CLEARS that text from the box instead of submitting half a message
   * (the router sends the whole one again). Not called when nothing was typed.
   */
  abandon?(typed: string): void
}

export interface BusyPaneEmitConfig {
  chunkGapMs: number
  pollMs: number
  maxRetries: number
}

/** The head of our text, the part sure to stand on the box's first row (the box wraps). */
export function payloadHead(oneLine: string): string {
  return oneLine.slice(0, 24)
}

/**
 * The pane shows only the live input box, and what it shows of the box is our text and nothing
 * else (every visible row a piece of it). Not the head: under a long message the box grows
 * taller than the pane and its head scrolls out (nautilus, 2026-10-14).
 */
function ourTextInLiveBox(pane: string | null, text: string): boolean {
  return pane != null && paneShowsOnlyLiveInput(pane) && liveBoxHoldsOnly(pane, text)
}

/**
 * Type `oneLine` into a busy pane and submit it for Claude Code to queue. 'sent' only when
 * the Enter went into the live box with our text in it and the box then let it go; 'not-landed'
 * whenever a look before a key did not allow it, or the text did not leave the box.
 */
export async function emitIntoBusyPane(oneLine: string, io: BusyPaneIo, cfg: BusyPaneEmitConfig): Promise<'sent' | 'not-landed'> {
  const chunks = splitForSendKeys(oneLine)
  let typed = ''
  const notLanded = (): 'not-landed' => {
    if (typed.length > 0) io.abandon?.(typed)
    return 'not-landed'
  }
  for (let i = 0; i < chunks.length; i++) {
    const pane = io.capture()
    if (pane == null || !paneShowsOnlyLiveInput(pane)) return notLanded()
    io.typeChunk(chunks[i]!)
    typed += chunks[i]!
    if (i < chunks.length - 1) await io.delay(cfg.chunkGapMs)
  }
  const head = payloadHead(oneLine)
  if (!ourTextInLiveBox(io.capture(), oneLine)) return notLanded()
  io.enter()
  for (let attempt = 0; ; attempt++) {
    await io.delay(cfg.pollMs)
    const pane = io.capture()
    const action = decideSubmitFollowup(pane, head, attempt, cfg.maxRetries, { busyTarget: true, payload: oneLine })
    if (action === 'done') return 'sent'
    if (action !== 'retry-enter') return notLanded()
    // the retry Enter gets the same fresh look as the first one
    if (!ourTextInLiveBox(io.capture(), oneLine)) return notLanded()
    io.enter()
  }
}
