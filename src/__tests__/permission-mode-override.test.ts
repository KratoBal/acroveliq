import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionFlagFor } from '../web/agent-config.js'
import { parsePermissionOverrides, readPermissionOverrideFrom, untrustedReason } from '../web/agent-permission-overrides.js'

const src = (rel: string) => readFileSync(join(__dirname, '..', 'web', rel), 'utf-8')
const uid = process.getuid?.() ?? 0

// The auto-mode trial (kanban c47f5846, task auto-mode-proba): one strict agent may launch with --permission-mode auto,
// switched on from store/, which no agent can write. Nothing else moves.
describe('parsePermissionOverrides', () => {
  it('lists the agents whose value is exactly "auto"', () => {
    const m = parsePermissionOverrides('{"barracuda":"auto","nautilus":"auto"}')
    expect([...m.keys()].sort()).toEqual(['barracuda', 'nautilus'])
  })

  it('ignores everything else: a typo or a stronger mode never loosens anything', () => {
    for (const v of ['"Auto"', '"AUTO"', '" auto"', '"autoo"', '"bypassPermissions"', '"acceptEdits"', '"strict"', '""', 'true', '1', 'null', '["auto"]', '{}']) {
      expect(parsePermissionOverrides(`{"barracuda":${v}}`).size, v).toBe(0)
    }
  })

  it('is empty for unparseable, empty and non-object content', () => {
    for (const raw of ['', 'not json', 'null', '[]', '"auto"', '42']) expect(parsePermissionOverrides(raw).size, raw).toBe(0)
  })

  it('an object prototype name is not an agent that carries the override', () => {
    const m = parsePermissionOverrides('{"barracuda":"auto"}')
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(m.get(n), n).toBeUndefined()
  })
})

describe('the override file is trusted only as a file the server owns and the agents cannot write', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perm-override-'))
    file = join(dir, 'agent-permission-overrides.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const write = (mode: number) => {
    writeFileSync(file, '{"barracuda":"auto"}')
    chmodSync(file, mode)
  }

  it('a file of ours, 0644 or 0600, lists the agent; an unlisted agent has no override', () => {
    write(0o644)
    expect(readPermissionOverrideFrom(file, 'barracuda', uid)).toBe('auto')
    expect(readPermissionOverrideFrom(file, 'nautilus', uid)).toBeNull()
    write(0o600)
    expect(readPermissionOverrideFrom(file, 'barracuda', uid)).toBe('auto')
  })

  it('a file writable by the group or by others is ignored (an agent in the fleet group could have written it)', () => {
    for (const mode of [0o664, 0o660, 0o666, 0o646]) {
      write(mode)
      expect(readPermissionOverrideFrom(file, 'barracuda', uid), mode.toString(8)).toBeNull()
    }
  })

  it('a file owned by someone else is ignored', () => {
    write(0o644)
    expect(readPermissionOverrideFrom(file, 'barracuda', uid + 1)).toBeNull()
  })

  it('a symbolic link, a directory and a missing file give no override', () => {
    write(0o644)
    const link = join(dir, 'link.json')
    symlinkSync(file, link)
    expect(readPermissionOverrideFrom(link, 'barracuda', uid)).toBeNull()
    const sub = join(dir, 'sub.json')
    mkdirSync(sub)
    expect(readPermissionOverrideFrom(sub, 'barracuda', uid)).toBeNull()
    expect(readPermissionOverrideFrom(join(dir, 'missing.json'), 'barracuda', uid)).toBeNull()
  })

  it('untrustedReason names the first fault, null for a good file', () => {
    const file0 = { isFile: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o100644 }
    expect(untrustedReason(file0, 1000)).toBeNull()
    expect(untrustedReason({ ...file0, mode: 0o100664 }, 1000)).toMatch(/group or others/)
    expect(untrustedReason({ ...file0, uid: 1001 }, 1000)).toMatch(/owned by uid 1001/)
    expect(untrustedReason({ ...file0, isFile: () => false }, 1000)).toMatch(/regular file/)
    expect(untrustedReason({ ...file0, isSymbolicLink: () => true }, 1000)).toMatch(/link/)
  })
})

describe('the agent\'s own, agent-writable config is not a source', () => {
  it('the reader names no agent-config.json, and the config module has no reader of the override', () => {
    expect(src('agent-permission-overrides.ts')).not.toContain('agent-config.json')
    expect(src('agent-config.ts')).not.toMatch(/permissionModeOverride/)
  })

  it('a "permissionModeOverride" line in an agent-config.json changes nothing: the only reader is the store file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-override-cfg-'))
    try {
      writeFileSync(join(dir, 'agent-config.json'), '{"permissionModeOverride":"auto"}')
      // the reader is given the store file's path, and the agent's config lies beside it: no store file, no override
      expect(readPermissionOverrideFrom(join(dir, 'agent-permission-overrides.json'), 'barracuda', uid)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('permissionFlagFor', () => {
  it('a strict profile with no override launches with no flag, as before', () => {
    expect(permissionFlagFor('strict', null)).toBe('')
  })

  it('a strict profile with the override gets --permission-mode auto, and only that', () => {
    expect(permissionFlagFor('strict', 'auto')).toBe('--permission-mode auto ')
  })

  it('a permissive profile keeps --dangerously-skip-permissions, override or not', () => {
    expect(permissionFlagFor('permissive', null)).toBe('--dangerously-skip-permissions ')
    expect(permissionFlagFor('permissive', 'auto')).toBe('--dangerously-skip-permissions ')
    expect(permissionFlagFor('bypassPermissions', 'auto')).toBe('--dangerously-skip-permissions ')
  })
})

describe('the launch command', () => {
  const proc = src('agent-process.ts')

  it('takes the flag from permissionFlagFor with the host file\'s override, nowhere else', () => {
    expect(proc).toContain('permissionFlagFor(profile.permissionMode, readAgentPermissionModeOverride(name))')
    expect(proc).not.toMatch(/profile\.permissionMode === 'strict' \? '' :/)
    expect(proc).toContain("from './agent-permission-overrides.js'")
  })

  it('the settings (deny list, allow list, hooks) are still written from the profile alone, before the flag is chosen', () => {
    const write = proc.indexOf('writeAgentSettingsFromProfile(name, profile)')
    const flag = proc.indexOf('permissionFlagFor(profile.permissionMode')
    expect(write).toBeGreaterThan(-1)
    expect(flag).toBeGreaterThan(write)
    // the override is read for the flag and nowhere near the settings: the scaffold never sees it
    expect(src('agent-scaffold.ts')).not.toMatch(/permissionModeOverride|readAgentPermissionModeOverride|agent-permission-overrides/)
    expect(proc.match(/readAgentPermissionModeOverride\(/g)?.length).toBe(1)
  })
})
