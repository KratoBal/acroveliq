import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  THE GITHUB REVIEW GATE OF THE MERGE (b25-gepi-review). What turns these red: a head
  with no APPROVED review passing; an APPROVE on an older head covering a newer one; a
  user's LATER CHANGES_REQUESTED or DISMISSED not cancelling their earlier APPROVE; a
  COMMENTED review counting; another user's CHANGES_REQUESTED being ignored; only the
  first page of reviews being read; "GitHub did not answer" reading as "no review" (exit
  1) or as a pass (exit 0); a repository that is not a fleet repository being held to a
  review that cannot exist; the token going to a foreign address; and, in pr-beolvaszt.sh,
  the gate standing after the merge PUT, being enforced while the mode line says log, or
  not stopping in the enforced mode.
*/

const REPO_ROOT = process.cwd()
const helper = join(REPO_ROOT, 'scripts', 'gepi-review-ellenor.py')
const root = mkdtempSync(join(tmpdir(), 'gepi-review-'))
const tokenFile = join(root, 'gh-token')
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const BARRACUDA = 'machine-approver'

let server: Server
let port = 0
let requests: { method: string; path: string; auth: string | undefined }[] = []
let pages: [number, unknown][] = []

beforeAll(async () => {
  writeFileSync(tokenFile, 'gh-proba-token\n')
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization })
    const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1')
    const [status, body] = pages[page - 1] ?? [200, []]
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
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
  pages = []
})

const review = (state: string, user = BARRACUDA, commit = HEAD) => ({ state, user: { login: user }, commit_id: commit })

type Result = { code: number; out: string }
const finish = (resolve: (r: Result) => void) => (error: unknown, stdout: string, stderr: string) =>
  resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr })

function run(args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-B', helper, ...args],
      { env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_TOKEN_FILE: tokenFile, ...env } },
      finish(resolve),
    )
  })
}

const ask = (repo = 'KratoBal/acroveliq', head = HEAD, env: Record<string, string> = {}) =>
  run(['--repo', repo, '--pr', '257', '--head', head], env)

describe('gepi-review-ellenor.py: is there a review on this head', () => {
  it('an APPROVED review on the head: 0, with the user and the short head, and exactly one authenticated GET', async () => {
    pages = [[200, [review('APPROVED')]]]
    const r = await ask()
    expect(r.code).toBe(0)
    expect(r.out).toContain('gepi review rendben')
    expect(r.out).toContain(HEAD.slice(0, 12))
    expect(r.out).toContain(BARRACUDA)
    expect(requests).toEqual([
      { method: 'GET', path: '/repos/KratoBal/acroveliq/pulls/257/reviews?per_page=100&page=1', auth: 'Bearer gh-proba-token' },
    ])
  })

  it('no review at all: 1', async () => {
    pages = [[200, []]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('NINCS GEPI REVIEW A FEJEN')
  })

  it('only a COMMENTED review: 1 (a comment is no approval)', async () => {
    pages = [[200, [review('COMMENTED')]]]
    expect((await ask()).code).toBe(1)
  })

  it('an APPROVED review of an OLDER head: 1, and the message names both heads and the push', async () => {
    pages = [[200, [review('APPROVED', BARRACUDA, OLD)]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain(OLD.slice(0, 12))
    expect(r.out).toContain(HEAD.slice(0, 12))
    expect(r.out).toContain('a push utan')
  })

  it('an APPROVED review, then the same user DISMISSED: 1', async () => {
    pages = [[200, [review('APPROVED'), review('DISMISSED')]]]
    expect((await ask()).code).toBe(1)
  })

  it('an APPROVED review, then the same user CHANGES_REQUESTED: 1, and it says so', async () => {
    pages = [[200, [review('APPROVED'), review('CHANGES_REQUESTED')]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('CHANGES_REQUESTED')
  })

  it('CHANGES_REQUESTED, then the same user APPROVED on the head: 0 (the latest deciding review counts)', async () => {
    pages = [[200, [review('CHANGES_REQUESTED'), review('COMMENTED'), review('APPROVED')]]]
    expect((await ask()).code).toBe(0)
  })

  it('a COMMENTED review after the APPROVED one does not cancel it: 0', async () => {
    pages = [[200, [review('APPROVED'), review('COMMENTED')]]]
    expect((await ask()).code).toBe(0)
  })

  it("another user's CHANGES_REQUESTED next to an APPROVED: 1", async () => {
    pages = [[200, [review('APPROVED'), review('CHANGES_REQUESTED', 'someone-else')]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('someone-else')
  })

  it('the APPROVED review on the second page of reviews is found: 0, and two pages were asked', async () => {
    pages = [
      [200, Array.from({ length: 100 }, () => review('COMMENTED', 'chatty'))],
      [200, [review('APPROVED')]],
    ]
    const r = await ask()
    expect(r.code).toBe(0)
    expect(requests.map((q) => q.path)).toEqual([
      '/repos/KratoBal/acroveliq/pulls/257/reviews?per_page=100&page=1',
      '/repos/KratoBal/acroveliq/pulls/257/reviews?per_page=100&page=2',
    ])
  })

  it('more reviews than the page limit allows: 3, not a guess', async () => {
    pages = Array.from({ length: 10 }, () => [200, Array.from({ length: 100 }, () => review('COMMENTED', 'chatty'))] as [number, unknown])
    const r = await ask()
    expect(r.code).toBe(3)
    expect(r.out).toContain('NEM TUDOM MEGKERDEZNI')
  })

  it.each([
    ['a 500', [500, { message: 'Server Error' }]],
    ['a 404', [404, { message: 'Not Found' }]],
    ['an answer that is not JSON', [200, 'Bad gateway']],
    ['an answer that is not a list', [200, { message: 'rate limited' }]],
  ] as [string, [number, unknown]][])('GitHub gives %s: 3 (could not ask), never 0 and never "no review"', async (_n, answer) => {
    pages = [answer]
    const r = await ask()
    expect(r.code).toBe(3)
    expect(r.out).toContain('NEM TUDOM MEGKERDEZNI')
    expect(r.out).not.toContain('NINCS GEPI REVIEW')
  })

  it('an unreadable token file: 3, and GitHub is not asked', async () => {
    const r = await ask('KratoBal/acroveliq', HEAD, { GITHUB_TOKEN_FILE: join(root, 'nincs-ilyen') })
    expect(r.code).toBe(3)
    expect(requests).toEqual([])
  })

  it('a repository that is not a fleet repository: 0, said aloud, GitHub not asked', async () => {
    const r = await ask('KratoBal/acropora-os')
    expect(r.code).toBe(0)
    expect(r.out).toContain('nem flotta repo')
    expect(requests).toEqual([])
  })

  it('the old name of the fleet repository is a fleet repository too', async () => {
    pages = [[200, []]]
    expect((await ask('KratoBal/marveen')).code).toBe(1)
  })

  it('the GitHub URL may only be api.github.com or a local one: the token goes nowhere else', async () => {
    const r = await ask('KratoBal/acroveliq', HEAD, { GITHUB_API_URL: 'https://gyujto.example' })
    expect(r.code).toBe(2)
    expect(requests).toEqual([])
  })

  it.each([
    ['a short head', ['--repo', 'KratoBal/acroveliq', '--pr', '257', '--head', 'a'.repeat(12)]],
    ['an upper-case head', ['--repo', 'KratoBal/acroveliq', '--pr', '257', '--head', 'A'.repeat(40)]],
    ['a repo without owner', ['--repo', 'acroveliq', '--pr', '257', '--head', HEAD]],
    ['a PR that is not a number', ['--repo', 'KratoBal/acroveliq', '--pr', 'x', '--head', HEAD]],
    ['a missing head', ['--repo', 'KratoBal/acroveliq', '--pr', '257']],
    ['an unknown switch', ['--repo', 'KratoBal/acroveliq', '--pr', '257', '--head', HEAD, '--force', 'x']],
  ])('%s: usage error 2, nothing sent', async (_n, args) => {
    const r = await run(args)
    expect(r.code).toBe(2)
    expect(requests).toEqual([])
  })
})

describe('pr-beolvaszt.sh: where the gate stands and what it does', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'pr-beolvaszt.sh'), 'utf8')

  it('the mode line is one line, and today it is LOG mode (the ruleset day flips it, and this test with it)', () => {
    expect(src.match(/^GEPI_REVIEW_KENYSZERIT=\d$/gm)).toEqual(['GEPI_REVIEW_KENYSZERIT=0'])
    expect(src).toContain('"$GEPI_REVIEW" "$GEPI_OK" "$GEPI_REVIEW_KENYSZERIT" << \'PYEOF\'')
  })

  it('the gate stands before the --nez exit and before the merge PUT, so --nez shows it', () => {
    const gate = src.indexOf("_gr = subprocess.run(['python3', '-B', gepi_szkript")
    const nez = src.indexOf("print('CSAK NEZEM (--nez)")
    const put = src.indexOf("text, code = api('PUT', f'/pulls/{pr}/merge'")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(nez)
    expect(nez).toBeLessThan(put)
  })

  // the gate block alone, run with a helper stand-in: the four answers it can get, in both modes
  const start = src.indexOf("_gr = subprocess.run(['python3', '-B', gepi_szkript")
  const end = src.indexOf('def _feladat_esemeny(extra):')
  const block = src.slice(start, end)

  function gate(helperCode: number, helperSays: string, mode: { kenyszerit: boolean; ok?: string }): Promise<Result> {
    const fake = join(root, `fake-${Math.random().toString(36).slice(2)}.py`)
    writeFileSync(fake, `import sys\nprint(${JSON.stringify(helperSays)})\nsys.exit(${helperCode})\n`)
    const prog = [
      'import subprocess, sys',
      `repo, pr, sha = 'KratoBal/acroveliq', 257, '${HEAD}'`,
      `gepi_szkript = ${JSON.stringify(fake)}`,
      `gepi_ok = ${JSON.stringify(mode.ok ?? '')}`,
      `gepi_kenyszerit = ${mode.kenyszerit ? 'True' : 'False'}`,
      block,
      "print('A KAPU ELENGEDTE')",
    ].join('\n')
    return new Promise((resolve) => execFile('python3', ['-B', '-c', prog], finish(resolve)))
  }

  it('there is a review: passes in both modes, and prints what the helper said', async () => {
    for (const kenyszerit of [false, true]) {
      const r = await gate(0, 'gepi review rendben: proba', { kenyszerit })
      expect(r.code).toBe(0)
      expect(r.out).toContain('gepi review rendben: proba')
      expect(r.out).toContain('A KAPU ELENGEDTE')
    }
  })

  it.each([
    [1, 'NINCS GEPI REVIEW A FEJEN: proba'],
    [3, 'NEM TUDOM MEGKERDEZNI: proba'],
  ])('helper exit %i, LOG mode: a warning, the merge goes on', async (code, says) => {
    const r = await gate(code, says, { kenyszerit: false })
    expect(r.code).toBe(0)
    expect(r.out).toContain('FIGYELEM (naplo mod')
    expect(r.out).toContain(says)
    expect(r.out).toContain('A KAPU ELENGEDTE')
  })

  it.each([
    [1, 'NINCS GEPI REVIEW A FEJEN: proba'],
    [3, 'NEM TUDOM MEGKERDEZNI: proba'],
  ])('helper exit %i, ENFORCED mode: no merge, its own words, and the way to override', async (code, says) => {
    const r = await gate(code, says, { kenyszerit: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('NEM OLVASZTOK: ' + says)
    expect(r.out).toContain('--gepi-review-rendben')
    expect(r.out).not.toContain('A KAPU ELENGEDTE')
  })

  it('ENFORCED mode with the override reason: the merge goes on and the reason is printed with the gap', async () => {
    const r = await gate(1, 'NINCS GEPI REVIEW A FEJEN: proba', { kenyszerit: true, ok: 'barracuda jovahagyta a 33-as uzenetben' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('gepi review feloldva: barracuda jovahagyta a 33-as uzenetben')
    expect(r.out).toContain('NINCS GEPI REVIEW A FEJEN')
  })

  it('the override flag needs a reason (no reason, no merge)', async () => {
    const r = await new Promise<Result>((resolve) =>
      execFile('bash', [join(REPO_ROOT, 'scripts', 'pr-beolvaszt.sh'), '--gepi-review-rendben'], { env: { ...process.env, PATH: process.env.PATH ?? '' } }, finish(resolve)),
    )
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('INDOKOT var')
  })
})
