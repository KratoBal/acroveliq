// scripts/ai-kerdeskeszlet-or.sh (task t-20261116-kerdeskeszlet-or): the pinned question set against the test AI, from
// cron. WHAT TURNS THIS RED: a run on a quiet tick (the 16 model calls spent when nothing changed and the last report is
// fresh); no run when the AI's code or instruction text moved, or when the last report is a week old; the token on the
// runner's command line instead of its environment; a message on a clean run, or none on a regression or a setup
// failure; a dirty or stale AI clone used as it stands; the cron line missing, or pointing at a script not in the repo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'ai-kerdeskeszlet-or.sh')
const root = mkdtempSync(join(tmpdir(), 'kerdeskeszlet-or-'))
let server: Server
let base = ''
let health: Record<string, unknown> = { version: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(health))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

let n = 0
/** A fresh world: report dir, token file, message and runner stand-ins that write down what they got. */
function world(runnerCode = 0) {
  n += 1
  const dir = join(root, `w${n}`)
  mkdirSync(dir)
  const reports = join(dir, 'reports')
  const token = join(dir, 'token')
  writeFileSync(token, 'titok-token-123')
  const msgLog = join(dir, 'msg.txt')
  const msg = join(dir, 'msg.sh')
  writeFileSync(msg, `#!/usr/bin/env bash\necho "TO=$1 $2" >> '${msgLog}'\ncat >> '${msgLog}'\n`)
  const argsLog = join(dir, 'runner-args.txt')
  const envLog = join(dir, 'runner-env.txt')
  const runner = join(dir, 'runner.sh')
  // writes a report shaped like the real one at --out, and exits with the code the test asked for
  writeFileSync(
    runner,
    `#!/usr/bin/env bash
echo "$*" >> '${argsLog}'
echo "\${AI_API_TOKEN:-}" >> '${envLog}'
out=""; while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done
python3 -c 'import json,sys,datetime; json.dump({"serverVersion": sys.argv[2], "instructionsVersion": sys.argv[3], "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}, open(sys.argv[1], "w"))' "$out" '${String(health.version)}' '${String(health.instructionsVersion)}'
echo "compared ... REGRESSION glossary-not-forced: pass -> fail"
exit ${runnerCode}
`,
  )
  chmodSync(runner, 0o755)
  const env = {
    ...process.env,
    KERDES_AI_URL: base,
    KERDES_TOKEN_FILE: token,
    KERDES_REPORT_DIR: reports,
    KERDES_MSG: msg,
    KERDES_RUNNER: `bash ${runner}`,
    KERDES_LOCK: join(dir, 'lock'),
  }
  const run = (extra: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile('bash', [SCRIPT], { env: { ...env, ...extra } }, (error, stdout, stderr) =>
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      ),
    )
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : '')
  return { dir, reports, token, run, args: () => read(argsLog), envSeen: () => read(envLog), messages: () => read(msgLog) }
}

/** A report as the runner writes it, at a given age. */
function report(reports: string, name: string, versions: { serverVersion: string; instructionsVersion: string }, ageDays: number) {
  mkdirSync(reports, { recursive: true })
  const startedAt = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  writeFileSync(join(reports, name), JSON.stringify({ ...versions, startedAt }))
}

describe('ai-kerdeskeszlet-or.sh', () => {
  it('first run: runs the set with the token in the environment only, no --compare, and stays quiet on exit 0', async () => {
    health = { version: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }
    const w = world(0)
    const r = await w.run()
    expect({
      code: r.code,
      reports: readdirSync(w.reports).filter((f) => /^qs-.*-aaaa1111\.json$/.test(f)).length,
      urlArg: w.args().includes(`--url ${base}`),
      compare: w.args().includes('--compare'),
      tokenInArgs: w.args().includes('titok-token-123') || r.out.includes('titok-token-123'),
      tokenInEnv: w.envSeen().trim(),
      messages: w.messages(),
    }).toEqual({ code: 0, reports: 1, urlArg: true, compare: false, tokenInArgs: false, tokenInEnv: 'titok-token-123', messages: '' })
  })

  it('a quiet tick: same code, same instructions, a fresh report -> no run, no output', async () => {
    health = { version: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }
    const w = world(0)
    report(w.reports, 'qs-elozo.json', { serverVersion: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }, 1)
    const r = await w.run()
    expect({ code: r.code, out: r.out, ran: w.args() }).toEqual({ code: 0, out: '', ran: '' })
  })

  it('the instruction text moved: runs with --compare against the newest report, and a regression (exit 3) tells acrobot', async () => {
    health = { version: 'aaaa1111bbbb', instructionsVersion: 'cccccccccccc' }
    const w = world(3)
    report(w.reports, 'qs-regi.json', { serverVersion: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }, 3)
    report(w.reports, 'qs-ujabb.json', { serverVersion: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }, 1)
    const r = await w.run()
    expect({
      code: r.code,
      compareNewest: w.args().includes(`--compare ${join(w.reports, 'qs-ujabb.json')}`),
      to: w.messages().startsWith('TO=acrobot acrobot'),
      regression: /ROMLAS \(changed, szerver aaaa1111\).*glossary-not-forced: pass -> fail.*Jelentes: /.test(w.messages()),
    }).toEqual({ code: 3, compareNewest: true, to: true, regression: true })
  })

  it('a week-old report with nothing changed: the weekly run', async () => {
    health = { version: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }
    const w = world(0)
    report(w.reports, 'qs-heti.json', { serverVersion: 'aaaa1111bbbb', instructionsVersion: '5789d9bc8eb1' }, 8)
    const r = await w.run()
    expect({ code: r.code, ran: w.args().includes('--compare'), weekly: /futas \(weekly/.test(r.out), messages: w.messages() }).toEqual({
      code: 0,
      ran: true,
      weekly: true,
      messages: '',
    })
  })

  it('setup and reach: an unreadable token is a setup message (exit 2, no run); an unreachable /health is a log line (exit 1)', async () => {
    health = { version: 'dddd2222eeee', instructionsVersion: '5789d9bc8eb1' }
    const w = world(0)
    rmSync(w.token)
    const noToken = await w.run()
    const unreachable = await w.run({ KERDES_AI_URL: 'http://127.0.0.1:9', KERDES_TOKEN_FILE: join(w.dir, 'x') })
    expect({
      noToken: noToken.code,
      ran: w.args(),
      setupMessage: /beallitasi hiba: a teszt AI tokenje nem olvashato/.test(w.messages()),
      unreachable: unreachable.code,
      unreachableLine: /a \/health nem olvashato/.test(unreachable.out),
      oneMessage: (w.messages().match(/TO=acrobot/g) ?? []).length,
    }).toEqual({ noToken: 2, ran: '', setupMessage: true, unreachable: 1, unreachableLine: true, oneMessage: 1 })
  })

  it('the AI clone: set to origin/main and built when its head moved; a dirty clone is a setup failure, not used as it stands', async () => {
    health = { version: 'ffff3333aaaa', instructionsVersion: '5789d9bc8eb1' }
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf-8' }).trim()
    const w = world(0)
    const remote = join(w.dir, 'ai.git')
    const seed = join(w.dir, 'seed')
    git(w.dir, 'init', '-q', '--bare', remote)
    git(w.dir, 'clone', '-q', remote, seed)
    mkdirSync(join(seed, 'scripts'))
    // the AI repo's runner, stood in by a script that writes a report and exits 0
    writeFileSync(
      join(seed, 'scripts', 'question-set-run.mjs'),
      `import { writeFileSync } from "node:fs";\nconst a = process.argv; writeFileSync(a[a.indexOf("--out") + 1], JSON.stringify({ serverVersion: "ffff3333aaaa", instructionsVersion: "5789d9bc8eb1", startedAt: new Date().toISOString() }));\n`,
    )
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'A')
    git(seed, 'push', '-q', 'origin', 'HEAD:main')
    const klon = join(w.dir, 'klon')
    git(w.dir, 'clone', '-q', remote, klon)
    writeFileSync(join(seed, 'b.txt'), 'b\n')
    git(seed, 'add', 'b.txt')
    git(seed, 'commit', '-q', '-m', 'B')
    git(seed, 'push', '-q', 'origin', 'HEAD:main')
    const remoteMain = git(seed, 'rev-parse', 'HEAD')
    const gitAuth = join(w.dir, 'git-auth.sh')
    writeFileSync(gitAuth, '#!/usr/bin/env bash\nexec git "$@"\n')
    const built = join(w.dir, 'built.txt')
    const env = {
      KERDES_RUNNER: '',
      KERDES_KLON: klon,
      KERDES_GIT_AUTH: gitAuth,
      KERDES_BUILD: `mkdir -p '${klon}/dist' && touch '${klon}/dist/question-set-run.js' && echo built >> '${built}'`,
    }
    const clean = await w.run(env)
    const head = git(klon, 'rev-parse', 'HEAD')
    // a second tick on the same versions is quiet; then a dirty clone with a moved remote is refused
    writeFileSync(join(klon, 'sajat.txt'), 'local work\n')
    health = { version: 'ffff4444aaaa', instructionsVersion: '5789d9bc8eb1' }
    const dirty = await w.run(env)
    expect({
      clean: clean.code,
      atRemoteMain: head === remoteMain,
      builtOnce: readFileSync(built, 'utf-8'),
      dirty: dirty.code,
      dirtyMessage: /az AI-futtato nem epult .*FAIL a klon nem tiszta/.test(w.messages()),
      dirtyKept: readFileSync(join(klon, 'sajat.txt'), 'utf-8'),
    }).toEqual({ clean: 0, atRemoteMain: true, builtOnce: 'built\n', dirty: 2, dirtyMessage: true, dirtyKept: 'local work\n' })
  })

  it('the cron line runs the script from the repo, and the script is executable', () => {
    const cron = readFileSync(join(process.cwd(), 'scripts', 'crontab', 'marveen.cron'), 'utf-8')
    const line = cron.split('\n').find((l) => l.includes('ai-kerdeskeszlet-or.sh') && !l.startsWith('#'))
    expect({
      line: /^\*\/15 \* \* \* \* \/home\/marveen\/marveen\/scripts\/ai-kerdeskeszlet-or\.sh >>/.test(line ?? ''),
      executable: (statSync(SCRIPT).mode & 0o111) !== 0,
    }).toEqual({ line: true, executable: true })
  })
})
