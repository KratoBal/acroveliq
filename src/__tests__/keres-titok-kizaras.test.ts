import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
  keres.sh never reads a secret (B28, 2026-10-16): on 2026-10-14 a search from
  the fleet root read 56 secret files, and a match prints the line, value and
  all. Built on a synthetic tree: no real secret is read. What turns these red:
  a store/ dotfile, a tokens/ file, a store/ file that is not world-readable or
  sits in a directory that is not, or a .env file reaching the search, whether
  walked, named on the command line or reached through a symlink; and on the
  other side (the control), an ordinary file in or out of store/ no longer
  found.
*/

const MARK = 'kizaraspróba'
const script = join(process.cwd(), 'scripts', 'keres.sh')
let root: string

const put = (rel: string, mode = 0o644) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `elotte ${MARK} utana\n`)
  chmodSync(p, mode)
  return p
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'keres-titok-'))
  put('jegyzet.md')
  put('store/discord-szalak.md')
  put('store/szabaly-tortenet/eset.md')
  put('store/.fake-token', 0o600)
  put('store/.olvashato-dot', 0o644)
  put('store/tokens/acrobot.token', 0o644)
  put('store/vault.json', 0o600)
  put('store/secret-hashes.txt', 0o640)
  put('store/zart/belul.md', 0o644)
  chmodSync(join(root, 'store', 'zart'), 0o700)
  put('.env', 0o644)
  put('agents/x/.env.mentes', 0o644)
  symlinkSync(join(root, 'store', '.fake-token'), join(root, 'link.txt'))
})

afterAll(() => {
  chmodSync(join(root, 'store', 'zart'), 0o755)
  rmSync(root, { recursive: true, force: true })
})

const keres = (...paths: string[]) => execFileSync('bash', [script, 'KIZARASPROBA', ...paths], { encoding: 'utf8' })
const hits = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.includes(MARK))
    .map((l) => l.split(':')[0]!.slice(root.length + 1))
    .sort()

describe('keres.sh secret exclusion', () => {
  it('a walk over the whole tree finds the ordinary files and none of the secrets', () => {
    const out = keres(root)
    expect(hits(out)).toEqual(['jegyzet.md', 'store/discord-szalak.md', 'store/szabaly-tortenet/eset.md'])
    expect(out).toMatch(/TALALAT: 3 .*, 9 titok-helyen kizarva\)/)
  })

  it.each([
    'store/.fake-token',
    'store/.olvashato-dot',
    'store/tokens/acrobot.token',
    'store/vault.json',
    'store/secret-hashes.txt',
    '.env',
    'agents/x/.env.mentes',
    'link.txt',
  ])('%s named on the command line is not read', (rel) => {
    const out = keres(join(root, rel))
    expect(hits(out)).toEqual([])
    expect(out).toContain(`KIZARVA (titok-hely, nem olvasom): ${join(root, rel)}`)
    expect(out).toContain('TALALAT: 0 ')
  })

  it('an ordinary store/ file named on the command line is still read (the control)', () => {
    expect(hits(keres(join(root, 'store', 'discord-szalak.md')))).toEqual(['store/discord-szalak.md'])
  })
})
