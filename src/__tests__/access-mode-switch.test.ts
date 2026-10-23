// The ACCESS_MODE switch as one named, logged step (src/web/access-mode-switch.ts; acrobot 35368, P0-1 / B3).
// WHAT TURNS THIS RED: a position that switches the check off, or a typo that opens; a forward step that
// skips a position, goes without the owner's approval reference or without two clean daily preflights one
// after the other; a way back that lands anywhere but `naplo` or goes without a reason; the `.env` edit that
// leaves two lines, touches another setting or drops the trailing newline; a probe set that cannot tell the
// three running modes apart; a failed probe that leaves the setting where it was; a restart that fails and
// leaves the new line in `.env`; a refused or dry-run step that writes, restarts or records.
import { describe, it, expect } from 'vitest'
import {
  ROLLBACK_TARGET, cleanRuns, modeFromStatuses, modeInEnv, parseHistory, planTransition, probesFor,
  restartDashboard, runSwitch, setModeInEnv, CLEAN_RUN_MAX_AGE_S, CLEAN_RUNS_MIN_GAP_S,
  type HistoryEntry, type Probe, type RestartIo, type SwitchDeps, type SwitchRecord,
} from '../web/access-mode-switch.js'
import { ACCESS_MODES, type AccessMode } from '../web/access-enforcement.js'

const NOW = 1_800_000_000
const H = 3600
const clean = (...agoHours: number[]): HistoryEntry[] => agoHours.map((h) => ({ ts: NOW - h * H, verdict: 'RENDBEN', rest: '' }))
const TWO_CLEAN = clean(25, 1)

describe('the history of the daily preflight', () => {
  it('parses one line per run, skips what is not a line, keeps the order', () => {
    const text = '1799990000 RENDBEN RENDBEN: minden rendben\nnem sor\n1799999000 JELZES JELZES: valami\n\n'
    expect(parseHistory(text)).toEqual([
      { ts: 1799990000, verdict: 'RENDBEN', rest: 'RENDBEN: minden rendben' },
      { ts: 1799999000, verdict: 'JELZES', rest: 'JELZES: valami' },
    ])
  })

  it('two clean runs a day apart, the newest fresh: clean', () => {
    expect(cleanRuns(TWO_CLEAN, NOW).ok).toBe(true)
    // an extra manual run between them does not break the chain
    expect(cleanRuns(clean(25, 12, 1), NOW).ok).toBe(true)
  })

  it('no history, a stale newest run, a run too close, a JELZES in the chain: not clean, each with its reason', () => {
    expect(cleanRuns([], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('no history') })
    expect(cleanRuns(clean(70, 40), NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('hours old') })
    expect(cleanRuns(clean(5, 1), NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('span less than') })
    const broken: HistoryEntry[] = [...clean(30), { ts: NOW - 12 * H, verdict: 'JELZES', rest: '' }, ...clean(1)]
    expect(cleanRuns(broken, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('JELZES') })
    expect(cleanRuns([...clean(30), { ts: NOW - H, verdict: 'JELZES', rest: '' }], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('not RENDBEN') })
  })

  it('the limits are the documented ones', () => {
    expect([CLEAN_RUNS_MIN_GAP_S, CLEAN_RUN_MAX_AGE_S]).toEqual([20 * H, 36 * H])
    expect(cleanRuns(clean(20, 0), NOW).ok).toBe(true)
    expect(cleanRuns(clean(19.9, 0), NOW).ok).toBe(false)
  })
})

describe('the plan', () => {
  const plan = (over: Partial<Parameters<typeof planTransition>[0]>) =>
    planTransition({ from: 'naplo', to: 'legacy-szukitett', approval: 'discord:1562000000000000000', history: TWO_CLEAN, now: NOW, ...over })

  it('there is no position that switches the check off, and a typo is refused, not taken as the strictest', () => {
    for (const to of ['ki', 'off', 'none', 'kikenyszeri', '']) {
      expect(plan({ from: 'kikenyszerit', to, reason: 'vészhelyzet, nincs más' }).ok, to).toBe(false)
    }
    // case and spaces are not a typo (parseAccessMode): this is the same position, already held
    expect(plan({ from: 'kikenyszerit', to: ' KIKENYSZERIT ' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('already')] })
  })

  it('one position at a time, forward', () => {
    expect(plan({ from: 'naplo', to: 'legacy-szukitett' })).toMatchObject({ ok: true, kind: 'forward' })
    expect(plan({ from: 'legacy-szukitett', to: 'kikenyszerit' })).toMatchObject({ ok: true, kind: 'forward' })
    expect(plan({ from: 'naplo', to: 'kikenyszerit' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('one position at a time')] })
  })

  it('a forward step needs the approval reference and two clean daily runs', () => {
    expect(plan({ approval: '' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('approval')] })
    expect(plan({ approval: 'igen' })).toMatchObject({ ok: false })
    expect(plan({ history: [] })).toMatchObject({ ok: false, refusals: [expect.stringContaining('preflight')] })
    expect(plan({ approval: undefined, history: [] })).toMatchObject({ ok: false, refusals: [expect.any(String), expect.any(String)] })
  })

  it('the way back is to naplo, in one step, with a reason, and needs no preflight', () => {
    const back = (over: Partial<Parameters<typeof planTransition>[0]>) =>
      planTransition({ from: 'kikenyszerit', to: 'naplo', reason: 'a fő ágens egy fix útja 403-at kap', history: [], now: NOW, ...over })
    expect(back({})).toMatchObject({ ok: true, kind: 'rollback', to: ROLLBACK_TARGET })
    expect(back({ from: 'legacy-szukitett' })).toMatchObject({ ok: true, kind: 'rollback' })
    expect(back({ to: 'legacy-szukitett' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('in one step')] })
    expect(back({ reason: '' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('reason')] })
    expect(back({ reason: 'rövid' })).toMatchObject({ ok: false })
  })

  it('to the position it is already in: refused', () => {
    expect(plan({ from: 'naplo', to: 'naplo' })).toMatchObject({ ok: false, refusals: [expect.stringContaining('already')] })
  })
})

describe('the .env line', () => {
  it('reads the last ACCESS_MODE line, like src/env.ts; a missing one is naplo; a typo is the strictest and says so', () => {
    expect(modeInEnv('A=1\n').mode).toBe('naplo')
    expect(modeInEnv('ACCESS_MODE=legacy-szukitett\nACCESS_MODE=kikenyszerit\n').mode).toBe('kikenyszerit')
    expect(modeInEnv('ACCESS_MODE="naplo"\n').mode).toBe('naplo')
    expect(modeInEnv('# ACCESS_MODE=kikenyszerit\n').mode).toBe('naplo')
    expect(modeInEnv('ACCESS_MODE=kikenyszeri\n')).toMatchObject({ mode: 'kikenyszerit', problem: expect.stringContaining('none of') })
  })

  it('replaces the first line, removes the duplicates, touches nothing else, keeps the trailing newline', () => {
    const before = '# fejléc\nMAIN_AGENT_ID=acrobot\nACCESS_MODE=naplo\nEGYEB=a=b=c\nACCESS_MODE=naplo\n# ACCESS_MODE=komment marad\n'
    const after = setModeInEnv(before, 'legacy-szukitett')
    expect(after).toBe('# fejléc\nMAIN_AGENT_ID=acrobot\nACCESS_MODE=legacy-szukitett\nEGYEB=a=b=c\n# ACCESS_MODE=komment marad\n')
    expect(after.split('\n').filter((l) => l.startsWith('ACCESS_MODE=')).length).toBe(1)
    expect(modeInEnv(after).mode).toBe('legacy-szukitett')
  })

  it('appends the line when there is none, before the trailing newline', () => {
    expect(setModeInEnv('A=1\nB=2\n', 'naplo')).toBe('A=1\nB=2\nACCESS_MODE=naplo\n')
    expect(setModeInEnv('', 'naplo')).toBe('ACCESS_MODE=naplo\n')
  })
})

describe('the probes', () => {
  it('the first two tell the three running modes apart, and read back to the same mode', () => {
    const pairs = ACCESS_MODES.map((m) => probesFor(m, '2026-10-23').slice(0, 2).map((p) => p.expected).join('/'))
    expect(new Set(pairs).size).toBe(3)
    for (const mode of ACCESS_MODES) {
      const [l, a] = probesFor(mode, '2026-10-23')
      expect(modeFromStatuses(l!.expected, a!.expected)).toBe(mode)
    }
    expect(modeFromStatuses(200, 200)).toBeNull()
  })

  it("the main agent's fixed routes are 200 in every mode, and every probe is a GET (a probe writes nothing)", () => {
    for (const mode of ACCESS_MODES) {
      const fixed = probesFor(mode, '2026-10-23').filter((p) => p.caller === 'A' && !p.path.includes('nincs-ilyen'))
      expect(fixed.length).toBeGreaterThanOrEqual(4)
      expect(fixed.every((p) => p.expected === 200)).toBe(true)
    }
  })
})

// ---- the restart, proven ----------------------------------------------------------------

function restartIo(over: { pids?: Array<number | null>; code?: number | null; answers?: boolean[] } = {}): RestartIo & { clock: number; ran: number } {
  const pids = [...(over.pids ?? [100, 100, 200])]
  const answers = [...(over.answers ?? [true])]
  const io = {
    clock: 0,
    ran: 0,
    pid: async () => (pids.length > 1 ? pids.shift()! : pids[0]!),
    restart: async () => { io.ran += 1; return over.code === undefined ? 0 : over.code },
    answers: async () => (answers.length > 1 ? answers.shift()! : answers[0]!),
    sleep: async (ms: number) => { io.clock += ms },
    now: () => io.clock,
  }
  return io
}

describe('the restart is a NEW process answering', () => {
  it('a new pid that answers: restarted', async () => {
    expect(await restartDashboard(restartIo({ pids: [100, 100, 200] }), 30_000)).toMatchObject({ ok: true, why: expect.stringContaining('new process 200') })
  })

  it('supervisorctl failing is a failure, even though the old process still answers', async () => {
    const io = restartIo({ code: 7, pids: [100] })
    expect(await restartDashboard(io, 30_000)).toMatchObject({ ok: false, why: expect.stringContaining('supervisorctl exited 7') })
    expect(await restartDashboard(restartIo({ code: null, pids: [100] }), 30_000)).toMatchObject({ ok: false })
  })

  it('the SAME process answering is not a restart (the old one did not stop)', async () => {
    expect(await restartDashboard(restartIo({ pids: [100] }), 10_000)).toMatchObject({ ok: false, why: expect.stringContaining('same process (pid 100)') })
  })

  it('a pid that cannot be read before the restart cannot be proven; one that never answers fails after the wait', async () => {
    const unreadable = restartIo({ pids: [null] })
    expect(await restartDashboard(unreadable, 30_000)).toMatchObject({ ok: false, why: expect.stringContaining('could not be read') })
    expect(unreadable.ran).toBe(0)
    expect(await restartDashboard(restartIo({ pids: [100, 200], answers: [false] }), 10_000)).toMatchObject({ ok: false, why: expect.stringContaining('no new process answered') })
  })

  it('a new process that comes up a little later still counts', async () => {
    expect(await restartDashboard(restartIo({ pids: [100, null, 200], answers: [false, true] }), 30_000)).toMatchObject({ ok: true })
  })
})

// ---- the step, with fakes ---------------------------------------------------------------

function fakes(over: { env?: string; history?: string; answers?: (mode: AccessMode, p: Probe) => number; restartOk?: boolean[] } = {}) {
  const state = { env: over.env ?? 'MAIN_AGENT_ID=acrobot\nACCESS_MODE=naplo\n', writes: [] as string[], records: [] as SwitchRecord[], restarts: 0, running: 'naplo' as AccessMode }
  const restartPlan = over.restartOk ?? []
  const deps: SwitchDeps = {
    now: () => NOW,
    today: () => '2026-10-23',
    readEnv: () => state.env,
    writeEnv: (text) => { state.env = text; state.writes.push(text) },
    readHistory: () => over.history ?? TWO_CLEAN.map((e) => `${e.ts} ${e.verdict} x`).join('\n'),
    record: (e) => { state.records.push(e) },
    restart: async () => {
      const ok = restartPlan[state.restarts] ?? true
      state.restarts += 1
      if (ok) state.running = modeInEnv(state.env).mode
      return ok
    },
    probe: async (p) => (over.answers ? over.answers(state.running, p) : p.expected),
  }
  return { state, deps }
}
const REQ = { to: 'legacy-szukitett', approval: 'discord:1562000000000000000' }

describe('the step (runSwitch)', () => {
  it('a forward step: the line is written, recorded, the dashboard restarted, the probes agree', async () => {
    const { state, deps } = fakes({ answers: (running, p) => probesFor(running, '2026-10-23').find((q) => q.path === p.path && q.caller === p.caller)!.expected })
    const out = await runSwitch(REQ, deps)
    expect(out).toMatchObject({ ok: true, finalMode: 'legacy-szukitett' })
    expect(modeInEnv(state.env).mode).toBe('legacy-szukitett')
    expect(state.restarts).toBe(1)
    expect(state.records).toHaveLength(1)
    expect(state.records[0]).toMatchObject({ kind: 'forward', from: 'naplo', to: 'legacy-szukitett', approval: REQ.approval, result: 'ok' })
  })

  it('a refused step writes nothing, restarts nothing, records nothing', async () => {
    const { state, deps } = fakes()
    const out = await runSwitch({ to: 'kikenyszerit', approval: 'x' }, deps)
    expect(out.ok).toBe(false)
    expect(out.lines.some((l) => l.startsWith('REFUSED'))).toBe(true)
    expect([state.writes.length, state.restarts, state.records.length]).toEqual([0, 0, 0])
  })

  it('a dry run stops at the plan: nothing written, restarted or recorded', async () => {
    const { state, deps } = fakes()
    const out = await runSwitch({ ...REQ, dryRun: true }, deps)
    expect(out.ok).toBe(true)
    expect([state.writes.length, state.restarts, state.records.length]).toEqual([0, 0, 0])
  })

  it('a failed probe turns the setting back to naplo at once, restarts, records both, and says so', async () => {
    // after the switch the shared token on the unruled route does not give the expected answer
    const { state, deps } = fakes({
      answers: (running, p) => (running === 'legacy-szukitett' && p.caller === 'A' && p.path.startsWith('/api/kanban') ? 403 : probesFor(running, '2026-10-23').find((q) => q.path === p.path && q.caller === p.caller)!.expected),
    })
    const out = await runSwitch(REQ, deps)
    expect(out).toMatchObject({ ok: false, finalMode: 'naplo' })
    expect(out.lines.some((l) => l.startsWith('PROBE FAILED') && l.includes('/api/kanban'))).toBe(true)
    expect(modeInEnv(state.env).mode).toBe('naplo')
    expect(state.restarts).toBe(2)
    expect(state.records.map((r) => [r.kind, r.result])).toEqual([['forward', 'probe-failed'], ['auto-rollback', 'ok']])
    expect(state.records[1]).toMatchObject({ from: 'legacy-szukitett', to: 'naplo' })
  })

  it('a dashboard that does not come back: the old .env line is put back, the failure recorded', async () => {
    const { state, deps } = fakes({ restartOk: [false, true] })
    const before = state.env
    const out = await runSwitch(REQ, deps)
    expect(out.ok).toBe(false)
    expect(state.env).toBe(before)
    expect(state.records.map((r) => r.result)).toEqual(['restart-failed'])
    expect(state.restarts).toBe(2)
  })

  it('a failed probe after a step from a STRICTER position goes back to where the step started, never to naplo', async () => {
    const { state, deps } = fakes({
      env: 'ACCESS_MODE=legacy-szukitett\n',
      answers: (running, p) => (running === 'kikenyszerit' && p.path === '/api/kanban' ? 403 : probesFor(running, '2026-10-23').find((q) => q.path === p.path && q.caller === p.caller)!.expected),
    })
    const out = await runSwitch({ to: 'kikenyszerit', approval: 'discord:1562000000000000000' }, deps)
    expect(out).toMatchObject({ ok: false, finalMode: 'legacy-szukitett' })
    expect(modeInEnv(state.env).mode).toBe('legacy-szukitett')
    expect(state.records.map((r) => [r.kind, r.from, r.to, r.result])).toEqual([
      ['forward', 'legacy-szukitett', 'kikenyszerit', 'probe-failed'],
      ['auto-rollback', 'kikenyszerit', 'legacy-szukitett', 'ok'],
    ])
    expect(JSON.stringify(state.records)).not.toContain('"to":"naplo"')
    expect(state.env).not.toContain('naplo')
  })

  it('a restart that fails while the OLD dashboard still answers: the old line comes back and nothing falls to naplo', async () => {
    const { state, deps } = fakes({ env: 'ACCESS_MODE=legacy-szukitett\n', restartOk: [false, true] })
    const out = await runSwitch({ to: 'kikenyszerit', approval: 'discord:1562000000000000000' }, deps)
    expect(out).toMatchObject({ ok: false, finalMode: 'legacy-szukitett' })
    expect(modeInEnv(state.env).mode).toBe('legacy-szukitett')
    expect(state.records.map((r) => [r.kind, r.result])).toEqual([['forward', 'restart-failed']])
    expect(state.env).not.toContain('naplo')
  })

  it('the old line is written onto a FRESH read of .env: a setting written in the meantime stays', async () => {
    const { state, deps } = fakes({ restartOk: [false, true] })
    const realRestart = deps.restart
    let first = true
    deps.restart = async () => {
      if (first) { first = false; state.env += 'MASIK_BEALLITAS=1\n' }
      return realRestart()
    }
    await runSwitch(REQ, deps)
    expect(state.env).toContain('MASIK_BEALLITAS=1')
    expect(modeInEnv(state.env).mode).toBe('naplo')
  })

  it('when the way back cannot be confirmed either, the final state is UNKNOWN (null) and the first line says so', async () => {
    const { state, deps } = fakes({ restartOk: [false, false] })
    const out = await runSwitch(REQ, deps)
    expect(out).toMatchObject({ ok: false, finalMode: null })
    expect(out.lines[0]).toContain('UNKNOWN STATE')
    expect(state.records.map((r) => r.result)).toEqual(['restart-failed'])
    // and a failed probe whose way back fails too
    const second = fakes({ restartOk: [true, false], answers: (_m, p) => p.expected + 1 })
    const out2 = await runSwitch(REQ, second.deps)
    expect(out2).toMatchObject({ ok: false, finalMode: null })
    expect(out2.lines[0]).toContain('UNKNOWN STATE')
  })

  it('the way back: naplo, with the reason recorded; a failing probe there does not loop', async () => {
    const { state, deps } = fakes({ env: 'ACCESS_MODE=kikenyszerit\n', answers: () => 500 })
    const out = await runSwitch({ to: 'naplo', reason: 'a fő ágens fix útja 403-at kap' }, deps)
    expect(out.ok).toBe(false)
    expect(modeInEnv(state.env).mode).toBe('naplo')
    expect(state.restarts).toBe(1)
    expect(state.records).toHaveLength(1)
    expect(state.records[0]).toMatchObject({ kind: 'rollback', to: 'naplo', reason: 'a fő ágens fix útja 403-at kap', result: 'probe-failed' })
  })
})
