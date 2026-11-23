// PIPEFAIL-KORAI-OLVASO (barracuda on #401, 59680; acrobot 59706): the #401 guard looks for printf/echo into grep -q,
// but the family is wider. Under `set -o pipefail` ANY reader that leaves early (grep -q at its first match, awk at an
// `exit`, as in #395) can kill a writer still holding output, and the pipeline then fails though the reader succeeded.
// Measured 2026-11-23 on the tree: 77 early readers in 137 pipefail scripts. head / grep -m / head -c are value readers:
// their output is right even when the writer dies, and every one of them either drops the status (inside a larger
// string, an assignment without errexit) or absorbs it (`|| true`), so they are counted, not guarded. grep -q has no
// output: its status is all it says, so every piped grep -q is a decision. Two were false passes, now here-strings:
// agent-msg.sh (a body that held a forged send-time line got no warning, 200/200 at 160 KB) and folytonossag.sh (a
// transcript dir looked empty and the next candidate, the main agent's, became the answer: 179/200 at 1000 files;
// ls writes in 4 KB pieces, so it fails far below the 64 KB pipe buffer).
// WHAT TURNS THIS RED: a piped grep -q (any path, any flag cluster) or a piped awk with an `exit` outside END, in a
// tracked .sh with pipefail, that is not on ALLOWED below; an ALLOWED entry that no longer matches its count of lines;
// and the premises (the big input fails piped and passes as a here-string; the allowed small writer never fails).
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const PIPE_TO_GREP_Q = /(?<!\|)\|\s*(?:\/(?:usr\/)?bin\/)?grep\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)\b/
const PIPE_TO_AWK = /(?<!\|)\|\s*awk\b[^']*'([^']*)'/

/** Measured sites that stay piped: the writer's whole output is one small write (it is done before grep can leave),
 *  and a spurious miss stops or repeats an idempotent step instead of letting something through. */
const ALLOWED: { file: string; text: string; n: number; why: string }[] = [
  { file: 'scripts/fleet-bootstrap.sh', text: `| tr ' ' '\\n' | grep -qx`, n: 3, why: 'id -nG: a miss re-runs an idempotent usermod -aG' },
  { file: 'scripts/agent-to-own-user.sh', text: `| tr ' ' '\\n' | grep -qx fleet`, n: 1, why: 'id -nG: a miss is a FAIL exit' },
  { file: 'scripts/agent-to-own-user.sh', text: `2>/dev/null | grep -qx "agent-$AGENT"`, n: 1, why: 'tmux list-sessions, a few names' },
  { file: 'scripts/__tests__/test-voice-install.sh', text: '| grep -q opus', n: 1, why: 'ffprobe: one codec name; a miss fails the test' },
  { file: 'scripts/__tests__/acropora-restore-probe.test.sh', text: '| grep -q', n: 5, why: 'fixture log and jget reasons; a miss fails the check' },
]

/** Non-comment logical lines (backslash and pipe continuations joined) of every tracked .sh file with pipefail. */
function logicalLines(): { file: string; line: number; text: string }[] {
  const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean)
  const out: { file: string; line: number; text: string }[] = []
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf-8')
    if (!src.includes('pipefail')) continue
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const start = i
      let text = lines[i]
      while (i + 1 < lines.length && (/(\\|\|)\s*$/.test(text) || /^\s*\|(?!\|)/.test(lines[i + 1]))) text = text.replace(/\\\s*$/, ' ') + ' ' + lines[++i]
      if (!/^\s*#/.test(text)) out.push({ file, line: start + 1, text })
    }
  }
  return out
}

/** Lines with a piped grep -q, or a piped awk whose program exits outside END. */
function earlyReaders() {
  return logicalLines().filter(({ text }) => {
    if (PIPE_TO_GREP_Q.test(text)) return true
    const awk = PIPE_TO_AWK.exec(text)
    return awk !== null && /\bexit\b/.test(awk[1].replace(/END\s*\{[^}]*\}/g, ''))
  })
}

const run = (script: string) => spawnSync('bash', ['-c', `set -o pipefail\n${script}`], { encoding: 'utf-8' })

describe('pipefail: no early reader on a pipe whose status decides, a here-string instead', () => {
  it('the premise: a big writer into grep -q or an early awk exit fails piped and passes as a here-string', () => {
    const r = run(`x="$(printf 'MATCH\\n'; head -c 400000 /dev/zero | tr '\\0' 'a')"
if { echo MATCH; head -c 400000 /dev/zero; } | grep -q MATCH; then echo grep-pipe=match; else echo grep-pipe=miss; fi
printf '%s\\n' "$x" | awk '/MATCH/ {print; exit}' >/dev/null; echo "awk-pipe=$?"
awk '/MATCH/ {print; exit}' <<< "$x" >/dev/null; echo "awk-here=$?"
if grep -q MATCH <<< "$x"; then echo grep-here=match; else echo grep-here=miss; fi`)
    expect(r.stdout, r.stderr).toContain('grep-pipe=miss')
    expect(r.stdout, r.stderr).toContain('awk-pipe=141')
    expect(r.stdout, r.stderr).toContain('awk-here=0')
    expect(r.stdout, r.stderr).toContain('grep-here=match')
  })

  it('the allow-list premise: a writer whose whole output is one small write never fails (0 of 200)', () => {
    const r = run(`m=0; g="$(id -gn)"; for i in $(seq 200); do id -nG | tr ' ' '\\n' | grep -qx "$g" || m=$((m+1)); done; echo "miss=$m"`)
    expect(r.stdout, r.stderr).toContain('miss=0')
  })

  it('every piped early reader with a deciding status is a measured, allowed site', () => {
    const found = earlyReaders()
    const outside = found.filter((s) => !ALLOWED.some((a) => a.file === s.file && s.text.includes(a.text)))
    expect(outside.map((s) => `${s.file}:${s.line}`), 'use grep -q PATTERN <<< "$x" (or awk ... <<< "$x")').toEqual([])
    for (const a of ALLOWED) {
      const n = found.filter((s) => s.file === a.file && s.text.includes(a.text)).length
      expect(n, `ALLOWED ${a.file} "${a.text}" (${a.why}) matches ${n} lines, not ${a.n}: measure the new or gone site`).toBe(a.n)
    }
  })

  it('the scan sees the tree: it finds the allowed sites and reads the here-strings the fix wrote', () => {
    expect(earlyReaders().length).toBeGreaterThanOrEqual(10)
    expect(readFileSync(join(ROOT, 'scripts/agent-msg.sh'), 'utf-8')).toMatch(/grep -qF -- "--- a kuldes mert ideje:" <<< "\$C"/)
    expect(readFileSync(join(ROOT, 'scripts/folytonossag.sh'), 'utf-8')).toMatch(/grep -q '\\\.jsonl\$' <<< "\$\(\/bin\/ls "\$J"/)
  })
})
