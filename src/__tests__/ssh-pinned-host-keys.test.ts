// The production and stage machines' host keys are pinned in the repo (Security Baseline,
// task ssh-hostkulcs-rogzites; nautilus's finding: four ssh calls ran with the host-key check
// off, so a fake machine could have handed back a fake version or a fake deployed event).
//
// WHAT TURNS THIS RED:
//   - any script under scripts/ turns the host-key check off again (outside a comment);
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

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

describe('pinned ssh host keys', () => {
  it('SSH-NO-OFF: no script under scripts/ turns the host-key check off', () => {
    const offenders = files(SCRIPTS)
      .filter((path) => /\.(sh|py|mjs|js)$/.test(path))
      .filter((path) => /StrictHostKeyChecking\s*=?\s*no\b/i.test(code(readFileSync(path, 'utf-8'))))
      .map((path) => path.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
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
