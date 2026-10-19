// The mail relay's settings (task level-kozvetito, plan v2 exchange-out/level-kozvetito-terv-v2-2026-10-19.md).
// The file is root-owned on the host and mounted read-only into the relay's own container: nothing the
// fleet writes decides who may call it, which sender is excluded, or how many mails may be archived a day.
// Parsing is strict, like the deploy executor's: an unknown key, a missing field or a value out of range
// refuses to start, because a typo that falls back to a default must not decide anything here.

export const ACCOUNTS = ['info', 'balazs'] as const
export type AccountId = (typeof ACCOUNTS)[number]

/**
 * How numbers are taken out of a mail body before it reaches a model.
 *   all-short-numbers  every standalone 4-8 digit number (the safe default, plan C)
 *   near-code-word     only such a number within 40 characters of a code word ("kód", "code", "PIN" ...)
 * `near-code-word` exists for the info@ invoice reading, IF the two-path comparison (plan, barracuda's
 * point 3) shows the default taking invoice numbers; it is a setting, never the default.
 */
export const REDACTION_MODES = ['all-short-numbers', 'near-code-word'] as const
export type RedactionMode = (typeof REDACTION_MODES)[number]

export interface CallerEntry {
  /** the name the log carries; one entry per caller who may ask */
  name: string
  /** hex sha256 of the caller's token; the token itself is the caller's own 0400 file */
  tokenSha256: string
}

export interface AccountEntry {
  /** the mailbox's address, for the log of what was set up (never used to address anything) */
  address: string
  /** the refresh token, a compose secret file */
  refreshTokenFile: string
  /** whether this account has the calendar verb */
  calendar: boolean
  redaction: RedactionMode
}

export interface RelayConfig {
  stateDir: string
  /** where `csatolmany` writes an attachment, for the quarantine reader; nothing else is written outside stateDir */
  quarantineDir: string
  oauthClientIdFile: string
  oauthClientSecretFile: string
  callers: readonly CallerEntry[]
  accounts: Readonly<Record<AccountId, AccountEntry>>
  /** senders whose mail text and attachments never come out (account-security and bank senders) */
  excludedSenders: { domains: readonly string[]; addresses: readonly string[] }
  /** archivePerDay: the most mails the relay will archive on balazs@ in one Budapest day (plan v2 point A) */
  limits: { callsPerMinute: number; maxAttachmentBytes: number; archivePerDay: number }
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/

class ConfigError extends Error {}

function fail(path: string, why: string): never {
  throw new ConfigError(`relay config ${path}: ${why}`)
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

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(path, `must be an integer ${min}..${max}`)
  return v
}

function strings(v: unknown, path: string, re: RegExp): string[] {
  if (!Array.isArray(v)) fail(path, 'must be an array')
  // lower-cased BEFORE the check: an entry written with capitals is the same domain, and matching is on lower case
  return v.map((x, i) => str(typeof x === 'string' ? x.toLowerCase() : x, `${path}[${i}]`, re))
}

export function parseRelayConfig(raw: unknown): RelayConfig {
  const top = obj(raw, '', [
    'stateDir',
    'quarantineDir',
    'oauthClientIdFile',
    'oauthClientSecretFile',
    'callers',
    'accounts',
    'excludedSenders',
    'limits',
  ])

  const callersRaw = top['callers']
  if (!Array.isArray(callersRaw) || callersRaw.length === 0) fail('callers', 'must be a non-empty array')
  const seenNames = new Set<string>()
  const seenHashes = new Set<string>()
  const callers = callersRaw.map((v, i): CallerEntry => {
    const c = obj(v, `callers[${i}]`, ['name', 'tokenSha256'])
    const name = str(c['name'], `callers[${i}].name`, NAME)
    const tokenSha256 = str(c['tokenSha256'], `callers[${i}].tokenSha256`, SHA256)
    if (seenNames.has(name)) fail(`callers[${i}].name`, 'duplicate')
    // two callers with one token would make the log name the wrong one
    if (seenHashes.has(tokenSha256)) fail(`callers[${i}].tokenSha256`, 'duplicate token')
    seenNames.add(name)
    seenHashes.add(tokenSha256)
    return { name, tokenSha256 }
  })

  const accountsRaw = obj(top['accounts'], 'accounts', ACCOUNTS)
  const account = (id: AccountId): AccountEntry => {
    const a = obj(accountsRaw[id], `accounts.${id}`, ['address', 'refreshTokenFile', 'calendar', 'redaction'])
    const redaction = a['redaction']
    if (!(REDACTION_MODES as readonly unknown[]).includes(redaction)) {
      fail(`accounts.${id}.redaction`, `must be one of ${REDACTION_MODES.join(', ')}`)
    }
    if (typeof a['calendar'] !== 'boolean') fail(`accounts.${id}.calendar`, 'must be true or false')
    return {
      address: str(a['address'], `accounts.${id}.address`, ADDRESS),
      refreshTokenFile: absPath(a['refreshTokenFile'], `accounts.${id}.refreshTokenFile`),
      calendar: a['calendar'],
      redaction: redaction as RedactionMode,
    }
  }

  const ex = obj(top['excludedSenders'], 'excludedSenders', ['domains', 'addresses'])
  const lim = obj(top['limits'], 'limits', ['callsPerMinute', 'maxAttachmentBytes', 'archivePerDay'])

  return {
    stateDir: absPath(top['stateDir'], 'stateDir'),
    quarantineDir: absPath(top['quarantineDir'], 'quarantineDir'),
    oauthClientIdFile: absPath(top['oauthClientIdFile'], 'oauthClientIdFile'),
    oauthClientSecretFile: absPath(top['oauthClientSecretFile'], 'oauthClientSecretFile'),
    callers,
    accounts: { info: account('info'), balazs: account('balazs') },
    excludedSenders: {
      domains: strings(ex['domains'], 'excludedSenders.domains', DOMAIN),
      addresses: strings(ex['addresses'], 'excludedSenders.addresses', ADDRESS),
    },
    limits: {
      callsPerMinute: int(lim['callsPerMinute'], 'limits.callsPerMinute', 1, 600),
      maxAttachmentBytes: int(lim['maxAttachmentBytes'], 'limits.maxAttachmentBytes', 1, 50 * 1024 * 1024),
      archivePerDay: int(lim['archivePerDay'], 'limits.archivePerDay', 1, 1000),
    },
  }
}
