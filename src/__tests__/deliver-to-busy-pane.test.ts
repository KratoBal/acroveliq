// Delivery into a BUSY pane (task kezbesites-busy-panelre). Since #105 a turn longer than a
// minute reads 'busy', and the router wrote only into an idle pane: an agent in long,
// back-to-back turns got nothing for many minutes (2026-10-14: nautilus 39 min, 7 waiting).
// Claude Code queues a line submitted during a running turn, so a busy pane may take a
// message -- unless something else is in the way.
//
// WHAT TURNS THIS RED:
//   - a busy pane with a free box (empty, or only the queue hint) is refused;
//   - an idle pane, a permission question, a menu, a placeholder, typed or parked text, a
//     saturated context or a pane without a live box is accepted;
//   - a dim ghost in the box blocks, though the dim-stripped view shows it empty;
//   - after a send into a busy pane, 'busy' alone counts as landed, our text parked in the
//     box gets no Enter, or a placeholder is Ctrl-C'd (clear-and-resend) into a live turn;
//   - the old (idle-target) follow-up changes.
import { describe, it, expect } from 'vitest'
import { paneAcceptsQueuedPrompt, queuedPromptRefusal, decideSubmitFollowup } from '../pane-state.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const pane = (above: string[], box: string[], footer: string[] = ['  Opus 5 · ctx 406k/1.0M · 41%', FOOTER]) =>
  [...above, SEP, ...box, SEP, ...footer].join('\n')

const SPINNER = '✳ Forming… (32m 37s · ↓ 76.1k tokens)'
const BUSY_EMPTY = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ '])
const BUSY_QUEUED = pane(['❯ [an earlier queued message]', '', SPINNER, ''], ['❯ Press up to edit queued messages'])
const BUSY_TYPED = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ félig begépelt sor'])
const BUSY_PLACEHOLDER = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ [Pasted text #2 +1200 chars]'])
const BUSY_SATURATED = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ '], ['  Opus 5 · 100% context used', FOOTER])
const IDLE = pane(['  ⎿  … tool output …', ''], ['❯ '])
// a tool-permission dialog parked under a spinner line still in the live region
const BUSY_PERMISSION = [
  '  ⎿  … tool output …',
  SPINNER,
  ' Bash command',
  '   rm -rf build',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently (esc)',
  '',
  ' ↑/↓ to navigate · Esc to cancel',
].join('\n')
// the guards themselves: a live box AND a question / menu hint in the live region (the box
// rule alone would let these through, so each guard has a pane only it refuses)
const BUSY_BOX_AND_QUESTION = pane(['  ⎿  … tool output …', SPINNER, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], ['❯ '])
const BUSY_BOX_AND_MENU = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ '], ['  ↑/↓ to navigate · Esc to cancel', FOOTER])
// Captured live (murena, 2026-10-14, mid-turn, the bottom seven lines): the prompt glyph is
// followed by a NO-BREAK SPACE (U+00A0), and the top separator carries the session's title.
const LIVE_BUSY = [
  '* Leavening… (5m 28s · ↓ 31.4k tokens · thought for 5s)',
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  '',
  '─'.repeat(151) + ' Murena ─',
  '❯\u00a0',
  '─'.repeat(160),
  '  claude-opus-5-5 | 5h 14% | 7d 50%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · install gh for PR status · ← for agents',
].join('\n')
// the same running turn, but not in bypass-permissions mode (barracuda, #117: there a
// permission question is far more likely, so the busy path is not offered)
const BUSY_ACCEPT_EDITS = pane(['  ⎿  … tool output …', '', SPINNER, ''], ['❯ '], ['  Opus 5 · ctx 40%', '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents'])
const BUSY_NO_BOX = ['  ⎿  … tool output …', SPINNER, FOOTER].join('\n')

describe('paneAcceptsQueuedPrompt', () => {
  it('QUEUE-ACCEPT: a running turn with an empty box, or with only the queue hint, takes a message', () => {
    expect([paneAcceptsQueuedPrompt(BUSY_EMPTY), paneAcceptsQueuedPrompt(BUSY_QUEUED)]).toEqual([true, true])
  })

  it('QUEUE-LIVE: a real mid-turn pane (no-break space after the prompt, titled separator) takes a message', () => {
    expect(paneAcceptsQueuedPrompt(LIVE_BUSY)).toBe(true)
  })

  it('QUEUE-REFUSE: idle, typed text, placeholder, permission question, saturated context, no live box', () => {
    expect(
      [IDLE, BUSY_TYPED, BUSY_PLACEHOLDER, BUSY_PERMISSION, BUSY_SATURATED, BUSY_NO_BOX, ''].map((p) => paneAcceptsQueuedPrompt(p)),
    ).toEqual([false, false, false, false, false, false, false])
  })

  it('QUEUE-GUARDS: a permission question or a menu hint refuses even with a free live box', () => {
    expect([paneAcceptsQueuedPrompt(BUSY_BOX_AND_QUESTION), paneAcceptsQueuedPrompt(BUSY_BOX_AND_MENU)]).toEqual([false, false])
  })

  it('QUEUE-BYPASS-ONLY: a running turn outside bypass-permissions mode is not offered the busy path', () => {
    expect(paneAcceptsQueuedPrompt(BUSY_ACCEPT_EDITS)).toBe(false)
  })

  it('QUEUE-GHOST: text the dim-stripped view does not show is a ghost; text it still shows is real', () => {
    expect([
      paneAcceptsQueuedPrompt(BUSY_TYPED, BUSY_EMPTY),
      paneAcceptsQueuedPrompt(BUSY_TYPED, BUSY_TYPED),
      paneAcceptsQueuedPrompt(BUSY_TYPED, null),
    ]).toEqual([true, false, false])
  })
})

// The diagnostics name the refusing look (delivery-diag.ts). RED if a name drifts from the
// boolean it stands behind, or two different blockers share a name.
describe('queuedPromptRefusal: the refusing look by name', () => {
  it('QUEUE-REASON: every fixture gets its own look name, and null exactly where it is accepted', () => {
    const cases: Array<[string, string, string | null]> = [
      ['BUSY_EMPTY', BUSY_EMPTY, null],
      ['BUSY_QUEUED', BUSY_QUEUED, null],
      ['IDLE', IDLE, 'not-busy'],
      ['BUSY_ACCEPT_EDITS', BUSY_ACCEPT_EDITS, 'not-bypass'],
      ['BUSY_PLACEHOLDER', BUSY_PLACEHOLDER, 'placeholder'],
      ['BUSY_SATURATED', BUSY_SATURATED, 'context-saturated'],
      ['BUSY_BOX_AND_QUESTION', BUSY_BOX_AND_QUESTION, 'permission-question'],
      ['BUSY_BOX_AND_MENU', BUSY_BOX_AND_MENU, 'menu'],
      ['BUSY_TYPED', BUSY_TYPED, 'box-not-free'],
      ['BUSY_NO_BOX', BUSY_NO_BOX, 'no-box'],
      ['BUSY_PERMISSION', BUSY_PERMISSION, 'permission-question'],
    ]
    expect(cases.map(([n, p]) => [n, queuedPromptRefusal(p)])).toEqual(cases.map(([n, , r]) => [n, r]))
    // the name and the boolean never disagree
    expect(cases.every(([, p]) => (queuedPromptRefusal(p) === null) === paneAcceptsQueuedPrompt(p))).toBe(true)
    expect([queuedPromptRefusal(BUSY_TYPED, BUSY_EMPTY), queuedPromptRefusal(null), queuedPromptRefusal('  ')]).toEqual([null, 'no-capture', 'no-capture'])
  })
})

describe('decideSubmitFollowup into a busy pane', () => {
  const HINT = 'TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer> block'
  const parked = pane(['  ⎿  … tool output …', '', SPINNER, ''], [`❯ ${HINT.slice(0, 70)}`, `  ${HINT.slice(70)}`])
  const busy = { busyTarget: true }

  it('BUSY-LANDED: an empty box or the queue hint is landed; our text still in the box gets an Enter, then gives up', () => {
    expect([
      decideSubmitFollowup(BUSY_EMPTY, HINT, 0, 3, busy),
      decideSubmitFollowup(BUSY_QUEUED, HINT, 0, 3, busy),
      decideSubmitFollowup(parked, HINT, 0, 3, busy),
      decideSubmitFollowup(parked, HINT, 3, 3, busy),
      decideSubmitFollowup(null, HINT, 0, 3, busy),
    ]).toEqual(['done', 'done', 'retry-enter', 'give-up', 'give-up'])
  })

  it('BUSY-DIALOG-AFTER-ENTER: a permission dialog on screen is not landed and gets no key (give-up)', () => {
    const dialog = ['  ⎿  … tool output …', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' ↑/↓ to navigate · Esc to cancel'].join('\n')
    expect(decideSubmitFollowup(dialog, HINT, 0, 3, busy)).toBe('give-up')
  })

  it('BUSY-NO-CTRL-C: a placeholder in a running turn is left alone (give-up), never clear-and-resend', () => {
    expect(decideSubmitFollowup(BUSY_PLACEHOLDER, HINT, 0, 3, busy)).toBe('give-up')
  })

  it('IDLE-TARGET-UNCHANGED: without busyTarget a busy pane is landed, as before', () => {
    expect([decideSubmitFollowup(parked, HINT, 0, 3), decideSubmitFollowup(BUSY_PLACEHOLDER, HINT, 0, 3)]).toEqual(['done', 'done'])
  })
})
