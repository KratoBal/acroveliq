import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, DEFAULT_AGENT_MODEL } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { LOCKED_RECORD, writeTrustedRecord } from './agent-profile-store.js'
import { safeJoin } from './sanitize.js'
import { isValidModelId, InvalidModelIdError } from '../model-id.js'
import {
  resolveAgentModelFromConfig,
  validateModelProfileMap,
  type AgentModelConfig,
  type ModelProfileMapState,
  type ModelResolution,
} from '../model-profiles.js'

export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')

// Install-wide default (DEFAULT_AGENT_MODEL: config-overrides.json > .env >
// distribution default). Re-exported under the historical name so the many
// call sites -- and the 'inherit' alias below -- keep working unchanged.
export const DEFAULT_MODEL = DEFAULT_AGENT_MODEL

// Map short model names to full Claude model IDs (backwards compat with old configs)
export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-5[1m]',
  'sonnet': 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet5': 'claude-sonnet-5',
  'opus-5': 'claude-opus-5',
  'opus5': 'claude-opus-5',
  'haiku': 'claude-haiku-4-5-20251001',
  'inherit': DEFAULT_MODEL,
}

export function agentDir(name: string): string {
  // safeJoin rejects path-traversal components. The first line of defense is
  // still sanitizeAgentName() at the create-endpoint, but going through
  // safeJoin turns every non-whitelisted `name` (e.g. a buggy internal caller
  // that forgot to sanitize) into an explicit throw instead of silently
  // writing outside AGENTS_BASE_DIR.
  return safeJoin(AGENTS_BASE_DIR, name)
}

export function agentConfigRoot(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return agentDir(name)
}

export function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function extractDescriptionFromClaudeMd(content: string): string {
  // Try to grab first meaningful paragraph after any heading
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return lines[0]?.trim().slice(0, 200) || ''
}

export function findAvatarForAgent(name: string): string | null {
  const dir = agentDir(name)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(dir, `avatar${ext}`)
    if (existsSync(p)) return p
  }
  return null
}

export function resolveModelId(raw: string): string {
  return MODEL_ALIASES[raw] || raw
}

// ---- model-profile map (deployment-local, card c755f4b2 Block B) -------------
//
// store/ is gitignored, so the concrete profile -> model mapping never leaves
// the machine. config-examples/model-profile-map.example.json documents the
// shape. A missing map is FINE: every agent that names a concrete `model`
// keeps working untouched, which is every agent today.
const MODEL_PROFILE_MAP_PATH = join(PROJECT_ROOT, 'store', 'model-profile-map.json')

let cachedProfileMap: { state: ModelProfileMapState; mtimeMs: number } | null = null

export function readModelProfileMap(): ModelProfileMapState | null {
  try {
    if (!existsSync(MODEL_PROFILE_MAP_PATH)) return null
    const mtimeMs = statSync(MODEL_PROFILE_MAP_PATH).mtimeMs
    if (cachedProfileMap && cachedProfileMap.mtimeMs === mtimeMs) return cachedProfileMap.state
    let state: ModelProfileMapState
    try {
      state = validateModelProfileMap(JSON.parse(readFileSync(MODEL_PROFILE_MAP_PATH, 'utf-8')))
    } catch {
      state = { ok: false, error: 'profile_map_unparseable' }
    }
    cachedProfileMap = { state, mtimeMs }
    return state
  } catch {
    return { ok: false, error: 'profile_map_read_error' }
  }
}

export function invalidateModelProfileMapCache(): void {
  cachedProfileMap = null
}

// Full resolution result, for callers that need to show or log WHY an agent is
// on a given model (the /api/agents payload, the profile canary).
export function resolveAgentModelDetailed(name: string): ModelResolution {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: AgentModelConfig
  try {
    config = JSON.parse(readFileOr(configPath, '{}')) as AgentModelConfig
  } catch {
    return { model: DEFAULT_MODEL, source: 'default' }
  }
  return resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)
}

// Unchanged contract: the concrete model id this agent runs on. For every
// config that names a `model` -- which is all of them today -- this returns
// byte-identically what it returned before Block B existed.
export function readAgentModel(name: string): string {
  return resolveAgentModelDetailed(name).model
}

// Card c755f4b2 Block B. Passing null REMOVES the key rather than writing a
// null: an absent field and an explicit null must not become two ways of
// saying the same thing in a config a human also edits by hand.
export function writeAgentModelProfile(name: string, profile: string | null): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch { /* start fresh */ }
  if (profile === null) delete config.modelProfile
  else config.modelProfile = profile
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentModel(name: string, model: string): void {
  if (!isValidModelId(model)) throw new InvalidModelIdError(model)
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.model = model
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentDisplayName(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = typeof config.displayName === 'string' ? config.displayName.trim() : ''
    if (raw) return raw
  } catch { /* fall through */ }
  // Fall back to a title-cased version of the sanitized name.
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function writeAgentDisplayName(name: string, displayName: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.displayName = displayName
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentSecurityProfile(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.securityProfile === 'string' && config.securityProfile.trim()) {
      return config.securityProfile.trim()
    }
  } catch { /* fall through */ }
  return 'default'
}

// Pure-logic resolver for the optional per-agent claudeConfigDir field.
// Takes the raw agent-config.json text (or `{}` when no file exists) plus an
// explicit home-dir, and returns the absolute path to use as
// CLAUDE_CONFIG_DIR, or null when the field is missing/blank/non-string or
// the JSON is unparseable. Tilde forms are expanded against the supplied
// homeDir. Kept dependency-free so it can be unit-tested without the fs.
//
// Allowed character set for the path: alphanumerics, dot, slash, hyphen,
// underscore, tilde. Anything else is rejected.
//
// This is a whitelist rather than a blacklist for a reason. The launcher
// inlines the path into a tmux command via nested template literals, which
// produces a shell string with both an outer and an inner double-quoted
// region. Bash treats the inner `"` as a quote delimiter, not a literal,
// so the path actually lands partly inside and partly outside double-quote
// context. Inside double quotes most metachars are tame; outside, almost
// anything (parens, single quote, spaces, semicolons, &, |) is shell-
// significant. Enumerating "safe outside double quotes" by blacklist is a
// trap -- a whitelist of characters that survive both layers is far
// shorter to write and more robust to future changes in the launcher.
//
// Local config is only writable by the host operator, so this is defense-
// in-depth rather than a hard security boundary, but it cheaply removes
// the trivial way to break the launcher with a config typo.
//
// Path values containing `..` segments are also rejected. Without this
// guard `path.join` would silently collapse them ("~/../../../etc/passwd"
// resolves to "/etc/passwd"), which is almost never what the operator
// meant. Absolute paths without `..` remain accepted, so legitimate non-
// home locations like "/var/lib/claude-coding" still work.
const CLAUDE_CONFIG_DIR_ALLOWED = /^[A-Za-z0-9_./~-]+$/

// Only `..` segments are rejected, not `.` (current dir) or empty segments
// from doubled slashes (`//`). Both of those are no-ops -- the OS and
// `path.join` normalize them away without changing where the path points.
// `..` is the only segment that meaningfully alters the destination, so
// it's the only one we treat as suspicious.
function hasParentTraversal(raw: string): boolean {
  return raw.split('/').some(segment => segment === '..')
}

// Expand + validate a raw config-dir string (already extracted from wherever
// it was stored) against the launcher's shell-safety rules. Shared by the
// per-agent `claudeConfigDir` resolver and the named-plan registry
// (claude-plans.ts) so both feed the tmux launcher through the exact same
// whitelist/traversal/tilde gauntlet -- there is only one place that decides
// what is safe to inline into the launch command. Returns the absolute path,
// or null when the value is blank/malformed/unsafe.
export function expandAndValidateConfigDir(
  rawValue: string,
  homeDir: string,
): string | null {
  const raw = rawValue.trim()
  if (!raw) return null
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(raw)) return null
  if (hasParentTraversal(raw)) return null
  // Tilde may appear at most once, and only as the bare `~` or as the
  // leading `~/` of a `~/...` form. `~user`, mid-string `~`, double tildes
  // -- all rejected because the runtime shell would re-expand them at
  // assignment time even though our resolver does not, and we do not want
  // the launcher to silently route an agent to a different user's home
  // directory or to a path the operator did not write.
  if (raw.includes('~')) {
    const tildeCount = raw.split('~').length - 1
    const validForm = raw === '~' || raw.startsWith('~/')
    if (!validForm || tildeCount > 1) return null
  }
  let resolved: string
  if (raw === '~') resolved = homeDir
  else if (raw.startsWith('~/')) resolved = join(homeDir, raw.slice(2))
  else resolved = raw
  // Re-validate after expansion: if `homeDir` itself contains a character
  // outside the whitelist (e.g. a space in a multi-word account name), the
  // resolved path would land in unquoted shell context and break the
  // launcher cmd. Reject rather than ship a broken export.
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(resolved)) return null
  return resolved
}

export function resolveClaudeConfigDir(
  rawConfigJson: string,
  homeDir: string,
): string | null {
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return null }
  if (!config || typeof config !== 'object') return null
  const value = (config as Record<string, unknown>).claudeConfigDir
  if (typeof value !== 'string') return null
  return expandAndValidateConfigDir(value, homeDir)
}

// Optional per-agent override for the Claude Code config directory. When set,
// the launcher injects CLAUDE_CONFIG_DIR into the tmux command, letting that
// agent use a different login (credentials, plugins, sessions) than the host
// default. When null, no env var is injected and Claude Code uses its built-in
// default location (`~/.claude/` on macOS/Linux).
export function readAgentClaudeConfigDir(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  return resolveClaudeConfigDir(readFileOr(configPath, '{}'), homedir())
}

// --- Remote agent config (remoteHost + remoteWorkdir) ---
//
// When BOTH a valid host and a valid absolute workdir are present, the agent's
// tmux session runs on a remote machine over ssh instead of locally. Validation
// mirrors resolveClaudeConfigDir's whitelist-not-blacklist philosophy: the host
// is passed as a raw ssh-destination argv element (never shell-interpolated), so
// the charset is defense-in-depth, but the workdir IS inlined into the remote
// launch command (shQuoted), so it is validated strictly too.

// ssh alias or user@host. NO ':' -- `ssh host:port` is not valid syntax; the
// port belongs in the ~/.ssh/config `Port` directive.
const REMOTE_HOST_ALLOWED = /^[A-Za-z0-9_.@-]+$/
// Absolute path only. Tilde is rejected: a `~/proj` workdir would encode to
// `~-proj` for the --continue probe but Claude Code stores the tilde-EXPANDED
// path as `-home-user-proj`, so the probe would never match and --continue would
// be silently dropped. Requiring an absolute path makes the encoding
// deterministic.
const REMOTE_WORKDIR_ALLOWED = /^\/[A-Za-z0-9_./@+-]*$/

export interface RemoteAgentConfig {
  host: string | null
  workdir: string | null
}

// Pure resolver: takes the raw agent-config.json text and returns the remote
// {host, workdir}. An agent is "remote" only when BOTH validate; a
// half-configured agent (host set but workdir invalid, or vice-versa) is
// treated as local (both null) so it never launches into an undefined dir.
export function resolveRemoteConfig(rawConfigJson: string): RemoteAgentConfig {
  const NONE: RemoteAgentConfig = { host: null, workdir: null }
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return NONE }
  if (!config || typeof config !== 'object') return NONE
  const rawHost = (config as Record<string, unknown>).remoteHost
  const rawWorkdir = (config as Record<string, unknown>).remoteWorkdir
  if (typeof rawHost !== 'string' || typeof rawWorkdir !== 'string') return NONE
  const host = rawHost.trim()
  const workdir = rawWorkdir.trim()
  if (!host || !workdir) return NONE
  if (!REMOTE_HOST_ALLOWED.test(host)) return NONE
  if (!REMOTE_WORKDIR_ALLOWED.test(workdir)) return NONE
  if (hasParentTraversal(workdir)) return NONE
  return { host, workdir }
}

// B45 follow-up (b77e2688, Security Baseline 2026-10-13): the remote host is an
// ssh destination the ROUTER connects to, with the router's own key, from every
// panel and lifecycle path (send-keys, capture, stop, restart, start). It used to
// come from agent-config.json, which lives in the agent's own tree: the agent owns
// that directory and the fleet group can write the file. An agent could therefore
// point the router's ssh at any host it chose. The host now comes from a registry
// the router owns (store/, not writable by any agent), written only by
// writeAgentRemoteConfig (PUT /api/agents/:name/remote). A remoteHost or
// remoteWorkdir left in agent-config.json has no effect any more.
//
// Shape: { "<agent>": { "remoteHost": "...", "remoteWorkdir": "..." } }, each entry
// validated exactly like the old config keys (resolveRemoteConfig).
let remoteHostsFile = join(STORE_DIR, 'agent-remote-hosts.json')

export function setAgentRemoteHostsFileForTests(path: string): void {
  remoteHostsFile = path
}

function parseRemoteRegistry(rawRegistryJson: string): Record<string, unknown> {
  let reg: unknown
  try { reg = JSON.parse(rawRegistryJson) } catch { return {} }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return {}
  return reg as Record<string, unknown>
}

// Pure resolver over the registry text. Own keys only: a name like "constructor"
// must not resolve through the prototype.
export function resolveRemoteRegistryEntry(rawRegistryJson: string, name: string): RemoteAgentConfig {
  const reg = parseRemoteRegistry(rawRegistryJson)
  if (!Object.prototype.hasOwnProperty.call(reg, name)) return { host: null, workdir: null }
  const entry = reg[name]
  if (!entry || typeof entry !== 'object') return { host: null, workdir: null }
  return resolveRemoteConfig(JSON.stringify(entry))
}

export function readAgentRemoteConfig(name: string): RemoteAgentConfig {
  return resolveRemoteRegistryEntry(readFileOr(remoteHostsFile, '{}'), name)
}

// A remoteHost still standing in the agent's own config: ignored, reported so an
// install that configured a remote agent the old way sees why it now runs locally.
export function agentConfigHasIgnoredRemoteHost(name: string): boolean {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const cfg = JSON.parse(readFileOr(configPath, '{}')) as Record<string, unknown>
    return !!cfg && typeof cfg.remoteHost === 'string' && cfg.remoteHost.trim() !== ''
  } catch { return false }
}

// Convenience for the many callers that only need the host to decide whether a
// session is remote. Returns null for local agents.
export function readAgentRemoteHost(name: string): string | null {
  return readAgentRemoteConfig(name).host
}

// A POSIX-ish account name. Deliberately narrow: this value is passed to
// `sudo -u`, so anything outside [a-z0-9_-] (and a leading letter/underscore)
// is rejected rather than escaped. 32 chars is the useradd limit.
const RUN_AS_USER_ALLOWED = /^[a-z_][a-z0-9_-]{0,31}$/

// Pure resolver: which OS user this agent's tmux server belongs to, or null when
// the agent shares the router's own user (today's default for every agent).
//
// Why this exists: tmux refuses a cross-user connection even when the socket
// permissions allow it (measured 2026-08-19: "access not allowed"), so reaching
// an agent that runs under its own uid means running tmux AS that user. The
// value is only ever used with `sudo -n -u <user> tmux ...`, backed by a
// per-agent sudoers rule that grants that one binary and nothing else.
export function resolveRunAsUser(rawConfigJson: string): string | null {
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return null }
  if (!config || typeof config !== 'object') return null
  const raw = (config as Record<string, unknown>).runAsUser
  if (typeof raw !== 'string') return null
  const user = raw.trim()
  if (!user || !RUN_AS_USER_ALLOWED.test(user)) return null
  return user
}

export function readAgentRunAsUser(name: string): string | null {
  return runAsUserForPanel(name, readAgentConfiguredRunAsUser(name))
}

// The configured value, UNFILTERED. The router's own writes into an agent's tree (B45
// B2-6: is this .claude.json written through the private group?) decide from this, not
// from the panel's filtered value: an agent that writes another user into its own
// config must not turn its tree's writes back into plain, fleet-readable ones. The two
// questions differ: "which tmux server do I talk to" may fall back to the router's,
// "is this a per-user tree" must not fall back to "no" (rebase of #57 onto #54).
export function readAgentConfiguredRunAsUser(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  return resolveRunAsUser(readFileOr(configPath, '{}'))
}

// B45 B2-2 follow-up (barracuda, review of #45): the START is checked against the
// OS (checkAgentRunIdentity), but every other tmux call of the panel (key input,
// pane capture, stop) still took runAsUser from the agent-writable config at call
// time. Only the agent's OWN user (agent-<name>) is honoured there now; another
// agent's user, the router or root resolves to null, i.e. the router's own tmux
// server, where a per-user agent has no session.
export function runAsUserForPanel(name: string, configured: string | null): string | null {
  return configured === agentOsUserName(name) ? configured : null
}

// B45 B2-2 (Security Baseline, 2026-10-13): the run identity is checked against
// the OS, not taken from the agent's own config. agent-config.json lives in the
// agent's own directory, and the agent OWNS that directory, so it can always
// replace the file. Two values used to be honoured from it:
//   - an empty / missing runAsUser -> the router started the agent as ITSELF
//     (marveen: every store/ secret), ssh-tmux.ts buildTmuxInvocation;
//   - another agent's user ("agent-murena" in barracuda's config) -> started via
//     `sudo -n -u agent-murena`, with murena's groups (GitHub, Expo).
// A remoteHost has the same effect for an agent that has its own OS user: the
// router would launch it over ssh with its own key, outside the agent's uid.
// Rule: if the OS user `agent-<name>` exists, runAsUser must be exactly that and
// no remote host may be set; if it does not exist, runAsUser must be absent.
// Anything else refuses the start (fail closed) instead of picking a fallback.
export function agentOsUserName(name: string): string {
  return `agent-${name}`
}

// The checked identity: on ok, the user the agent RUNS AS (its own OS user, or null =
// the router's user). The start uses this value and does not read the config again:
// between the check and the launch the whole provisioning runs, and the config is in
// the agent's own, agent-writable tree (barracuda, review of #57). Re-reading it there
// would let a changed config pick the launch user after the check. The same holds for
// the HOST: the local launch target is host null, decided by the remote check, not a
// re-read (review of #57 v2).
export type RunIdentity = { ok: true; runAsUser: string | null } | { ok: false; error: string }

// `remoteHost` is the router's registry value (readAgentRemoteHost), never the
// config's: a remoteHost in agent-config.json launches nothing any more (b77e2688).
export function checkAgentRunIdentity(
  name: string,
  rawConfigJson: string,
  osUserExists: (user: string) => boolean,
  remoteHost: string | null = null,
): RunIdentity {
  const expected = agentOsUserName(name)
  const own = osUserExists(expected)
  let raw: unknown = undefined
  try {
    const cfg = JSON.parse(rawConfigJson) as Record<string, unknown>
    if (cfg && typeof cfg === 'object') raw = cfg.runAsUser
  } catch { /* unparseable: judged below like a missing value */ }
  const actual = resolveRunAsUser(rawConfigJson)
  if (own) {
    if (actual !== expected) {
      return { ok: false, error: `run identity refused: OS user ${expected} exists, agent-config.json runAsUser is ${JSON.stringify(raw ?? null)}` }
    }
    if (remoteHost) {
      return { ok: false, error: `run identity refused: agent ${name} has its own OS user, a remoteHost would run it outside that uid` }
    }
    return { ok: true, runAsUser: expected }
  }
  if (raw !== undefined && raw !== null && raw !== '') {
    return { ok: false, error: `run identity refused: no OS user ${expected}, but agent-config.json sets runAsUser ${JSON.stringify(raw)}` }
  }
  return { ok: true, runAsUser: null }
}

export function osUserExistsFromPasswd(passwd: string): (user: string) => boolean {
  const names = new Set(passwd.split('\n').map(l => l.split(':')[0]).filter(Boolean))
  return (user: string) => names.has(user)
}

// B45 B2-6: the private group that lets ONLY the agent and the router read the
// agent's own config files (agent-<name>-cfg, members: agent-<name> and marveen).
// Created by root; until it exists, group-shared writes are refused (fail closed).
export function agentConfigGroupName(name: string): string {
  return `agent-${name}-cfg`
}

export function gidFromGroupFile(groupFile: string, group: string): number | null {
  for (const line of groupFile.split('\n')) {
    const f = line.split(':')
    if (f[0] === group && f.length >= 3 && /^\d+$/.test(f[2])) return Number(f[2])
  }
  return null
}

export function readAgentConfigGroupGid(name: string): number | null {
  return gidFromGroupFile(readFileOr('/etc/group', ''), agentConfigGroupName(name))
}

export function readAgentRunIdentity(name: string): RunIdentity {
  const configPath = join(agentDir(name), 'agent-config.json')
  // B45 B2-2 follow-up (barracuda): an unreadable or empty /etc/passwd made every
  // OS user look absent, so an agent WITH its own user and no runAsUser in its
  // config would have started as the router. Unknown identity is a stop, too.
  return checkAgentRunIdentityWithPasswd(name, readFileOr(configPath, '{}'), readFileOr('/etc/passwd', ''), readAgentRemoteHost(name))
}

export function checkAgentRunIdentityWithPasswd(
  name: string,
  rawConfigJson: string,
  passwd: string,
  remoteHost: string | null = null,
): RunIdentity {
  if (!passwd.trim()) return { ok: false, error: 'run identity refused: /etc/passwd is unreadable or empty' }
  return checkAgentRunIdentity(name, rawConfigJson, osUserExistsFromPasswd(passwd), remoteHost)
}

// Validate-and-persist the remote config into the router's registry (see
// readAgentRemoteConfig). Empty strings clear the entry (revert the agent to
// local). Returns the resolved config on success, or an error string when a
// non-empty value fails validation. The agent's own agent-config.json is not
// touched: nothing in it decides the host any more.
export function writeAgentRemoteConfig(
  name: string,
  host: string,
  workdir: string,
): { ok: true; remote: RemoteAgentConfig } | { ok: false; error: string } {
  const h = host.trim()
  const w = workdir.trim()
  const reg = parseRemoteRegistry(readFileOr(remoteHostsFile, '{}'))

  // Clearing: both empty -> remove the entry, agent becomes local.
  if (!h && !w) {
    if (Object.prototype.hasOwnProperty.call(reg, name)) {
      delete reg[name]
      atomicWriteFileSync(remoteHostsFile, JSON.stringify(reg, null, 2), { mode: 0o644 })
    }
    return { ok: true, remote: { host: null, workdir: null } }
  }

  // Setting: both required and both must validate together.
  if (!h || !w) {
    return { ok: false, error: 'Both remoteHost and remoteWorkdir are required (or both empty to clear).' }
  }
  const probe = resolveRemoteConfig(JSON.stringify({ remoteHost: h, remoteWorkdir: w }))
  if (!probe.host || !probe.workdir) {
    return {
      ok: false,
      error: 'Invalid remoteHost (alias or user@host, no port/metachars) or remoteWorkdir (must be an absolute path without `..`).',
    }
  }
  reg[name] = { remoteHost: probe.host, remoteWorkdir: probe.workdir }
  atomicWriteFileSync(remoteHostsFile, JSON.stringify(reg, null, 2), { mode: 0o644 })
  return { ok: true, remote: probe }
}

export function readAgentChannelProvider(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.channelProvider === 'string' && config.channelProvider.trim()) {
      return config.channelProvider.trim()
    }
  } catch { /* fall through */ }
  return null
}

export function writeAgentChannelProvider(name: string, provider: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.channelProvider = provider
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export type AuthMode = 'shared' | 'own_team' | 'api'

const VALID_AUTH_MODES = new Set<AuthMode>(['shared', 'own_team', 'api'])

export function readAgentAuthMode(name: string): AuthMode {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode as AuthMode)) {
      return config.authMode as AuthMode
    }
  } catch { /* fall through */ }
  return 'shared'
}

// Opt-in per-agent auto-memory isolation (default OFF). When true, the
// launcher plants a stub git root in the agent dir so Claude Code's
// file-based auto-memory resolves to the agent's own project key instead of
// the shared install-root key. See src/web/memory-boundary.ts for the full
// mechanism and trade-offs. Absent/false = current shared behavior, unchanged.
export function readAgentMemoryIsolation(name: string): boolean {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    return config.memoryIsolation === true
  } catch { /* fall through */ }
  return false
}

// Persist the opt-in memoryIsolation flag. `false` removes the key so the
// config file stays minimal and the default-OFF semantics remain explicit.
export function writeAgentMemoryIsolation(name: string, enabled: boolean): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  if (enabled) config.memoryIsolation = true
  else delete config.memoryIsolation
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentAuthMode(name: string, mode: AuthMode): void {
  if (!VALID_AUTH_MODES.has(mode)) return
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.authMode = mode
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentSecurityProfile(name: string, profileId: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.securityProfile = profileId
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
  // the launch reads the profile from the trusted record, which only the dashboard writes
  // (agent-profile-store.ts); the config field stays for display and comparison. A new record's
  // role and trust graph are never taken from the config: member, no relations (LOCKED_RECORD's).
  writeTrustedRecord(name, { profile: profileId }, { ...LOCKED_RECORD, profile: profileId })
}

// Optional per-agent named Claude subscription plan. Stores a registry id
// (see claude-plans.ts) that resolves to a CLAUDE_CONFIG_DIR at launch. This
// is the operator-facing, dashboard-selectable indirection over the raw
// `claudeConfigDir` field: a plan bundles {configDir, planType, channelsAllowed}
// under a stable id so many agents can share one login without repeating the
// path. When unset (null), launch falls back to the raw claudeConfigDir and
// then to Claude Code's default -- fully backwards-compatible.
export function readAgentClaudePlan(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const value = config.claudePlan
    if (typeof value === 'string' && value.trim()) return value.trim()
  } catch { /* fall through */ }
  return null
}

// Set (non-empty string) or clear (empty/whitespace) the per-agent plan id.
// Clearing removes the key so the agent reverts to the raw-configDir/default
// resolution path.
export function writeAgentClaudePlan(name: string, planId: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  const trimmed = planId.trim()
  if (trimmed) config.claudePlan = trimmed
  else delete config.claudePlan
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// Sentinel filename. A subdirectory under agents/ that contains this empty
// file is treated as a TECHNICAL worker, not a first-class agent: it stays
// out of listAgentNames() (so it never appears on the dashboard, in the
// schedule runner, in inter-agent message routing, etc.), but is still a
// real directory on disk for whatever workflow needs it. Used today by
// agents/heartbeat-worker/, the sentinel cwd for the SDK-spawned hourly
// heartbeat sub-agent (Szabi 2026-06-02: "ez a technikai agent meg se
// jelenjen a dashboardon").
export const HIDDEN_AGENT_SENTINEL = '.hidden-from-dashboard'

/**
 * EVERY agent directory, hidden technical workers included.
 *
 * This answers "what does the fleet have to KEEP ALIVE"; listAgentNames()
 * answers "what should the operator SEE". They were the same call for a long
 * time, and that is precisely how the hourly heartbeat went silent on
 * 2026-08-04: agents/heartbeat carries HIDDEN_AGENT_SENTINEL, so the
 * context-guard sweep -- the ONLY mechanism that rescues a 100%-context
 * session -- never visited it. The schedule runner correctly refuses to inject
 * into a saturated pane and defers to the retry queue, but that deferral
 * assumes somebody eventually rescues the session. Nobody did, so the retry sat
 * unbounded and two hourly ticks plus a support-inbox tick died quietly.
 *
 * Hiding an agent from the dashboard is a VISIBILITY decision. It must never
 * decide whether that agent gets kept alive. Lifecycle sweeps use this
 * function; anything that renders a list to the operator uses listAgentNames().
 */
export function listAllAgentNames(): string[] {
  if (!existsSync(AGENTS_BASE_DIR)) return []
  return readdirSync(AGENTS_BASE_DIR).filter((f) => {
    try { return statSync(join(AGENTS_BASE_DIR, f)).isDirectory() } catch { return false }
  })
}

export function listAgentNames(): string[] {
  // Hide technical workers explicitly opted out via the sentinel file. Cheap
  // fs stat -- one extra existsSync per agent dir per tick; the agent list is
  // small (~6 today).
  return listAllAgentNames().filter((f) => {
    try { return !existsSync(join(AGENTS_BASE_DIR, f, HIDDEN_AGENT_SENTINEL)) } catch { return false }
  })
}

// ---- per-agent voice config -----------------------------------------------

export type VoiceResponseMode = 'text' | 'voice' | 'auto'

export interface AgentVoiceConfig {
  responseMode: VoiceResponseMode
  voiceModel: string
}

// Canonical set of bundled voice model identifiers (basename without .onnx).
// Extend here when new models are added to the installer.
export const KNOWN_VOICE_MODELS = new Set<string>([
  'hu_HU-imre-medium',
  'hu_HU-anna-medium',
])

const VALID_RESPONSE_MODES = new Set<VoiceResponseMode>(['text', 'voice', 'auto'])

export const DEFAULT_VOICE_CONFIG: AgentVoiceConfig = {
  responseMode: 'text',
  voiceModel: 'hu_HU-imre-medium',
}

export function readAgentVoiceConfig(name: string): AgentVoiceConfig {
  const configPath = join(agentConfigRoot(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const vc = (config.voice ?? {}) as Partial<AgentVoiceConfig>
    return {
      responseMode: VALID_RESPONSE_MODES.has(vc.responseMode as VoiceResponseMode)
        ? (vc.responseMode as VoiceResponseMode)
        : DEFAULT_VOICE_CONFIG.responseMode,
      voiceModel: KNOWN_VOICE_MODELS.has(vc.voiceModel ?? '')
        ? (vc.voiceModel as string)
        : DEFAULT_VOICE_CONFIG.voiceModel,
    }
  } catch {
    return { ...DEFAULT_VOICE_CONFIG }
  }
}

export function writeAgentVoiceConfig(name: string, patch: Partial<AgentVoiceConfig>): void {
  if (patch.responseMode !== undefined && !VALID_RESPONSE_MODES.has(patch.responseMode)) {
    throw new Error(`Invalid responseMode: ${patch.responseMode}`)
  }
  if (patch.voiceModel !== undefined && !KNOWN_VOICE_MODELS.has(patch.voiceModel)) {
    throw new Error(`Unknown voiceModel: ${patch.voiceModel}`)
  }
  const configPath = join(agentConfigRoot(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  const current = readAgentVoiceConfig(name)
  config.voice = {
    responseMode: patch.responseMode ?? current.responseMode,
    voiceModel: patch.voiceModel ?? current.voiceModel,
  }
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// ---- agent lookup ----------------------------------------------------------

// Does this identifier refer to a registered agent? MAIN_AGENT_ID always
// counts (it lives outside agents/ but is a first-class peer). Sub-agents
// need a directory on disk. One fs stat per call -- the router calls this
// twice per pending message on its 5s tick, roughly 10-20 stats per tick
// in practice, no memoisation needed.
export function isKnownAgent(name: string): boolean {
  if (!name) return false
  if (name === MAIN_AGENT_ID) return true
  try {
    const dir = agentDir(name)
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Parse YAML frontmatter capabilities from a persona file.
// Expected format (first block in the file):
//   ---
//   capabilities: [tag1, tag2, tag3]
//   ---
// Returns [] if the file has no frontmatter or no capabilities key.
function parsePersonaCapabilities(name: string): string[] {
  const personaPath = join(PROJECT_ROOT, 'personas', `${name}.md`)
  try {
    const content = readFileSync(personaPath, 'utf-8')
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fmMatch) return []
    const lineMatch = fmMatch[1].match(/^capabilities:\s*\[([^\]]*)\]/m)
    if (!lineMatch) return []
    return lineMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  } catch {
    return []
  }
}

// Capability resolution order (first match wins):
//   1. agent-config.json "capabilities" field (runtime override via PUT API)
//   2. personas/<name>.md YAML frontmatter "capabilities:" line (auto-derived)
export function readAgentCapabilities(name: string): string[] {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (Array.isArray(config.capabilities)) return config.capabilities
  } catch { /* fall through to persona */ }
  return parsePersonaCapabilities(name)
}

export function writeAgentCapabilities(name: string, capabilities: string[]): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.capabilities = capabilities
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}
