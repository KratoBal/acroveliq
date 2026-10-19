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
    const delays: number[] = []
    const s = [...submit]
    const c = [...clear]
    const deps: TakeoverDeps = {
      broker: async (v) => {
        log.push(v[0]!)
        if (v[0] === 'submit') return s.length > 1 ? s.shift()! : (s[0] ?? EMPTY)
        return c.length > 1 ? c.shift()! : (c[0] ?? OK)
      },
      delay: async (ms) => void delays.push(ms),
    }
    return takeOverParkedDelivery('proba', reason, deps).then((r) => ({ r, log, delays }))
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

  it.each(['not-in-box', 'placeholder', 'box-changed', 'something-new'])('%s: the box does not hold exactly our text: NOTHING pressed, NOTHING cleared, LEFT (no broker call at all)', async (reason) => {
    const x = await run(reason, [OK], [OK])
    expect([x.r.outcome, x.r.presses, x.log]).toEqual(['left', 0, []])
    expect(x.r.note).toContain('nothing cleared')
  })

  it.each(['dialog-while-typing:permission', 'dialog-before-enter:menu', 'dialog-after-enter:consent'])('%s: LEFT, no broker call at all (an Enter or a clear could answer it)', async (reason) => {
    const x = await run(reason, [], [])
    expect([x.r.outcome, x.log]).toEqual(['left', []])
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

  it.each(['not-in-box', 'placeholder', 'box-changed'])('typed but %s: no Enter and NO clear, NOT-LANDED, the takeover says LEFT', async (why) => {
    script({ code: 11, out: why }, [OK], [OK])
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver'])
    expect(reports[0]!.reason).toContain(`fleet-pane:${why}; takeover:left`)
  })

  it('a dialog after the Enter: nothing is touched, NOT-LANDED, the takeover says LEFT', async () => {
    script({ code: 11, out: 'dialog-after-enter:consent' })
    const { result, reports } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver'])
    expect(reports[0]!.reason).toContain('takeover:left')
  })

  it('a refusal BEFORE typing (code 10: busy, box-not-free) is not a typed-not-landed: no takeover', async () => {
    script({ code: 10, out: 'box-not-free' })
    const { result } = await send()
    expect(result).toBe('not-landed')
    expect(brokerVerbs()).toEqual(['deliver'])
    script({ code: 10, out: 'busy' })
    calls.length = 0
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
