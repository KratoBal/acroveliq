// The deploy executor's settings and allowlist (SB1, plan 3.3). The file is
// root-owned on the host and mounted read-only into the executor's own
// container: nothing the fleet writes decides which application may be
// deployed, who may approve it, or which Discord bot's message counts as the
// request. Parsing is strict: an unknown key, a missing field or a value out
// of range refuses to start, because a typo that silently falls back to a
// default is exactly the half setting that must not decide anything.

export const ACTIONS = ['deploy'] as const
export type ExecutorAction = (typeof ACTIONS)[number]

/** The other kind of R: a fleet_ro grant, applied on the host through the B8 gate (task parancssor-a-fleet-ro-grant). */
export const GRANT_ACTION = 'fleet-ro-grant'

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
  /**
   * The app's PUBLIC health address (https, no credentials or query). When set, a deployment that Coolify reports
   * finished on the right commit is `finished_verified` only after this address answers 200 (a container that is
   * still starting answers 503 from the proxy). Absent: the check is skipped, as before.
   */
  healthUrl?: string
  /**
   * A PROD app's stage counterpart (an app with env "stage" and the same repo and branch). The rule path deploys to
   * prod only a commit this executor has already deployed to that stage app and seen `finished_verified` ("ami a
   * teszten átment", Balázs 2026-10-19). Absent: prod by rule is refused, the Discord path remains.
   */
  stageApp?: string
}

/**
 * THE RULE PATH (task vegrehajto-szabaly-jovahagyas; Balázs 2026-10-19 19:54 UTC, "1 mehet 2 mehet 3 mehet"): a deploy
 * R is approved without a Discord answer when the evidence on GitHub says so. Absent: only the Discord path.
 */
export interface RuleConfig {
  /** GitHub logins whose APPROVED review counts: the machine account `fleet-approve` posts with (D4, review bound to the head) */
  reviewerLogins: readonly string[]
  /** prod only: a changed file whose path matches one of these (case-insensitive) refuses, naming the file */
  frozenPaths: readonly RegExp[]
  /** prod only: these repositories are frozen as a whole (the commerce freeze stands on Balázs's word) */
  frozenRepos: readonly string[]
}

/** A database whose fleet_ro grants this executor may apply, on the gate's host. */
export interface GrantEntry {
  /** the label in the canonical line and its approval (prod) */
  env: string
  /** the name in the canonical line (the request's `app`) */
  name: string
  /** owner/name on GitHub: the repository whose main holds the list the gate reads */
  repo: string
  /** the branch a commit must be part of */
  branch: string
  /** the gate's container key (the start of the container's name) and database, fixed here, never from a request */
  gateKey: string
  database: string
  approvalMinutes: number
}

/** The SSH door to the gate: one host, one user, one key (a compose secret), a pinned host key. */
export interface GateConfig {
  host: string
  port: number
  user: string
  keyFile: string
  knownHostsFile: string
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
  /** both absent: the executor does no grants at all; one without the other refuses to start */
  gate: GateConfig | null
  grants: readonly GrantEntry[]
  /** absent: no rule path, every deploy needs the owner's Discord answer */
  rules: RuleConfig | null
}

export const MAX_APPROVAL_MINUTES = 60

const NAME = /^[a-z][a-z0-9-]{0,62}$/
const SNOWFLAKE = /^\d{17,20}$/
const COOLIFY_UUID = /^[a-z0-9]{8,64}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const WORD = /^[a-záéíóöőúüű]{1,16}$/
// a host must not start with a hyphen (an option for ssh), a user is a plain account name
const GATE_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const GATE_USER = /^[a-z_][a-z0-9_-]{0,31}$/
const GATE_KEY = /^[a-z0-9]{8,64}$/
const DATABASE = /^[a-z][a-z0-9_]{0,62}$/
// a GitHub login, or an App's bot login (`name[bot]`)
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

class ConfigError extends Error {}

function fail(path: string, why: string): never {
  throw new ConfigError(`executor config ${path}: ${why}`)
}

function obj(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object')
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) fail(`${path}.${k}`, 'unknown key')
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

/** The health address: https only (a plain http probe of a public host proves less and leaks nothing worth the risk), no credentials, query or fragment. */
function healthUrl(v: unknown, path: string): string {
  const s = str(v, path)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    fail(path, 'not a URL')
  }
  if (u.protocol !== 'https:') fail(path, 'must be https')
  if (u.username || u.password || u.search || u.hash) fail(path, 'no credentials, query or fragment')
  return s
}

export function parseExecutorConfig(raw: unknown): ExecutorConfig {
  const top = obj(raw, '', ['stateDir', 'discord', 'github', 'coolifyHosts', 'apps'], ['gate', 'grants', 'rules'])
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
    const a = obj(v, p, ['env', 'name', 'coolifyHost', 'coolifyUuid', 'repo', 'branch', 'actions', 'approvalMinutes'], ['healthUrl', 'stageApp'])
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
      ...('healthUrl' in a ? { healthUrl: healthUrl(a['healthUrl'], `${p}.healthUrl`) } : {}),
      ...('stageApp' in a ? { stageApp: str(a['stageApp'], `${p}.stageApp`, NAME) } : {}),
    }
  })
  // a stageApp names a real stage app of the same code: otherwise "verified on stage" would prove another repository
  apps.forEach((a, i) => {
    if (a.stageApp === undefined) return
    if (a.env !== 'prod') fail(`apps[${i}].stageApp`, 'only a prod app has a stage counterpart')
    const stage = apps.find((s) => s.env === 'stage' && s.name === a.stageApp)
    if (!stage) fail(`apps[${i}].stageApp`, 'no stage app of that name')
    if (stage.repo !== a.repo || stage.branch !== a.branch) fail(`apps[${i}].stageApp`, 'the stage app deploys another repository or branch')
  })

  let rules: RuleConfig | null = null
  if ('rules' in top) {
    const r = obj(top['rules'], 'rules', ['reviewerLogins', 'frozenPaths', 'frozenRepos'])
    const logins = r['reviewerLogins']
    if (!Array.isArray(logins) || logins.length === 0) fail('rules.reviewerLogins', 'must be a non-empty array')
    const paths = r['frozenPaths']
    if (!Array.isArray(paths)) fail('rules.frozenPaths', 'must be an array')
    const repos = r['frozenRepos']
    if (!Array.isArray(repos)) fail('rules.frozenRepos', 'must be an array')
    rules = {
      reviewerLogins: logins.map((x, i) => str(x, `rules.reviewerLogins[${i}]`, GITHUB_LOGIN)),
      frozenPaths: paths.map((x, i) => {
        const src = str(x, `rules.frozenPaths[${i}]`)
        try {
          return new RegExp(src, 'i')
        } catch {
          fail(`rules.frozenPaths[${i}]`, 'not a regular expression')
        }
      }),
      frozenRepos: repos.map((x, i) => str(x, `rules.frozenRepos[${i}]`, REPO)),
    }
  }

  const hasGate = 'gate' in top
  const hasGrants = 'grants' in top
  if (hasGate !== hasGrants) fail(hasGate ? 'grants' : 'gate', 'missing: the grant door needs both keys or neither')
  let gate: GateConfig | null = null
  const grants: GrantEntry[] = []
  if (hasGate) {
    const gv = obj(top['gate'], 'gate', ['host', 'port', 'user', 'keyFile', 'knownHostsFile'])
    const port = gv['port']
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) fail('gate.port', 'must be an integer 1..65535')
    gate = {
      host: str(gv['host'], 'gate.host', GATE_HOST),
      port,
      user: str(gv['user'], 'gate.user', GATE_USER),
      keyFile: absPath(gv['keyFile'], 'gate.keyFile'),
      knownHostsFile: absPath(gv['knownHostsFile'], 'gate.knownHostsFile'),
    }
    const grantsRaw = top['grants']
    if (!Array.isArray(grantsRaw) || grantsRaw.length === 0) fail('grants', 'must be a non-empty array')
    const seenGrant = new Set<string>()
    grantsRaw.forEach((v, i) => {
      const p = `grants[${i}]`
      const e = obj(v, p, ['env', 'name', 'repo', 'branch', 'gateKey', 'database', 'approvalMinutes'])
      const env = str(e['env'], `${p}.env`, NAME)
      const name = str(e['name'], `${p}.name`, NAME)
      if (seenGrant.has(`${env}/${name}`)) fail(p, 'duplicate env/name')
      seenGrant.add(`${env}/${name}`)
      const minutes = e['approvalMinutes']
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_APPROVAL_MINUTES) {
        fail(`${p}.approvalMinutes`, `must be an integer 1..${MAX_APPROVAL_MINUTES}`)
      }
      grants.push({
        env,
        name,
        repo: str(e['repo'], `${p}.repo`, REPO),
        branch: str(e['branch'], `${p}.branch`, BRANCH),
        gateKey: str(e['gateKey'], `${p}.gateKey`, GATE_KEY),
        database: str(e['database'], `${p}.database`, DATABASE),
        approvalMinutes: minutes,
      })
    })
  }

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
    gate,
    grants,
    rules,
  }
}

export function findGrant(cfg: ExecutorConfig, env: string, name: string): GrantEntry | undefined {
  return cfg.grants.find((g) => g.env === env && g.name === name)
}

export function findApp(cfg: ExecutorConfig, env: string, name: string): AppEntry | undefined {
  return cfg.apps.find((a) => a.env === env && a.name === name)
}
