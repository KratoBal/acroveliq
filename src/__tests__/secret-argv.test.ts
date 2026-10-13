// A secret must not ride on a process's argv: /proc is mounted without
// hidepid, so every agent's `ps` shows every process's command line
// (measured 2026-10-13: a running pr-allapot.sh showed the GitHub token in
// curl's argv, 22 samples). The GitHub helpers that call curl from Python now
// hand the header over on curl's stdin (`-H @-`).
//
// pr-allapot.sh runs for real, copied into a throwaway root (only its fixed
// ROOT line points there), with a fake token and a curl shim first on PATH
// that records its argv and its stdin, then answers with an empty object.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO = process.cwd()
const SECRET = 'secret-gh-token-0123456789'

function run(script: string, args: string[]): { argv: string; stdin: string; calls: number } {
  const root = mkdtempSync(join(tmpdir(), 'mv-argv-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'store', '.github-token'), `${SECRET}\n`, { mode: 0o600 })
  const copy = join(root, 'scripts', script)
  copyFileSync(join(REPO, 'scripts', script), copy)
  const src = readFileSync(copy, 'utf8')
  expect(src).toContain('ROOT=/home/marveen/marveen\n')
  writeFileSync(copy, src.replace('ROOT=/home/marveen/marveen\n', `ROOT=${root}\n`))
  const shim = join(root, 'bin', 'curl')
  writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${root}/argv.log"\ncat >> "${root}/stdin.log"\necho '{}'\n`)
  chmodSync(shim, 0o755)
  spawnSync('bash', [copy, ...args], { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', input: '' })
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')
  const argv = read('argv.log')
  return { argv, stdin: read('stdin.log'), calls: argv.split('\n').filter(Boolean).length }
}

describe('the GitHub helpers keep the token off curl\'s command line', () => {
  it('SECRET-ARGV: pr-allapot.sh hands the header on stdin, and no argv carries the token', () => {
    const r = run('pr-allapot.sh', ['85'])
    expect([r.calls > 0, r.argv.includes(SECRET), r.stdin.includes(`Authorization: Bearer ${SECRET}`)], 'SECRET-ARGV').toEqual([true, false, true])
  })
})

// The Facebook scripts (#87's two named leftovers, task fb-token-argv): the page token
// rode on curl's argv as `-F access_token=...` (fb-schedule-post.sh) and as
// debug_token's `input_token=...` (fb-insights.sh), and every script's scrub() put the
// token into sed's argv. They run for real in a throwaway root (ROOT is derived from
// the script's own path) with curl and sed shims first on PATH. The curl shim also
// reads every /dev/fd/N its argv names, so the test proves the token still REACHES
// curl, not only that it left the command line; the sed shim records its argv and
// runs the real sed. No request leaves the machine.
const FB_PAGE = 'fbpagetoken0123456789abcdef'
const FB_USER = 'fbusertoken9876543210fedcba'

function runFb(script: string, args: string[], files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mv-fb-argv-'))
  for (const d of ['store', 'scripts', 'bin', 'in']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'store', '.fb-page-token'), `${FB_PAGE}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'store', '.fb-user-token'), `${FB_USER}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'store', '.fb-page-id'), '1111\n')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'in', name), body)
  copyFileSync(join(REPO, 'scripts', script), join(root, 'scripts', script))
  const sedPath = ['/usr/bin/sed', '/bin/sed'].find((p) => existsSync(p))!
  writeFileSync(join(root, 'bin', 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${root}/curl-argv.log"
echo=""
for a in "$@"; do
  f="\${a#*[<@]}"
  case "$f" in /dev/fd/*|/proc/self/fd/*) v="$(cat "$f")"; printf '%s\\n' "$v" >> "${root}/curl-fd.log"; [ -n "$echo" ] || echo="\${v##* }";; esac
done
# the answer echoes the token it got, so what the script prints goes through scrub() for real
case "$*" in *http_code*) printf '{"data":{"app_id":"42"},"id":"777","echo":"%s"}\\n200' "$echo";; *) printf '{"id":"777","echo":"%s"}' "$echo";; esac
`)
  writeFileSync(join(root, 'bin', 'sed'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${root}/sed-argv.log"\nexec ${sedPath} "$@"\n`)
  chmodSync(join(root, 'bin', 'curl'), 0o755)
  chmodSync(join(root, 'bin', 'sed'), 0o755)
  const r = spawnSync('bash', [join(root, 'scripts', script), ...args.map((a) => a.replace('{in}', join(root, 'in')))], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', input: '',
  })
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')
  const curlArgv = read('curl-argv.log')
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr,
    curlArgv, curlFd: read('curl-fd.log'), sedArgv: read('sed-argv.log'),
    curlCalls: curlArgv.split('\n').filter(Boolean).length,
  }
}

describe('the Facebook scripts keep the page and user token off every command line', () => {
  const when = String(Math.floor(Date.now() / 1000) + 3 * 86400)
  const cases: [string, string[], number][] = [
    ['photo', ['photo', '{in}/a.jpg', '{in}/t.txt', when], 2],
    ['photos', ['photos', '{in}/t.txt', when, '{in}/a.jpg', '{in}/a.jpg'], 3],
    ['list', ['list'], 1],
    ['show', ['show', '777'], 1],
    ['settext', ['settext', '777', '{in}/t.txt'], 1],
    ['setdate', ['setdate', '777', when], 2],
    ['delete', ['delete', '777'], 1],
  ]
  for (const [name, args, calls] of cases) {
    it(`FB-ARGV fb-schedule-post.sh ${name}: the token reaches curl through a file descriptor, never on curl's or sed's argv`, () => {
      const r = runFb('fb-schedule-post.sh', args, { 'a.jpg': 'jpg', 't.txt': 'szoveg' })
      expect(r.status, r.stderr).toBe(0)
      expect([r.curlCalls, r.curlArgv.includes(FB_PAGE), r.sedArgv.includes(FB_PAGE), r.sedArgv.length > 0],
        `FB-ARGV ${name}`).toEqual([calls, false, false, true])
      // every call carried the token, and the request keeps its access_token field
      expect(r.curlFd.split(FB_PAGE).length - 1, `FB-ARGV ${name} fd`).toBe(calls)
      for (const line of r.curlArgv.split('\n').filter(Boolean)) expect(line).toMatch(/access_token[=@]<?\/dev\/fd\/\d+|access_token@\/dev\/fd\/\d+/)
    })
  }

  it('FB-ARGV fb-insights.sh check: debug_token gets input_token from a file descriptor', () => {
    const r = runFb('fb-insights.sh', ['check'])
    expect(r.status, r.stderr).toBe(0)
    expect([r.curlCalls, r.curlArgv.includes(FB_PAGE), r.sedArgv.includes(FB_PAGE)], 'FB-ARGV check').toEqual([1, false, false])
    expect(r.curlArgv).toMatch(/--data-urlencode input_token@\/dev\/fd\/\d+/)
    // the Authorization header and input_token: two reads of the token
    expect(r.curlFd.split(FB_PAGE).length - 1).toBe(2)
  })

  it('FB-ARGV fb-insights.sh raw-user: the user token is scrubbed without riding on sed\'s argv', () => {
    const r = runFb('fb-insights.sh', ['raw-user', 'me'])
    expect(r.status, r.stderr).toBe(0)
    expect([r.curlArgv.includes(FB_USER), r.sedArgv.includes(FB_USER), r.sedArgv.includes(FB_PAGE)], 'FB-ARGV raw-user').toEqual([false, false, false])
    expect(r.curlFd).toContain(`Authorization: Bearer ${FB_USER}`)
  })

  it('FB-ARGV the scrub still hides the token in what the script prints (the shim echoes it back)', () => {
    const insights = runFb('fb-insights.sh', ['check'])
    const list = runFb('fb-schedule-post.sh', ['list'])
    const user = runFb('fb-insights.sh', ['raw-user', 'me'])
    expect([insights.status, list.status, user.status]).toEqual([0, 0, 0])
    expect([insights.stdout.includes('"echo":"<TOKEN>"'), list.stdout.includes('"echo":"<TOKEN>"'), user.stdout.includes('"echo":"<USER_TOKEN>"')],
      'FB-ARGV scrub').toEqual([true, true, true])
    for (const out of [insights.stdout, list.stdout, user.stdout]) expect(out).not.toMatch(new RegExp(`${FB_PAGE}|${FB_USER}`))
  })

  it('FB-ARGV fb-campaign-draft.sh: the scrub takes its sed script from a file descriptor', () => {
    const src = readFileSync(join(REPO, 'scripts', 'fb-campaign-draft.sh'), 'utf8')
    expect(src).toContain(`scrub() { sed -f <(printf 's|%s|<TOKEN>|g\\n' "$TOKEN"); }`)
    for (const f of ['fb-campaign-draft.sh', 'fb-insights.sh', 'fb-schedule-post.sh']) {
      const text = readFileSync(join(REPO, 'scripts', f), 'utf8')
      expect(text, f).not.toMatch(/sed "s\|\$(TOKEN|utok)/)
      expect(text, f).not.toMatch(/(access_token|input_token)=\$TOKEN/)
    }
  })
})

