import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  THE MERGE ON THE TASK'S TIMELINE (TC-Lite L4). What turns these red: a
  merged event written when the merge PUT was not 200, when its answer has no
  merge sha, or when that sha is not on the target branch (behind, diverged,
  unknown, resolved to another commit); more than one event for one merge; the
  --nez form sending anything; a GitHub URL other than api.github.com or a
  local one getting the token; pr-beolvaszt.sh calling the helper anywhere
  but right after the PUT, or not on --nez; review-csomag.sh taking a package
  without a task id.
*/

const REPO_ROOT = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tcl-l4-merge-'))
const helper = join(root, 'scripts', 'beolvadt-esemeny.py')
const tokenFile = join(root, 'gh-token')
const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)

let server: Server
let port = 0
let requests: { method: string; path: string; auth: string | undefined; body: unknown }[] = []
let compare: [number, unknown] = [200, { status: 'ahead', base_commit: { sha: MERGE } }]

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts', 'beolvadt-esemeny.py'), helper)
  copyFileSync(join(REPO_ROOT, 'scripts', 'fleet-api.sh'), join(root, 'scripts', 'fleet-api.sh'))
  writeFileSync(join(root, 'store', '.dashboard-token'), 'dash-token')
  writeFileSync(tokenFile, 'gh-proba-token\n')
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const path = req.url ?? ''
      requests.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
      const [status, body] = path.includes('/compare/') ? compare : [201, { id: requests.length }]
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  requests = []
  compare = [200, { status: 'ahead', base_commit: { sha: MERGE } }]
})

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-B', helper, ...args],
      { env: { ...process.env, MARVEEN_WEB_PORT: String(port), GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_TOKEN_FILE: tokenFile, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })
}

function putBody(body: unknown): string {
  const f = join(root, `put-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
  return f
}

const base = ['--task', 'tcl-l4', '--repo', 'KratoBal/marveen', '--pr', '41', '--head', HEAD, '--base', 'main']
const events = () => requests.filter((r) => r.path.startsWith('/api/tasks/'))
const compares = () => requests.filter((r) => r.path.includes('/compare/'))

describe('beolvadt-esemeny.py', () => {
  it.each(['ahead', 'identical'])('PUT 200 with the merge sha on main (%s): exactly one merged event with the four data fields', async (status) => {
    compare = [200, { status, base_commit: { sha: MERGE } }]
    const r = await run([...base, '--put-code', '200', '--put-body-file', putBody({ sha: MERGE, merged: true })])
    expect(r.code).toBe(0)
    expect(compares()).toEqual([
      { method: 'GET', path: `/repos/KratoBal/marveen/compare/${MERGE}...main`, auth: 'Bearer gh-proba-token', body: null },
    ])
    expect(events()).toEqual([
      {
        method: 'POST',
        path: '/api/tasks/tcl-l4/events',
        auth: 'Bearer dash-token',
        body: { kind: 'merged', actor: 'acrobot', ref: 'KratoBal/marveen#41', data: { repo: 'KratoBal/marveen', pr: 41, head_sha: HEAD, merge_sha: MERGE } },
      },
    ])
  })

  it.each([
    ['the PUT was 405', '405', { message: 'not mergeable' }],
    ['the PUT was 409', '409', { message: 'head changed' }],
    ['the PUT gave no answer', '000', ''],
    // the code alone must decide: this answer names a sha, so only the 200-check stops it
    ['the PUT was 422 though its answer names a sha', '422', { sha: MERGE, message: 'Validation Failed' }],
  ])('%s: no event, and GitHub is not even asked', async (_n, code, body) => {
    const r = await run([...base, '--put-code', code, '--put-body-file', putBody(body)])
    expect(r.code).not.toBe(0)
    expect(requests).toEqual([])
  })

  it.each([
    ['no sha in the answer', { merged: true }],
    ['a short sha', { sha: 'b'.repeat(12) }],
    ['not JSON', 'Server Error'],
  ])('PUT 200 but %s: no event', async (_n, body) => {
    const r = await run([...base, '--put-code', '200', '--put-body-file', putBody(body)])
    expect(r.code).not.toBe(0)
    expect(events()).toEqual([])
  })

  it.each([
    ['behind main', [200, { status: 'behind', base_commit: { sha: MERGE } }]],
    ['diverged', [200, { status: 'diverged', base_commit: { sha: MERGE } }]],
    ['unknown to GitHub', [404, { message: 'Not Found' }]],
    ['resolved to another commit', [200, { status: 'ahead', base_commit: { sha: 'c'.repeat(40) } }]],
  ] as [string, [number, unknown]][])('the merge sha %s: no event', async (_n, answer) => {
    compare = answer
    const r = await run([...base, '--put-code', '200', '--put-body-file', putBody({ sha: MERGE })])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('NEM IROK ESEMENYT')
    expect(events()).toEqual([])
  })

  it('--nez prints the event and sends nothing at all', async () => {
    const r = await run([...base, '--put-code', '000', '--nez'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('task-event tcl-l4 merged acrobot')
    expect(r.out).toContain('"head_sha": "' + HEAD + '"')
    expect(requests).toEqual([])
  })

  it('the GitHub URL may only be api.github.com or a local one: the token goes nowhere else', async () => {
    const r = await run([...base, '--put-code', '200', '--put-body-file', putBody({ sha: MERGE })], { GITHUB_API_URL: 'https://gyujto.example' })
    expect(r.code).toBe(2)
    expect(requests).toEqual([])
  })

  it.each([
    ['a task id with a space', ['--task', 'tcl l4']],
    ['a short head sha', ['--head', 'a'.repeat(12)]],
    ['a repo without owner', ['--repo', 'marveen']],
    ['a path as branch', ['--base', '../main']],
  ])('%s: usage error, nothing sent', async (_n, over) => {
    const args = [...base]
    args[args.indexOf(over[0]!) + 1] = over[1]!
    const r = await run([...args, '--put-code', '200', '--put-body-file', putBody({ sha: MERGE })])
    expect(r.code).toBe(2)
    expect(requests).toEqual([])
  })
})

describe('pr-beolvaszt.sh calls it in exactly two places', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'pr-beolvaszt.sh'), 'utf8')

  it('right after the merge PUT, with its code and answer, only with --task', () => {
    const put = src.indexOf("text, code = api('PUT', f'/pulls/{pr}/merge'")
    const call = src.indexOf("_feladat_esemeny(['--put-code', code, '--put-body-file', _tf.name])")
    expect(put).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(put)
    expect(src.slice(put, call)).toContain('\nif task:\n')
    expect(src.match(/_feladat_esemeny\(\[/g)).toHaveLength(2)
  })

  it('on --nez, in the --nez form, before it exits', () => {
    const nez = src.indexOf("print('CSAK NEZEM (--nez): minden feltetel teljesul, de NEM olvasztok be.')")
    const call = src.indexOf("_feladat_esemeny(['--put-code', '000', '--nez'])")
    const exit = src.indexOf('sys.exit(0)', nez)
    expect(nez).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(nez)
    expect(call).toBeLessThan(exit)
  })

  it('a missing --task is loud for two weeks, then refused (but never on --nez)', () => {
    expect(src).toContain('TASK_KOTELEZO_ETTOL=2026-10-27')
    expect(src).toMatch(/if \[\[ "\$\(date -u \+%F\)" < "\$TASK_KOTELEZO_ETTOL" \]\] \|\| \[ "\$NEZ" = 1 \]; then/)
  })
})

describe('review-csomag.sh', () => {
  it('its own guard test passes, the task id cases included', async () => {
    const r = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile('bash', [join(REPO_ROOT, 'scripts', '__tests__', 'review-csomag.test.sh')], (error, stdout, stderr) =>
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      ),
    )
    expect(r.out).toContain('[PASS] no task_id -> usage error')
    expect(r.out).toContain('all pass')
    expect(r.code).toBe(0)
  })
})
