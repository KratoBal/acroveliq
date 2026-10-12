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
//   request_actors     who called what, counted per day, actor, method and path
//                      (id-like path segments collapsed), so a day's traffic shows
//                      which agent already uses its own token and which call
//                      still comes with the shared one ('legacy').
//
// THIS STEP FORBIDS NOTHING. A principal token resolves to the same auth kind as
// the shared token ({ kind: 'token' }), with the principal attached, so every
// route that branches on the kind behaves exactly as before. The access matrix
// and its enforcement come later, behind a setting.

import { randomBytes, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

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
 * A path as the actor log keeps it: id-like segments (numbers, hex ids, uuids,
 * minted keys) become `:id`, so a day's log is a list of routes, not of ids.
 * Agent names and fixed segments stay.
 */
export function normalizeRequestPath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8,}$/i.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^(?:mvdk|mvpt|inv)_/.test(segment)
        ? ':id'
        : segment,
    )
    .join('/')
    .slice(0, 300)
}

/**
 * Counts one request in the actor log. Only the API and the fleet manifest
 * are counted (not static files). Must never throw: a logging failure cannot
 * fail the request it describes.
 */
export function recordRequestActor(db: Database.Database, auth: ActorSource, method: string, path: string, now: number): void {
  if (!path.startsWith('/api/') && path !== '/.well-known/fleetq') return
  try {
    const { project, actor } = actorOf(auth)
    const day = new Date(now * 1000).toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO request_actors (day, project, actor, method, path, count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (day, project, actor, method, path) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
    ).run(day, project, actor, method, normalizeRequestPath(path), now, now)
  } catch {
    // the log is a measurement, not a gate
  }
}
