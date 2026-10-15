// The trusted record of each agent's security profile, team role and trust graph (barracuda's
// measured finding, 2026-10-15, acrobot 31248; the trust graph and the closed failure modes from
// barracuda's #192 review, acrobot 31290).
//
// Until now the router took all of these from agents/<name>/agent-config.json, and an agent can
// WRITE its own config (rw-rw-r--+ marveen:fleet with an ACL; `test -w` true as barracuda):
//   - one line (`"securityProfile": "developer-senior"`, or `"team": {"role": "leader"}`, which
//     resolves to the applier pool) raised the agent at its next start to a permissive profile,
//     launched with --dangerously-skip-permissions;
//   - one line in the team fields (`"trustFrom": ["barracuda"]`) made the agent's messages arrive
//     at barracuda as <trusted-peer> instead of <untrusted>, without a restart and without
//     barracuda's consent, because the trust rule is symmetric (team-trust.ts).
// A prompt injection in the agent's shell could do either.
//
// So the launch, the scaffold and the message router read these from here:
// store/agent-profiles.json, written only by the dashboard (the process runs as marveen, the file
// is 0600; an agent runs as its own agent-* user and can neither read nor write it). The same idea
// as the B45 B2-2 run identity: the trusted value comes from something the agent does not control.
//
// The config's fields stay, for display and as a comparison: when they differ from the record, the
// record is used and a WARN line names the difference.
//
// THE THREE STATES OF THE FILE ARE THREE DIFFERENT CASES, and only the first one may seed:
//   - missing (the first read after this change): each agent is seeded once, on its first read;
//   - damaged (unparseable, the wrong shape, or unreadable): set aside as <file>.damaged-<epoch>,
//     never overwritten, and this read answers LOCKED (strict, member, no trust). The next read finds
//     the file missing and seeds again, through the same gate;
//   - not writable while seeding: LOCKED, loudly. The config never wins in any of these.
//
// THE SEED NEVER RAISES. A permissive profile or the leader role in the config is not copied: the
// seed writes LOCKED with a WARN, and only an explicit dashboard write gives the higher record. The
// trust graph is always seeded empty (on 2026-10-15 every agent's four team fields were null,
// acrobot measured it); a relation comes only from the dashboard's team write.
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

export type TeamRole = 'leader' | 'member'

export interface TrustedProfile {
  /** the explicit profile id set through the dashboard (create or PUT /security) */
  profile: string
  /** the team role set through the dashboard; a leader resolves to the applier pool */
  role: TeamRole
}

export interface TrustedTrust {
  reportsTo: string | null
  delegatesTo: string[]
  trustFrom: string[]
}

export type TrustedRecord = TrustedProfile & TrustedTrust

/** The strict profile the closed failure modes use (profiles.ts: no template file can redefine it). */
export const LOCKED_PROFILE_ID = 'locked'

export const LOCKED_RECORD: TrustedRecord = Object.freeze({
  profile: LOCKED_PROFILE_ID,
  role: 'member',
  reportsTo: null,
  delegatesTo: [],
  trustFrom: [],
}) as TrustedRecord

const NO_TRUST: TrustedTrust = { reportsTo: null, delegatesTo: [], trustFrom: [] }

interface Store {
  agents: Record<string, TrustedRecord>
}

type Loaded =
  | { state: 'ok'; store: Store }
  | { state: 'missing'; store: Store }
  | { state: 'damaged'; reason: string }

export interface StoreLog {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

const defaultLog: StoreLog = {
  warn: (o, m) => logger.warn(o, m),
  error: (o, m) => logger.error(o, m),
}

/** AGENT_PROFILE_STORE overrides the place (tests). */
export function agentProfileStorePath(): string {
  return process.env.AGENT_PROFILE_STORE || join(STORE_DIR, 'agent-profiles.json')
}

function loadStore(path: string): Loaded {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', store: { agents: {} } }
    return { state: 'damaged', reason: (err as NodeJS.ErrnoException).code || 'unreadable' }
  }
  try {
    const d = JSON.parse(text) as Partial<Store>
    if (d && typeof d.agents === 'object' && d.agents !== null && !Array.isArray(d.agents)) {
      return { state: 'ok', store: { agents: d.agents } }
    }
    return { state: 'damaged', reason: 'wrong shape' }
  } catch {
    return { state: 'damaged', reason: 'not JSON' }
  }
}

/** Moves a damaged file aside (never overwrites it), so the next read starts from "missing". */
function setAside(path: string, reason: string, log: StoreLog): void {
  const aside = `${path}.damaged-${Date.now()}`
  try {
    renameSync(path, aside)
    log.error({ path, aside, reason }, 'agent profile store damaged: set aside; this read is locked, the next one re-seeds through the gate')
  } catch (err) {
    log.error({ path, reason, err }, 'agent profile store damaged and could not be set aside: every agent stays locked')
  }
}

function writeStore(path: string, store: Store): void {
  atomicWriteFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []

const clean = (t: Partial<TrustedRecord> | undefined): TrustedRecord | null =>
  t && typeof t.profile === 'string' && t.profile.trim()
    ? {
        profile: t.profile.trim(),
        role: t.role === 'leader' ? 'leader' : 'member',
        reportsTo: typeof t.reportsTo === 'string' && t.reportsTo.trim() ? t.reportsTo.trim() : null,
        delegatesTo: names(t.delegatesTo),
        trustFrom: names(t.trustFrom),
      }
    : null

const hasTrust = (t: TrustedTrust): boolean =>
  t.reportsTo !== null || t.delegatesTo.length > 0 || t.trustFrom.length > 0

const sameRecord = (a: TrustedRecord, b: TrustedRecord): boolean =>
  JSON.stringify([a.profile, a.role, a.reportsTo, a.delegatesTo, a.trustFrom]) ===
  JSON.stringify([b.profile, b.role, b.reportsTo, b.delegatesTo, b.trustFrom])

/**
 * What a missing record is seeded with: the config's profile only when it is not elevated (a strict
 * profile, the member role), else LOCKED; the trust graph always empty. `isElevated` comes from the
 * caller (agent-team.ts), which knows how a profile resolves.
 */
export function gatedSeed(
  fromConfig: Partial<TrustedRecord>,
  isElevated: (t: TrustedProfile) => boolean,
): { record: TrustedRecord; dropped: string[] } {
  const c = clean({ profile: 'default', ...fromConfig }) ?? { ...LOCKED_RECORD }
  const dropped: string[] = []
  let record: TrustedRecord = { ...c, ...NO_TRUST }
  if (hasTrust(c)) dropped.push('trust graph')
  if (isElevated({ profile: c.profile, role: c.role })) {
    dropped.push(c.role === 'leader' ? 'leader role' : `permissive profile ${c.profile}`)
    record = { ...LOCKED_RECORD }
  }
  return { record, dropped }
}

export function readTrustedRecord(name: string, path = agentProfileStorePath()): TrustedRecord | null {
  const loaded = loadStore(path)
  return loaded.state === 'damaged' ? null : clean(loaded.store.agents[name])
}

/**
 * Records a change made through the dashboard (create, PUT /security, the team write). `seed` fills
 * the fields this write does not carry when the agent has no record yet; the caller passes a gated
 * seed, never the raw config. A damaged file is set aside first, never overwritten.
 */
export function writeTrustedRecord(
  name: string,
  patch: Partial<TrustedRecord>,
  seed: TrustedRecord,
  path = agentProfileStorePath(),
  log: StoreLog = defaultLog,
): void {
  const loaded = loadStore(path)
  let store: Store = { agents: {} }
  if (loaded.state === 'damaged') setAside(path, loaded.reason, log)
  else store = loaded.store
  const base = clean(store.agents[name]) ?? seed
  store.agents[name] = clean({ ...base, ...patch }) ?? base
  writeStore(path, store)
}

/**
 * Drops an agent's record when the agent is deleted. Without this a later agent created under the
 * same name inherited the deleted one's profile, possibly a higher one.
 */
export function removeTrustedRecord(name: string, path = agentProfileStorePath(), log: StoreLog = defaultLog): void {
  const loaded = loadStore(path)
  if (loaded.state === 'damaged') { setAside(path, loaded.reason, log); return }
  if (!(name in loaded.store.agents)) return
  delete loaded.store.agents[name]
  writeStore(path, loaded.store)
}

/**
 * The record the launch, the scaffold and the router use. `fromConfig` is what the agent's own
 * config says: only the input of a gated seed (once, with a WARN) and the comparison behind a WARN,
 * never an override. Every failure answers LOCKED, never the config.
 */
export function trustedRecordFor(
  name: string,
  fromConfig: Partial<TrustedRecord>,
  isElevated: (t: TrustedProfile) => boolean,
  path = agentProfileStorePath(),
  log: StoreLog = defaultLog,
): TrustedRecord {
  const loaded = loadStore(path)
  if (loaded.state === 'damaged') {
    setAside(path, loaded.reason, log)
    return { ...LOCKED_RECORD }
  }
  const store = loaded.store
  const trusted = clean(store.agents[name])
  if (!trusted) {
    const { record, dropped } = gatedSeed(fromConfig, isElevated)
    try {
      store.agents[name] = record
      writeStore(path, store)
    } catch (err) {
      log.error({ name, err }, 'agent profile store not writable while seeding: the agent is locked')
      return { ...LOCKED_RECORD }
    }
    log.warn({ name, profile: record.profile, role: record.role }, 'agent security record seeded (first read): verify it')
    if (dropped.length) {
      log.warn({ name, dropped }, 'agent-config.json asked for more than a seed may give; set it through the dashboard')
    }
    return record
  }
  const config = clean({ profile: 'default', ...fromConfig })
  if (config && !sameRecord(config, trusted)) {
    log.warn({ name, trusted, config }, 'agent-config.json differs from the trusted security record; the trusted one is used')
  }
  return trusted
}
