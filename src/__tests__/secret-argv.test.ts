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
