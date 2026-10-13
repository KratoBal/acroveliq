// The deploy executor's settings and allowlist (SB1, plan 3.3). The file is
// root-owned on the host and mounted read-only into the executor's own
// container: nothing the fleet writes decides which application may be
// deployed, who may approve it, or which Discord bot's message counts as the
// request. Parsing is strict: an unknown key, a missing field or a value out
// of range refuses to start, because a typo that silently falls back to a
// default is exactly the half setting that must not decide anything.

export const ACTIONS = ['deploy'] as const
export type ExecutorAction = (typeof ACTIONS)[number]

export interface AppEntry {
  /** the label in the canonical line and its approval (prod, stage) */
  env: string
  /** the name in the canonical line; the uuid, not the name, is what is deployed */
  name: string
  /**
   * which Coolify runs it. Not the same as env: the AI API runs on the AI
   * machine's Coolify and is still a production app (three-changes 3)
   */
  coolifyHost: string
  coolifyUuid: string
  /** owner/name on GitHub */
  repo: string
  /** the branch a commit must be part of */
  branch: string
  actions: readonly ExecutorAction[]
  /** how long an R stays usable, in minutes */
  approvalMinutes: number
}

export interface CoolifyHostEntry {
  /** e.g. https://coolify.example/api/v1 */
  coolifyApiUrl: string
  coolifyTokenFile: string
}

export interface ExecutorConfig {
  stateDir: string
  discord: {
    channelId: string
    /** the dashboard bot that posts the #33 request; only its message counts */
    requestBotUserId: string
    /** who may answer `igen <code>` (the owner) */
    deciderUserIds: readonly string[]
    yes: string
    no: string
    tokenFile: string
  }
  github: { tokenFile: string }
  coolifyHosts: Readonly<Record<string, CoolifyHostEntry>>
  apps: readonly AppEntry[]
}

export const MAX_APPROVAL_MINUTES = 60

const NAME = /^[a-z][a-z0-9-]{0,62}$/
const SNOWFLAKE = /^\d{17,20}$/
const COOLIFY_UUID = /^[a-z0-9]{8,64}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const WORD = /^[a-záéíóöőúüű]{1,16}$/

class ConfigError extends Error {}

function fail(path: string, why: string): never {
  throw new ConfigError(`executor config ${path}: ${why}`)
}

function obj(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object')
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${path}.${k}`, 'unknown key')
  for (const k of keys) if (!(k in o)) fail(`${path}.${k}`, 'missing')
  return o
}

function str(v: unknown, path: string, re?: RegExp): string {
  if (typeof v !== 'string' || v === '') fail(path, 'must be a non-empty string')
  if (re && !re.test(v)) fail(path, `does not match ${re}`)
  return v
}

function absPath(v: unknown, path: string): string {
  const s = str(v, path)
  if (!s.startsWith('/') || s.split('/').includes('..')) fail(path, 'must be an absolute path without ..')
  return s
}

function apiUrl(v: unknown, path: string): string {
  const s = str(v, path)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    fail(path, 'not a URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(path, 'must be http(s)')
  if (u.username || u.password || u.search || u.hash) fail(path, 'no credentials, query or fragment')
  return s.replace(/\/+$/, '')
}

export function parseExecutorConfig(raw: unknown): ExecutorConfig {
  const top = obj(raw, '', ['stateDir', 'discord', 'github', 'coolifyHosts', 'apps'])
  const d = obj(top['discord'], 'discord', ['channelId', 'requestBotUserId', 'deciderUserIds', 'yes', 'no', 'tokenFile'])
  const deciders = d['deciderUserIds']
  if (!Array.isArray(deciders) || deciders.length === 0) fail('discord.deciderUserIds', 'must be a non-empty array')
  const yes = str(d['yes'], 'discord.yes', WORD)
  const no = str(d['no'], 'discord.no', WORD)
  if (yes === no) fail('discord.no', 'must differ from yes')
  const requestBotUserId = str(d['requestBotUserId'], 'discord.requestBotUserId', SNOWFLAKE)
  const deciderUserIds = deciders.map((x, i) => str(x, `discord.deciderUserIds[${i}]`, SNOWFLAKE))
  // the bot posts the request; if it could also answer it, the owner would not be needed
  if (deciderUserIds.includes(requestBotUserId)) fail('discord.deciderUserIds', 'must not contain the request bot')

  const g = obj(top['github'], 'github', ['tokenFile'])

  const hostsRaw = top['coolifyHosts']
  if (typeof hostsRaw !== 'object' || hostsRaw === null || Array.isArray(hostsRaw)) fail('coolifyHosts', 'must be an object')
  const coolifyHosts: Record<string, CoolifyHostEntry> = {}
  for (const [name, v] of Object.entries(hostsRaw as Record<string, unknown>)) {
    if (!NAME.test(name)) fail(`coolifyHosts.${name}`, 'bad host name')
    const e = obj(v, `coolifyHosts.${name}`, ['coolifyApiUrl', 'coolifyTokenFile'])
    coolifyHosts[name] = {
      coolifyApiUrl: apiUrl(e['coolifyApiUrl'], `coolifyHosts.${name}.coolifyApiUrl`),
      coolifyTokenFile: absPath(e['coolifyTokenFile'], `coolifyHosts.${name}.coolifyTokenFile`),
    }
  }
  if (Object.keys(coolifyHosts).length === 0) fail('coolifyHosts', 'empty')

  const appsRaw = top['apps']
  if (!Array.isArray(appsRaw) || appsRaw.length === 0) fail('apps', 'must be a non-empty array')
  const seen = new Set<string>()
  const seenUuid = new Set<string>()
  const apps: AppEntry[] = appsRaw.map((v, i) => {
    const p = `apps[${i}]`
    const a = obj(v, p, ['env', 'name', 'coolifyHost', 'coolifyUuid', 'repo', 'branch', 'actions', 'approvalMinutes'])
    const env = str(a['env'], `${p}.env`, NAME)
    const name = str(a['name'], `${p}.name`, NAME)
    const coolifyHost = str(a['coolifyHost'], `${p}.coolifyHost`, NAME)
    if (!Object.hasOwn(coolifyHosts, coolifyHost)) fail(`${p}.coolifyHost`, 'not in coolifyHosts')
    const coolifyUuid = str(a['coolifyUuid'], `${p}.coolifyUuid`, COOLIFY_UUID)
    if (seen.has(`${env}/${name}`)) fail(p, 'duplicate env/name')
    if (seenUuid.has(coolifyUuid)) fail(p, 'duplicate coolifyUuid')
    seen.add(`${env}/${name}`)
    seenUuid.add(coolifyUuid)
    const acts = a['actions']
    if (!Array.isArray(acts) || acts.length === 0) fail(`${p}.actions`, 'must be a non-empty array')
    const actions = acts.map((x, j) => {
      if (!(ACTIONS as readonly unknown[]).includes(x)) fail(`${p}.actions[${j}]`, `must be one of ${ACTIONS.join(', ')}`)
      return x as ExecutorAction
    })
    const minutes = a['approvalMinutes']
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_APPROVAL_MINUTES) {
      fail(`${p}.approvalMinutes`, `must be an integer 1..${MAX_APPROVAL_MINUTES}`)
    }
    return {
      env,
      name,
      coolifyHost,
      coolifyUuid,
      repo: str(a['repo'], `${p}.repo`, REPO),
      branch: str(a['branch'], `${p}.branch`, BRANCH),
      actions,
      approvalMinutes: minutes,
    }
  })

  return {
    stateDir: absPath(top['stateDir'], 'stateDir'),
    discord: {
      channelId: str(d['channelId'], 'discord.channelId', SNOWFLAKE),
      requestBotUserId,
      deciderUserIds,
      yes,
      no,
      tokenFile: absPath(d['tokenFile'], 'discord.tokenFile'),
    },
    github: { tokenFile: absPath(g['tokenFile'], 'github.tokenFile') },
    coolifyHosts,
    apps,
  }
}

export function findApp(cfg: ExecutorConfig, env: string, name: string): AppEntry | undefined {
  return cfg.apps.find((a) => a.env === env && a.name === name)
}
