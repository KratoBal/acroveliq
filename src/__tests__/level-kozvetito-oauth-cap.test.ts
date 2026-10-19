// The consent container's rights (task level-kozvetito-oauth-cap, 2026-10-19, acrobot 33175 and 33176).
//
// The facts, from the host (acrobot): `titkok/` is root:root 0700; the client id, the client secret and the refresh tokens in it are
// 10003:10003 0400; `titkok-ver/` is 10003:10003 0700; the relay's state volume is 10003:10003 0700. The consent container is uid 0
// with `cap_drop: ALL`. Root without capabilities cannot read a 0400 file of uid 10003 (`open /run/secrets/oauth-client-id: permission
// denied`), and cannot open one for writing or write into a 10003 directory (`open /var/lib/levelkozvetito/oauth-state-balazs`).
//
// The choice, the fewest rights: CAP_DAC_READ_SEARCH (read only) and CAP_CHOWN, NOT CAP_DAC_OVERRIDE. That needs the consent to write
// only where root is the owner: the secrets directory. The `state` goes there, and the token file is replaced by a temp file and a
// rename instead of being opened for writing.
//
// WHAT TURNS THIS RED: the capability list changing (DAC_READ_SEARCH gone: the consent cannot read its own client; DAC_OVERRIDE or
// anything else added: more rights than the reads need); the relay itself getting a capability; the relay's state volume mounted in the
// consent container again; the consent writing its `state` into the state directory again; the token file opened for writing in place;
// the token file handed to uid 10003 AFTER it replaced the target (a window with a root-owned token the relay cannot read); a failed
// replacement leaving a temp file or damaging the old token.
//
// NOT MEASURED HERE: the container itself (no docker for the author). The capability analysis is from capabilities(7); the first
// live consent after this change is the measurement (README, "Consent").
import { chmodSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { replaceTokenFile } from '../level-kozvetito/token-file.js'

const ROOT = process.cwd()
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/** The text of one compose service (from its name line to the next service, top-level key or end). */
function service(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.findIndex((l) => l === `  ${name}:`)
  if (start < 0) throw new Error(`no service ${name}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!) || /^\S/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** The list items under `key:` inside a service block (two spaces deeper than the service). */
function listUnder(block: string, key: string): string[] | null {
  const lines = block.split('\n')
  const at = lines.findIndex((l) => l === `    ${key}:`)
  if (at < 0) return null
  const out: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^ {6}- (\S+)\s*$/.exec(lines[i]!)
    if (!m) break
    out.push(m[1]!)
  }
  return out
}

describe('the compose file: the consent container has the fewest rights that work', () => {
  const compose = stripComments(read('level-kozvetito', 'compose.yaml').replace(/^\s*#.*$/gm, ''))
  const oauth = service(compose, 'oauth')
  const relay = service(compose, 'levelkozvetito')

  it('the consent service is root, drops ALL, and adds exactly CHOWN and DAC_READ_SEARCH (no DAC_OVERRIDE)', () => {
    expect(oauth).toContain('user: "0:0"')
    expect(listUnder(oauth, 'cap_drop')).toEqual(['ALL'])
    expect([...(listUnder(oauth, 'cap_add') ?? [])].sort()).toEqual(['CHOWN', 'DAC_READ_SEARCH'])
    expect(oauth).not.toMatch(/DAC_OVERRIDE|FOWNER|SYS_ADMIN|privileged/i)
    expect(oauth).toContain('no-new-privileges:true')
    expect(oauth).toContain('read_only: true')
  })

  it('the relay itself has no capability to add, runs as 10003 and keeps its root file system read only', () => {
    expect(listUnder(relay, 'cap_add')).toBeNull()
    expect(listUnder(relay, 'cap_drop')).toEqual(['ALL'])
    expect(relay).toContain('user: "10003:10003"')
    expect(relay).toContain('read_only: true')
  })

  it('the consent container does not mount the relay state volume (nothing there is written, and root with read access should not see it)', () => {
    expect(oauth).not.toMatch(/allapot|\/var\/lib\/levelkozvetito\n|target: \/var\/lib\/levelkozvetito$/m)
    expect(oauth).not.toContain('docker.sock')
  })

  it('the secrets directory is mounted writable at /run/secrets and the example settings keep every token file in it', () => {
    const mount = /source: \/opt\/levelkozvetito\/titkok\n\s+target: \/run\/secrets\n/.exec(oauth)
    expect(mount).not.toBeNull()
    expect(oauth.slice(mount!.index, mount!.index + 200).split('\n').slice(0, 3).join('\n')).not.toContain('read_only')
    const cfg = JSON.parse(read('level-kozvetito', 'config.example.json')) as { accounts: Record<string, { refreshTokenFile: string }> }
    const dirs = Object.values(cfg.accounts).map((a) => a.refreshTokenFile.replace(/\/[^/]+$/, ''))
    expect(dirs.length).toBeGreaterThan(0)
    expect(new Set(dirs)).toEqual(new Set(['/run/secrets']))
  })

  it('the layout facts the capability choice rests on are in the README and the Dockerfile', () => {
    const readme = read('level-kozvetito', 'README.md')
    expect(readme).toMatch(/^ {2}titkok\/ +root:root 700$/m)
    expect(readme).toMatch(/^ {2}titkok-ver\/ +10003:10003 700 /m)
    expect(read('level-kozvetito', 'Dockerfile')).toMatch(/chown 10003:10003 \/var\/lib\/levelkozvetito && chmod 700 \/var\/lib\/levelkozvetito/)
  })
})

describe('the consent code writes only where root owns the directory', () => {
  const main = stripComments(read('src', 'level-kozvetito', 'oauth-main.ts'))
  const tokenFile = stripComments(read('src', 'level-kozvetito', 'token-file.ts'))

  it('the state file sits next to the token file, never in the relay state directory', () => {
    expect(main).toContain("const stateFile = join(dirname(target), `oauth-state-${account}`)")
    expect(main).not.toContain('config.stateDir')
  })

  it('the token goes through replaceTokenFile: no write of the target, no chown of it, no write flag on it', () => {
    expect(main).toContain('replaceTokenFile(target, token, uid)')
    expect(main).not.toMatch(/chownSync|flag:\s*'w'|writeFileSync\(target/)
    // the one remaining writeFileSync is the state file
    expect(main.match(/writeFileSync\(/g)).toHaveLength(1)
    expect(main).toContain('writeFileSync(stateFile')
  })

  it('token-file.ts opens only a NEW temp file for writing (wx) and the directory for reading', () => {
    const opens = [...tokenFile.matchAll(/openSync\(([^)]*)\)/g)].map((m) => m[1]!.replace(/\s+/g, ' '))
    expect(opens).toEqual(["temp, 'wx', 0o400", "dir, 'r'"])
    expect(tokenFile).not.toMatch(/writeFileSync|appendFileSync|truncate/)
  })
})

describe('replaceTokenFile', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lvk-token-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const OLD = 'old-refresh-token'
  const NEW = 'new-refresh-token'
  const target = () => join(dir, 'balazs-refresh-token')
  const seed = () => {
    writeFileSync(target(), OLD, { mode: 0o400 })
    chmodSync(target(), 0o400)
  }

  it('POSITIVE CONTROL: the old way (open the existing 0400 file for writing) is refused for a user who is not root', () => {
    seed()
    if (process.getuid?.() === 0) return // root passes the permission check, so the contrast does not exist here
    expect(() => openSync(target(), 'w')).toThrow(/EACCES/)
  })

  it('replaces an existing 0400 file: new value, mode 0400, a new inode, no temp file left', () => {
    seed()
    const before = statSync(target())
    replaceTokenFile(target(), NEW, 10003, { chown: () => {} })
    const after = statSync(target())
    expect([readFileSync(target(), 'utf8'), after.mode & 0o777, after.ino === before.ino, readdirSync(dir)]).toEqual([NEW, 0o400, false, ['balazs-refresh-token']])
  })

  it('creates the file when there is none (the first consent)', () => {
    replaceTokenFile(target(), NEW, 10003, { chown: () => {} })
    expect([readFileSync(target(), 'utf8'), statSync(target()).mode & 0o777, readdirSync(dir)]).toEqual([NEW, 0o400, ['balazs-refresh-token']])
  })

  it('hands the NEW file to the relay user BEFORE it replaces the target (the target still holds the old value at that moment)', () => {
    seed()
    const seen: { path: string; uid: number; gid: number; targetThen: string; tempExists: boolean }[] = []
    replaceTokenFile(target(), NEW, 10003, {
      chown: (path, uid, gid) => seen.push({ path, uid, gid, targetThen: readFileSync(target(), 'utf8'), tempExists: existsSync(path) }),
    })
    expect(seen).toHaveLength(1)
    expect([seen[0]!.uid, seen[0]!.gid, seen[0]!.targetThen, seen[0]!.tempExists, seen[0]!.path === target()]).toEqual([10003, 10003, OLD, true, false])
    expect(seen[0]!.path.startsWith(`${dir}/.balazs-refresh-token.neu-`)).toBe(true)
  })

  it('a failed hand-over leaves the old token untouched and no temp file behind', () => {
    seed()
    expect(() =>
      replaceTokenFile(target(), NEW, 10003, {
        chown: () => {
          throw new Error('EPERM')
        },
      }),
    ).toThrow('EPERM')
    expect([readFileSync(target(), 'utf8'), readdirSync(dir)]).toEqual([OLD, ['balazs-refresh-token']])
  })

  it('the token value is never part of an error', () => {
    seed()
    let message = ''
    try {
      replaceTokenFile(target(), NEW, 10003, {
        chown: () => {
          throw new Error('chown failed')
        },
      })
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message).not.toContain(NEW)
  })
})
