// The trusted record of each agent's Claude login settings: the named plan and the raw config dir (kanban 47bf704b, task
// launch-settings-store; acrobot 38622, after barracuda's finding on #321, 2026-10-30).
//
// Until now both came from agents/<name>/agent-config.json, and an agent can WRITE its own config (rw-rw-r--+
// marveen:fleet with an ACL; `test -w` true as the agent, measured by barracuda). `claudeConfigDir` becomes the
// CLAUDE_CONFIG_DIR of the launch (credentials, plugins, a user-level settings.json with its own allow rules) and
// `claudePlan` names a bundle of the same: an agent that could write either could start itself on another login or another
// user-level configuration. The security profile had the same lesson on 2026-10-15 (agent-profile-store.ts), and the
// permission switch on 2026-10-30 (agent-permission-overrides.ts): the trusted value comes from store/, which no agent can
// write.
//
// store/agent-launch-settings.json, {"agents": {"<name>": {"claudeConfigDir": "...", "claudePlan": "..."}}}, written only
// by the dashboard process (the plan PUT writes it too). An agent with no entry is seeded ONCE, on its first read, from
// its config at that moment (the baseline; an agent that wrote a value before this change shipped has it baked in:
// the host can pre-create the file with the intended values to prevent that). From then on the agent's own
// config is not looked at for these two keys: a line written there has no effect.
//
// THE FILE'S STATES:
//   - missing: each agent is seeded on its first read, and the file is created (when it cannot be written, the seed is not
//     used either: the agent reads the default login until it can);
//   - damaged (unparseable or the wrong shape) or not trusted (a link, not ours, writable by group or others): never
//     overwritten, and every agent reads "no config dir, no plan" (Claude Code's default login), loudly. Fail closed:
//     the agents come up on the default login, none on a value a stranger wrote.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { untrustedReason } from './agent-permission-overrides.js'

export interface LaunchSettings {
  /** the raw per-agent config dir as written ('~' forms allowed); validated where it is used (agent-config.ts) */
  claudeConfigDir: string | null
  /** the named plan id (claude-plans.ts) */
  claudePlan: string | null
}

export const NO_LAUNCH_SETTINGS: LaunchSettings = Object.freeze({ claudeConfigDir: null, claudePlan: null }) as LaunchSettings

interface Store {
  agents: Record<string, Partial<LaunchSettings>>
}

type Loaded =
  | { state: 'ok'; store: Store }
  | { state: 'missing'; store: Store }
  | { state: 'unusable'; reason: string }

export interface StoreLog {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

const defaultLog: StoreLog = {
  warn: (o, m) => logger.warn(o, m),
  error: (o, m) => logger.error(o, m),
}

/**
 * AGENT_LAUNCH_SETTINGS overrides the place (tests). It moves the file in production too, as AGENT_PROFILE_STORE does: the
 * variable belongs to the server's own environment, which no agent writes, and the file it names must pass the same trust
 * check, so an agent cannot put a file of its own there.
 */
export function agentLaunchSettingsPath(): string {
  return process.env.AGENT_LAUNCH_SETTINGS || join(STORE_DIR, 'agent-launch-settings.json')
}

function load(path: string, uid: number | undefined = process.getuid?.()): Loaded {
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', store: { agents: Object.create(null) } }
    return { state: 'unusable', reason: (err as NodeJS.ErrnoException).code || 'unreadable' }
  }
  const why = untrustedReason(st, uid)
  if (why) return { state: 'unusable', reason: `not trusted: ${why}` }
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return { state: 'unusable', reason: 'not JSON' }
  }
  const agents = (data as { agents?: unknown } | null)?.agents
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return { state: 'unusable', reason: 'wrong shape' }
  // own keys only, into a prototype-less map: an agent called "constructor" is an agent, not Object.prototype
  const map: Record<string, Partial<LaunchSettings>> = Object.create(null)
  for (const [name, v] of Object.entries(agents as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) map[name] = v as Partial<LaunchSettings>
  }
  return { state: 'ok', store: { agents: map } }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

const clean = (e: Partial<LaunchSettings> | undefined): LaunchSettings => ({ claudeConfigDir: text(e?.claudeConfigDir), claudePlan: text(e?.claudePlan) })

function write(path: string, store: Store): void {
  atomicWriteFileSync(path, JSON.stringify({ agents: store.agents }, null, 2) + '\n', { mode: 0o600 })
}

/**
 * The agent's trusted settings. An agent with no entry is seeded from `seed()` (its config, read by the caller) once;
 * an unusable file answers "no settings" and is left as it is.
 */
export function trustedLaunchSettings(
  name: string,
  seed: () => LaunchSettings,
  path = agentLaunchSettingsPath(),
  log: StoreLog = defaultLog,
): LaunchSettings {
  const loaded = load(path)
  if (loaded.state === 'unusable') {
    log.error({ path, reason: loaded.reason }, 'agent launch settings store unusable: every agent reads the default login')
    return { ...NO_LAUNCH_SETTINGS }
  }
  const entry = loaded.store.agents[name]
  if (entry) return clean(entry)
  const seeded = clean(seed())
  loaded.store.agents[name] = seeded
  try {
    write(path, loaded.store)
    log.warn({ name, claudeConfigDir: seeded.claudeConfigDir, claudePlan: seeded.claudePlan }, 'agent launch settings seeded once from the agent config')
  } catch (err) {
    // not writable: the seed is NOT used. Answering it would make the agent's own config live on every read for as long as the
    // write fails (nautilus on #322); the default login is the closed answer, and the next read tries to seed again
    log.error({ path, name, err }, 'agent launch settings store not writable while seeding: the default login is used')
    return { ...NO_LAUNCH_SETTINGS }
  }
  return seeded
}

/**
 * A change made through the dashboard (the plan PUT). `seed` fills what this write does not carry when the agent has no
 * entry yet. An unusable file is not overwritten: the change stays in the config only and has no effect until the file is fixed.
 */
export function writeLaunchSettings(
  name: string,
  patch: Partial<LaunchSettings>,
  seed: () => LaunchSettings,
  path = agentLaunchSettingsPath(),
  log: StoreLog = defaultLog,
): boolean {
  const loaded = load(path)
  if (loaded.state === 'unusable') {
    log.error({ path, reason: loaded.reason, name }, 'agent launch settings store unusable: the change was not recorded')
    return false
  }
  const base = loaded.store.agents[name] ? clean(loaded.store.agents[name]) : clean(seed())
  loaded.store.agents[name] = { ...base, ...patch }
  write(path, loaded.store)
  return true
}

/** Drops an agent's entry when the agent is deleted: a later agent of the same name must not inherit its login. */
export function removeLaunchSettings(name: string, path = agentLaunchSettingsPath(), log: StoreLog = defaultLog): void {
  const loaded = load(path)
  if (loaded.state !== 'ok' || !loaded.store.agents[name]) return
  delete loaded.store.agents[name]
  try {
    write(path, loaded.store)
  } catch (err) {
    log.error({ path, name, err }, 'agent launch settings entry could not be removed')
  }
}
