import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotaWorkClass, reportQuotaInput } from '../web/schedule-runner.js'
import { parseLatestQuotaSample, parseQuotaSnapshot, readQuotaSnapshot } from '../quota-snapshot.js'
import { decideQuotaAction, quotaInputProblem } from '../quota-gate.js'

// The gate itself is covered in quota-gate.test.ts. This file covers the two
// seams around it: how a scheduled task is classified, and how the collector's
// on-disk JSON becomes the gate's input.

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
    expect(RUNNER_SRC).toContain('const quotaSnapshot = readQuotaSnapshot()')
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

describe('parseQuotaSnapshot', () => {
  const onDisk = {
    generated_at: '2026-08-17T14:53:57.362898+00:00',
    generated_at_local: '2026-08-17 16:53:57 CEST',
    codex: { ok: false },
    claude: {
      provider: 'claude',
      source: 'authoritative',
      ok: true,
      windows: {
        five_hour: { used_percent: 10.0, resets_at: 1786990200.146628 },
        seven_day: { used_percent: 13.0, resets_at: 1787205600.146654 },
      },
    },
  }

  it('maps the collector output onto the gate input', () => {
    const s = parseQuotaSnapshot(onDisk)
    expect(s?.source).toBe('authoritative')
    expect(s?.generatedAtMs).toBe(Date.parse('2026-08-17T14:53:57.362898+00:00'))
    expect(s?.windows?.five_hour?.used_percent).toBe(10)
  })

  it('returns null for anything that is not a collector snapshot', () => {
    expect(parseQuotaSnapshot(null)).toBeNull()
    expect(parseQuotaSnapshot('nope')).toBeNull()
    expect(parseQuotaSnapshot({})).toBeNull()
    expect(parseQuotaSnapshot({ claude: 'not-an-object' })).toBeNull()
  })

  it('survives a snapshot with an unparseable timestamp', () => {
    const s = parseQuotaSnapshot({ ...onDisk, generated_at: 'yesterday-ish' })
    // Null timestamp -> the gate fails open rather than trusting stale numbers.
    expect(s?.generatedAtMs).toBeNull()
    expect(s?.source).toBe('authoritative')
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

describe('parseLatestQuotaSample', () => {
  it('maps the newest statusline line onto the gate input', () => {
    const s = parseLatestQuotaSample([sampleLine(1000, 5), sampleLine(2000, 91), ''].join('\n'))
    expect(s).toEqual({
      source: 'claude-code-statusline',
      generatedAtMs: 2_000_000,
      windows: {
        five_hour: { used_percent: 91, resets_at: 1791932400 },
        seven_day: { used_percent: 38, resets_at: 1792393200 },
      },
    })
  })

  it('falls back past a torn last line instead of losing the sample', () => {
    const s = parseLatestQuotaSample(sampleLine(1000) + '\n' + sampleLine(2000).slice(0, 40))
    expect(s?.generatedAtMs).toBe(1_000_000)
  })

  it('returns null when no line carries a percentage', () => {
    expect(parseLatestQuotaSample('')).toBeNull()
    expect(parseLatestQuotaSample('{"sampled_at":1}\nnot json')).toBeNull()
  })
})

describe('readQuotaSnapshot -- real files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const paths = () => ({ usageLatest: join(dir, 'usage-latest.json'), samples: join(dir, 'quota-samples.jsonl') })
  const NOW_S = 1_791_922_500
  const background = (nowS: number) =>
    decideQuotaAction({ snapshot: readQuotaSnapshot(paths()), nowMs: nowS * 1000, workClass: 'background' })

  it('MISSING input: both files absent -> null, the gate runs AND names why', () => {
    // The state measured on 2026-10-13: usage-latest.json never written.
    expect(readQuotaSnapshot(paths())).toBeNull()
    expect(background(NOW_S)).toEqual({ action: 'run', reason: 'no-snapshot', pressure: null })
  })

  it('reads the statusline samples when usage-latest.json does not exist', () => {
    // Before this change the gate read only usage-latest.json, so this
    // pressure was invisible and the decision was 'run'.
    writeFileSync(paths().samples, sampleLine(NOW_S - 60, 92) + '\n')
    expect(background(NOW_S)).toMatchObject({ action: 'defer', reason: 'pressure:92%' })
  })

  it('STALE input: an old sample fails open and says it is stale', () => {
    writeFileSync(paths().samples, sampleLine(NOW_S - 30 * 60, 92) + '\n')
    expect(background(NOW_S)).toEqual({ action: 'run', reason: 'stale-snapshot:30m', pressure: null })
  })

  it('takes the newer of the two inputs', () => {
    writeFileSync(paths().samples, sampleLine(NOW_S - 60, 92) + '\n')
    writeFileSync(
      paths().usageLatest,
      JSON.stringify({
        generated_at: new Date((NOW_S - 600) * 1000).toISOString(),
        claude: { source: 'authoritative', windows: { five_hour: { used_percent: 10, resets_at: null } } },
      }),
    )
    expect(readQuotaSnapshot(paths())?.source).toBe('claude-code-statusline')

    writeFileSync(paths().samples, sampleLine(NOW_S - 1200, 92) + '\n')
    expect(readQuotaSnapshot(paths())?.source).toBe('authoritative')
    expect(background(NOW_S)).toMatchObject({ action: 'run', reason: 'ok@10%' })
  })

  it('reads only the tail of a large log and still finds the newest line', () => {
    const old = Array.from({ length: 2000 }, (_, i) => sampleLine(NOW_S - 100_000 + i, 1)).join('\n')
    writeFileSync(paths().samples, old + '\n' + sampleLine(NOW_S - 60, 88) + '\n')
    expect(quotaInputProblem(readQuotaSnapshot(paths()), NOW_S * 1000)).toBeNull()
    expect(background(NOW_S).reason).toBe('pressure:88%')
  })
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
    expect(RUNNER_SRC).toContain('reportQuotaInput(quotaInputProblem(quotaSnapshot, now))')
  })
})
