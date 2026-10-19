// The router's side of the root broker into agent panes (src/web/fleet-pane.ts, the broker
// branches in agent-process.ts; B48 (2), P1-13, task t-20261015-b48-fleet-pane).
//
// WHAT TURNS THIS RED:
//   - with the switch ON, any call aimed at an agent under its own user goes out as
//     `sudo -u <user> tmux`, or any raw send-keys leaves at all (typing, dialogs, clear, Enter);
//   - a tmux shape with no verb falls back to the old line instead of being refused;
//   - a read/lifecycle shape the router uses is not translated, or is translated loosely
//     (another session, a longer history, an extra flag);
//   - the message text reaches the broker anywhere but its stdin, or the broker's refusal
//     reads as delivered;
//   - with the switch OFF (the default), anything changes: the old path, unchanged;
//   - a new-session (the router's command string) reaches the broker or the old line with the
//     switch on; a start skips `generate`, starts after a refused generate, or passes anything
//     but the closed launch list; a broker-started agent still gets a typed `/name`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

type Call = { file: string; args: string[]; input?: string; timeout?: number }
const calls: Call[] = []
let pane = ''
let brokerAnswer: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: 'landed' })

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  const syncFake = vi.fn((file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    const a = [...args]
    if (a.includes('capture-pane') || a[2] === 'capture') return pane
    if (a[2] === 'status') return 'agent-proba\n'
    if (a[1] === '/usr/local/sbin/fleet-pane') {
      const r = brokerAnswer(a.slice(2))
      if (r.code !== 0) throw Object.assign(new Error('broker'), { status: r.code, stdout: r.out })
      return r.out
    }
    return ''
  })
  const asyncFake = vi.fn((file: string, args: readonly string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
    const call: Call = { file, args: [...args], timeout: (_opts as { timeout?: number }).timeout }
    calls.push(call)
    const child = new EventEmitter() as EventEmitter & { stdin: { end: (s?: string) => void } }
    child.stdin = {
      end: (s?: string) => {
        if (s !== undefined) call.input = s
        const r = brokerAnswer([...args].slice(2))
        setImmediate(() => cb(r.code === 0 ? null : Object.assign(new Error('broker'), { code: r.code }), r.out, ''))
      },
    }
    return child
  })
  return { ...orig, execFileSync: syncFake, execFile: asyncFake }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, listAgentNames: () => ['proba'], readAgentRunAsUser: (n: string) => (n === 'proba' ? 'agent-proba' : null) }
})

import { brokerArgsForTmux, brokerStartAgent, _setFleetPaneBrokerForTest, FLEET_PANE_BIN, deliverOutcome, deliverTimeoutMs, DELIVER_MAX_CHARS } from '../web/fleet-pane.js'
import { readFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { join } from 'node:path'
import { FLEET_PANE_BROKER } from '../config.js'
import { tmuxInvocationFor, sendPromptToSession, sendEnterToSession, clearInputBuffer, dismissResumeSummaryModalIfPresent, scheduleIdentitySetup } from '../web/agent-process.js'
import { getAbandonedPrompt, _resetInjectedPromptsForTest } from '../web/injected-prompt-registry.js'

const S = 'agent-proba'
const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const IDLE = ['  ⎿  … tool output …', '', SEP, '❯ ', SEP, '  Opus 5 · ctx 40%', FOOTER].join('\n')
const RESUME = [' Context low', ' ❯ 1. Resume from summary (recommended)', '   2. Resume full session', '', ' Enter to confirm · Esc to cancel'].join('\n')
const brokerCalls = () => calls.filter((c) => c.file === 'sudo' && c.args[1] === FLEET_PANE_BIN).map((c) => c.args.slice(2))
const rawKeys = () => calls.filter((c) => c.args.includes('send-keys') || c.args.includes('-u'))

beforeEach(() => {
  calls.length = 0
  pane = IDLE
  brokerAnswer = () => ({ code: 0, out: 'landed' })
  _resetInjectedPromptsForTest()
})
afterEach(() => _setFleetPaneBrokerForTest(null))

describe('the translation (brokerArgsForTmux)', () => {
  it('FP-TRANSLATE: every read and lifecycle shape the router uses has its exact verb; a new-session has none', () => {
    expect([
      brokerArgsForTmux(['has-session', '-t', S], 'proba'),
      brokerArgsForTmux(['list-sessions', '-F', '#{session_name}'], 'proba'),
      brokerArgsForTmux(['display-message', '-p', '-t', S, '#{session_created}'], 'proba'),
      brokerArgsForTmux(['capture-pane', '-t', S, '-p'], 'proba'),
      brokerArgsForTmux(['capture-pane', '-t', S, '-e', '-p'], 'proba'),
      brokerArgsForTmux(['capture-pane', '-t', S, '-S', '-2000', '-e', '-p'], 'proba'),
      brokerArgsForTmux(['kill-session', '-t', S], 'proba'),
      brokerArgsForTmux(['new-session', '-d', '-s', S, '-x', '200', '-y', '24', 'claude'], 'proba'),
    ]).toEqual([
      ['status', 'proba'], ['status', 'proba'], ['status', 'proba', '--created'], ['capture', 'proba'], ['capture', 'proba', '--ansi'],
      ['capture', 'proba', '--lines', '2000', '--ansi'], ['stop', 'proba'], null,
    ])
  })

  it('FP-NO-VERB: raw keys, run-shell, another session, a longer history, an extra flag: no verb', () => {
    const none = [
      ['send-keys', '-t', S, '-l', 'x'], ['send-keys', '-t', S, 'Enter'], ['run-shell', 'id'], ['capture-pane', '-t', 'agent-masik', '-p'],
      ['capture-pane', '-t', S, '-S', '-5000', '-p'], ['capture-pane', '-t', S, '-p', '-J'], ['kill-session', '-t', S, '-a'],
      ['has-session', '-t', `${S}:0.1`], ['display-message', '-p', '-t', S, '#{pane_pid}'], ['list-sessions'], ['kill-server'],
    ]
    expect(none.map((a) => brokerArgsForTmux(a, 'proba'))).toEqual(none.map(() => null))
  })
})

describe('with the switch OFF (the default)', () => {
  it('FP-OFF: the switch defaults off, and every path is the old one (sudo -u, send-keys)', async () => {
    expect([FLEET_PANE_BROKER, tmuxInvocationFor(['capture-pane', '-t', S, '-p']).args.slice(0, 4)]).toEqual([false, ['-n', '-u', 'agent-proba', expect.stringContaining('tmux')]])
    await sendPromptToSession(S, 'Hello broker', null, { waitForIdle: false })
    expect([brokerCalls(), calls.some((c) => c.args.includes('send-keys'))]).toEqual([[], true])
  })
})

describe('with the switch ON', () => {
  beforeEach(() => _setFleetPaneBrokerForTest(true))

  it('FP-INVOKE: reads go to the broker verb; a shape with no verb throws (never the old line), a new-session too', () => {
    expect(tmuxInvocationFor(['capture-pane', '-t', S, '-e', '-p'])).toEqual({ file: 'sudo', args: ['-n', FLEET_PANE_BIN, 'capture', 'proba', '--ansi'] })
    expect(tmuxInvocationFor(['list-sessions', '-F', '#{session_name}'], { host: null, runAsUser: 'agent-proba' })).toEqual({ file: 'sudo', args: ['-n', FLEET_PANE_BIN, 'status', 'proba'] })
    expect(() => tmuxInvocationFor(['send-keys', '-t', S, 'Enter'])).toThrow(/fleet-pane: no broker verb for tmux send-keys/)
    expect(() => tmuxInvocationFor(['run-shell', '-t', S, 'id'])).toThrow(/no broker verb/)
    expect(() => tmuxInvocationFor(['new-session', '-d', '-s', S, '-x', '200', '-y', '24', 'claude'])).toThrow(/no broker verb for tmux new-session/)
  })

  it('FP-START: generate, then start with exactly the launch list; a refused generate starts nothing', async () => {
    const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
    for (const launch of [[], ['--continue'], ['--session-id', UUID]]) {
      calls.length = 0
      expect(await brokerStartAgent('proba', launch)).toEqual({ ok: true })
      expect(brokerCalls()).toEqual([['generate', 'proba'], ['start', 'proba', ...launch]])
    }
    calls.length = 0
    brokerAnswer = (a) => (a[0] === 'generate' ? { code: 10, out: 'profile-mismatch' } : { code: 0, out: 'started' })
    expect(await brokerStartAgent('proba', [])).toEqual({ ok: false, error: 'fleet-pane generate refused: profile-mismatch' })
    expect(brokerCalls()).toEqual([['generate', 'proba']])
    calls.length = 0
    brokerAnswer = (a) => (a[0] === 'start' ? { code: 12, out: 'running' } : { code: 0, out: 'generated x' })
    expect(await brokerStartAgent('proba', [])).toEqual({ ok: false, error: 'fleet-pane start refused: running' })
  })

  it('FP-NAME: a broker-started agent gets no typed /name (it has --name); the dialog checks still run', async () => {
    const logged: string[] = []
    const warn = vi.spyOn(logger, 'warn').mockImplementation(((_o: unknown, msg?: string) => { logged.push(String(msg)) }) as never)
    const info = vi.spyOn(logger, 'info').mockImplementation(((_o: unknown, msg?: string) => { logged.push(String(msg)) }) as never)
    vi.useFakeTimers()
    try {
      await scheduleIdentitySetup(S, 'Proba Nev')
      await vi.advanceTimersByTimeAsync(20_000)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      info.mockRestore()
    }
    // the raw send-keys would be refused anyway (no verb): what must not happen is the attempt
    const all = JSON.stringify(calls)
    expect([all.includes('/name'), calls.some((c) => c.args.includes('send-keys')), brokerCalls().some((a) => a[0] === 'capture'),
      logged.filter((m) => /\/name/.test(m))]).toEqual([false, false, true, []])
  })

  it('FP-TIMEOUT: the deliver limit is the broker\'s own deadline (read from its source) plus 30 s, grows with the text, and the max matches the broker', async () => {
    await sendPromptToSession(S, 'A' + 'x'.repeat(7999), null)
    const py = readFileSync(join(__dirname, '..', '..', 'scripts', 'root', 'fleet-pane.py'), 'utf8')
    const base = Number(/^DELIVER_BASE = ([\d.]+)$/m.exec(py)?.[1])
    const perPiece = Number(/^DELIVER_PER_PIECE = ([\d.]+)$/m.exec(py)?.[1])
    const chunk = Number(/^CHUNK = (\d+)$/m.exec(py)?.[1])
    const expectMs = (chars: number) => Math.round((base + 30 + perPiece * Math.ceil(chars / chunk)) * 1000)
    expect([calls.find((c) => c.args[2] === 'deliver')!.timeout, deliverTimeoutMs(DELIVER_MAX_CHARS), Number(/^MAX_TEXT = (\d+)$/m.exec(py)?.[1])]).toEqual([
      expectMs(8000), expectMs(DELIVER_MAX_CHARS), DELIVER_MAX_CHARS,
    ])
    expect([calls.find((c) => c.args[2] === 'deliver')!.timeout, deliverTimeoutMs(DELIVER_MAX_CHARS)]).toEqual([290_000, 950_000])
  })

  it('FP-DELIVER: the message goes to `deliver proba` on STDIN, nowhere in argv; no raw key, no sudo -u', async () => {
    const r = await sendPromptToSession(S, 'Hello broker\nsecond line', null)
    const deliver = calls.find((c) => c.args[2] === 'deliver')!
    expect([r, deliver.args, deliver.input, calls.some((c) => c.args.join(' ').includes('Hello')), rawKeys()]).toEqual([
      'sent', ['-n', FLEET_PANE_BIN, 'deliver', 'proba'], 'Hello broker second line', false, [],
    ])
  })

  it('FP-REFUSED: a broker refusal is never "sent": busy is aborted-busy, typed-not-landed is not-landed', async () => {
    brokerAnswer = (a) => (a[0] === 'deliver' ? { code: 10, out: 'busy' } : { code: 0, out: '' })
    const busy = await sendPromptToSession(S, 'Hello', null, { waitForIdle: false, onBusyTimeout: 'abort' })
    brokerAnswer = (a) => (a[0] === 'deliver' ? { code: 11, out: 'dialog-before-enter:permission-question' } : { code: 0, out: '' })
    const typed = await sendPromptToSession(S, 'Hello', null)
    expect([deliverOutcome({ code: 10, out: 'busy@confirm' }), deliverOutcome({ code: 10, out: 'permission-question' }), typed, rawKeys()]).toEqual(['aborted-busy', 'not-landed', 'not-landed', []])
    // a caller that does not wait (forceSend) tried the queued path once, with its own looks
    expect([busy, brokerCalls().filter((c) => c[0] === 'deliver').slice(0, 2)]).toEqual(['aborted-busy', [['deliver', 'proba'], ['deliver', 'proba', '--queued']]])
  })

  it('FP-QUEUED: delivery into a running turn is `deliver --queued`; a half left typed is recorded as abandoned (cleared, never submitted)', async () => {
    brokerAnswer = (a) => (a[0] === 'deliver' ? { code: 11, out: 'dialog-while-typing:permission-question' } : { code: 0, out: '' })
    const r = await sendPromptToSession(S, 'Hello queued', null, { waitForIdle: false, busyTarget: true })
    expect([r, brokerCalls().filter((c) => c[0] === 'deliver'), getAbandonedPrompt(S) != null]).toEqual(['not-landed', [['deliver', 'proba', '--queued']], true])
  })

  it('FP-DIALOG: the router\'s own dialog answer goes to `dismiss`, the Enter to `submit`, the clear to `clear`; no raw key', async () => {
    pane = RESUME
    await dismissResumeSummaryModalIfPresent(S, null)
    pane = IDLE
    const entered = sendEnterToSession(S, null)
    const cleared = await clearInputBuffer(S, null)
    expect([brokerCalls().filter((c) => c[0] !== 'capture' && c[0] !== 'status'), entered, cleared, rawKeys()]).toEqual([
      [['dismiss', 'proba', 'resume-summary'], ['submit', 'proba'], ['clear', 'proba']], true, true, [],
    ])
  })
})
