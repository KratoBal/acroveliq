// Per-actor dashboard tokens and the actor log (acrovelIQ P0-1, step 1:
// identity, without enforcement).
//
// Today every fleet agent calls the dashboard with ONE shared bearer token, so
// the server cannot tell who is calling. This module adds the identity layer:
//
//   principal_tokens   one token per actor (an agent), per project. Modeled on
//                      device_keys: only sha256(token) is stored, the raw value
//                      is returned once at mint time, the prefix makes a leaked
//                      value recognisable, expiry is opt-in. A revoked token
//                      keeps its row (revoked_at) for the audit trail.
//   request_actors     who called what, counted per day, actor, method and ROUTE
//                      (the route rule's pattern, never the raw path: no value
//                      from a path, a token or an e-mail, reaches the log), so a day's traffic shows
//                      which agent already uses its own token and which call
//                      still comes with the shared one ('legacy').
//   legacy_callers     the shared token's calls once more, with three hints at
//                      WHO made them (P0-1 deployment steps, point 4: the
//                      residual legacy calls by name): the User-Agent's first
//                      product token, a self-declared name (an X-Fleet-Caller
//                      header or the `agent` query) and the remote address.
//                      A hint, not an identity: the shared token proves no name,
//                      so this only says where to look. Each value is checked
//                      against a narrow pattern; anything else is stored as `?`,
//                      a missing one as `-`, so no free text reaches the log.
//
// THIS STEP FORBIDS NOTHING. A principal token resolves to the same auth kind as
// the shared token ({ kind: 'token' }), with the principal attached, so every
// route that branches on the kind behaves exactly as before. The access matrix
// and its enforcement come later, behind a setting.

import { randomBytes, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

import { APP_TZ } from '../config.js'
import { matchRouteRule } from './route-match.js'

export const DEFAULT_PROJECT = 'acropora'

const TOKEN_PREFIX = 'mvpt_'

export interface Principal {
  id: number
  project: string
  actor: string
}

export interface MintedPrincipalToken extends Principal {
  /** The raw credential. Returned ONCE at mint time, never recoverable. */
  token: string
  createdAt: number
  expiresAt: number | null
}

export function ensurePrincipalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS principal_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}',
      actor TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      last_used_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_principal_tokens_actor ON principal_tokens(project, actor)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_actors (
      day TEXT NOT NULL,
      project TEXT NOT NULL,
      actor TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (day, project, actor, method, path)
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_callers (
      day TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      ua TEXT NOT NULL,
      claimed TEXT NOT NULL,
      remote TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (day, method, path, ua, claimed, remote)
    )
  `)
}

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex')

const ACTOR_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function createPrincipalToken(
  db: Database.Database,
  actor: string,
  opts: { project?: string; expiresInDays?: number; now: number },
): MintedPrincipalToken {
  if (!ACTOR_NAME.test(actor)) throw new Error(`invalid actor name: ${actor}`)
  if (actor === 'legacy') throw new Error('"legacy" names the shared token, not an actor')
  const project = opts.project ?? DEFAULT_PROJECT
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = opts.expiresInDays ? opts.now + Math.floor(opts.expiresInDays * 86400) : null
  const info = db
    .prepare('INSERT INTO principal_tokens (project, actor, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(project, actor, sha256hex(token), opts.now, expiresAt)
  return { id: Number(info.lastInsertRowid), project, actor, token, createdAt: opts.now, expiresAt }
}

/** The principal of a presented token, or null (unknown, revoked or expired). */
export function resolvePrincipalToken(db: Database.Database, raw: string, now: number): Principal | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null
  const row = db
    .prepare('SELECT id, project, actor, expires_at, revoked_at, last_used_at FROM principal_tokens WHERE key_hash = ?')
    .get(sha256hex(raw)) as
    | { id: number; project: string; actor: string; expires_at: number | null; revoked_at: number | null; last_used_at: number | null }
    | undefined
  if (!row || row.revoked_at !== null || (row.expires_at !== null && now > row.expires_at)) return null
  if (row.last_used_at === null || now - row.last_used_at >= 60)
    db.prepare('UPDATE principal_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id)
  return { id: row.id, project: row.project, actor: row.actor }
}

/** Revokes a token; the row stays, with the time of revocation. */
export function revokePrincipalToken(db: Database.Database, id: number, now: number): boolean {
  return db.prepare('UPDATE principal_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes > 0
}

/** The auth result fields this module reads (a structural subset of AuthResult). */
export type ActorSource =
  | { kind: 'token'; principal?: Principal }
  | { kind: 'device'; device: string }
  | { kind: 'session'; user: string }
  | { kind: 'federation'; peer: string }
  | { kind: 'none' }

/**
 * Who is calling, as one name: an agent's token gives its name; the shared
 * token gives `legacy`; the others say what they are.
 */
export function actorOf(auth: ActorSource): { project: string; actor: string } {
  switch (auth.kind) {
    case 'token':
      return auth.principal ? { project: auth.principal.project, actor: auth.principal.actor } : { project: DEFAULT_PROJECT, actor: 'legacy' }
    case 'device':
      return { project: DEFAULT_PROJECT, actor: `device:${auth.device}` }
    case 'session':
      return { project: DEFAULT_PROJECT, actor: `session:${auth.user}` }
    case 'federation':
      return { project: DEFAULT_PROJECT, actor: `federation:${auth.peer}` }
    default:
      return { project: DEFAULT_PROJECT, actor: 'anonymous' }
  }
}

/**
 * A request as the actor log keeps it: the pattern of the route rule it
 * answers to (`/api/agents/:name/channels/:provider/invites/:token`), so the
 * log holds routes, never a value from a path (barracuda, #20: an invite token
 * and an e-mail-like username were kept by a segment heuristic). A request no
 * rule answers is `:ismeretlen`.
 */
export function routeKey(method: string, path: string): string {
  return matchRouteRule(method, path)?.path ?? ':ismeretlen'
}

/** The fleet's day (Budapest), like the other daily breakdowns, not the UTC day. */
export function localDay(now: number): string {
  return new Date(now * 1000).toLocaleDateString('en-CA', { timeZone: APP_TZ })
}

/** Who made a shared-token call, as far as the request tells (legacy_callers). */
export interface CallerHint {
  ua: string
  claimed: string
  remote: string
}

const first = (value: string | string[] | null | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value ?? undefined
const UA_PRODUCT = /^([A-Za-z][A-Za-z0-9._-]{0,31})(?:\/([0-9][0-9A-Za-z._-]{0,15}))?/
const CLAIMED_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const IP_ADDRESS = /^[0-9a-fA-F:.]{2,45}$/

/**
 * The three hints, from the raw request values. Only a value that fits its
 * pattern is kept: the User-Agent's first product token (`curl/8.5.0`,
 * `python-requests/2.31.0`, `node`), a self-declared name shaped like an
 * agent's, an IP address. A value that does not fit is `?`, a missing one `-`.
 */
export function callerHint(raw: {
  userAgent?: string | string[] | null
  fleetCaller?: string | string[] | null
  queryAgent?: string | null
  remoteAddress?: string | null
}): CallerHint {
  const userAgent = first(raw.userAgent)?.trim()
  const product = userAgent ? UA_PRODUCT.exec(userAgent) : null
  const claimedRaw = (first(raw.fleetCaller) ?? raw.queryAgent ?? undefined)?.trim()
  const remoteRaw = raw.remoteAddress?.replace(/^::ffff:/, '')
  return {
    ua: !userAgent ? '-' : product ? (product[2] ? `${product[1]}/${product[2]}` : product[1]!) : '?',
    claimed: !claimedRaw ? '-' : CLAIMED_NAME.test(claimedRaw) ? claimedRaw : '?',
    remote: !remoteRaw ? '-' : IP_ADDRESS.test(remoteRaw) ? remoteRaw : '?',
  }
}

/** How long the actor log keeps a day. */
export const ACTOR_LOG_DAYS = 90
let lastPrunedDay = ''

/**
 * Counts one request in the actor log. Only the API and the fleet manifest
 * are counted (not static files). Must never throw: a logging failure cannot
 * fail the request it describes.
 */
export function recordRequestActor(
  db: Database.Database,
  auth: ActorSource,
  method: string,
  path: string,
  now: number,
  hint?: CallerHint,
): void {
  if (!path.startsWith('/api/') && path !== '/.well-known/fleetq') return
  try {
    const { project, actor } = actorOf(auth)
    const day = localDay(now)
    // once per day: drop the days past the retention
    if (day !== lastPrunedDay) {
      lastPrunedDay = day
      const cutoff = localDay(now - ACTOR_LOG_DAYS * 86400)
      db.prepare('DELETE FROM request_actors WHERE day < ?').run(cutoff)
      db.prepare('DELETE FROM legacy_callers WHERE day < ?').run(cutoff)
    }
    const route = routeKey(method, path)
    db.prepare(
      `INSERT INTO request_actors (day, project, actor, method, path, count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (day, project, actor, method, path) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
    ).run(day, project, actor, method, route, now, now)
    // only the shared token: an agent's own token already names its caller
    if (actor === 'legacy' && hint) {
      db.prepare(
        `INSERT INTO legacy_callers (day, method, path, ua, claimed, remote, count, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (day, method, path, ua, claimed, remote) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
      ).run(day, method, route, hint.ua, hint.claimed, hint.remote, now, now)
    }
  } catch {
    // the log is a measurement, not a gate
  }
}
