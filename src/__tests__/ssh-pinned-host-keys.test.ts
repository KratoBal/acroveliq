// The production and stage machines' host keys are pinned in the repo (Security Baseline,
// task ssh-hostkulcs-rogzites; nautilus's finding: four ssh calls ran with the host-key check
// off, so a fake machine could have handed back a fake version or a fake deployed event).
//
// WHAT TURNS THIS RED:
//   - any script under scripts/, or any source file under src/ (tests excepted), turns the
//     host-key check off or weakens it (outside a comment): StrictHostKeyChecking no, off or
//     accept-new; accept-new trusts the first key a machine offers, so a fake machine met first
//     is pinned instead of the real one (barracuda, #126);
//   - one of the three scripts reaches its machine without the pinned file, without
//     StrictHostKeyChecking=yes, or with the global known_hosts still consulted;
//   - the pinned file loses one of the two machines, holds a key other than ed25519 (the only
//     type with an independent source, acrobot 2026-10-14), or a line that is not a public key;
//   - a call offers other host-key algorithms than ssh-ed25519.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SCRIPTS = join(ROOT, 'scripts')
const SRC = join(ROOT, 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

// A comment line by the file's own syntax: `#` in shell and Python, `//`, `/*` and ` *` in
// JavaScript and TypeScript. One list for both would hide a shell `*) ssh ...` case arm.
const code = (text: string, path = 'x.sh') => {
  const comment = /\.(sh|py)$/.test(path) ? /^\s*#/ : /^\s*(\/\/|\/\*|\*)/
  return text
    .split('\n')
    .filter((line) => !comment.test(line))
    .join('\n')
}

// ssh takes `-o StrictHostKeyChecking=no`, `-oStrictHostKeyChecking=no` and `-o "StrictHostKeyChecking no"`;
// `off` is ssh's synonym for `no`, and `accept-new` pins whatever key a machine offers first.
const WEAK = /StrictHostKeyChecking\s*(=|\s)\s*["']?(no|off|accept-new)\b/i

// the files whose code could run ssh: every script, and src/ without its tests (a test names the
// weak forms on purpose, this one included)
const scanned = () => [
  ...files(SCRIPTS).filter((path) => /\.(sh|py|mjs|cjs|js)$/.test(path)),
  ...files(SRC).filter((path) => /\.(ts|mjs|cjs|js)$/.test(path) && !path.includes(`${join('src', '__tests__')}`)),
]

describe('pinned ssh host keys', () => {
  it('SSH-NO-OFF: no script under scripts/ and no source under src/ turns the host-key check off or to accept-new', () => {
    const all = scanned()
    const offenders = all
      .filter((path) => WEAK.test(code(readFileSync(path, 'utf-8'), path)))
      .map((path) => path.slice(ROOT.length + 1))
    // the scan sees both trees: a guard that looked at nothing would also be empty
    const seen = (tree: string) => all.some((path) => path.startsWith(join(ROOT, tree) + '/'))
    expect([offenders, seen('scripts'), seen('src'), all.some((p) => p.endsWith(join('src', 'web', 'ssh-tmux.ts')))]).toEqual([[], true, true, true])
  })

  it('SSH-NO-OFF-MATCH: the weak forms match in every spelling ssh takes; yes, ask and comments do not', () => {
    const hit = (text: string, path = 'x.sh') => WEAK.test(code(text, path))
    expect([
      hit('ssh -o StrictHostKeyChecking=no host'),
      hit('ssh -oStrictHostKeyChecking=off host'),
      hit('ssh -o "StrictHostKeyChecking accept-new" host'),
      hit("execFileSync('ssh', ['-o', 'StrictHostKeyChecking=accept-new', host])", 'x.ts'),
      hit('SSH_PIN=(-o StrictHostKeyChecking=NO)'),
      hit('  *) ssh -o StrictHostKeyChecking=no "$h" ;;'), // a shell case arm is code, not a comment
      hit('// StrictHostKeyChecking=no', 'x.sh'), // and a shell line starting with // is not a comment either
    ]).toEqual([true, true, true, true, true, true, true])
    expect([
      hit('ssh -o StrictHostKeyChecking=yes host'),
      hit('ssh -o StrictHostKeyChecking=ask host'),
      hit('# StrictHostKeyChecking=no would have taken any machine'),
      hit('  // StrictHostKeyChecking=accept-new trusts the first key', 'x.ts'),
      hit(' * StrictHostKeyChecking=no in a block comment', 'x.ts'),
      hit('ssh -o StrictHostKeyChecking=nope host'),
    ]).toEqual([false, false, false, false, false, false])
  })

  it('SSH-PINNED: the three scripts check against the pinned file only', () => {
    for (const script of ['scripts/eles-verziok.sh', 'scripts/fleet-api.sh', 'scripts/kirakat-telepites.sh']) {
      const text = code(readFileSync(join(ROOT, script), 'utf-8'))
      expect(
        [
          /StrictHostKeyChecking=yes/.test(text),
          /UserKnownHostsFile=\$KNOWN_HOSTS/.test(text),
          /GlobalKnownHostsFile=\/dev\/null/.test(text),
          /HostKeyAlgorithms=ssh-ed25519/.test(text),
          /KNOWN_HOSTS="\$\{FLEET_KNOWN_HOSTS:-\$\(dirname "\$\(readlink -f "\$\{BASH_SOURCE\[0\]\}"\)"\)\/host\/known_hosts\}"/.test(text),
        ],
        script,
      ).toEqual([true, true, true, true, true])
    }
  })

  it('SSH-KNOWN-HOSTS: the pinned file holds both machines, as public keys only', () => {
    const lines = readFileSync(join(SCRIPTS, 'host', 'known_hosts'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
    const hosts = new Set(lines.map((line) => line.split(/\s+/)[0]))
    expect([...hosts].sort()).toEqual(['100.88.199.87', '162.55.216.28'])
    for (const line of lines)
      expect(line, line.slice(0, 40)).toMatch(/^\S+ ssh-ed25519 AAAA[0-9A-Za-z+/]+=*$/)
  })
})
