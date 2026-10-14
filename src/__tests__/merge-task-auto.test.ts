import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  THE TASK FROM THE PR WHEN --task IS MISSING (merge-task-auto). What turns
  these red: feladat-pr-szerint.py choosing a task when two name the PR, or
  naming one when none does; a ref matching another PR (#9 for #97), another
  repo, or an event kind other than review_requested and verdict; a failed
  dashboard read looking like "no task"; and pr-beolvaszt.sh not taking the one
  found task, or taking anything when the answer is not exactly one.
*/

const REPO_ROOT = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'merge-task-auto-'))
const finder = join(root, 'scripts', 'feladat-pr-szerint.py')

type Item = { source: string; kind?: string; ref?: string | null }
let timelines: Record<string, Item[]> = {}
let listStatus = 200
let seenAuth: (string | undefined)[] = []
let server: Server
let port = 0

const ev = (kind: string, ref: string | null): Item => ({ source: 'event', kind, ref })

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts', 'feladat-pr-szerint.py'), finder)
  cpSync(join(REPO_ROOT, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(root, 'store', '.dashboard-token'), 'dash-token\n')
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization)
    const url = req.url ?? ''
    const m = url.match(/^\/api\/tasks\/([^/]+)\/timeline$/)
    let status = 404
    let body: unknown = { error: 'not found' }
    if (url === '/api/tasks') [status, body] = [listStatus, Object.keys(timelines).map((id) => ({ id }))]
    else if (m && decodeURIComponent(m[1]!) in timelines) [status, body] = [200, { task: decodeURIComponent(m[1]!), items: timelines[decodeURIComponent(m[1]!)] }]
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  listStatus = 200
  seenAuth = []
  timelines = {
    'keret-or': [ev('started', null), ev('review_requested', 'KratoBal/marveen#76 fej 2409741'), ev('verdict', 'APPROVE KratoBal/marveen#76 fej 2409741')],
    'gate-sablon': [ev('review_requested', 'KratoBal/marveen#97 fej 1416419'), { source: 'handoff' }],
    'masik-repo': [ev('review_requested', 'KratoBal/acropora-os#97 fej abc')],
    'csak-merged': [ev('merged', 'KratoBal/marveen#88'), ev('note', 'KratoBal/marveen#88')],
    'regi-alak': [ev('review_requested', null), ev('verdict', 'APPROVE #88')],
  }
})

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    )
  })
}
const find = (repo: string, pr: string) => sh('python3', ['-B', finder, '--repo', repo, '--pr', pr])

describe('feladat-pr-szerint.py', () => {
  it('one task names the PR: its id alone on stdout, exit 0; the repo is matched without case', async () => {
    const r = await find('kratobal/MARVEEN', '97')
    expect([r.code, r.out]).toEqual([0, 'gate-sablon\n'])
    expect(seenAuth.every((a) => a === 'Bearer dash-token')).toBe(true)
  })

  it('a verdict ref counts as well as a review request', async () => {
    timelines = { 'csak-verdict': [ev('verdict', 'APPROVE KratoBal/marveen#76')] }
    expect((await find('KratoBal/marveen', '76')).out).toBe('csak-verdict\n')
  })

  it('two tasks name it: no choice, both listed, exit 3, nothing on stdout', async () => {
    timelines['masodik'] = [ev('review_requested', 'KratoBal/marveen#97 fej 9999999')]
    const r = await find('KratoBal/marveen', '97')
    expect([r.code, r.out, r.err.includes('gate-sablon') && r.err.includes('masodik')]).toEqual([3, '', true])
  })

  it('none: exit 4; #9 is not #97, another repo\'s #97 is not ours, merged and note events and a bare #88 do not count', async () => {
    const r = await Promise.all([find('KratoBal/marveen', '9'), find('KratoBal/marveen', '7'), find('KratoBal/marveen', '88'), find('KratoBal/acropora-commerce', '97')])
    expect(r.map((x) => [x.code, x.out])).toEqual([[4, ''], [4, ''], [4, ''], [4, '']])
  })

  it('a dashboard that does not answer is not "no task": exit 1', async () => {
    listStatus = 500
    const failed = await find('KratoBal/marveen', '97')
    // a port nobody listens on
    const down = await new Promise<{ code: number }>((resolve) =>
      execFile('python3', ['-B', finder, '--repo', 'KratoBal/marveen', '--pr', '97'], { env: { ...process.env, MARVEEN_WEB_PORT: '1' } }, (error) =>
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0 }),
      ),
    )
    expect([failed.code, failed.out, down.code]).toEqual([1, '', 1])
  })

  it('bad arguments: exit 2, the dashboard is not asked', async () => {
    const r = await Promise.all([find('KratoBal/marveen', '97x'), find('../x', '97'), find('KratoBal/marveen', '0'), sh('python3', ['-B', finder, '--pr', '97'])])
    expect([r.map((x) => x.code), seenAuth]).toEqual([[2, 2, 2, 2], []])
  })
})

describe('pr-beolvaszt.sh takes the task only when exactly one names the PR', () => {
  // the script's own text from the --task deadline up to the token read, run with
  // the finder next to it: the block that decides, not a copy of it
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'pr-beolvaszt.sh'), 'utf8')
  const from = src.indexOf('TASK_KOTELEZO_ETTOL=2026-10-27')
  const to = src.indexOf('TOK="$(cat /home/marveen/marveen/store/.github-token)"')
  const block = join(root, 'scripts', 'blokk.sh')

  const decide = (pr: string, task = '') => {
    writeFileSync(block, `REPO=KratoBal/marveen\nPR=${pr}\nTASK=${task}\nNEZ=1\n${src.slice(from, to)}\necho "TASK=$TASK"\n`)
    return sh('bash', [block])
  }

  it('one: the task is taken and said; two or none or a failed read: no task', async () => {
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const one = await decide('97')
    timelines['masodik'] = [ev('review_requested', 'KratoBal/marveen#97')]
    const two = await decide('97')
    const none = await decide('5')
    listStatus = 500
    const failed = await decide('76')
    expect([one.out, one.err.includes('A feladat a review-esemenyek ref-jebol: gate-sablon'), two.out, two.err.includes('TOBB feladat'), none.out, failed.out, failed.err.includes('nem tudtam megkeresni')]).toEqual([
      'TASK=gate-sablon\n', true, 'TASK=\n', true, 'TASK=\n', 'TASK=\n', true,
    ])
  })

  it('a --task given by the caller wins, and the dashboard is not asked', async () => {
    const r = await decide('97', 'sajat-feladat')
    expect([r.out, seenAuth]).toEqual(['TASK=sajat-feladat\n', []])
  })
})
