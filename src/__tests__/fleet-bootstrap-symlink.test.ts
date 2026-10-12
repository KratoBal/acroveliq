import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// barracuda, marveen #24 v3 review: step 2c runs as ROOT on paths the router user owns
// (logs/, logs/acropora, store/secret-hashes.txt). install/chgrp/chmod follow a symlink, so
// a link from logs/ to /etc/sudoers.d would hand a root chmod 2770 to that directory.
// The step must refuse a link before touching it, and leave the link target unchanged.
// --dry-run is enough to prove it: the refusal runs in dry mode too, and in dry mode no
// other step changes anything.

const SCRIPT = resolve(__dirname, '../../scripts/fleet-bootstrap.sh')

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-root-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'store'))
  const foreign = mkdtempSync(join(tmpdir(), 'foreign-'))
  return { root, foreign }
}

function run(root: string) {
  return spawnSync('bash', [SCRIPT, '--dry-run'], {
    env: { ...process.env, FLEET_ROOT: root },
    encoding: 'utf8',
  })
}

describe('fleet-bootstrap step 2c refuses symlinks', () => {
  it('stops when logs/ is a link to a foreign directory, and leaves the target alone', () => {
    const { root, foreign } = fakeRoot()
    const before = statSync(foreign).mode
    symlinkSync(foreign, join(root, 'logs'))
    const r = run(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/logs is a symlink/)
    expect(statSync(foreign).mode).toBe(before)
  })

  it('stops when the secret-hash list is a link', () => {
    const { root, foreign } = fakeRoot()
    mkdirSync(join(root, 'logs', 'acropora'), { recursive: true })
    const target = join(foreign, 'shadow')
    writeFileSync(target, 'x')
    symlinkSync(target, join(root, 'store', 'secret-hashes.txt'))
    const r = run(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/secret-hashes\.txt is a symlink/)
  })

  it('passes step 2c when nothing is a link', () => {
    const { root } = fakeRoot()
    const r = run(root)
    expect(r.stdout).toMatch(/== 2c\./)
    expect(r.stderr).not.toMatch(/is a symlink/)
  })
})
