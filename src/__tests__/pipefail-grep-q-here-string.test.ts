// PIPEFAIL-GREP-Q (barracuda on #400, 59672; acrobot 59675; the #395 and #253 family): under `set -o pipefail`,
// `printf "$x" | grep -q PATTERN` can turn a MATCH into a failure. grep -q exits at its first match; a writer still
// holding more than the 64 KB pipe buffer then dies of SIGPIPE (141), the pipeline is non-zero, and the `if` takes the
// no-match branch. In fleet-bootstrap.sh that branch is "no unrestricted sudo rule": a false pass. A here-string
// (`grep -q PATTERN <<< "$x"`) has no writer to kill.
// WHAT TURNS THIS RED: any tracked .sh file that sets pipefail and pipes printf or echo into grep -q (comment lines
// aside); and, as the premise, the old form NOT failing on a big input in this bash (then the guard guards nothing).
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
// a path prefix too (pipefail-korai-olvaso-20261123): agent-msg.sh's `| /bin/grep -qF` stood outside the first scan
const PIPE_TO_GREP_Q = /(printf|echo)[^|]*\|\s*(?:\/(?:usr\/)?bin\/)?grep\s+-[A-Za-z]*q/

/** Every non-comment line of a tracked .sh file with pipefail that pipes printf/echo into grep -q, as file:line. */
function offenders(): string[] {
  const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean)
  const out: string[] = []
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf-8')
    if (!src.includes('pipefail')) continue
    src.split('\n').forEach((line, i) => {
      if (!/^\s*#/.test(line) && PIPE_TO_GREP_Q.test(line)) out.push(`${f}:${i + 1}`)
    })
  }
  return out
}

describe('pipefail: no printf/echo piped into grep -q, a here-string instead', () => {
  it('the premise: on a big input that matches on its first line, the piped form fails and the here-string passes', () => {
    const script = `set -o pipefail
x="$(printf 'MATCH\\n'; head -c 400000 /dev/zero | tr '\\0' 'a')"
if printf '%s\\n' "$x" | grep -q MATCH; then echo pipe=match; else echo pipe=miss; fi
if grep -q MATCH <<< "$x"; then echo here=match; else echo here=miss; fi`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' })
    expect(r.stdout, r.stderr).toContain('here=match')
    expect(r.stdout, r.stderr).toContain('pipe=miss')
  })

  it('no tracked .sh file with pipefail still uses the piped form', () => {
    const found = offenders()
    expect(found, `use grep -q PATTERN <<< "$x" at: ${found.join(', ')}`).toEqual([])
  })

  it('the scan sees the tree: it reads the files the fix touched (a zero from an empty file list is no proof)', () => {
    const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf-8' })
    for (const f of ['scripts/fleet-bootstrap.sh', 'scripts/eles-napi-felhozas.sh', 'scripts/tetlen-or.sh']) {
      expect(files).toContain(f)
      expect(readFileSync(join(ROOT, f), 'utf-8')).toMatch(/grep -[A-Za-z]*q [^\n]*<<< "\$/)
    }
  })
})
