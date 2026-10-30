import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionFlagFor, resolvePermissionModeOverride } from '../web/agent-config.js'

// The auto-mode trial (kanban c47f5846): one strict agent may launch with --permission-mode auto; nothing else moves.
describe('resolvePermissionModeOverride', () => {
  it('reads only the exact string "auto"', () => {
    expect(resolvePermissionModeOverride('{"permissionModeOverride":"auto"}')).toBe('auto')
  })

  it('ignores everything else: a typo or a stronger mode never loosens anything', () => {
    for (const v of ['"Auto"', '"AUTO"', '" auto"', '"autoo"', '"bypassPermissions"', '"acceptEdits"', '"strict"', '""', 'true', '1', 'null', '["auto"]', '{}']) {
      expect(resolvePermissionModeOverride(`{"permissionModeOverride":${v}}`), v).toBeNull()
    }
  })

  it('is null for a missing field, a missing file ({}) and unparseable or non-object JSON', () => {
    expect(resolvePermissionModeOverride('{"model":"sonnet"}')).toBeNull()
    expect(resolvePermissionModeOverride('{}')).toBeNull()
    expect(resolvePermissionModeOverride('not json')).toBeNull()
    expect(resolvePermissionModeOverride('')).toBeNull()
    expect(resolvePermissionModeOverride('null')).toBeNull()
    expect(resolvePermissionModeOverride('[]')).toBeNull()
    expect(resolvePermissionModeOverride('"auto"')).toBeNull()
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
  const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

  it('takes the flag from permissionFlagFor with the agent\'s own override, nowhere else', () => {
    expect(src).toContain("permissionFlagFor(profile.permissionMode, readAgentPermissionModeOverride(name))")
    expect(src).not.toMatch(/profile\.permissionMode === 'strict' \? '' :/)
  })

  it('the settings (deny list, allow list, hooks) are still written from the profile alone, before the flag is chosen', () => {
    const write = src.indexOf('writeAgentSettingsFromProfile(name, profile)')
    const flag = src.indexOf('permissionFlagFor(profile.permissionMode')
    expect(write).toBeGreaterThan(-1)
    expect(flag).toBeGreaterThan(write)
    // the override is read for the flag and nowhere near the settings: the scaffold never sees it
    const scaffold = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(scaffold).not.toMatch(/permissionModeOverride|readAgentPermissionModeOverride/)
    expect(src.match(/readAgentPermissionModeOverride\(/g)?.length).toBe(1)
  })
})
