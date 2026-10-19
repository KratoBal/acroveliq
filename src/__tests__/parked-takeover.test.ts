// A delivery that typed the message and did not land it (task kezbesites-enter-parkol, card e406512f):
// src/web/parked-takeover.ts and its use in sendPromptViaBroker / the router.
//
// WHAT TURNS THIS RED: a typed-not-landed deliver that is only logged again (the text left parked); a parked text our own Enter
// submitted being typed again (the 2026-10-19 double delivery of message 32993); a `landed` claimed without the pane saying so,
// above all an EMPTY box seen BEFORE any Enter of ours (somebody else may have emptied it: a silent loss; barracuda, #264 review);
// a submit pressed on a placeholder, a box that holds something else, or under a dialog; a CLEAR of a box that the broker said does
// not hold exactly our text (it could wipe a panel message or a person's typing); a clear that answers a dialog;
// more than three Enters; a takeover on the QUEUED path (it has its own recovery); the idle diagnostic row without the broker's
// reason; a stuck takeover that is not said at once to the main agent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Call = { file: string; args: string[]; input?: string }
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
    const call: Call = { file, args: [...args] }
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

import { _setFleetPaneBrokerForTest } from '../web/fleet-pane.js'
import { sendPromptToSession } from '../web/agent-process.js'
import { getAbandonedPrompt, _resetInjectedPromptsForTest } from '../web/injected-prompt-registry.js'
import { TAKEOVER_MAX_PRESSES, TAKEOVER_SETTLE_MS, takeOverParkedDelivery, type TakeoverDeps } from '../web/parked-takeover.js'
import { formatParkedDeliveryAlert } from '../web/message-router.js'
import type { BusyPaneReport } from '../web/busy-pane-emit.js'

const S = 'agent-proba'
const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const IDLE = ['  ⎿  … tool output …', '', SEP, '❯ ', SEP, '  Opus 5 · ctx 40%', FOOTER].join('\n')
const verbs = () => calls.filter((c) => c.file === 'sudo').map((c) => c.args.slice(2).join(' '))
const brokerVerbs = () => verbs().filter((v) => /^(deliver|submit|clear)\b/.test(v)).map((v) => v.split(' ')[0])

/** A broker that answers deliver with `del`, then each submit/clear from its own script (the last answer repeats). */
function script(del: { code: number; out: string }, submit: { code: number; out: string }[] = [], clear: { code: number; out: string }[] = []) {
  const s = [...submit]
  const c = [...clear]
  brokerAnswer = (a) => {
    if (a[0] === 'deliver') return del
    if (a[0] === 'submit') return s.length > 1 ? s.shift()! : (s[0] ?? { code: 12, out: 'box-empty' })
    if (a[0] === 'clear') return c.length > 1 ? c.shift()! : (c[0] ?? { code: 0, out: 'ok' })
    return { code: 0, out: 'ok' }
  }
}
const OK = { code: 0, out: 'ok' }
const EMPTY = { code: 12, out: 'box-empty' }
const RUNNING = { code: 12, out: 'not-idle' }
const DIALOG = { code: 12, out: 'dialog:permission' }
const NOT_OURS = { code: 12, out: 'not-ours' }
const PLACEHOLDER = { code: 12, out: 'placeholder' }
const OLD_BROKER = { code: 2, out: 'bad-option' }
const TEXT = 'Hello broker'

beforeEach(() => {
  calls.length = 0
  pane = IDLE
  brokerAnswer = () => ({ code: 0, out: 'landed' })
  _resetInjectedPromptsForTest()
  _setFleetPaneBrokerForTest(true)
})
afterEach(() => _setFleetPaneBrokerForTest(null))

describe('takeOverParkedDelivery (the decisions, with the broker injected)', () => {
  function run(reason: string, submit: { code: number; out: string }[], clear: { code: number; out: string }[] = []) {
    const log: string[] = []
    const full: { args: string; input?: string }[] = []
    const delays: number[] = []
    const s = [...submit]
    const c = [...clear]
    const deps: TakeoverDeps = {
      broker: async (v, input) => {
        log.push(v[0]!)
        full.push({ args: v.join(' '), input })
        if (v[0] === 'submit') return s.length > 1 ? s.shift()! : (s[0] ?? EMPTY)
        return c.length > 1 ? c.shift()! : (c[0] ?? OK)
      },
      delay: async (ms) => void delays.push(ms),
      text: TEXT,
    }
    return takeOverParkedDelivery('proba', reason, deps).then((r) => ({ r, log, delays, full }))
  }

  it('parked, the box is empty BEFORE any Enter of ours: UNKNOWN, not landed (somebody else may have emptied it), nothing pressed', async () => {
    const x = await run('parked', [EMPTY])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['unknown', 0, ['submit']])
    expect(x.r.note).toContain('not proof of delivery')
  })

  it('parked, one Enter of ours and the next look finds the box empty: LANDED after 1 press, settled in between', async () => {
    const x = await run('parked', [OK, EMPTY])
    expect([x.r.outcome, x.r.presses, x.log, x.delays]).toEqual(['landed', 1, ['submit', 'submit'], [TAKEOVER_SETTLE_MS]])
  })

  it('parked, a turn is running after our Enter: LANDED', async () => {
    const x = await run('parked', [OK, RUNNING])
    expect([x.r.outcome, x.r.presses]).toEqual(['landed', 1])
  })

  it('parked, a turn is running and no Enter of ours yet: UNKNOWN (never claimed landed), nothing cleared', async () => {
    const x = await run('parked', [RUNNING])
    expect([x.r.outcome, x.log]).toEqual(['unknown', ['submit']])
  })

  it(`parked and stubborn: at most ${TAKEOVER_MAX_PRESSES} Enters, then the clear is the look; an emptied box is CLEARED (the message goes again)`, async () => {
    const x = await run('parked', [OK], [OK])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['cleared', TAKEOVER_MAX_PRESSES, [...Array(TAKEOVER_MAX_PRESSES).fill('submit'), 'clear']])
    expect(x.delays).toHaveLength(TAKEOVER_MAX_PRESSES)
  })

  it('parked, the last Enter landed but the look came after the loop: the clear answers box-empty, so LANDED (not cleared, not resent)', async () => {
    const x = await run('parked', [OK], [EMPTY])
    expect(x.r.outcome).toBe('landed')
  })

  it('parked, the clear answers a running turn: LANDED; a dialog: LEFT; a failed clear: UNKNOWN', async () => {
    expect((await run('parked', [OK], [RUNNING])).r.outcome).toBe('landed')
    expect((await run('parked', [OK], [DIALOG])).r.outcome).toBe('left')
    expect((await run('parked', [OK], [{ code: 11, out: 'not-empty' }])).r.outcome).toBe('unknown')
  })

  it('parked, a dialog under the first submit: LEFT, nothing pressed, no clear', async () => {
    const x = await run('parked', [DIALOG])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['left', 0, ['submit']])
  })

  it('parked, the broker refuses or fails the submit: UNKNOWN, no clear', async () => {
    for (const bad of [{ code: 10, out: 'x' }, { code: 13, out: 'error:OSError' }, { code: -1, out: '' }]) {
      const x = await run('parked', [bad])
      expect([x.r.outcome, x.log]).toEqual(['unknown', ['submit']])
    }
  })

  it('every submit and clear of the takeover carries `--expect` and the typed text on STDIN (the content gate), nothing in argv', async () => {
    const x = await run('parked', [OK], [OK])
    expect(x.full.every((f) => f.args.endsWith('--expect') && f.input === TEXT)).toBe(true)
    expect(x.full.map((f) => f.args)).toEqual([...Array(TAKEOVER_MAX_PRESSES).fill('submit proba --expect'), 'clear proba --expect'])
    expect(JSON.stringify(x.full.map((f) => f.args))).not.toContain('Hello')
  })

  it('parked, the box no longer holds exactly our text before any Enter: LEFT, nothing pressed; after our Enter: UNKNOWN', async () => {
    const a = await run('parked', [NOT_OURS])
    expect([a.r.outcome, a.r.presses, a.log]).toEqual(['left', 0, ['submit']])
    const b = await run('parked', [OK, NOT_OURS])
    expect([b.r.outcome, b.r.presses]).toEqual(['unknown', 1])
  })

  it('parked, the TUI folded our text into a stub since the broker looked: the content-gated clear, never a second Enter', async () => {
    const a = await run('parked', [PLACEHOLDER], [OK])
    expect([a.r.outcome, a.log]).toEqual(['cleared', ['submit', 'clear']])
    const b = await run('parked', [PLACEHOLDER], [NOT_OURS])
    expect([b.r.outcome, b.log]).toEqual(['left', ['submit', 'clear']])
  })

  it('parked, still parked after the presses and the clear gate says not-ours: UNKNOWN, nothing cleared', async () => {
    const x = await run('parked', [OK], [NOT_OURS])
    expect(x.r.outcome).toBe('unknown')
  })

  it('an OLD broker (no --expect, answers bad-option): the parked branch falls back to its plain verbs once, then stays plain', async () => {
    const x = await run('parked', [OLD_BROKER, OK, EMPTY])
    expect([x.r.outcome, x.r.presses, x.full.map((f) => f.args)]).toEqual(['landed', 1, ['submit proba --expect', 'submit proba', 'submit proba']])
  })

  it('an OLD broker on a not-in-box reason: LEFT (no plain clear: it would not compare the content)', async () => {
    const x = await run('not-in-box', [], [OLD_BROKER])
    expect([x.r.outcome, x.log]).toEqual(['unknown', ['clear']])
  })

  it.each(['not-in-box', 'placeholder', 'box-changed', 'placeholder-stuck'])('%s: the content-gated clear: our text in the box is emptied (CLEARED, the message goes again)', async (reason) => {
    const x = await run(reason, [OK], [OK])
    expect([x.r.outcome, x.r.presses, x.log, x.full[0]!.args, x.full[0]!.input]).toEqual(['cleared', 0, ['clear'], 'clear proba --expect', TEXT])
  })

  it.each(['not-in-box', 'placeholder', 'box-changed'])('%s: a box that does NOT hold our text (not-ours): LEFT, nothing pressed, nothing cleared', async (reason) => {
    const x = await run(reason, [OK], [NOT_OURS])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['left', 0, ['clear']])
    expect(x.r.note).toContain('nothing cleared')
  })

  it('a clearable reason, the clear answers empty / running / dialog / not-empty: CLEARED / LEFT / LEFT / UNKNOWN', async () => {
    expect((await run('not-in-box', [], [EMPTY])).r.outcome).toBe('cleared')
    expect((await run('not-in-box', [], [RUNNING])).r.outcome).toBe('left')
    expect((await run('not-in-box', [], [DIALOG])).r.outcome).toBe('left')
    expect((await run('not-in-box', [], [{ code: 11, out: 'not-empty' }])).r.outcome).toBe('unknown')
  })

  it.each(['no-echo', 'placeholder-cleared', 'deliver-timeout'])('%s: the broker emptied what it typed: CLEARED, no broker call at all', async (reason) => {
    const x = await run(reason, [OK], [OK])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['cleared', 0, []])
  })

  it('a reason this router does not know: LEFT, no broker call at all', async () => {
    const x = await run('something-new', [OK], [OK])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['left', 0, []])
    expect(x.r.note).toContain('nothing cleared')
  })

  it.each(['dialog-while-typing:permission', 'dialog-before-enter:menu', 'dialog-after-enter:consent'])('%s: LEFT, no broker call at all (an Enter or a clear could answer it)', async (reason) => {
    const x = await run(reason, [], [])
    expect([x.r.outcome, x.log]).toEqual(['left', []])
    expect(x.r.note).toContain('a dialog is up')
  })
})

describe('sendPromptToSession through the broker: the takeover on the IDLE path', () => {
  const send = (opts: Record<string, unknown> = {}) => {
    const reports: BusyPaneReport[] = []
    return sendPromptToSession(S, 'Hello broker', null, { onBusyReport: (r) => reports.push(r), ...opts }).then((result) => ({ result, reports }))
  }

  it('a plain delivery is untouched: sent, one deliver, no submit or clear, no diagnostic report', async () => {
    script({ code: 0, out: 'landed' })
    const { result, reports } = await send()
    expect(result).toBe('sent')
    expect(brokerVerbs()).toEqual(['deliver'])
    expect(reports).toEqual([])
  })

  it('typed, parked, and the box is empty BEFORE any Enter of ours: NOT-LANDED (never claimed delivered), the reason in the report', async () => {
    script({ code: 11, out: 'parked' }, [EMPTY])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver', 'submit'])
    expect(reports).toHaveLength(1)
    expect(reports[0]!.result).toBe('not-landed')
    expect(reports[0]!.reason).toContain('fleet-pane:parked; takeover:unknown(the box was empty before any Enter of ours')
  })

  it('typed, parked, our Enter lands it: SENT after the settle', async () => {
    script({ code: 11, out: 'parked' }, [OK, EMPTY])
    expect((await send()).result).toBe('sent')
    expect(brokerVerbs()).toEqual(['deliver', 'submit', 'submit'])
  })

  it('typed, parked, stubborn: three Enters and a clear, NOT-LANDED (the message stays pending, the box is empty), reason in the report', async () => {
    script({ code: 11, out: 'parked' }, [OK], [OK])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver', 'submit', 'submit', 'submit', 'clear'])
    expect(reports[0]!.result).toBe('not-landed')
    expect(reports[0]!.reason).toContain('fleet-pane:parked; takeover:cleared')
  })

  it.each(['not-in-box', 'placeholder', 'box-changed'])('typed but %s: no Enter, ONE content-gated clear with the text on stdin: NOT-LANDED, the takeover says CLEARED', async (why) => {
    script({ code: 11, out: why }, [OK], [OK])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver', 'clear'])
    const clear = calls.find((c) => c.args[2] === 'clear')!
    expect([clear.args.slice(2), clear.input]).toEqual([['clear', 'proba', '--expect'], 'Hello broker'])
    expect(reports[0]!.reason).toContain(`fleet-pane:${why}; takeover:cleared`)
  })

  it.each(['not-in-box', 'placeholder', 'box-changed'])('typed but %s and the box holds something that is not ours: the clear gate says not-ours, NOT-LANDED, the takeover says LEFT', async (why) => {
    script({ code: 11, out: why }, [OK], [NOT_OURS])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver', 'clear'])
    expect(reports[0]!.reason).toContain(`fleet-pane:${why}; takeover:left`)
  })

  it.each(['no-echo', 'placeholder-cleared', 'deliver-timeout'])('typed but %s: the broker emptied it itself: no further call, NOT-LANDED, the takeover says CLEARED', async (why) => {
    script({ code: 11, out: why }, [OK], [OK])
    const { result, reports } = await send()
    expect([result, brokerVerbs()]).toEqual(['not-landed', ['deliver']])
    expect(reports[0]!.reason).toContain(`fleet-pane:${why}; takeover:cleared`)
  })

  it('a dialog after the Enter: nothing is touched, NOT-LANDED, the takeover says LEFT', async () => {
    script({ code: 11, out: 'dialog-after-enter:consent' })
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver'])
    expect(reports[0]!.reason).toContain('takeover:left')
  })

  it('box-not-free: an earlier copy of THIS message may sit in the box: one content-gated clear; ours is emptied and the message typed once more', async () => {
    const answers = [{ code: 10, out: 'box-not-free' }, { code: 0, out: 'landed' }]
    brokerAnswer = (a) => (a[0] === 'deliver' ? answers.shift()! : { code: 0, out: 'ok' })
    const { result, reports } = await send()
    expect([result, brokerVerbs(), reports]).toEqual(['sent', ['deliver', 'clear', 'deliver'], []])
    const clear = calls.find((c) => c.args[2] === 'clear')!
    expect([clear.args.slice(2), clear.input]).toEqual([['clear', 'proba', '--expect'], 'Hello broker'])
  })

  it('box-not-free and the box holds something that is not our text: the gate says not-ours, nothing is typed again, NOT-LANDED, the reason alone in the report', async () => {
    script({ code: 10, out: 'box-not-free' }, [], [NOT_OURS])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver', 'clear'])
    expect(reports.map((r) => r.reason)).toEqual(['fleet-pane:box-not-free'])
  })

  it('a refusal BEFORE typing (code 10: busy) is not a typed-not-landed: no takeover', async () => {
    script({ code: 10, out: 'busy' })
    calls.length = 0
    brokerAnswer = (a) => (a[0] === 'deliver' ? { code: 10, out: 'busy' } : { code: 0, out: 'ok' })
    // a caller that does not wait for idle retries the queued path once (existing behaviour): still no submit or clear
    expect((await send({ onBusyTimeout: 'abort', waitForIdle: false })).result).toBe('aborted-busy')
    expect(brokerVerbs()).toEqual(['deliver', 'deliver'])
  })

  it('the QUEUED path (busyTarget) keeps its own recovery: no submit, no clear, the abandoned prompt is recorded', async () => {
    script({ code: 11, out: 'parked' }, [EMPTY], [OK])
    const { result } = await send({ waitForIdle: false, busyTarget: true })
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver'])
    expect(getAbandonedPrompt(S)).not.toBeNull()
  })
})

describe('the router: the alert and the diagnostic row', () => {
  it('the alert names the message, the agent and the reason, tells the way out, and warns about the double delivery', () => {
    const t = formatParkedDeliveryAlert('barracuda', 'acrobot', 'agent-barracuda', 32993, 'fleet-pane:parked; takeover:unknown(a turn is running and the box was not seen empty)')!
    expect(t).toContain('[delivery-parked]')
    expect(t).toContain('32993')
    expect(t).toContain("'barracuda'")
    expect(t).toContain('takeover:unknown')
    expect(t).toContain('fleet-pane submit barracuda')
    expect(t).toContain('arrive twice')
  })

  it('never for the main agent, and a reason with control characters is made printable and cut', () => {
    expect(formatParkedDeliveryAlert('acrobot', 'acrobot', 'tmux', 1, 'x')).toBeNull()
    const t = formatParkedDeliveryAlert('barracuda', 'acrobot', 's', 1, `a\nb\u0001${'z'.repeat(400)}`)!
    expect(t).not.toMatch(/[\n\u0001]/)
    expect(t.length).toBeLessThan(700)
  })

  const src = readFileSync(join(process.cwd(), 'src', 'web', 'message-router.ts'), 'utf8')
  it('the router alerts at once for left and unknown only, and the idle send passes the report callback', () => {
    expect(src).toContain('/takeover:(left|unknown)/.test(r.reason)')
    expect(src).not.toMatch(/takeover:\(cleared/)
    const idleCall = src.indexOf(': await sendPromptToSession(session, prefix + wrapped, host, {')
    expect(idleCall).toBeGreaterThan(0)
    expect(src.slice(idleCall, idleCall + 400)).toContain('onBusyReport')
  })
})
