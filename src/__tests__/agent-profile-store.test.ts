// The trusted security profile (barracuda's finding, acrobot 31248): an agent can write its own
// agent-config.json, and the launch took its profile from there. WHAT TURNS THIS RED:
//   - a config the agent rewrote (a higher profile, or team.role "leader") raising the profile the
//     launch uses, instead of the trusted record winning with a WARN;
//   - a missing record not seeded once (with a WARN to verify), or seeded without being kept;
//   - a dashboard write not landing in the trusted record, or the file not 0600;
//   - resolveAgentSecurityProfile reading the agent's config instead of the record.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTrustedProfile, removeTrustedProfile, trustedProfileFor, writeTrustedProfile, type TrustedProfile } from '../web/agent-profile-store.js'
import { resolveAgentSecurityProfile, resolveSecurityProfileId } from '../web/agent-team.js'

let dir: string
let store: string
let warnings: Array<{ obj: object; msg: string }>
let previous: string | undefined
const warn = (obj: object, msg: string) => { warnings.push({ obj, msg }) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-profiles-'))
  store = join(dir, 'agent-profiles.json')
  warnings = []
  previous = process.env.AGENT_PROFILE_STORE
  process.env.AGENT_PROFILE_STORE = store
})
afterEach(() => {
  // back to the setup file's scratch store, never to the install's real one
  if (previous === undefined) delete process.env.AGENT_PROFILE_STORE
  else process.env.AGENT_PROFILE_STORE = previous
  rmSync(dir, { recursive: true, force: true })
})

const effective = (t: TrustedProfile) => resolveSecurityProfileId(t.profile, { role: t.role })

describe('the trusted security profile', () => {
  it('PROFILE-SEED: a missing record is seeded once from the config, kept 0600, with a WARN to verify', () => {
    const t = trustedProfileFor('murena', { profile: 'developer-senior', role: 'member' }, store, warn)
    const again = trustedProfileFor('murena', { profile: 'developer-senior', role: 'member' }, store, warn)
    expect([t, again, readTrustedProfile('murena', store), (statSync(store).mode & 0o777).toString(8),
      warnings.map((w) => w.msg)], 'PROFILE-SEED').toEqual([
      { profile: 'developer-senior', role: 'member' },
      { profile: 'developer-senior', role: 'member' },
      { profile: 'developer-senior', role: 'member' },
      '600',
      ['agent security profile seeded from agent-config.json (first read): verify it'],
    ])
  })

  it('PROFILE-TAMPER: a config rewritten to a higher profile does not raise it; the record wins, with a WARN', () => {
    writeTrustedProfile('barracuda', { profile: 'reviewer' }, { profile: 'reviewer', role: 'member' }, store)
    const t = trustedProfileFor('barracuda', { profile: 'developer-senior', role: 'member' }, store, warn)
    expect([effective(t), warnings.length, (warnings[0]?.obj as { config?: TrustedProfile }).config?.profile], 'PROFILE-TAMPER')
      .toEqual(['reviewer', 1, 'developer-senior'])
  })

  it('PROFILE-ROLE: team.role "leader" written into the config does not reach the applier pool', () => {
    writeTrustedProfile('korall', { profile: 'default' }, { profile: 'default', role: 'member' }, store)
    const t = trustedProfileFor('korall', { profile: 'default', role: 'leader' }, store, warn)
    expect([effective(t), effective({ profile: 'default', role: 'leader' }), warnings.length], 'PROFILE-ROLE')
      .toEqual(['default', 'applier', 1])
  })

  it('PROFILE-WRITE: a dashboard write lands in the record and keeps the other field', () => {
    writeTrustedProfile('polip', { profile: 'researcher-reader' }, { profile: 'researcher-reader', role: 'member' }, store)
    writeTrustedProfile('polip', { role: 'leader' }, { profile: 'ignored', role: 'member' }, store)
    writeTrustedProfile('polip', { profile: 'researcher' }, { profile: 'ignored', role: 'member' }, store)
    expect(readTrustedProfile('polip', store), 'PROFILE-WRITE').toEqual({ profile: 'researcher', role: 'leader' })
  })

  it('PROFILE-DELETE: a deleted agent leaves no record; a new one under the name seeds from its own config', () => {
    writeTrustedProfile('regi-agens', { profile: 'developer-senior' }, { profile: 'developer-senior', role: 'member' }, store)
    removeTrustedProfile('regi-agens', store)
    const fresh = trustedProfileFor('regi-agens', { profile: 'researcher-reader', role: 'member' }, store, warn)
    expect(fresh, 'PROFILE-DELETE').toEqual({ profile: 'researcher-reader', role: 'member' })
  })

  it('PROFILE-RESOLVE: resolveAgentSecurityProfile takes the record, not the agent config', () => {
    // an agent name with no directory: its config reads as 'default' / member
    writeTrustedProfile('nincs-ilyen-agens-teszt', { profile: 'reviewer' }, { profile: 'reviewer', role: 'member' }, store)
    expect(resolveAgentSecurityProfile('nincs-ilyen-agens-teszt'), 'PROFILE-RESOLVE').toBe('reviewer')
  })

  it('PROFILE-UNREADABLE: a broken store file is an empty store, the agent seeds again (not a crash)', () => {
    writeFileSync(store, '{nem json')
    const t = trustedProfileFor('picasso', { profile: 'designer', role: 'member' }, store, warn)
    expect([t, existsSync(store), JSON.parse(readFileSync(store, 'utf-8')).agents.picasso], 'PROFILE-UNREADABLE')
      .toEqual([{ profile: 'designer', role: 'member' }, true, { profile: 'designer', role: 'member' }])
  })
})
