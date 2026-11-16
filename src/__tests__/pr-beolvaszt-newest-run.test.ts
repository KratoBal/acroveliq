import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/*
  pr-beolvaszt.sh: ONLY THE NEWEST RUN OF EACH CHECK NAME COUNTS (card 055f4676, 2026-11-16: acropora-os #2631, a CI rerun left the old,
  failed verify-db row in the commit's check-runs list, the failed list counted it, and the script stopped on a green head). The
  segment from the check-runs call up to the `if fut:` line is extracted from the script and run with a stand-in `api` that returns
  the given JSON, so the test measures the script's OWN code on both paths (check-runs, and the actions/runs fallback when check-runs
  answers 403). What turns this red: an old failure with the same name still counted (the rerun case); an old success hiding a NEWER
  failure (the other direction); the order of the rows deciding (the newest listed first); distinct names losing a row; the fallback
  path not applying the rule; the running list losing a still running newest row.
*/
const script = readFileSync(join(process.cwd(), 'scripts', 'pr-beolvaszt.sh'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'pr-beolvaszt-newest-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const START = "def _legujabb_nevenkent(sorok):"
const END = '\nif fut:'

function segment(): string {
  const start = script.indexOf(START)
  expect(start, 'the newest-per-name function is in the script').toBeGreaterThan(-1)
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
  started_at?: string
}

type Result = { exit: string | null; fut: string[]; bukott: string[]; out: string }

function run(opts: { checkRuns?: Row[]; checkRunsCode?: string; actionRuns?: Row[] }): Result {
  const checkRuns = opts.checkRuns ?? []
  const harness = `
import json, sys
sha = 'abc'
def _row(r, runs_api):
    d = {'name': r['name'], 'status': r.get('status', 'completed'), 'conclusion': r.get('conclusion', 'success'), 'id': r['id']}
    if r.get('started_at'): d['run_started_at' if runs_api else 'started_at'] = r['started_at']
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

const old = (name: string, conclusion: string): Row => ({ id: 100, name, conclusion })
const fresh = (name: string, conclusion: string): Row => ({ id: 200, name, conclusion })

describe('pr-beolvaszt.sh: the newest run of a check name is the one that counts', () => {
  it('an old failure and a newer success with the same name: nothing failed, and the log names the skipped old row', () => {
    const r = run({ checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success'), fresh('verify-unit', 'success')] })
    expect(r.bukott).toEqual([])
    expect(r.out).toContain('regebbi futas, nem szamit: verify-db completed failure')
  })

  it('the other direction: an old success and a newer failure still fails', () => {
    const r = run({ checkRuns: [old('verify-db', 'success'), fresh('verify-db', 'failure')] })
    expect(r.bukott).toEqual(['verify-db'])
  })

  it('the order of the rows does not decide: the newest listed first gives the same answer', () => {
    const a = run({ checkRuns: [fresh('verify-db', 'success'), old('verify-db', 'failure')] })
    const b = run({ checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success')] })
    expect(a.bukott).toEqual([])
    expect(b.bukott).toEqual([])
    const c = run({ checkRuns: [fresh('verify-db', 'failure'), old('verify-db', 'success')] })
    expect(c.bukott).toEqual(['verify-db'])
  })

  it('distinct names are all kept, and a failure under another name is still a failure', () => {
    const r = run({
      checkRuns: [old('verify-db', 'failure'), fresh('verify-db', 'success'), { id: 150, name: 'verify-unit', conclusion: 'failure' }],
    })
    expect(r.bukott).toEqual(['verify-unit'])
  })

  it('a newest row that is still running is a running one, not hidden by an older finished row', () => {
    const r = run({
      checkRuns: [old('verify-db', 'failure'), { id: 200, name: 'verify-db', status: 'in_progress', conclusion: null }],
    })
    expect(r.fut).toEqual(['verify-db'])
    expect(r.bukott).toEqual([])
  })

  it('the actions/runs fallback (check-runs answered 403) applies the same rule, in both directions', () => {
    const rerun = run({
      checkRunsCode: '403',
      actionRuns: [old('verify', 'failure'), fresh('verify', 'success')],
    })
    expect(rerun.bukott).toEqual([])
    const worse = run({
      checkRunsCode: '403',
      actionRuns: [old('verify', 'success'), fresh('verify', 'failure')],
    })
    expect(worse.bukott).toEqual(['verify'])
  })

  it('equal ids fall back to the later start time; a missing id counts as the oldest', () => {
    const r = run({
      checkRuns: [
        { id: 5, name: 'verify', conclusion: 'failure', started_at: '2026-11-16T12:00:00Z' },
        { id: 5, name: 'verify', conclusion: 'success', started_at: '2026-11-16T13:00:00Z' },
      ],
    })
    expect(r.bukott).toEqual([])
  })

  it('no rows at all still ends with the old refusal (the empty list is not a pass)', () => {
    const r = run({ checkRuns: [] })
    expect(r.exit).toBe('1')
    expect(r.out).toContain('NEM OLVASZTOK: egyetlen ellenorzes sincs')
  })
})
