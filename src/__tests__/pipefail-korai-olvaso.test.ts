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

// ERREXIT (errexit-ertekolvaso-20261123, card 1a69029e; barracuda 59722 on #403): the value readers above are harmless
// when the status is dropped, but under `set -e` the status of `x="$(writer | head -1)"`, or of a plain
// `writer | grep -m 1 x` statement, IS used: a writer killed by SIGPIPE (141), or a grep that found nothing (1), stops
// the script with no word. github-pr-monitor.sh did the second on every PR opened after its baseline, before the
// snapshot was written, so each later run stopped at the same PR. Scope: tracked .sh files with pipefail and errexit,
// heredoc bodies aside (the post-checkout hook that install-prod-tree-guard-hook.sh writes has neither).
// WHAT TURNS THIS RED: such an assignment or plain statement whose pipe ends in head or grep -m, with no `||` after it
// and not under if/while/until/!; and the premise, the silent stop itself, no longer reproducing.
const EARLY_STAGE = /(?<!\|)\|\s*(?:head\b(?!\s+-n\s*-)|(?:\/(?:usr\/)?bin\/)?grep\b[^|]*\s-[A-Za-z]*m\s*\d)/g
const CONDITION_START = /^\s*(?:if|elif|while|until|!|\[\[?|case|for|function)\b|^\s*!|^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\)/

/** Non-comment logical lines of the errexit + pipefail .sh files, heredoc bodies skipped. */
function errexitLines(): { file: string; line: number; text: string }[] {
  const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean)
  const out: { file: string; line: number; text: string }[] = []
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf-8')
    if (!src.includes('pipefail') || !/^\s*set\s+-[A-Za-z]*e|set\s+-o\s+errexit/m.test(src)) continue
    const lines = src.split('\n')
    let heredocEnd: string | null = null
    for (let i = 0; i < lines.length; i++) {
      if (heredocEnd !== null) {
        if (lines[i].trim() === heredocEnd) heredocEnd = null
        continue
      }
      const start = i
      let text = lines[i]
      while (i + 1 < lines.length && (/(\\|\|)\s*$/.test(text) || /^\s*\|(?!\|)/.test(lines[i + 1]))) text = text.replace(/\\\s*$/, ' ') + ' ' + lines[++i]
      if (/^\s*#/.test(text)) continue
      // a heredoc's body is another program's text (here-strings, <<<, are not heredocs)
      const doc = /(?<!<)<<-?(?!<)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(text)
      if (doc) heredocEnd = doc[1]
      out.push({ file, line: start + 1, text })
    }
  }
  return out
}

/** The command-substitution depth ($( ... )) at each index of a line; quotes are not tracked (good enough for a scan). */
function depthAt(text: string, at: number): number {
  let depth = 0
  for (let i = 0; i < at; i++) {
    if (text[i] === '$' && text[i + 1] === '(') { depth++; i++ } else if (text[i] === ')' && depth > 0) depth--
  }
  return depth
}

/** Assignments and plain statements whose status errexit acts on and whose pipe ends in an early value reader. */
function silentStops() {
  return errexitLines().filter(({ text }) => {
    if (CONDITION_START.test(text)) return false
    const stages = [...text.matchAll(EARLY_STAGE)].map((m) => m.index ?? 0)
    if (stages.length === 0) return false
    const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*="?\$\(/.test(text)
    return stages.some((at) => {
      const depth = depthAt(text, at)
      // a plain statement reads at depth 0, an assignment inside its own $( ); a deeper read is inside a string or message
      if (!(depth === 0 || (assignment && depth === 1))) return false
      // an `||` after the reader takes the status (|| true, || fail ...): at the statement's level, or for an
      // assignment also inside its own $( ), where `a | head -1 || true` makes the substitution's status 0
      const rest = text.slice(at)
      return ![...rest.matchAll(/\|\|/g)].some((m) => depthAt(text, at + (m.index ?? 0)) <= depth)
    })
  })
}

describe('pipefail + errexit: no value reader on a pipe whose status stops the script', () => {
  it('the premise: an assignment from a pipe into head stops a set -e script with no word, on SIGPIPE and on no match', () => {
    const r1 = spawnSync('bash', ['-c', `set -euo pipefail
x="$({ echo first; head -c 400000 /dev/zero; } | head -1)"
echo "after x=$x"`], { encoding: 'utf-8' })
    expect(r1.stdout).not.toContain('after')
    expect(r1.status).toBe(141)
    const r2 = spawnSync('bash', ['-c', `set -euo pipefail
old="$(printf '7\\tA\\n' | grep -P '^8\\t' | head -1 | cut -f2-)"
echo "after old=$old"`], { encoding: 'utf-8' })
    expect(r2.stdout).not.toContain('after')
    expect(r2.status).toBe(1)
    const r3 = spawnSync('bash', ['-c', `set -euo pipefail
f=$(mktemp); printf '7\\tA\\n' > "$f"
old="$(awk -F'\\t' -v p=8 '$1 == p { sub(/^[^\\t]*\\t/, ""); print; exit }' "$f")"; rm -f "$f"
echo "after old=[$old]"`], { encoding: 'utf-8' })
    expect(r3.stdout, r3.stderr).toContain('after old=[]')
  })

  it('no errexit .sh file assigns from, or runs as a statement, a pipe ending in head or grep -m', () => {
    const found = silentStops()
    expect(found.map((s) => `${s.file}:${s.line}`), 'read the file directly (awk/grep -m on the file), or end with || ...').toEqual([])
  })

  it('the scan sees the tree: it finds the shapes it is meant to find, and skips the heredoc body', () => {
    const lines = errexitLines()
    expect(lines.length).toBeGreaterThan(1000)
    // the hook body the installer writes is a heredoc: its own `| head -n 1` line must not be read as the installer's
    expect(lines.some((l) => l.file === 'scripts/install-prod-tree-guard-hook.sh' && l.text.includes('prod-tree-guard.conf" 2>/dev/null | head -n 1)"'))).toBe(false)
    expect(lines.some((l) => l.file === 'scripts/install-prod-tree-guard-hook.sh' && l.text.includes('CONF_ID="$(sed -n'))).toBe(true)
    expect(readFileSync(join(ROOT, 'scripts/github-pr-monitor.sh'), 'utf-8')).toMatch(/old="\$\(awk -F'\\t' -v p="\$pr"/)
  })
})
