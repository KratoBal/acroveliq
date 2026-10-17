import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUOTA_BLIND_ACTIVITY_MARGIN_MS, QUOTA_BLIND_CONFIRM_MS, noticeQuotaBlind, quotaWorkClass, reportQuotaInput, setQuotaNoticeStateForTest, setQuotaNotifyForTest } from '../web/schedule-runner.js'
import { parseGateSample, readQuotaSnapshot } from '../quota-snapshot.js'
import { decideQuotaAction, quotaInputProblem } from '../quota-gate.js'

// The gate itself is covered in quota-gate.test.ts. This file covers the two
// seams around it: how a scheduled task is classified, and how the collector's
// sample file becomes the gate's input, and who may write it.

const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('quotaWorkClass', () => {
  it('exempts shell-command tasks -- they never call a model', () => {
    expect(quotaWorkClass({ type: 'command' })).toBe('free')
  })

  it('classifies heartbeats as background', () => {
    expect(quotaWorkClass({ type: 'heartbeat' })).toBe('background')
  })

  it('treats owner-visible and unknown future types as owner-facing', () => {
    expect(quotaWorkClass({ type: 'task' })).toBe('owner-facing')
    expect(quotaWorkClass({ type: 'dream-engine' } as never)).toBe('owner-facing')
    expect(quotaWorkClass({} as never)).toBe('owner-facing')
  })
})

describe('schedule-runner wiring', () => {
  it('reads the snapshot once per tick, not once per task', () => {
    // A per-task read would re-parse the same file N times every 60s tick.
    expect(RUNNER_SRC).toContain('const quotaRead = readQuotaSnapshot()')
    expect(RUNNER_SRC.match(/readQuotaSnapshot\(\)/g)?.length).toBe(1)
  })

  it('records a held-back occurrence so the catch-up window cannot re-fire it', () => {
    // Mirrors the pre-check skip: mark the tick as run, log a task-run row.
    const gate = RUNNER_SRC.slice(RUNNER_SRC.indexOf("if (quota.action === 'defer')"))
    const block = gate.slice(0, gate.indexOf('const cronPc'))
    expect(block).toContain('scheduleLastRun.set(task.name, now)')
    expect(block).toContain('persistScheduleLastRun()')
    expect(block).toContain("appendTaskRun(task.name, agentName, 'skipped')")
  })

  it('gates before the pre-check, so a deferred task never spawns its script', () => {
    expect(RUNNER_SRC.indexOf("if (quota.action === 'defer')")).toBeLessThan(
      RUNNER_SRC.indexOf('const cronPc = runPreCheck(task)'),
    )
  })
})

// One line exactly as scripts/measure-statusline.py writes it (copied from
// store/measurements/quota-samples.jsonl, 2026-10-13).
const sampleLine = (sampledAt: number, five = 12, seven = 38) =>
  JSON.stringify({
    sampled_at: sampledAt,
    source: 'claude-code-statusline',
    agent: 'acrobot',
    model: 'claude-opus-5-5',
    five_hour_pct: five,
    five_hour_resets_at: 1791932400,
    seven_day_pct: seven,
    seven_day_resets_at: 1792393200,
  })

describe('parseGateSample', () => {
  it('maps one statusline sample onto the gate input', () => {
    expect(parseGateSample(sampleLine(2000, 91) + '\n')).toEqual({
      source: 'claude-code-statusline',
      generatedAtMs: 2_000_000,
      windows: {
        five_hour: { used_percent: 91, resets_at: 1791932400 },
        seven_day: { used_percent: 38, resets_at: 1792393200 },
      },
    })
  })

  it('returns null for anything that carries no percentage', () => {
    expect(parseGateSample('')).toBeNull()
    expect(parseGateSample('{"sampled_at":1}')).toBeNull()
    expect(parseGateSample('not json')).toBeNull()
  })
})

// The gate reads ONLY the router-owned sample (acrobot's decision on #76):
// a regular file, owned by the dashboard's user, writable by nobody else.
describe('readQuotaSnapshot -- the router-owned gate sample', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-gate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const NOW_S = 1_791_922_500
  const file = () => join(dir, 'quota-gate-sample.json')
  const write = (line: string, mode = 0o644) => {
    writeFileSync(file(), line + '\n')
    chmodSync(file(), mode)
  }
  /** What the runner does each tick: the read's own problem first, then the gate's. */
  const tick = (uid = process.getuid?.()) => {
    const read = readQuotaSnapshot(file(), uid)
    return {
      read,
      reported: read.problem ?? quotaInputProblem(read.snapshot, NOW_S * 1000),
      decision: decideQuotaAction({ snapshot: read.snapshot, nowMs: NOW_S * 1000, workClass: 'background' }),
    }
  }

  it('MISSING: no file -> no snapshot, the gate runs and the runner reports no-snapshot', () => {
    const t = tick()
    expect(t.read).toEqual({ snapshot: null, problem: null })
    expect(t.reported).toBe('no-snapshot')
    expect(t.decision).toEqual({ action: 'run', reason: 'no-snapshot', pressure: null })
  })

  it('VALID: a fresh 0644 sample owned by this user is read, and high pressure defers', () => {
    write(sampleLine(NOW_S - 60, 92))
    const t = tick()
    expect(t.read.problem).toBeNull()
    expect(t.reported).toBeNull()
    expect(t.decision).toMatchObject({ action: 'defer', reason: 'pressure:92%' })
  })

  it('GROUP-WRITABLE: rejected, the gate runs, the reason is reported', () => {
    write(sampleLine(NOW_S - 60, 92), 0o664)
    const t = tick()
    expect(t.read).toEqual({ snapshot: null, problem: 'gate-input:group-or-world-writable' })
    expect(t.reported).toBe('gate-input:group-or-world-writable')
    expect(t.decision.action).toBe('run')
  })

  it('WORLD-WRITABLE: rejected the same way', () => {
    write(sampleLine(NOW_S - 60, 92), 0o646)
    expect(tick().read.problem).toBe('gate-input:group-or-world-writable')
  })

  it('FOREIGN OWNER: a file not owned by the dashboard user is rejected', () => {
    write(sampleLine(NOW_S - 60, 92))
    const t = tick((process.getuid?.() ?? 0) + 1)
    expect(t.read).toEqual({ snapshot: null, problem: 'gate-input:foreign-owner' })
    expect(t.decision.action).toBe('run')
  })

  it('FIFO: returns at once instead of blocking the dashboard, and is rejected', () => {
    execFileSync('mkfifo', [file()])
    const t0 = Date.now()
    const t = tick()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(t.read).toEqual({ snapshot: null, problem: 'gate-input:not-a-regular-file' })
    expect(t.decision.action).toBe('run')
  })

  it('SYMLINK: not followed, even to a valid sample', () => {
    const target = join(dir, 'elsewhere.json')
    writeFileSync(target, sampleLine(NOW_S - 60, 99) + '\n')
    chmodSync(target, 0o644)
    symlinkSync(target, file())
    const t = tick()
    expect(t.read).toEqual({ snapshot: null, problem: 'gate-input:symlink' })
    expect(t.decision.action).toBe('run')
  })

  it('FUTURE-DATED: invalid, the gate runs and names it', () => {
    write(sampleLine(NOW_S + 3600, 99))
    const t = tick()
    expect(t.reported).toBe('future-snapshot:60m')
    expect(t.decision).toEqual({ action: 'run', reason: 'future-snapshot:60m', pressure: null })
  })

  it('tolerates ordinary clock skew', () => {
    write(sampleLine(NOW_S + 60, 90))
    expect(tick().decision).toMatchObject({ action: 'defer', reason: 'pressure:90%' })
  })

  it('STALE: an old sample fails open and says so', () => {
    write(sampleLine(NOW_S - 30 * 60, 92))
    expect(tick().decision).toEqual({ action: 'run', reason: 'stale-snapshot:30m', pressure: null })
  })

  it('UNPARSEABLE: a garbled file is reported, not taken as missing', () => {
    write('{"sampled_at":')
    expect(tick().read).toEqual({ snapshot: null, problem: 'gate-input:unparseable' })
  })
})

describe('measure-statusline.py -- who writes the gate sample', () => {
  const SCRIPT = join(__dirname, '..', '..', 'scripts', 'measure-statusline.py')
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-gate-writer-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const run = (gateFile: string, five: number) =>
    spawnSync('python3', [SCRIPT], {
      input: JSON.stringify({
        model: { id: 'claude-opus-5-5' },
        rate_limits: { five_hour: { used_percentage: five, resets_at: 1791932400 }, seven_day: { used_percentage: 38, resets_at: 1792393200 } },
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        MEASURE_AGENT: 'acrobot',
        MEASURE_DIR: join(dir, 'measurements'),
        MEASURE_QUOTA_FILE: join(dir, 'measurements', 'quota-samples.jsonl'),
        MEASURE_USAGE_DIR: join(dir, 'measurements', 'usage'),
        MEASURE_GATE_FILE: gateFile,
      },
    })

  it('the owner of the directory writes a 0644 sample the reader accepts, at most once per minute', () => {
    expect(run(file(dir), 41).status).toBe(0)
    expect(statSync(file(dir)).mode & 0o777).toBe(0o644)
    const read = readQuotaSnapshot(file(dir))
    expect(read.problem).toBeNull()
    expect(read.snapshot?.windows?.five_hour?.used_percent).toBe(41)
    expect(run(file(dir), 77).status).toBe(0)
    expect(readQuotaSnapshot(file(dir)).snapshot?.windows?.five_hour?.used_percent).toBe(41)
  })

  it('a user who does not own the directory writes nothing there, even where it could', () => {
    // /tmp is root-owned and world-writable: the write WOULD succeed, so only
    // the ownership check keeps an agent from planting the router's sample.
    if (process.getuid?.() === 0) return
    const target = join(tmpdir(), `quota-gate-foreign-${process.pid}.json`)
    try {
      expect(run(target, 41).status).toBe(0)
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(target, { force: true })
    }
  })

  function file(d: string) {
    return join(d, 'quota-gate-sample.json')
  }
})

describe('reportQuotaInput -- blind state is reported once per change', () => {
  it('warns when the gate goes blind, stays quiet while it stays blind, reports recovery', () => {
    reportQuotaInput(null) // reset to a known, healthy state
    expect(reportQuotaInput('no-snapshot')).toBe('blind')
    expect(reportQuotaInput('no-snapshot')).toBeNull()
    expect(reportQuotaInput('stale-snapshot:21m')).toBe('blind') // a different kind of blind
    expect(reportQuotaInput('stale-snapshot:22m')).toBeNull() // same kind, minute ticked on
    expect(reportQuotaInput(null)).toBe('recovered')
    expect(reportQuotaInput(null)).toBeNull()
  })

  // task kvota-kapu-bemenet: 2026-10-15 the gate was blind for two hours and only the log said so.
  // barracuda, #157: an idle night makes the sample stale too, and a message then would wake the
  // main agent, draw a fresh sample, and loop all night. Only activity after the sample is blindness.
  it('QUOTA-BLIND-NOTICE: one message when the main session worked after the sample, none for an idle stale sample; a recovery message only after a blind one', () => {
    const sent: string[] = []
    setQuotaNotifyForTest((c) => sent.push(c))
    setQuotaNoticeStateForTest(join(mkdtempSync(join(tmpdir(), 'quota-notice-')), 'state.json'))
    try {
      const t0 = Date.parse('2026-10-15T05:30:00Z') // the last sample
      const M = QUOTA_BLIND_ACTIVITY_MARGIN_MS
      noticeQuotaBlind(null, t0, { sampleAtMs: t0, activityAtMs: t0 }) // a known state
      sent.length = 0
      const idle = [
        // an idle night: stale, the last activity is the sample's own turn
        noticeQuotaBlind('stale-snapshot:21m', t0 + 21 * 60_000, { sampleAtMs: t0, activityAtMs: t0 + 30_000 }),
        noticeQuotaBlind('stale-snapshot:300m', t0 + 300 * 60_000, { sampleAtMs: t0, activityAtMs: t0 + M }), // exactly at the margin: still idle
        noticeQuotaBlind('stale-snapshot:301m', t0 + 301 * 60_000, { sampleAtMs: t0, activityAtMs: null }), // nothing readable
        noticeQuotaBlind(null, t0 + 302 * 60_000, { sampleAtMs: t0 + 302 * 60_000, activityAtMs: t0 + 302 * 60_000 }), // fresh again: no recovery without a blind
      ]
      const idleSent = sent.length
      const blind = [
        // 07:30-09:50: the main session works, no sample; the first such tick only opens the suspicion
        noticeQuotaBlind('stale-snapshot:23m', t0 + 23 * 60_000, { sampleAtMs: t0, activityAtMs: t0 + 23 * 60_000 }),
        noticeQuotaBlind('stale-snapshot:25m', t0 + 25 * 60_000, { sampleAtMs: t0, activityAtMs: t0 + 24 * 60_000 }),
        noticeQuotaBlind('stale-snapshot:26m', t0 + 26 * 60_000, { sampleAtMs: t0, activityAtMs: t0 + 26 * 60_000 }),
        noticeQuotaBlind('no-snapshot', t0 + 27 * 60_000, { sampleAtMs: null, activityAtMs: t0 + 27 * 60_000 }), // another kind, the same episode
        noticeQuotaBlind(null, t0 + 145 * 60_000, { sampleAtMs: t0 + 145 * 60_000, activityAtMs: t0 + 145 * 60_000 }),
        noticeQuotaBlind(null, t0 + 146 * 60_000, { sampleAtMs: t0 + 146 * 60_000, activityAtMs: t0 + 146 * 60_000 }),
      ]
      expect([idle, idleSent, blind, sent.length, /vak \(stale-snapshot:25m\): a fő munkamenet dolgozik/.test(sent[0] ?? ''), /újra friss \(az üzenet óta 120 perc\)/.test(sent[1] ?? '')],
        'QUOTA-BLIND-NOTICE').toEqual([[null, null, null, null], 0, [null, 'blind', null, null, 'recovered', null], 2, true, true])
    } finally {
      noticeQuotaBlind(null, Date.now(), { sampleAtMs: null, activityAtMs: null })
      setQuotaNotifyForTest(null)
      setQuotaNoticeStateForTest(null)
    }
  })

  // acrobot, 2026-10-17: msg 32290 (08:30) and 32292 (09:30), each followed by "újra friss, 0 perc". After an
  // idle half hour the wakeup prompt writes the transcript at once and the statusline draws seconds later.
  it('QUOTA-BLIND-TURN-START: a blind look that the next sample clears inside the confirm window sends nothing; one that holds past it sends once', () => {
    const sent: string[] = []
    setQuotaNotifyForTest((c) => sent.push(c))
    setQuotaNoticeStateForTest(join(mkdtempSync(join(tmpdir(), 'quota-notice-')), 'state.json'))
    try {
      const t0 = Date.parse('2026-10-17T07:01:00Z') // the last sample before the idle stretch
      const C = QUOTA_BLIND_CONFIRM_MS
      const turnStart = t0 + 29 * 60_000 + 30_000
      const race = [
        noticeQuotaBlind('stale-snapshot:30m', turnStart + 5_000, { sampleAtMs: t0, activityAtMs: turnStart }),
        noticeQuotaBlind(null, turnStart + 65_000, { sampleAtMs: turnStart + 3_000, activityAtMs: turnStart + 60_000 }),
      ]
      const raceSent = sent.length
      const s1 = turnStart + 3_000
      const later = s1 + 40 * 60_000 // a real blind state: activity goes on, no sample comes
      const held = [
        noticeQuotaBlind('stale-snapshot:40m', later, { sampleAtMs: s1, activityAtMs: later }),
        noticeQuotaBlind('stale-snapshot:41m', later + C - 1, { sampleAtMs: s1, activityAtMs: later + C - 1 }),
        noticeQuotaBlind('stale-snapshot:42m', later + C, { sampleAtMs: s1, activityAtMs: later + C }),
      ]
      expect([race, raceSent, held, sent.length], 'QUOTA-BLIND-TURN-START').toEqual([[null, null], 0, [null, null, 'blind'], 1])
    } finally {
      noticeQuotaBlind(null, Date.now(), { sampleAtMs: null, activityAtMs: null })
      setQuotaNotifyForTest(null)
      setQuotaNoticeStateForTest(null)
    }
  })

  // acrobot, 2026-10-15: the blind message came twice (09:37, 09:43) with a dashboard restart between
  it('QUOTA-BLIND-RESTART: the episode is kept in the store file: a restart inside it sends no second message, and the recovery clears it', () => {
    const sent: string[] = []
    const state = join(mkdtempSync(join(tmpdir(), 'quota-notice-')), 'state.json')
    setQuotaNotifyForTest((c) => sent.push(c))
    setQuotaNoticeStateForTest(state)
    try {
      const t0 = Date.parse('2026-10-15T07:30:00Z')
      const working = (m: number) => ({ sampleAtMs: t0, activityAtMs: t0 + m * 60_000 })
      const suspected = noticeQuotaBlind('stale-snapshot:125m', t0 + 125 * 60_000, working(125))
      const first = noticeQuotaBlind('stale-snapshot:127m', t0 + 127 * 60_000, working(126))
      const saved = JSON.parse(readFileSync(state, 'utf-8')).notifiedAt
      setQuotaNoticeStateForTest(state) // the dashboard restarts: memory gone, the file stays
      const afterRestart = noticeQuotaBlind('stale-snapshot:133m', t0 + 133 * 60_000, working(132))
      const recovered = noticeQuotaBlind(null, t0 + 140 * 60_000, { sampleAtMs: t0 + 140 * 60_000, activityAtMs: t0 + 140 * 60_000 })
      setQuotaNoticeStateForTest(state) // and once more: a cleared episode stays cleared
      const quiet = noticeQuotaBlind(null, t0 + 141 * 60_000, { sampleAtMs: t0 + 141 * 60_000, activityAtMs: t0 + 141 * 60_000 })
      expect([suspected, first, saved, afterRestart, recovered, quiet, sent.length, JSON.parse(readFileSync(state, 'utf-8')).notifiedAt, /az üzenet óta 13 perc/.test(sent[1] ?? '')],
        'QUOTA-BLIND-RESTART').toEqual([null, 'blind', t0 + 127 * 60_000, null, 'recovered', null, 2, null, true])
    } finally {
      setQuotaNotifyForTest(null)
      setQuotaNoticeStateForTest(null)
    }
  })

  it('is wired to the per-tick snapshot read', () => {
    expect(RUNNER_SRC).toContain('const quotaProblem = quotaRead.problem ?? quotaInputProblem(quotaSnapshot, now)')
    expect(RUNNER_SRC).toContain('reportQuotaInput(quotaProblem)')
    // the notice reads the gate sample's time and the MAIN session's last turn from the transcript's
    // own timestamps (not the mtime: idle writes moved it, acrobot 2026-10-17, msg 32305)
    expect(RUNNER_SRC).toMatch(/noticeQuotaBlind\(quotaProblem, now, \{\s*sampleAtMs: typeof quotaSnapshot\?\.generatedAtMs === 'number'[^}]*activityAtMs: readTranscriptLastTurnAtFromProjectDir\(PROJECT_ROOT\),/)
  })
})
