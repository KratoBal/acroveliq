import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const root = mkdtempSync(join(tmpdir(), 'gepi-review-'))
// the helper runs from a copy, next to a test list of its own: the real list is measured separately below
const helper = join(root, 'scripts', 'gepi-review-ellenor.py')
const listFile = join(root, 'scripts', 'gepi-review.json')
const REPOS = ['acroveliq', 'acropora-os', 'caparium-napplo']
const writeList = (o: unknown) => writeFileSync(listFile, typeof o === 'string' ? o : JSON.stringify(o))
const tokenFile = join(root, 'gh-token')
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const BARRACUDA = 'machine-approver'

let server: Server
let port = 0
let requests: { method: string; path: string; auth: string | undefined }[] = []
let pages: [number, unknown][] = []

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts', 'gepi-review-ellenor.py'), helper)
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
  writeList({ owner: 'KratoBal', repos: REPOS, reviewers: [BARRACUDA] })
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

  it("a stranger's APPROVED on the head is NOT enough: 1, and the message names the stranger and the listed reviewer", async () => {
    pages = [[200, [review('APPROVED', 'some-app[bot]')]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('some-app[bot]')
    expect(r.out).toContain(BARRACUDA)
  })

  it("a stranger's APPROVED next to the reviewer's own APPROVED: 0, and only the reviewer is named as the approver", async () => {
    pages = [[200, [review('APPROVED', 'some-app[bot]'), review('APPROVED')]]]
    const r = await ask()
    expect(r.code).toBe(0)
    expect(r.out).toContain(`(${BARRACUDA})`)
    expect(r.out).not.toContain('some-app')
  })

  it("a stranger's APPROVED on the head after the reviewer's APPROVED on an older head: 1 (the head is not covered by the reviewer)", async () => {
    pages = [[200, [review('APPROVED', BARRACUDA, OLD), review('APPROVED', 'some-app[bot]')]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('a push utan')
  })

  it('the login is compared without regard to case (GitHub logins are case-insensitive)', async () => {
    pages = [[200, [review('APPROVED', 'Machine-Approver')]]]
    expect((await ask()).code).toBe(0)
  })

  it('an EMPTY reviewer list: 1, said as "not checkable", with the logins that approved (the first measurement fills the list)', async () => {
    writeList({ owner: 'KratoBal', repos: REPOS, reviewers: [] })
    pages = [[200, [review('APPROVED', 'ez-lehet-a-gepi-fiok')]]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('NEM ELLENORIZHETO')
    expect(r.out).toContain('ez-lehet-a-gepi-fiok')
  })

  it('an empty reviewer list and no approval at all: still 1, and it says nobody approved', async () => {
    writeList({ owner: 'KratoBal', repos: REPOS, reviewers: [] })
    pages = [[200, []]]
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('senki')
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

  it('a repository that is not in the list: 0, said aloud, GitHub not asked', async () => {
    const r = await ask('KratoBal/masik-repo')
    expect(r.code).toBe(0)
    expect(r.out).toContain('nem flotta repo')
    expect(requests).toEqual([])
  })

  it.each(['acroveliq', 'acropora-os', 'caparium-napplo'])('%s is in the list: GitHub is asked, no review means 1', async (name) => {
    pages = [[200, []]]
    const r = await ask(`KratoBal/${name}`)
    expect(r.code).toBe(1)
    expect(requests).toHaveLength(1)
  })

  it('the list decides: a repo added to it is asked, a repo removed from it is not', async () => {
    writeList({ owner: 'KratoBal', repos: ['uj-repo'], reviewers: [BARRACUDA] })
    pages = [[200, []]]
    expect((await ask('KratoBal/uj-repo')).code).toBe(1)
    expect((await ask('KratoBal/acroveliq')).code).toBe(0)
    expect(requests).toHaveLength(1)
  })

  it('the owner of the list counts: the same repo name under another owner is not in it', async () => {
    const r = await ask('MasikCeg/acroveliq')
    expect(r.code).toBe(0)
    expect(r.out).toContain('nem flotta repo')
  })

  it.each([
    ['missing', null],
    ['not JSON', 'ez nem json'],
    ['no reviewers key', { owner: 'KratoBal', repos: REPOS }],
    ['reviewers not a list', { owner: 'KratoBal', repos: REPOS, reviewers: 'machine-approver' }],
    ['a repo name that is not a name', { owner: 'KratoBal', repos: ['../x'], reviewers: [] }],
  ])('the list is %s: 3, GitHub not asked (it is not "no review" and not a pass)', async (_n, content) => {
    if (content === null) rmSync(listFile)
    else writeList(content)
    const r = await ask()
    expect(r.code).toBe(3)
    expect(r.out).toContain('NEM TUDOM MEGKERDEZNI')
    expect(requests).toEqual([])
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

  it('the mode line is one line, and it is ENFORCE mode since 2026-10-30 (#157 merged without a verdict in log mode)', () => {
    expect(src.match(/^GEPI_REVIEW_KENYSZERIT=\d$/gm)).toEqual(['GEPI_REVIEW_KENYSZERIT=1'])
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

  const argvFile = join(root, 'helper-argv.txt')

  function gate(helperCode: number, helperSays: string, mode: { kenyszerit: boolean; ok?: string }): Promise<Result> {
    const fake = join(root, `fake-${Math.random().toString(36).slice(2)}.py`)
    writeFileSync(fake, `import sys\nopen(${JSON.stringify(argvFile)}, 'w').write(' '.join(sys.argv[1:]))\nprint(${JSON.stringify(helperSays)})\nsys.exit(${helperCode})\n`)
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

  it('the helper is asked about exactly this repository, this PR and this head', async () => {
    await gate(0, 'rendben', { kenyszerit: false })
    expect(readFileSync(argvFile, 'utf8')).toBe(`--repo KratoBal/acroveliq --pr 257 --head ${HEAD}`)
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

describe('the one list (scripts/gepi-review.json) and the fleet-approve config it must agree with', () => {
  const real = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'gepi-review.json'), 'utf8')) as { owner: string; repos: string[]; reviewers: string[] }
  const template = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'root', 'fleet-github-app.example.json'), 'utf8')) as { owner: string; repos: string[] }

  // the live config (/etc/fleet-github/app.json) is root-only and cannot be read from here or from CI: the
  // repo's template of it is what can be compared. caparium-napplo is the one known extra: barracuda's root
  // records (#258 review 1, 2026-10-19) show the live approver knows it, the template has not been given it.
  const KNOWN_EXTRA = ['caparium-napplo']

  it('every repository of the config template is in the list, and the owner is the same', () => {
    expect(real.owner).toBe(template.owner)
    expect(template.repos.filter((r) => !real.repos.includes(r))).toEqual([])
  })

  it('the list holds nothing the template lacks, except the named extra (a new repo is added to BOTH)', () => {
    expect(real.repos.filter((r) => !template.repos.includes(r))).toEqual(KNOWN_EXTRA)
  })

  it('the machine account is the listed reviewer (Balazs 2026-10-15 16:50 UTC, Eldontendo msg 1560334076613754972, via acrobot 32949)', () => {
    expect(real.reviewers).toEqual(['flotta-bot-acro'])
  })

  const runReal = (head: string) =>
    new Promise<Result>((resolve) =>
      execFile(
        'python3',
        ['-B', join(REPO_ROOT, 'scripts', 'gepi-review-ellenor.py'), '--repo', 'KratoBal/acroveliq', '--pr', '257', '--head', head],
        { env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_TOKEN_FILE: tokenFile } },
        finish(resolve),
      ),
    )

  it('the helper, run from the real scripts directory, reads the real list: the machine account\'s APPROVED on the head passes', async () => {
    pages = [[200, [review('APPROVED', 'flotta-bot-acro')]]]
    const r = await runReal(HEAD)
    expect(r.code).toBe(0)
    expect(r.out).toContain('(flotta-bot-acro)')
  })

  it('... and a stranger\'s APPROVED on the head does not: 1, the stranger named', async () => {
    pages = [[200, [review('APPROVED', 'valaki')]]]
    const r = await runReal(HEAD)
    expect(r.code).toBe(1)
    expect(r.out).toContain('valaki')
    expect(r.out).toContain('flotta-bot-acro')
  })
})

describe('--osszevet <app.json>: the install step that compares the live config with the list', () => {
  const cfgFile = join(root, 'app-proba.json')
  const compare = (cfg: unknown) =>
    new Promise<Result>((resolve) => {
      if (cfg !== null) writeFileSync(cfgFile, typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
      else rmSync(cfgFile, { force: true })
      execFile('python3', ['-B', helper, '--osszevet', cfgFile], finish(resolve))
    })

  it('the same owner and repos (in any order, other keys ignored): 0', async () => {
    const r = await compare({ owner: 'KratoBal', repos: [...REPOS].reverse(), approvers: ['agent-barracuda'], app_id: 'x' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('egyezik')
  })

  it('a repo only in the live config: 1, named', async () => {
    const r = await compare({ owner: 'KratoBal', repos: [...REPOS, 'uj-repo'] })
    expect(r.code).toBe(1)
    expect(r.out).toContain('csak a konfigban: KratoBal/uj-repo')
  })

  it('a repo only in the list: 1, named', async () => {
    const r = await compare({ owner: 'KratoBal', repos: REPOS.slice(1) })
    expect(r.code).toBe(1)
    expect(r.out).toContain('csak a gepi review listaban: KratoBal/acroveliq')
  })

  it('another owner: 1 (every repo differs)', async () => {
    expect((await compare({ owner: 'MasikCeg', repos: REPOS })).code).toBe(1)
  })

  it.each([
    ['missing', null],
    ['not JSON', 'ez nem json'],
    ['no repos key', { owner: 'KratoBal' }],
  ])('the config is %s: 3, not a pass', async (_n, cfg) => {
    expect((await compare(cfg)).code).toBe(3)
  })
})
