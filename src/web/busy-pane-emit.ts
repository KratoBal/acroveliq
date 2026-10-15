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
import { decideSubmitFollowup, detectsPastePlaceholder, liveBoxHoldsOnly, liveInputRefusal } from '../pane-state.js'

/**
 * The one line a message is typed as: a line break, every C0 and C1 control and the Unicode
 * separators U+2028/U+2029 become a space. typed with `send-keys -l`, a raw ESC reaches the
 * TUI as the Escape key, a Tab as completion, and a U+2028/U+2029 broke the line in the box:
 * barracuda's message 31054 (one of each) arrived about fourteen times over, each copy cut at
 * the separator, because every replay typed a new copy on top of the last (acrobot 31075).
 * A CRLF is one space, as the old `\r?\n` replacement made it.
 */
export function typedLine(text: string): string {
  return text.replace(/\r\n|[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
}

/** Characters per send-keys write, as on the idle path. */
export const SEND_KEYS_CHUNK = 80
const MAX_SLIDE = 8

/**
 * The piece that types one ';'. tmux (3.3a, measured 2026-10-15) takes an argument that ENDS in
 * ';' as a command separator: `E;` types `E` (the ';' is lost), `A\;` types `A;`, a lone `\;`
 * types `;`. A ';' inside an argument is typed as is. (fleet-pane.py applies the same rule.)
 */
export const SEND_KEYS_SEMICOLON = '\\;'

/** What tmux types for these chunks: the inverse of splitForSendKeys (the escaped ';' pieces). */
export function typedFromChunks(chunks: readonly string[]): string {
  return chunks.map((c) => (c === SEND_KEYS_SEMICOLON ? ';' : c)).join('')
}

/**
 * The send-keys chunks of one line, used by BOTH the idle path (sendPromptToSession) and the
 * busy path. No chunk ends in ';' (tmux would drop it, see SEND_KEYS_SEMICOLON): trailing
 * semicolons go as their own escaped pieces.
 *
 * A chunk starting with '-' would parse as a flag ("unknown flag -s" on Hungarian suffixes like
 * -szal). `terminated`: the chunks go after `--` (sendKeysLiteralArgs), measured to work on the
 * local tmux 3.3a (2026-10-15), so they are plain slices and the text is typed exactly. Without
 * it (a remote agent, whose tmux is not measured) the old rule: the boundary slides past up to
 * MAX_SLIDE dashes, and a chunk that still starts with one gets a leading space.
 */
export function splitForSendKeys(oneLine: string, chunkSize = SEND_KEYS_CHUNK, terminated = false): string[] {
  const out: string[] = []
  const pieces = terminated ? (oneLine.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, 'g')) ?? []) : splitAtDashes(oneLine, chunkSize)
  for (const chunk of pieces) {
    const body = chunk.replace(/;+$/, '')
    if (body) out.push(body)
    for (let k = body.length; k < chunk.length; k++) out.push(SEND_KEYS_SEMICOLON)
  }
  return out
}

/** The `send-keys` arguments after the target that type one chunk: `-l --` with `terminated`. */
export function sendKeysLiteralArgs(chunk: string, terminated: boolean): string[] {
  return terminated ? ['-l', '--', chunk] : ['-l', chunk]
}

function splitAtDashes(oneLine: string, chunkSize: number): string[] {
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
  /** How the send ended, without its content (delivery-diag.ts): called once, on every return. */
  report?(r: BusyPaneReport): void
}

/** Where a busy-pane send stopped: the look that failed, by name. No message text. */
export interface BusyPaneReport {
  result: 'sent' | 'not-landed'
  /** the look that refused (liveInputRefusal names, 'not-ours', 'placeholder', 'parked-after-retries') */
  reason?: string
  /** 'chunk' (before typing a chunk), 'before-enter', 'after-enter' (incl. retries) */
  stage?: 'chunk' | 'before-enter' | 'after-enter'
  /** 1-based index of the chunk whose look refused (stage 'chunk') */
  chunk?: number
  chunks: number
  /** retry Enters pressed before the end */
  retries: number
}

export interface BusyPaneEmitConfig {
  chunkGapMs: number
  pollMs: number
  maxRetries: number
  /** The chunks are typed after `--` (splitForSendKeys); the caller's typeChunk must send them so. */
  terminated?: boolean
}

/** The head of our text, the part sure to stand on the box's first row (the box wraps). */
export function payloadHead(oneLine: string): string {
  return oneLine.slice(0, 24)
}

/**
 * Why the box may not take the Enter, or null when it may: the pane shows only the live input
 * box, and what it shows of the box is our text and nothing else (every visible row a piece of
 * it). Not the head: under a long message the box grows taller than the pane and its head
 * scrolls out (nautilus, 2026-10-14).
 */
function ourTextRefusal(pane: string | null, text: string): string | null {
  return liveInputRefusal(pane) ?? (liveBoxHoldsOnly(pane!, text) ? null : 'not-ours')
}

/** The name of the look that made decideSubmitFollowup give up in busyTarget mode. */
function followupRefusal(pane: string | null): string {
  const live = liveInputRefusal(pane)
  if (live) return live
  return detectsPastePlaceholder(pane!) ? 'placeholder' : 'parked-after-retries'
}

/**
 * Type `oneLine` into a busy pane and submit it for Claude Code to queue. 'sent' only when
 * the Enter went into the live box with our text in it and the box then let it go; 'not-landed'
 * whenever a look before a key did not allow it, or the text did not leave the box.
 */
export async function emitIntoBusyPane(oneLine: string, io: BusyPaneIo, cfg: BusyPaneEmitConfig): Promise<'sent' | 'not-landed'> {
  const chunks = splitForSendKeys(oneLine, SEND_KEYS_CHUNK, cfg.terminated === true)
  let typed = ''
  let retries = 0
  const notLanded = (stage: BusyPaneReport['stage'], reason: string, chunk?: number): 'not-landed' => {
    if (typed.length > 0) io.abandon?.(typed)
    io.report?.({ result: 'not-landed', reason, stage, ...(chunk != null ? { chunk } : {}), chunks: chunks.length, retries })
    return 'not-landed'
  }
  for (let i = 0; i < chunks.length; i++) {
    const refusal = liveInputRefusal(io.capture())
    if (refusal) return notLanded('chunk', refusal, i + 1)
    io.typeChunk(chunks[i]!)
    typed += typedFromChunks([chunks[i]!])
    if (i < chunks.length - 1) await io.delay(cfg.chunkGapMs)
  }
  const head = payloadHead(oneLine)
  const beforeEnter = ourTextRefusal(io.capture(), oneLine)
  if (beforeEnter) return notLanded('before-enter', beforeEnter)
  io.enter()
  for (let attempt = 0; ; attempt++) {
    await io.delay(cfg.pollMs)
    const pane = io.capture()
    const action = decideSubmitFollowup(pane, head, attempt, cfg.maxRetries, { busyTarget: true, payload: oneLine })
    if (action === 'done') {
      io.report?.({ result: 'sent', chunks: chunks.length, retries })
      return 'sent'
    }
    if (action !== 'retry-enter') return notLanded('after-enter', followupRefusal(pane))
    // the retry Enter gets the same fresh look as the first one
    const look = io.capture()
    const beforeRetry = ourTextRefusal(look, oneLine)
    if (beforeRetry) {
      // the text left the box between the two looks: the first Enter landed late. Not
      // 'not-landed' -- the router would send the whole message again (barracuda, #129 review)
      if (decideSubmitFollowup(look, head, attempt, cfg.maxRetries, { busyTarget: true, payload: oneLine }) === 'done') {
        io.report?.({ result: 'sent', chunks: chunks.length, retries })
        return 'sent'
      }
      return notLanded('after-enter', beforeRetry)
    }
    io.enter()
    retries++
  }
}
