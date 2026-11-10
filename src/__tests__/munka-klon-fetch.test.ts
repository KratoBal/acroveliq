// scripts/munka-klon-fetch.sh (card a9cef971): the review clones' origin/main kept fresh from cron. WHAT TURNS THIS RED:
// the fetch moving HEAD, the branch, the index or the working tree (work may be in progress in these clones); origin/main
// not following the remote; a quiet run printing anything; one failing or missing clone stopping the others or exiting 0;
// the cron line missing, or pointing at a script that is not in the repo.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'munka-klon-fetch.sh')
const root = mkdtempSync(join(tmpdir(), 'munka-klon-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim()

describe('munka-klon-fetch.sh', () => {
  it('MUNKA-KLON-FETCH: only origin/main moves; the work in the clone stays; a broken or missing clone does not stop the rest', () => {
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    git(root, 'init', '-q', '--bare', remote)
    git(root, 'clone', '-q', remote, seed)
    writeFileSync(join(seed, 'a.txt'), 'a\n')
    git(seed, 'add', 'a.txt')
    git(seed, 'commit', '-q', '-m', 'A')
    git(seed, 'push', '-q', 'origin', 'HEAD:main')

    // a clone with work in progress: its own branch, a staged file and an unstaged edit
    const klon = join(root, 'klon')
    git(root, 'clone', '-q', remote, klon)
    git(klon, 'switch', '-q', '-c', 'munka')
    writeFileSync(join(klon, 'uj.txt'), 'staged\n')
    git(klon, 'add', 'uj.txt')
    writeFileSync(join(klon, 'a.txt'), 'edited\n')
    // and no fetch refspec of its own (one live clone has only main, one all branches): the script names its own
    git(klon, 'config', '--unset-all', 'remote.origin.fetch')
    const before = { head: git(klon, 'rev-parse', 'HEAD'), branch: git(klon, 'branch', '--show-current'), status: git(klon, 'status', '--porcelain') }

    // a clone whose remote is gone: its fetch fails
    const rossz = join(root, 'rossz')
    git(root, 'clone', '-q', remote, rossz)
    git(rossz, 'remote', 'set-url', 'origin', join(root, 'nincs-ilyen.git'))

    // the remote moves on
    writeFileSync(join(seed, 'b.txt'), 'b\n')
    git(seed, 'add', 'b.txt')
    git(seed, 'commit', '-q', '-m', 'B')
    git(seed, 'push', '-q', 'origin', 'HEAD:main')
    const remoteMain = git(seed, 'rev-parse', 'HEAD')

    // git-auth.sh needs the broker's token; the test's stand-in runs plain git with the same arguments
    const stub = join(root, 'git-auth-stub.sh')
    const calls = join(root, 'git-auth-calls.txt')
    writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> '${calls}'\nexec git "$@"\n`)
    chmodSync(stub, 0o755)
    const env = { ...process.env, MUNKA_KLONOK: `${rossz} ${join(root, 'nincs')} ${klon}`, MUNKA_KLON_GIT_AUTH: stub }
    const run = () => spawnSync('bash', [SCRIPT], { env, encoding: 'utf-8' })

    const first = run()
    const after = { head: git(klon, 'rev-parse', 'HEAD'), branch: git(klon, 'branch', '--show-current'), status: git(klon, 'status', '--porcelain') }
    const second = spawnSync('bash', [SCRIPT], { env: { ...env, MUNKA_KLONOK: klon }, encoding: 'utf-8' })
    // a failing fetch alone (no missing clone beside it) still exits 1
    const brokenAlone = spawnSync('bash', [SCRIPT], { env: { ...env, MUNKA_KLONOK: rossz }, encoding: 'utf-8' }).status
    expect(
      {
        code: first.status,
        moved: git(klon, 'rev-parse', 'refs/remotes/origin/main') === remoteMain,
        saidMove: new RegExp(`${klon}: origin/main [0-9a-f]{8} -> ${remoteMain.slice(0, 8)}`).test(first.stdout),
        saidFail: first.stdout.includes(`${rossz}: FAIL a fetch`),
        saidMissing: first.stdout.includes(`${join(root, 'nincs')}: nincs git-klon itt`),
        workKept: JSON.stringify(after) === JSON.stringify(before),
        stagedKept: readFileSync(join(klon, 'uj.txt'), 'utf-8') === 'staged\n',
        editKept: readFileSync(join(klon, 'a.txt'), 'utf-8') === 'edited\n',
        notMerged: !existsSync(join(klon, 'b.txt')),
        quietSecond: { code: second.status, out: second.stdout },
        brokenAlone,
        // barracuda, #352: no background maintenance (gc) behind a fetch from cron
        noMaintenance: readFileSync(calls, 'utf-8').trim().split('\n').every((l) => / fetch .*--no-auto-maintenance /.test(` ${l} `)),
      },
      'MUNKA-KLON-FETCH',
    ).toEqual({
      code: 1,
      moved: true,
      saidMove: true,
      saidFail: true,
      saidMissing: true,
      workKept: true,
      stagedKept: true,
      editKept: true,
      notMerged: true,
      quietSecond: { code: 0, out: '' },
      brokenAlone: 1,
      noMaintenance: true,
    })
  })

  it('MARVEEN-CRON-MUNKA-KLON: the fetch runs every five minutes from marveen.cron, and its script exists', () => {
    const live = readFileSync(join(process.cwd(), 'scripts', 'crontab', 'marveen.cron'), 'utf-8')
      .split('\n')
      .filter((l) => l.includes('munka-klon-fetch.sh') && !l.startsWith('#'))
    expect({ live, script: existsSync(SCRIPT) }, 'MARVEEN-CRON-MUNKA-KLON').toEqual({
      live: ['*/5 * * * * /home/marveen/marveen/scripts/munka-klon-fetch.sh >>/home/marveen/marveen/store/munka-klon-fetch.log 2>&1'],
      script: true,
    })
  })
})
