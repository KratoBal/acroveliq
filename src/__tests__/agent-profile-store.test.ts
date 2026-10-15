// The trusted security record (barracuda's finding, acrobot 31248; the trust graph and the closed
// failure modes from barracuda's #192 review). WHAT TURNS THIS RED:
//   - a config the agent rewrote (a higher profile, team.role "leader", or a trust relation) raising
//     what the launch or the router uses, instead of the record winning with a WARN;
//   - an agent writing trustFrom into its OWN config and becoming another agent's trusted peer;
//   - a seed copying a permissive profile, the leader role or a trust relation from the config;
//   - a damaged store answering anything but LOCKED, being overwritten instead of set aside, or a
//     store that cannot be written while seeding answering the config;
//   - the 'locked' profile not strict, or redefinable through the permissive 'default' fallback;
//   - a dashboard write not landing in the record, the file not 0600, a deleted agent's record kept.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, existsSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  LOCKED_RECORD,
  readTrustedRecord,
  removeTrustedRecord,
  trustedRecordFor,
  writeTrustedRecord,
  type StoreLog,
  type TrustedRecord,
} from '../web/agent-profile-store.js'
import {
  isElevatedProfile,
  readAgentTeam,
  resolveAgentSecurityProfile,
  resolveSecurityProfileId,
  writeAgentTeam,
} from '../web/agent-team.js'
import { isTrustedPeer } from '../team-trust.js'
import { writeAgentSecurityProfile } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'

let dir: string
let store: string
let warnings: string[]
let errors: string[]
let previous: string | undefined
const log: StoreLog = {
  warn: (_o, m) => { warnings.push(m) },
  error: (_o, m) => { errors.push(m) },
}
const created: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-profiles-'))
  store = join(dir, 'agent-profiles.json')
  warnings = []
  errors = []
  previous = process.env.AGENT_PROFILE_STORE
  process.env.AGENT_PROFILE_STORE = store
})
afterEach(() => {
  // back to the setup file's scratch store, never to the install's real one
  if (previous === undefined) delete process.env.AGENT_PROFILE_STORE
  else process.env.AGENT_PROFILE_STORE = previous
  try { chmodSync(dir, 0o700) } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })
  for (const name of created.splice(0)) rmSync(join(PROJECT_ROOT, 'agents', name), { recursive: true, force: true })
})

const rec = (r: Partial<TrustedRecord>): TrustedRecord => ({ ...LOCKED_RECORD, ...r })
const forConfig = (name: string, config: Partial<TrustedRecord>) =>
  trustedRecordFor(name, config, isElevatedProfile, store, log)
const effective = (t: TrustedRecord) => resolveSecurityProfileId(t.profile, { role: t.role })

/** an agent directory with the given (agent-writable) config, removed after the test */
function agentWithConfig(name: string, config: object): void {
  const d = join(PROJECT_ROOT, 'agents', name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'agent-config.json'), JSON.stringify(config))
  created.push(name)
}

describe('the trusted security record', () => {
  it('PROFILE-SEED: a strict member profile in the config is seeded once, kept 0600, with a WARN to verify', () => {
    const t = forConfig('polip', { profile: 'researcher-reader', role: 'member' })
    const again = forConfig('polip', { profile: 'researcher-reader', role: 'member' })
    expect([t, again, readTrustedRecord('polip', store), (statSync(store).mode & 0o777).toString(8), warnings], 'PROFILE-SEED')
      .toEqual([
        rec({ profile: 'researcher-reader' }),
        rec({ profile: 'researcher-reader' }),
        rec({ profile: 'researcher-reader' }),
        '600',
        ['agent security record seeded (first read): verify it'],
      ])
  })

  it('SEED-GATE: a permissive profile, the leader role or a trust relation in the config is not seeded', () => {
    const senior = forConfig('murena', { profile: 'developer-senior', role: 'member' })
    const leader = forConfig('korall', { profile: 'marketer', role: 'leader' })
    const trusting = forConfig('picasso', { profile: 'designer', role: 'member', trustFrom: ['barracuda'], reportsTo: 'barracuda' })
    const dflt = forConfig('uj-agens', {})
    expect([senior, leader, trusting, dflt], 'SEED-GATE values').toEqual([
      LOCKED_RECORD, LOCKED_RECORD, rec({ profile: 'designer' }), LOCKED_RECORD,
    ])
    expect(warnings.filter((w) => w.startsWith('agent-config.json asked')).length, 'SEED-GATE warnings').toBe(4)
  })

  it('PROFILE-TAMPER: a config rewritten to a higher profile does not raise it; the record wins, with a WARN', () => {
    writeTrustedRecord('barracuda', { profile: 'reviewer' }, LOCKED_RECORD, store, log)
    const t = forConfig('barracuda', { profile: 'developer-senior', role: 'member' })
    expect([effective(t), warnings], 'PROFILE-TAMPER')
      .toEqual(['reviewer', ['agent-config.json differs from the trusted security record; the trusted one is used']])
  })

  it('PROFILE-ROLE: team.role "leader" written into the config does not reach the applier pool', () => {
    writeTrustedRecord('korall', { profile: 'marketer' }, LOCKED_RECORD, store, log)
    const t = forConfig('korall', { profile: 'marketer', role: 'leader' })
    expect([effective(t), effective(rec({ profile: 'default', role: 'leader' }))], 'PROFILE-ROLE').toEqual(['marketer', 'applier'])
  })

  it('TRUST-TAMPER: an agent writing trustFrom (or delegatesTo, reportsTo) into its own config is nobody\'s trusted peer', () => {
    agentWithConfig('trust-teszt-kuldo', { securityProfile: 'researcher', team: { role: 'member', reportsTo: 'trust-teszt-cimzett', delegatesTo: ['trust-teszt-cimzett'], trustFrom: ['trust-teszt-cimzett'] } })
    agentWithConfig('trust-teszt-cimzett', { securityProfile: 'reviewer' })
    const ctx = { mainAgentId: 'nincs-ilyen-fo-agens', isKnownAgent: () => true, readAgentTeam }
    const before = [isTrustedPeer('trust-teszt-kuldo', 'trust-teszt-cimzett', ctx), isTrustedPeer('trust-teszt-cimzett', 'trust-teszt-kuldo', ctx)]
    // the dashboard's team write is the one way to a relation
    writeAgentTeam('trust-teszt-cimzett', { ...readAgentTeam('trust-teszt-cimzett'), trustFrom: ['trust-teszt-kuldo'] })
    const after = isTrustedPeer('trust-teszt-kuldo', 'trust-teszt-cimzett', ctx)
    expect([before, readAgentTeam('trust-teszt-kuldo').trustFrom, after], 'TRUST-TAMPER').toEqual([[false, false], [], true])
  })

  it('PROFILE-WRITE: a dashboard write lands in the record and keeps the other fields', () => {
    writeTrustedRecord('polip', { profile: 'researcher-reader' }, LOCKED_RECORD, store, log)
    writeTrustedRecord('polip', { role: 'leader', trustFrom: ['murena'] }, LOCKED_RECORD, store, log)
    writeTrustedRecord('polip', { profile: 'researcher' }, LOCKED_RECORD, store, log)
    expect(readTrustedRecord('polip', store), 'PROFILE-WRITE').toEqual(rec({ profile: 'researcher', role: 'leader', trustFrom: ['murena'] }))
  })

  it('PROFILE-DELETE: a deleted agent leaves no record; a new one under the name seeds through the gate', () => {
    writeTrustedRecord('regi-agens', { profile: 'developer-senior' }, LOCKED_RECORD, store, log)
    removeTrustedRecord('regi-agens', store, log)
    expect(forConfig('regi-agens', { profile: 'researcher', role: 'member' }), 'PROFILE-DELETE').toEqual(rec({ profile: 'researcher' }))
  })

  it('PROFILE-RESOLVE: resolveAgentSecurityProfile takes the record, not the agent config', () => {
    agentWithConfig('profil-teszt-agens', { securityProfile: 'developer-senior', team: { role: 'leader' } })
    writeTrustedRecord('profil-teszt-agens', { profile: 'reviewer' }, LOCKED_RECORD)
    expect(resolveAgentSecurityProfile('profil-teszt-agens'), 'PROFILE-RESOLVE').toBe('reviewer')
  })

  it('DASHBOARD-SEED: a dashboard profile write on a new agent takes neither the role nor the trust graph from the config', () => {
    agentWithConfig('dash-teszt-agens', { securityProfile: 'researcher', team: { role: 'leader', trustFrom: ['barracuda'] } })
    writeAgentSecurityProfile('dash-teszt-agens', 'reviewer')
    expect(readTrustedRecord('dash-teszt-agens'), 'DASHBOARD-SEED').toEqual(rec({ profile: 'reviewer' }))
  })

  it('STORE-DAMAGED: a broken file answers LOCKED, is set aside (not overwritten), and the next read seeds through the gate', () => {
    writeFileSync(store, '{nem json')
    const first = forConfig('picasso', { profile: 'designer', role: 'member' })
    const aside = readdirSync(dir).filter((f) => f.startsWith('agent-profiles.json.damaged-'))
    const second = forConfig('murena', { profile: 'developer-senior', role: 'member' })
    expect([first, existsSync(store) && JSON.parse(readFileSync(store, 'utf-8')).agents.picasso, aside.length,
      readFileSync(join(dir, aside[0]), 'utf-8'), second, errors.length], 'STORE-DAMAGED')
      .toEqual([LOCKED_RECORD, undefined, 1, '{nem json', LOCKED_RECORD, 1])
  })

  it('STORE-DAMAGED-WRITE: a dashboard write on a broken file sets it aside first, the other records are not rebuilt from configs', () => {
    writeFileSync(store, JSON.stringify({ agents: [] }))
    writeTrustedRecord('barracuda', { profile: 'reviewer' }, LOCKED_RECORD, store, log)
    expect([Object.keys(JSON.parse(readFileSync(store, 'utf-8')).agents), readdirSync(dir).filter((f) => f.includes('.damaged-')).length],
      'STORE-DAMAGED-WRITE').toEqual([['barracuda'], 1])
  })

  it('STORE-UNWRITABLE: a store that cannot be written while seeding answers LOCKED, not the config', () => {
    chmodSync(dir, 0o500)
    const t = forConfig('polip', { profile: 'researcher-reader', role: 'member' })
    chmodSync(dir, 0o700)
    // root writes anyway: then the seed went through, and this case says nothing
    if (existsSync(store)) return
    expect([t, errors], 'STORE-UNWRITABLE').toEqual([LOCKED_RECORD, ['agent profile store not writable while seeding: the agent is locked']])
  })

  it('LOCKED-PROFILE: strict, and not the permissive default fallback', () => {
    const p = loadProfileTemplate('locked')
    expect([p.id, p.permissionMode, isElevatedProfile({ profile: 'locked', role: 'member' }), isElevatedProfile({ profile: 'default', role: 'member' })],
      'LOCKED-PROFILE').toEqual(['locked', 'strict', false, true])
  })
})
