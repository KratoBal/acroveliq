import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
  scripts/ci-naplo.sh and the repo it asks (acroveliq #411, acrobot 60261). Without PR_REPO it asks
  KratoBal/acropora-os, and a fleet-repo head got the same "NINCS FUTAS" line as a head whose CI never
  started: no `?`, no success, and a waiting loop stood on it for 20 minutes. What turns these red: a
  head that is not in the asked repo reported as "not started" (or exit 0); the repo left unnamed; the
  default repo used without saying so; an unknown /commits answer claimed as either verdict.
*/

const HEAD = 'f472ecf9995aba038801673a26a4cde8bbf4489e'
let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-naplo-repo-'))
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'ci-naplo.sh'), readFileSync(join(process.cwd(), 'scripts', 'ci-naplo.sh')))
  // the token helper the script sources, pointed at a fake owner file: the replacement is checked
  // first, so a changed line can never hand a real token to the curl shim (barracuda, #201)
  const lib = readFileSync(join(process.cwd(), 'scripts', 'lib', 'github-token.sh'), 'utf8')
  expect(lib).toContain('GITHUB_OWNER_TOKEN_FILE=/home/marveen/marveen/store/.github-token\n')
  expect(lib).toContain('GITHUB_TOKEN_BROKER=/usr/local/sbin/fleet-github\n')
  writeFileSync(join(root, 'scripts', 'lib', 'github-token.sh'), lib
    .replace('GITHUB_OWNER_TOKEN_FILE=/home/marveen/marveen/store/.github-token\n', `GITHUB_OWNER_TOKEN_FILE=${join(root, 'store', '.github-token')}\n`)
    .replace('GITHUB_TOKEN_BROKER=/usr/local/sbin/fleet-github\n', `GITHUB_TOKEN_BROKER=${join(root, 'nincs-broker')}\n`))
  writeFileSync(join(root, 'store', '.github-token'), 'teszt-token\n')
  // the GitHub API, by path: no runs for any head, and the /commits answer from COMMIT_BODY
  writeFileSync(join(root, 'bin', 'curl'), `#!/usr/bin/env bash
cat > /dev/null
u=
for a in "$@"; do case "$a" in https://*) u=$a;; esac; done
echo "$u" >> "${root}/urls.log"
case "$u" in
  */actions/runs\\?head_sha=*) echo '{"total_count":0,"workflow_runs":[]}' ;;
  */commits/*) printf '%s' "$COMMIT_BODY" ;;
  *) echo '{}' ;;
esac
`)
  chmodSync(join(root, 'bin', 'curl'), 0o755)
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('bash', [join(root, 'scripts', 'ci-naplo.sh'), ...args], {
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, FLEET_GITHUB_APP: 'off', ...env },
    }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }))
  })
}

const notFound = JSON.stringify({ message: `No commit found for SHA: ${HEAD}`, status: '422' })
const found = JSON.stringify({ sha: HEAD })

describe('ci-naplo.sh: the repo it asks', () => {
  it('a head that is not in the asked repo is a FAIL that names the repo and PR_REPO, exit 1', async () => {
    const r = await run(['--sha', HEAD], { COMMIT_BODY: notFound })
    expect(r.code).toBe(1)
    expect(r.err).toContain('FAIL: a f472ecf9995a fej nincs a KratoBal/acropora-os repoban')
    expect(r.err).toContain('PR_REPO=<owner/repo>')
    expect(r.out).not.toContain('NINCS FUTAS')
  })

  it('a head that is in the repo with no run is still "not started", exit 0', async () => {
    const r = await run(['--sha', HEAD], { COMMIT_BODY: found, PR_REPO: 'KratoBal/acroveliq' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('repo KratoBal/acroveliq) ---')
    expect(r.out).toContain('NINCS FUTAS erre a fejre. Nem azt jelenti, hogy zold')
    expect(readFileSync(join(root, 'urls.log'), 'utf8')).toContain('/repos/KratoBal/acroveliq/commits/')
  })

  it('an answer that is neither a sha nor "No commit found" claims neither', async () => {
    const r = await run(['--sha', HEAD], { COMMIT_BODY: JSON.stringify({ message: 'Bad credentials' }) })
    expect(r.code).toBe(0)
    expect(r.out).toContain('a KratoBal/acropora-os repoban van-e, nem derult ki')
    expect(r.err).not.toContain('FAIL')
  })

  it('the default repo is said when PR_REPO is not set, and not when it is', async () => {
    const note = '[PR_REPO nincs megadva: az alapertelmezett repot kerdeztem'
    expect((await run(['--sha', HEAD], { COMMIT_BODY: found })).out).toContain(note)
    expect((await run(['--sha', HEAD], { COMMIT_BODY: found, PR_REPO: 'KratoBal/acroveliq' })).out).not.toContain(note)
  })

  it('a short sha the repo cannot resolve names the repo', async () => {
    const r = await run(['--sha', 'f472ecf9'], { COMMIT_BODY: notFound, PR_REPO: 'KratoBal/acropora-os' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('nem oldhato fel a KratoBal/acropora-os repoban')
  })
})
