// Per-actor tokens and the actor log (acrovelIQ P0-1, step 1: identity without
// enforcement). WHAT TURNS THIS RED:
//   - a revoked, expired or foreign token resolves to a principal;
//   - the name `legacy`, or a malformed name, can be minted for an actor;
//   - the shared token stops resolving exactly as before ({ kind: 'token' }),
//     or an agent's token resolves to anything but the same kind;
//   - a caller is named wrongly (legacy, the agent, session, device, federation);
//   - the actor log misses a request, counts a static file, keeps ids in the
//     path, or throws.
import { describe, it, expect, beforeAll } from 'vitest'
import type http from 'node:http'
import Database from 'better-sqlite3'

import { getDb, initDatabase } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import {
  actorOf,
  createPrincipalToken,
  ensurePrincipalSchema,
  normalizeRequestPath,
  recordRequestActor,
  resolvePrincipalToken,
  revokePrincipalToken,
} from '../web/auth-principals.js'

const SHARED = 'b'.repeat(64)
const NOW = 1_760_000_000
const mkReq = (authorization?: string) => ({ headers: { authorization } }) as unknown as http.IncomingMessage
const url = new URL('http://127.0.0.1:3420/api/memories')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('principal tokens', () => {
  it('PRINCIPAL-TOKEN: resolves its actor; revoked, expired, unknown or foreign-prefixed tokens do not', () => {
    const db = getDb()
    const murena = createPrincipalToken(db, 'murena', { now: NOW })
    const revoked = createPrincipalToken(db, 'nautilus', { now: NOW })
    const expiring = createPrincipalToken(db, 'barracuda', { project: 'reefclub', expiresInDays: 1, now: NOW })
    revokePrincipalToken(db, revoked.id, NOW + 10)
    const kept = db.prepare('SELECT revoked_at FROM principal_tokens WHERE id = ?').get(revoked.id) as { revoked_at: number }
    expect(
      [
        resolvePrincipalToken(db, murena.token, NOW),
        resolvePrincipalToken(db, revoked.token, NOW + 20),
        kept.revoked_at,
        resolvePrincipalToken(db, expiring.token, NOW + 3600),
        resolvePrincipalToken(db, expiring.token, NOW + 2 * 86400),
        resolvePrincipalToken(db, 'mvpt_' + 'x'.repeat(43), NOW),
        resolvePrincipalToken(db, murena.token.replace('mvpt_', 'mvdk_'), NOW),
        murena.token.startsWith('mvpt_'),
        (db.prepare('SELECT key_hash FROM principal_tokens WHERE id = ?').get(murena.id) as { key_hash: string }).key_hash.includes(murena.token),
      ],
      'PRINCIPAL-TOKEN',
    ).toEqual([
      { id: murena.id, project: 'acropora', actor: 'murena' },
      null,
      NOW + 10, // the row stays, for the audit trail
      { id: expiring.id, project: 'reefclub', actor: 'barracuda' },
      null,
      null,
      null,
      true,
      false, // only the hash is stored
    ])
  })

  it('refuses the name `legacy` and malformed actor names', () => {
    const db = getDb()
    expect(() => createPrincipalToken(db, 'legacy', { now: NOW })).toThrow(/legacy/)
    expect(() => createPrincipalToken(db, 'Murena Fő', { now: NOW })).toThrow(/invalid actor/)
  })
})

describe('the auth gate', () => {
  it('PRINCIPAL-GATE: the shared token resolves exactly as before; an agent\'s token is the same kind, with its principal', () => {
    const token = createPrincipalToken(getDb(), 'polip', { now: Math.floor(Date.now() / 1000) })
    const shared = resolveAuth(mkReq(`Bearer ${SHARED}`), url, '/api/memories', 'GET', SHARED)
    const agent = resolveAuth(mkReq(`Bearer ${token.token}`), url, '/api/memories', 'GET', SHARED)
    const unknown = resolveAuth(mkReq('Bearer mvpt_ismeretlen'), url, '/api/memories', 'GET', SHARED)
    // toStrictEqual: an attached `principal: undefined` on the shared token would already be a change
    expect([shared, agent, unknown], 'PRINCIPAL-GATE').toStrictEqual([
      { kind: 'token' },
      { kind: 'token', principal: { id: token.id, project: 'acropora', actor: 'polip' } },
      { kind: 'none' },
    ])
  })
})

describe('the caller and the actor log', () => {
  it('PRINCIPAL-ACTOR: every kind of caller has one name', () => {
    expect(
      [
        actorOf({ kind: 'token' }),
        actorOf({ kind: 'token', principal: { id: 1, project: 'acropora', actor: 'korall' } }),
        actorOf({ kind: 'session', user: 'balazs' }),
        actorOf({ kind: 'device', device: 'iphone' }),
        actorOf({ kind: 'federation', peer: 'masik-flotta' }),
        actorOf({ kind: 'none' }),
      ].map((a) => `${a.project}/${a.actor}`),
      'PRINCIPAL-ACTOR',
    ).toEqual([
      'acropora/legacy',
      'acropora/korall',
      'acropora/session:balazs',
      'acropora/device:iphone',
      'acropora/federation:masik-flotta',
      'acropora/anonymous',
    ])
  })

  it('PRINCIPAL-LOG: counts API calls per day, caller, method and route; static files are not counted; it never throws', () => {
    const db = new Database(':memory:')
    ensurePrincipalSchema(db)
    const agent = { kind: 'token' as const, principal: { id: 1, project: 'acropora', actor: 'murena' } }
    recordRequestActor(db, agent, 'GET', '/api/kanban/0a1b2c3d/comments', NOW)
    recordRequestActor(db, agent, 'GET', '/api/kanban/9f8e7d6c/comments', NOW + 5)
    recordRequestActor(db, { kind: 'token' }, 'POST', '/api/messages', NOW)
    recordRequestActor(db, { kind: 'token' }, 'GET', '/app.js', NOW)
    const rows = db.prepare('SELECT day, actor, method, path, count, first_seen, last_seen FROM request_actors ORDER BY actor').all()
    db.close()
    expect(() => recordRequestActor(db, agent, 'GET', '/api/agents', NOW)).not.toThrow() // a closed database
    expect(rows, 'PRINCIPAL-LOG').toEqual([
      { day: '2025-10-09', actor: 'legacy', method: 'POST', path: '/api/messages', count: 1, first_seen: NOW, last_seen: NOW },
      { day: '2025-10-09', actor: 'murena', method: 'GET', path: '/api/kanban/:id/comments', count: 2, first_seen: NOW, last_seen: NOW + 5 },
    ])
  })

  it('normalizes ids in a path, and keeps names', () => {
    expect([
      normalizeRequestPath('/api/agents/murena/pane'),
      normalizeRequestPath('/api/messages/12345'),
      normalizeRequestPath('/api/approvals/3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
      normalizeRequestPath('/api/auth/device-keys/mvdk_abc'),
    ]).toEqual(['/api/agents/murena/pane', '/api/messages/:id', '/api/approvals/:id', '/api/auth/device-keys/:id'])
  })
})
