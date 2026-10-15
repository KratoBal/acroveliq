// The trusted record of each agent's security profile and team role (barracuda's measured finding,
// 2026-10-15, acrobot 31248).
//
// Until now the router took both from agents/<name>/agent-config.json, and an agent can WRITE its
// own config (rw-rw-r--+ marveen:fleet with an ACL; `test -w` true as barracuda). One line in it
// (`"securityProfile": "developer-senior"`, or `"team": {"role": "leader"}`, which resolves to the
// applier pool) raised the agent at its next start to a permissive profile, launched with
// --dangerously-skip-permissions. A prompt injection in its shell could do the same.
//
// So the launch reads the profile from here: store/agent-profiles.json, written only by the
// dashboard (the process runs as marveen, the file is 0600; an agent runs as its own agent-* user
// and can neither read nor write it). The same idea as the B45 B2-2 run identity: the trusted value
// is measured against something the agent does not control, not taken from its own config.
//
// The config's two fields stay, for display and as a comparison: when they differ from the trusted
// record, the trusted one is used and a WARN line names the difference. An agent with no record yet
// (the first read after this change, or an install that never had one) is seeded ONCE from its
// config, with a WARN line to verify: the values of 2026-10-15 were checked against the fleet's
// expected profiles before this shipped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

export type TeamRole = 'leader' | 'member'

export interface TrustedProfile {
  /** the explicit profile id set through the dashboard (create or PUT /security), 'default' if none */
  profile: string
  /** the team role set through the dashboard; a leader resolves to the applier pool */
  role: TeamRole
}

interface Store {
  agents: Record<string, TrustedProfile>
}

/** AGENT_PROFILE_STORE overrides the place (tests). */
export function agentProfileStorePath(): string {
  return process.env.AGENT_PROFILE_STORE || join(STORE_DIR, 'agent-profiles.json')
}

function readStore(path: string): Store {
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Store>
    if (d && typeof d.agents === 'object' && d.agents !== null) return { agents: d.agents }
  } catch { /* missing or unreadable: an empty store, every agent seeds */ }
  return { agents: {} }
}

function writeStore(path: string, store: Store): void {
  atomicWriteFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

const clean = (t: Partial<TrustedProfile> | undefined): TrustedProfile | null =>
  t && typeof t.profile === 'string' && t.profile.trim()
    ? { profile: t.profile.trim(), role: t.role === 'leader' ? 'leader' : 'member' }
    : null

export function readTrustedProfile(name: string, path = agentProfileStorePath()): TrustedProfile | null {
  return clean(readStore(path).agents[name])
}

/**
 * Records a change made through the dashboard (create, PUT /security, the team write). `seed` fills
 * the fields this write does not carry when the agent has no record yet.
 */
export function writeTrustedProfile(
  name: string,
  patch: Partial<TrustedProfile>,
  seed: TrustedProfile,
  path = agentProfileStorePath(),
): void {
  const store = readStore(path)
  const base = clean(store.agents[name]) ?? seed
  store.agents[name] = { ...base, ...clean({ ...base, ...patch })! }
  writeStore(path, store)
}

/**
 * The profile and role the launch uses. `fromConfig` is what the agent's own config says: used
 * only to seed a missing record (once, with a WARN) and to name a difference (a WARN), never to
 * override the record.
 */
export function trustedProfileFor(
  name: string,
  fromConfig: TrustedProfile,
  path = agentProfileStorePath(),
  warn: (obj: object, msg: string) => void = (o, m) => logger.warn(o, m),
): TrustedProfile {
  const store = readStore(path)
  const trusted = clean(store.agents[name])
  if (!trusted) {
    const seeded = clean(fromConfig) ?? { profile: 'default', role: 'member' }
    try {
      store.agents[name] = seeded
      writeStore(path, store)
      warn({ name, ...seeded }, 'agent security profile seeded from agent-config.json (first read): verify it')
    } catch (err) {
      warn({ name, err }, 'agent security profile store not writable; using agent-config.json for now')
    }
    return seeded
  }
  const config = clean(fromConfig)
  if (config && (config.profile !== trusted.profile || config.role !== trusted.role)) {
    warn({ name, trusted, config }, 'agent-config.json differs from the trusted security profile; the trusted one is used')
  }
  return trusted
}
