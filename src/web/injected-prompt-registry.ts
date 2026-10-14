// Injected-prompt registry (STUCKINPUT827).
//
// Every machine-to-machine prompt reaches a running agent the same way: the
// dashboard TYPES it into the agent's tmux pane and presses Enter, because a
// live Claude Code session has no inbound API for "here is a new message".
// When that Enter does not submit, the text parks at the ❯ prompt and the
// stuck-input watcher has to decide what to do with it -- from a SCREEN SCRAPE.
//
// The scrape is a lossy view: the TUI drops the HEAD rows of an overfull input
// box, so a long inter-agent frame shows up as a tail fragment. From that alone
// the watcher cannot tell a wrapped single logical line (where Enter WOULD
// submit) from a genuinely multi-line buffer (where Enter inserts a newline and
// corrupts the message), so it holds -- forever, until a much slower un-wedge
// sweep discards the text. Measured 2026-08-27 on agent-cortex-router: 31
// minutes parked, the message dropped, the routing task only handled because
// the sender re-announced it.
//
// The fix is to stop guessing: the sender KNOWS the exact byte stream it typed.
// This registry remembers it per session so the watcher can clear the box and
// re-inject the ORIGINAL text instead of a scraped fragment. The parked scrape
// must still MATCH the record (see matchesInjectedPrompt) -- that match is what
// proves the parked text is ours and not a human's draft.
//
// Deliberately in-process and lossy-on-restart: a record that does not survive
// a dashboard restart simply means the watcher falls back to its previous
// conservative behaviour (hold), never to something less safe.

const RECORD_TTL_MS = 10 * 60 * 1000

// Bounded so a long-lived dashboard cannot accumulate one entry per session
// name forever (sessions come and go as agents are added/renamed).
const MAX_RECORDS = 200

export interface InjectedPromptRecord {
  /** The EXACT one-line text handed to send-keys (newlines already flattened). */
  text: string
  /** Epoch ms of the injection. */
  at: number
}

const records = new Map<string, InjectedPromptRecord>()

// ABANDONED TYPING (task kezbesites-busy-panelre, barracuda's #117 note): a send
// into a busy pane that stops before landing ('not-landed', busy-pane-emit.ts)
// leaves what it typed in the box ON PURPOSE (no keys while a dialog may be
// up). That text is NOT a message to submit: the router keeps the message
// pending and sends it again whole. Without this record the stuck-input
// recovery would read the half frame as machine-origin parked input and SUBMIT
// it -- the agent would get half a message, then the whole one. Here it is the
// opposite of an injected record: a match means CLEAR, never send.
const abandoned = new Map<string, InjectedPromptRecord>()

/** Collapse whitespace so a wrapped screen scrape compares against the source. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Remember what was typed into a pane. Called from the single choke point every
 * machine delivery goes through, so scheduled ticks, inter-agent messages and
 * context-guard prompts are all covered, not just the router.
 */
export function recordInjectedPrompt(session: string, text: string, now: number = Date.now()): void {
  if (session.length === 0 || text.length === 0) return
  if (!records.has(session) && records.size >= MAX_RECORDS) {
    // Evict the oldest rather than refusing to record: a full map must not
    // silently disable recovery for a new session.
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [key, rec] of records) {
      if (rec.at < oldestAt) { oldestAt = rec.at; oldestKey = key }
    }
    if (oldestKey != null) records.delete(oldestKey)
  }
  records.set(session, { text, at: now })
  // a newer typing supersedes an abandoned one: a parked RE-delivery must be
  // submitted, not cleared as the earlier half
  abandoned.delete(session)
}

/** Remember text typed into a busy pane by a send that did not land (clear it, never submit it). */
export function recordAbandonedPrompt(session: string, text: string, now: number = Date.now()): void {
  if (session.length === 0 || text.length === 0) return
  if (!abandoned.has(session) && abandoned.size >= MAX_RECORDS) {
    const oldest = [...abandoned.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) abandoned.delete(oldest[0])
  }
  abandoned.set(session, { text, at: now })
}

/** The abandoned typing of this pane, or null if absent/expired. */
export function getAbandonedPrompt(session: string, now: number = Date.now()): InjectedPromptRecord | null {
  const rec = abandoned.get(session)
  if (rec == null) return null
  if (now - rec.at > RECORD_TTL_MS) {
    abandoned.delete(session)
    return null
  }
  return rec
}

/** Forget the abandoned typing once it is cleared from the box. */
export function clearAbandonedPrompt(session: string): void {
  abandoned.delete(session)
}

/** The last prompt typed into this pane, or null if absent/expired. */
export function getInjectedPrompt(session: string, now: number = Date.now()): InjectedPromptRecord | null {
  const rec = records.get(session)
  if (rec == null) return null
  if (now - rec.at > RECORD_TTL_MS) {
    records.delete(session)
    return null
  }
  return rec
}

/**
 * Is the parked scrape a fragment of what we typed?
 *
 * This is the safety gate, not a convenience: re-injecting the recorded text is
 * only sound when the box demonstrably still holds THAT message. A human draft,
 * a different agent's message, or a box the agent has already partly consumed
 * all fail the match and leave the watcher on its old conservative path.
 *
 * The scrape may be missing its head (overfull box) or its tail (narrow pane),
 * so a substring test in either direction is the honest check; an equality test
 * would reject exactly the case this exists for.
 */
export function matchesInjectedPrompt(parked: string | null, record: InjectedPromptRecord | null): boolean {
  if (parked == null || record == null) return false
  const a = normalizeForMatch(parked)
  const b = normalizeForMatch(record.text)
  if (a.length === 0 || b.length === 0) return false
  // A very short fragment is not evidence: "the" appears in every message. The
  // floor is well under the shortest real inter-agent frame (the security
  // preamble alone is ~700 chars) but high enough to exclude noise.
  if (a.length < 24) return false
  return b.includes(a) || a.includes(b)
}

/**
 * Is the parked scrape a piece of what a busy-pane send typed and abandoned?
 * ONE direction only (barracuda, #118): the parked text must lie INSIDE the
 * abandoned typing. Every inter-agent frame starts with the same safety
 * preamble, so a half that only got through the preamble would, with the
 * two-way test of matchesInjectedPrompt, also "match" a later, longer, real
 * message parked there -- and clear it. A real later message is longer than
 * the half and runs past it; the half itself (or a head-lost scrape of it) is
 * always inside what was typed.
 */
export function isAbandonedFragment(parked: string | null, record: InjectedPromptRecord | null): boolean {
  if (parked == null || record == null) return false
  const a = normalizeForMatch(parked)
  const b = normalizeForMatch(record.text)
  if (a.length < 24 || b.length === 0) return false
  return b.includes(a)
}

/** Test-only: drop all records between unit tests. */
export function _resetInjectedPromptsForTest(): void {
  records.clear()
  abandoned.clear()
}
