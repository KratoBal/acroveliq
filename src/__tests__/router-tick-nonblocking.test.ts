import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Card b8ed4f45, slice (b), task t-20261114-router-capture-nonblocking (acrobot 17:10): the router tick started one
// SYNCHRONOUS `sudo fleet-pane` child per pane read and per receiver lookup. Measured with the real tick (the scratch
// harness this test came from), three agents (idle, busy with a free box, blocked on a permission question), two
// messages each, 80 ms per child:
//   BEFORE  tick 1: 105 sync children, 8.3 s of event-loop blocking, longest stall 571 ms; tick 2: 66 and 5.0 s
//   AFTER   tick 1:  46 sync children (all key writes), 3.6 s, longest stall 170 ms;       tick 2: 22 and 1.7 s
// WHAT TURNS THIS RED: a tick that starts a synchronous capture-pane, list-sessions or display-message child again;
// a tick that stops serving the idle agent (the positive control on the instrument).
const tmux = vi.hoisted(() => ({
  sync: {} as Record<string, number>,
  async: {} as Record<string, number>,
  sessions: [] as string[],
  panes: {} as Record<string, string>,
}))
const VERBS = ['list-sessions', 'display-message', 'capture-pane', 'send-keys', 'load-buffer', 'paste-buffer', 'set-buffer', 'delete-buffer', 'has-session']
const KEY_VERB = VERBS.find((v) => v.endsWith('-keys'))!
const verbOf = (args: string[]): string => VERBS.find((v) => args?.includes(v)) ?? 'other'
function answer(args: string[]): string {
  const verb = verbOf(args)
  if (verb === 'list-sessions') return tmux.sessions.join('\n') + '\n'
  if (verb === 'display-message') return '1700000000\n'
  if (verb === 'capture-pane') return tmux.panes[(args[args.indexOf('-t') + 1] ?? '').split(':')[0]!] ?? ''
  return ''
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((file: string, args: string[], ...rest: unknown[]) => {
      const verb = args ? verbOf(args) : 'other'
      if (verb === 'other') return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, ...rest)
      tmux.sync[verb] = (tmux.sync[verb] ?? 0) + 1
      return answer(args)
    }) as typeof actual.execFileSync,
  }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { agentDir } from '../web/agent-config.js'
import { agentSessionName, resetPaneSnapshotsForTest, setCaptureExecForTest } from '../web/agent-process.js'
import { createAgentMessage, getPendingMessages, initDatabase } from '../db.js'
import { runMessageRouterTick } from '../web/message-router.js'

const NAMES = ['zz-rt-idle', 'zz-rt-busy', 'zz-rt-block']
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const RULE = '─'.repeat(40)
const IDLE = ['some output', RULE, '❯ ', RULE, FOOTER].join('\n')
const BUSY = ['✻ Brewing… (23s · ↓ 1.4k tokens)', RULE, '❯ ', RULE, FOOTER + ' · esc to interrupt'].join('\n')
const BLOCKED = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', ' Esc to cancel'].join('\n')

describe('the router tick starts no synchronous pane-read or session-lookup child', () => {
  beforeEach(() => {
    for (const name of NAMES) mkdirSync(agentDir(name), { recursive: true })
    tmux.sync = {}
    tmux.async = {}
    tmux.sessions = NAMES.map(agentSessionName)
    tmux.panes = {
      [agentSessionName(NAMES[0]!)]: IDLE,
      [agentSessionName(NAMES[1]!)]: BUSY,
      [agentSessionName(NAMES[2]!)]: BLOCKED,
    }
    resetPaneSnapshotsForTest()
    setCaptureExecForTest(((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      const verb = verbOf(args)
      tmux.async[verb] = (tmux.async[verb] ?? 0) + 1
      setTimeout(() => cb(null, answer(args)), 1)
      return { stdin: { end: () => undefined } }
    }) as unknown as never)
    initDatabase(':memory:')
    for (const name of NAMES) {
      createAgentMessage('tester', name, 'msg 1')
      createAgentMessage('tester', name, 'msg 2')
    }
  })
  afterEach(() => {
    setCaptureExecForTest(null)
    for (const name of NAMES) rmSync(agentDir(name), { recursive: true, force: true })
  })

  it('two ticks: no sync capture-pane, list-sessions or display-message child, and the idle agent is served', async () => {
    await runMessageRouterTick()
    await runMessageRouterTick()
    expect(tmux.sync['capture-pane'] ?? 0).toBe(0)
    expect(tmux.sync['list-sessions'] ?? 0).toBe(0)
    expect(tmux.sync['display-message'] ?? 0).toBe(0)
    // slice (c) (card cdba1d62): the KEY WRITES are async too, so the tick starts no synchronous tmux child AT ALL
    expect(Object.values(tmux.sync).reduce((a, b) => a + b, 0)).toBe(0)
    // positive control on the instrument: the tick really ran the delivery path, and its writes used the async launcher
    expect(tmux.async[KEY_VERB] ?? 0).toBeGreaterThan(0)
    expect(getPendingMessages(NAMES[0]!).length).toBe(0) // the idle agent got both messages
    expect(getPendingMessages(NAMES[2]!).length).toBe(2) // the blocked agent keeps them: a permission question takes no line
  })
})

// What the behaviour test cannot reach: the stuck-session capture runs only after STUCK_ESCALATE_MS, and a pane read
// inside a function the tick does not exercise in this fixture. Guarded in the source, the way the other wiring is.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('wiring: no synchronous pane read in the router path', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const router = readFileSync(join(root, 'message-router.ts'), 'utf8')
  const processSrc = readFileSync(join(root, 'agent-process.ts'), 'utf8')
  const SYNC_READ = /\b(capturePane|captureParkedInputView|captureTmux)\(/

  it('message-router.ts reads panes and looks sessions up only through the async twins', () => {
    expect(router).not.toMatch(/\bcapturePane\(/)
    expect(router).not.toMatch(/\bsessionExistsOnHost\(/)
    expect(router).toContain('capturePaneAsync(')
    expect(router).toContain('sessionExistsOnHostAsync(')
  })

  it('the same functions and the Enter helper write keys through runTmuxAsync, never the sync runTmux or the sync broker call', () => {
    const names = [
      'sendPromptToSession',
      'clearInputBuffer',
      'discardPlaceholderBuffer',
      'answerFirstRunGates',
      'clearStaleParkedInput',
      'dismissSurveyModalIfPresent',
      'dismissResumeSummaryModalIfPresent',
      'dismissFeedbackDraftModalIfPresent',
      'dismissModelConsentDialogIfPresent',
      'sendEnterToSession',
    ]
    for (const name of names) {
      const at = processSrc.search(new RegExp(`\\n(export )?async function ${name}\\(`))
      expect(at, name).toBeGreaterThan(-1)
      const body = processSrc.slice(at, processSrc.indexOf('\n}\n', at))
      expect(body, name).not.toMatch(/\brunTmux\(/)
      expect(body, name).not.toMatch(/\bcallBrokerSync\(/)
    }
  })

  it('the delivery, modal, janitor and refusal functions in agent-process.ts read with no sync child', () => {
    const names = [
      'sendPromptToSession',
      'clearInputBuffer',
      'discardPlaceholderBuffer',
      'answerFirstRunGates',
      'waitForPaneIdle',
      'clearStaleParkedInput',
      'queuedPromptRefusalForSession',
      'clearFeedbackModalAndRecheck',
      'dismissSurveyModalIfPresent',
      'dismissResumeSummaryModalIfPresent',
      'dismissFeedbackDraftModalIfPresent',
      'dismissModelConsentDialogIfPresent',
    ]
    for (const name of names) {
      const at = processSrc.search(new RegExp(`\\n(export )?async function ${name}\\(`))
      expect(at, name).toBeGreaterThan(-1)
      const end = processSrc.indexOf('\n}\n', at)
      expect(processSrc.slice(at, end), name).not.toMatch(SYNC_READ)
    }
  })
})
