import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaWorkClass, reportQuotaInput } from '../web/schedule-runner.js'
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

  it('is wired to the per-tick snapshot read', () => {
    expect(RUNNER_SRC).toContain('reportQuotaInput(quotaRead.problem ?? quotaInputProblem(quotaSnapshot, now))')
  })
})
