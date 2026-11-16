import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/*
  pr-beolvaszt.sh: ONLY A RERUN MERGES, NOT A SHARED NAME (card 055f4676, 2026-11-16: acropora-os #2631, a CI rerun left the old, failed
  verify-db row in the commit's check-runs list, the failed list counted it, and the script stopped on a green head; barracuda's review of
  acroveliq #374: a check name is not unique, two workflows can both have a job called verify, and a "highest id wins" rule would hide the
  failed one behind its green neighbour). An older row is left out only when a NEWER row of the same name and the same app starts AFTER the
  older one has finished: that is the shape of a rerun. Two rows that ran at the same time both count; an older row that is still running, or
  a newer row without a start time, cannot be proved a rerun and stays.
  The segment from the merge function up to the `if fut:` line is extracted from the script and run with a stand-in `api`, so the test
  measures the script's OWN code on both paths (check-runs, and the actions/runs fallback when check-runs answers 403).
*/
const script = readFileSync(join(process.cwd(), 'scripts', 'pr-beolvaszt.sh'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'pr-beolvaszt-newest-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const START = "def _ujrafuttatasok_osszevonva(sorok):"
const END = '\nif fut:'

function segment(): string {
  const start = script.indexOf(START)
  expect(start, 'the rerun merge function is in the script').toBeGreaterThan(-1)
  const end = script.indexOf(END, start)
  expect(end, 'the `if fut:` line follows the segment').toBeGreaterThan(start)
  // the segment also holds the check-runs call, the fallback and the lists
  return script.slice(start, end)
}

interface Row {
  id: number
  name: string
  status?: string
  conclusion?: string | null
  started?: string
  completed?: string | null
  app?: string
}

type Result = { exit: string | null; fut: string[]; bukott: string[]; out: string }

function run(opts: { checkRuns?: Row[]; checkRunsCode?: string; actionRuns?: Row[] }): Result {
  const checkRuns = opts.checkRuns ?? []
  const harness = `
import json, sys
sha = 'abc'
def _row(r, runs_api):
    d = {'name': r['name'], 'status': r.get('status', 'completed'), 'conclusion': r.get('conclusion', 'success'), 'id': r['id']}
    if runs_api:
        if r.get('started'): d['run_started_at'] = r['started']
        d['updated_at'] = r.get('completed')
        d['workflow_id'] = r.get('app')
    else:
        if r.get('started'): d['started_at'] = r['started']
        d['completed_at'] = r.get('completed')
        d['app'] = {'slug': r.get('app')}
    return d
CHECK = json.loads(${JSON.stringify(JSON.stringify(checkRuns))})
ACTIONS = json.loads(${JSON.stringify(JSON.stringify(opts.actionRuns ?? []))})
CODE = ${JSON.stringify(opts.checkRunsCode ?? '200')}
def api(method, path, body=None):
    if '/check-runs' in path:
        return (json.dumps({'check_runs': [_row(r, False) for r in CHECK]}), CODE)
    if '/actions/runs' in path:
        return (json.dumps({'workflow_runs': [_row(r, True) for r in ACTIONS]}), '200')
    raise SystemExit('unexpected path ' + path)
exit_text = None
try:
${segment()
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
    print('@@RESULT@@' + json.dumps({'exit': None, 'fut': fut, 'bukott': bukott}))
except SystemExit as e:
    print('@@RESULT@@' + json.dumps({'exit': str(e.code), 'fut': [], 'bukott': []}))
`
  const file = join(dir, `harness-${Math.random().toString(36).slice(2)}.py`)
  writeFileSync(file, harness)
  const out = execFileSync('python3', ['-B', file], { encoding: 'utf8' })
  const marker = out.indexOf('@@RESULT@@')
  expect(marker, `the harness answered:\n${out}`).toBeGreaterThan(-1)
  const parsed = JSON.parse(out.slice(marker + '@@RESULT@@'.length))
  return { ...parsed, out: out.slice(0, marker) }
}

// 12:00-12:30 the first run, 13:00-13:30 the rerun that started after it finished, 12:10-12:50 a run that overlaps the first
const old = (name: string, conclusion: string): Row => ({ id: 100, name, conclusion, started: '2026-11-16T12:00:00Z', completed: '2026-11-16T12:30:00Z' })
const fresh = (name: string, conclusion: string): Row => ({ id: 200, name, conclusion, started: '2026-11-16T13:00:00Z', completed: '2026-11-16T13:30:00Z' })
const overlapping = (name: string, conclusion: string): Row => ({ id: 200, name, conclusion, started: '2026-11-16T12:10:00Z', completed: '2026-11-16T12:50:00Z' })

describe('pr-beolvaszt.sh: a rerun replaces the old run, a shared name does not', () => {
  it('an old failure and a rerun that succeeded: nothing failed, and the log names the skipped old row', () => {
    const r = run({ checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success'), fresh('verify-unit', 'success')] })
    expect(r.bukott).toEqual([])
    expect(r.out).toContain('ujrafuttatva, a regi futas nem szamit: verify-db completed failure')
  })

  it('the other direction: an old success and a rerun that failed still fails', () => {
    const r = run({ checkRuns: [old('verify-db', 'success'), fresh('verify-db', 'failure')] })
    expect(r.bukott).toEqual(['verify-db'])
  })

  it('the order of the rows does not decide', () => {
    expect(run({ checkRuns: [fresh('verify-db', 'success'), old('verify-db', 'failure')] }).bukott).toEqual([])
    expect(run({ checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success')] }).bukott).toEqual([])
    expect(run({ checkRuns: [fresh('verify-db', 'failure'), old('verify-db', 'success')] }).bukott).toEqual(['verify-db'])
  })

  it('a chain of reruns: failure, failure, success is not failed', () => {
    const second: Row = { id: 200, name: 'verify-db', conclusion: 'failure', started: '2026-11-16T13:00:00Z', completed: '2026-11-16T13:30:00Z' }
    const third: Row = { id: 300, name: 'verify-db', conclusion: 'success', started: '2026-11-16T14:00:00Z', completed: '2026-11-16T14:30:00Z' }
    expect(run({ checkRuns: [old('verify-db', 'failure'), second, third] }).bukott).toEqual([])
  })

  it('distinct names are all kept, and a failure under another name is still a failure', () => {
    const r = run({
      checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success'), { ...old('verify-unit', 'failure'), id: 150 }],
    })
    expect(r.bukott).toEqual(['verify-unit'])
  })

  it('TWO CHECKS OF THE SAME NAME THAT RAN AT THE SAME TIME BOTH COUNT: a failure is not hidden behind a green neighbour', () => {
    const r = run({ checkRuns: [old('verify', 'failure'), overlapping('verify', 'success')] })
    expect(r.bukott).toEqual(['verify'])
    expect(r.out).not.toContain('ujrafuttatva')
  })

  it('the same name from two different apps is not one check', () => {
    const r = run({ checkRuns: [{ ...old('build', 'failure'), app: 'github-actions' }, { ...fresh('build', 'success'), app: 'other-ci' }] })
    expect(r.bukott).toEqual(['build'])
  })

  it('an older row that is still running cannot be proved a rerun target: it stays, and it blocks the merge', () => {
    const running: Row = { id: 100, name: 'verify-db', status: 'in_progress', conclusion: null, started: '2026-11-16T12:00:00Z', completed: null }
    const r = run({ checkRuns: [running, fresh('verify-db', 'success')] })
    expect(r.fut).toEqual(['verify-db'])
  })

  it('a newer row without a start time proves nothing: the old failure stays', () => {
    const noStart: Row = { id: 200, name: 'verify-db', conclusion: 'success', completed: '2026-11-16T13:30:00Z' }
    expect(run({ checkRuns: [old('verify-db', 'failure'), noStart] }).bukott).toEqual(['verify-db'])
  })

  it('a rerun that is still running replaces the old finished failure, and it is a running check', () => {
    const r = run({
      checkRuns: [old('verify-db', 'failure'), { id: 200, name: 'verify-db', status: 'in_progress', conclusion: null, started: '2026-11-16T13:00:00Z', completed: null }],
    })
    expect(r.fut).toEqual(['verify-db'])
    expect(r.bukott).toEqual([])
  })

  it('the actions/runs fallback (check-runs answered 403) applies the same rule: rerun, the other direction, and the overlap', () => {
    const rerun = run({ checkRunsCode: '403', actionRuns: [old('verify', 'failure'), fresh('verify', 'success')] })
    expect(rerun.bukott).toEqual([])
    const worse = run({ checkRunsCode: '403', actionRuns: [old('verify', 'success'), fresh('verify', 'failure')] })
    expect(worse.bukott).toEqual(['verify'])
    const overlap = run({ checkRunsCode: '403', actionRuns: [old('verify', 'failure'), overlapping('verify', 'success')] })
    expect(overlap.bukott).toEqual(['verify'])
  })

  it('no rows at all still ends with the old refusal (the empty list is not a pass)', () => {
    const r = run({ checkRuns: [] })
    expect(r.exit).toBe('1')
    expect(r.out).toContain('NEM OLVASZTOK: egyetlen ellenorzes sincs')
  })
})
