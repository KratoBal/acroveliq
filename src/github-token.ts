/**
 * githubToken(repo, role): the dashboard's twin of scripts/lib/github-token.sh (the owner token's
 * retirement, PR 2, docs/fleet-github.md). The dashboard reads GitHub in two places, the handoff's
 * code-state check (task-handoff.ts) and the done guard's merge check (task-usage.ts); both read the
 * owner token file, one token for every repository. Before that token is revoked they go through here:
 *
 *   FLEET_GITHUB_APP=on   the root broker (/usr/local/sbin/fleet-github through sudo -n): a one-hour
 *                         installation token for the one repository, with the role's permissions only
 *   off (the default)     the owner token file, as before: the switch is the rollback
 *
 * A broker token covers ONE repository, so the token is asked per repository, and kept for 45 minutes
 * (the broker's tokens live an hour). Any failure answers null, which both checks already report as
 * "not measurable", never as agreement. The token never reaches a log line; a failure is logged by
 * repository and role only.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLEET_GITHUB_APP_SETTING, STORE_DIR } from './config.js'
import { logger } from './logger.js'

export type GithubRole = 'olvas' | 'push' | 'pr' | 'beolvaszt'
/** A token for one repository, or null when there is none (the caller reports "not measurable"). */
export type TokenSource = (repo: string) => Promise<string | null>

const REPO_RX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const ROLES: ReadonlySet<string> = new Set(['olvas', 'push', 'pr', 'beolvaszt'])
const CACHE_MS = 45 * 60 * 1000

/** The fixed places and the switch; replaceable in tests. */
export const githubTokenPlaces = {
  ownerFile: join(STORE_DIR, '.github-token'),
  broker: '/usr/local/sbin/fleet-github',
  sudo: ['sudo', '-n'] as string[],
  switchOn: (): boolean => (FLEET_GITHUB_APP_SETTING ?? 'off') === 'on',
  now: (): number => Date.now(),
}

const cache = new Map<string, { token: string; until: number }>()

/** Tests only: forget the kept broker tokens. */
export function forgetGithubTokens(): void {
  cache.clear()
}

function brokerToken(repo: string, role: GithubRole): Promise<string | null> {
  const [cmd, ...pre] = [...githubTokenPlaces.sudo, githubTokenPlaces.broker]
  return new Promise((resolve) => {
    execFile(cmd!, [...pre, 'token', repo, role], { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
      const token = String(stdout ?? '').trim()
      if (err || !token) {
        logger.warn({ repo, role }, 'github_token: the broker gave no token')
        resolve(null)
        return
      }
      resolve(token)
    })
  })
}

export async function githubToken(repo: string, role: GithubRole): Promise<string | null> {
  if (!REPO_RX.test(repo) || !ROLES.has(role)) return null
  if (githubTokenPlaces.switchOn()) {
    const key = `${repo} ${role}`
    const kept = cache.get(key)
    if (kept && kept.until > githubTokenPlaces.now()) return kept.token
    const token = await brokerToken(repo, role)
    if (token) cache.set(key, { token, until: githubTokenPlaces.now() + CACHE_MS })
    else cache.delete(key)
    return token
  }
  try {
    return readFileSync(githubTokenPlaces.ownerFile, 'utf-8').trim() || null
  } catch {
    return null
  }
}

/** The read token source both dashboard checks use. */
export const readTokenSource: TokenSource = (repo) => githubToken(repo, 'olvas')
