import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLaunchSettings, trustedLaunchSettings, writeLaunchSettings, type LaunchSettings } from '../web/agent-launch-settings.js'

const src = (rel: string) => readFileSync(join(__dirname, '..', 'web', rel), 'utf-8')
const quiet = { warn: () => {}, error: () => {} }
const seedOf = (s: Partial<LaunchSettings>) => (): LaunchSettings => ({ claudeConfigDir: null, claudePlan: null, ...s })
const UID = process.getuid?.() ?? 0

// The Claude login of an agent (the named plan and the config dir) comes from store/, which no agent can write; the
// agent's own config only seeds it once (task launch-settings-store, kanban 47bf704b).
describe('the trusted launch settings', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-settings-'))
    path = join(dir, 'agent-launch-settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('seeds an agent from its config once, writes the file 0600, and then ignores what the config says', () => {
    const first = trustedLaunchSettings('a', seedOf({ claudeConfigDir: '~/.claude-alt', claudePlan: 'team-1' }), path, quiet)
    expect(first).toEqual({ claudeConfigDir: '~/.claude-alt', claudePlan: 'team-1' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // the agent writes its own config: another login, another plan
    const later = trustedLaunchSettings('a', seedOf({ claudeConfigDir: '/home/evil/cfg', claudePlan: 'evil-plan' }), path, quiet)
    expect(later).toEqual({ claudeConfigDir: '~/.claude-alt', claudePlan: 'team-1' })
  })

  it('an agent with no login of its own is seeded with none, and a value written later does not give it one', () => {
    expect(trustedLaunchSettings('b', seedOf({}), path, quiet)).toEqual({ claudeConfigDir: null, claudePlan: null })
    expect(trustedLaunchSettings('b', seedOf({ claudeConfigDir: '/tmp/x', claudePlan: 'p' }), path, quiet)).toEqual({ claudeConfigDir: null, claudePlan: null })
  })

  it('a dashboard write changes the record, keeps the other key, and clears with null', () => {
    trustedLaunchSettings('a', seedOf({ claudeConfigDir: '/opt/c', claudePlan: 'p1' }), path, quiet)
    expect(writeLaunchSettings('a', { claudePlan: 'p2' }, seedOf({}), path, quiet)).toBe(true)
    expect(trustedLaunchSettings('a', seedOf({}), path, quiet)).toEqual({ claudeConfigDir: '/opt/c', claudePlan: 'p2' })
    writeLaunchSettings('a', { claudePlan: null }, seedOf({}), path, quiet)
    expect(trustedLaunchSettings('a', seedOf({ claudePlan: 'x' }), path, quiet)).toEqual({ claudeConfigDir: '/opt/c', claudePlan: null })
  })

  it('a dashboard write for an agent with no entry fills the rest from the seed', () => {
    writeLaunchSettings('c', { claudePlan: 'p' }, seedOf({ claudeConfigDir: '/opt/d' }), path, quiet)
    expect(trustedLaunchSettings('c', seedOf({}), path, quiet)).toEqual({ claudeConfigDir: '/opt/d', claudePlan: 'p' })
  })

  it('an agent called like an object property is an agent like any other', () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(trustedLaunchSettings(n, seedOf({ claudePlan: `plan-${n}` }), path, quiet).claudePlan, n).toBe(`plan-${n}`)
    }
  })

  it('a deleted agent loses its entry, so a new agent of the same name is seeded again', () => {
    trustedLaunchSettings('a', seedOf({ claudePlan: 'old' }), path, quiet)
    removeLaunchSettings('a', path, quiet)
    expect(trustedLaunchSettings('a', seedOf({ claudePlan: 'new' }), path, quiet).claudePlan).toBe('new')
  })

  it('when the seed cannot be written the seed is not used: the default login, and the next read tries again', () => {
    const unwritable = join(dir, 'no-such-dir', 'agent-launch-settings.json')
    const evil = seedOf({ claudePlan: 'evil', claudeConfigDir: '/x' })
    expect(trustedLaunchSettings('a', evil, unwritable, quiet)).toEqual({ claudeConfigDir: null, claudePlan: null })
    expect(trustedLaunchSettings('a', evil, unwritable, quiet)).toEqual({ claudeConfigDir: null, claudePlan: null })
  })

  describe('a file that cannot be trusted answers the default login and is left as it is', () => {
    const DEFAULT: LaunchSettings = { claudeConfigDir: null, claudePlan: null }
    const good = JSON.stringify({ agents: { a: { claudePlan: 'team-1' } } })
    // what an agent would write into its own config: a fall back to the seed would show it (nautilus on #322)
    const EVIL = seedOf({ claudePlan: 'evil', claudeConfigDir: '/x' })

    it('damaged: not JSON, the wrong shape', () => {
      for (const content of ['not json', '[]', '{"agents": []}', '{"agents": "x"}', '{}']) {
        writeFileSync(path, content)
        chmodSync(path, 0o600)
        expect(trustedLaunchSettings('a', seedOf({ claudePlan: 'evil' }), path, quiet), content).toEqual(DEFAULT)
        expect(readFileSync(path, 'utf-8')).toBe(content)
        expect(writeLaunchSettings('a', { claudePlan: 'x' }, seedOf({}), path, quiet)).toBe(false)
        expect(readFileSync(path, 'utf-8')).toBe(content)
      }
    })

    it('writable by the group or by others (an agent in the fleet group could have written it)', () => {
      for (const mode of [0o664, 0o660, 0o666, 0o646]) {
        writeFileSync(path, good)
        chmodSync(path, mode)
        expect(trustedLaunchSettings('a', EVIL, path, quiet), mode.toString(8)).toEqual(DEFAULT)
      }
    })

    it('a symbolic link', () => {
      const real = join(dir, 'real.json')
      writeFileSync(real, good)
      chmodSync(real, 0o600)
      symlinkSync(real, path)
      expect(trustedLaunchSettings('a', EVIL, path, quiet)).toEqual(DEFAULT)
    })

    it('the same content in a file of ours is read: the faults above are the file\'s, not the content\'s', () => {
      writeFileSync(path, good)
      chmodSync(path, 0o600)
      expect(trustedLaunchSettings('a', seedOf({}), path, quiet).claudePlan).toBe('team-1')
      expect(UID).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('the launch path reads the record, not the agent\'s own config', () => {
  const cfg = src('agent-config.ts')

  it('the two readers go through the trusted record', () => {
    expect(cfg).toMatch(/export function readAgentClaudeConfigDir[\s\S]{0,400}trustedLaunchSettings\(/)
    expect(cfg).toMatch(/export function readAgentClaudePlan[\s\S]{0,300}trustedLaunchSettings\(/)
  })

  it('the plan reader no longer parses the agent\'s config, and the config dir reader no longer calls the config-file resolver', () => {
    const plan = cfg.slice(cfg.indexOf('export function readAgentClaudePlan'), cfg.indexOf('export function writeAgentClaudePlan'))
    expect(plan).not.toContain('agent-config.json')
    const dirReader = cfg.slice(cfg.indexOf('export function readAgentClaudeConfigDir'), cfg.indexOf('function configLaunchSeed'))
    expect(dirReader).not.toContain('agent-config.json')
  })

  it('the plan write records first, leaves the config alone when it cannot, and the PUT says so', () => {
    const w = cfg.slice(cfg.indexOf('export function writeAgentClaudePlan'))
    expect(w.indexOf('if (!writeLaunchSettings(')).toBeGreaterThan(-1)
    expect(w.indexOf('return false')).toBeGreaterThan(w.indexOf('if (!writeLaunchSettings('))
    expect(w.indexOf('atomicWriteFileSync')).toBeGreaterThan(w.indexOf('return false'))
    expect(src('routes/agents.ts')).toMatch(/if \(!writeAgentClaudePlan\(name, planId\)\) \{[\s\S]{0,400}500/)
  })

  it('the plan PUT updates the record, the measurement reads it, and a deleted agent loses its entry', () => {
    expect(cfg).toContain('writeLaunchSettings(name, { claudePlan: trimmed || null }')
    expect(src('routes/measurements.ts')).toMatch(/claudeConfigDir: readAgentClaudeConfigDir\(n\), claudePlan: readAgentClaudePlan\(n\)/)
    expect(src('routes/agents.ts')).toContain('removeLaunchSettings(name)')
  })
})
