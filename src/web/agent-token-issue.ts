// Hands an agent its own dashboard token (acrovelIQ P0-1, plan step 5.2).
//
// The row goes to `principal_tokens` (only the hash, `createPrincipalToken`);
// the token itself goes to store/tokens/<agent>.token, created exclusively
// (`wx`, never over an existing file), mode 0400, then handed to the agent's
// OS user. If any file step fails after the row was written, the row is
// revoked and a half-made file removed: no token exists that no file holds.
// The token is never returned or printed.
//
// The other way (`issueAgentTokenToPipe`, barracuda's review of the P0-1 step
// sheet): the install's owner writes the row and hands the token to a pipe;
// root only places the file with base-system commands. Root then runs no
// repository code, which the install's owner can rewrite. The token is written
// to the pipe only, never to a terminal. A write the pipe refuses (its reader
// gone: EPIPE) revokes the row. What this side cannot see is a reader that
// took the token and failed afterwards (behind `docker compose exec` the
// write succeeds into docker's buffer whatever root's side does): there the
// step sheet's revoke step is the guard (L2), not this code.
//
// Dry run unless `apply`: it says what it would do and touches nothing.
import { chownSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

import { createPrincipalToken, DEFAULT_PROJECT, revokePrincipalToken } from './auth-principals.js'

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface TokenFileOps {
  exists(path: string): boolean
  mkdir(path: string, mode: number): void
  createExclusive(path: string, mode: number, content: string): void
  chown(path: string, uid: number, gid: number): void
  unlink(path: string): void
}

export const realTokenFileOps: TokenFileOps = {
  exists: (path) => existsSync(path),
  mkdir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
  createExclusive: (path, mode, content) => {
    const fd = openSync(path, 'wx', mode)
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
  },
  chown: (path, uid, gid) => chownSync(path, uid, gid),
  unlink: (path) => unlinkSync(path),
}

export interface IssueResult {
  status: 'dry-run' | 'issued'
  agent: string
  path: string
  owner: { uid: number; gid: number }
  /** the principal_tokens row id; only when issued */
  id?: number
}

export function agentTokenPath(root: string, agent: string): string {
  return join(root, 'store', 'tokens', `${agent}.token`)
}

export function issueAgentToken(
  db: Database.Database,
  opts: {
    root: string
    agent: string
    owner: { uid: number; gid: number }
    expiresInDays?: number
    now: number
    apply: boolean
    fs?: TokenFileOps
  },
): IssueResult {
  const fs = opts.fs ?? realTokenFileOps
  if (!AGENT_NAME.test(opts.agent)) throw new Error(`invalid agent name: ${opts.agent}`)
  const path = agentTokenPath(opts.root, opts.agent)
  if (fs.exists(path))
    throw new Error(`${path} already exists: revoke the old token and remove the file first, nothing overwritten`)
  const result: IssueResult = { status: 'dry-run', agent: opts.agent, path, owner: opts.owner }
  if (!opts.apply) return result

  // the directory lets an agent open its own file by name, not list the others
  fs.mkdir(join(opts.root, 'store', 'tokens'), 0o711)
  const minted = createPrincipalToken(db, opts.agent, { expiresInDays: opts.expiresInDays, now: opts.now })
  let created = false
  try {
    fs.createExclusive(path, 0o400, `${minted.token}\n`)
    created = true
    fs.chown(path, opts.owner.uid, opts.owner.gid)
  } catch (error) {
    revokePrincipalToken(db, minted.id, opts.now)
    if (created) {
      try {
        fs.unlink(path)
      } catch {
        // the revoked row already makes the file worthless
      }
    }
    throw error
  }
  return { ...result, status: 'issued', id: minted.id }
}

/**
 * Writes `text` to a stream and settles when the stream took it or refused
 * it. Node reports a write into a pipe whose reader is gone (EPIPE) as an
 * 'error' EVENT, not a throw, and an unhandled one ends the process (measured
 * on process.stdout, 2026-10-13: the CLI said "issued", then died, and the row
 * stayed live). The listener stays attached, so a late error cannot crash the
 * process either.
 */
export function writeToPipe(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    stream.on('error', fail)
    stream.write(text, (error?: Error | null) => {
      if (error) return fail(error)
      if (settled) return
      settled = true
      resolve()
    })
  })
}

/**
 * Mints the agent's token and writes it to `out.write` instead of a file
 * (the step sheet's root step places the file). Refused when `out.isTty`: a
 * token on a screen is a token in a scrollback. Refused, as in the file way,
 * when the agent's file already exists. If the write fails (it throws or its
 * promise rejects: `writeToPipe` turns a refused pipe into a rejection), the
 * row is revoked. A reader that took the token and failed later is not
 * visible here (see the header).
 */
export async function issueAgentTokenToPipe(
  db: Database.Database,
  opts: {
    root: string
    agent: string
    expiresInDays?: number
    now: number
    apply: boolean
    out: { isTty: boolean; write(text: string): void | Promise<void> }
    fs?: Pick<TokenFileOps, 'exists'>
  },
): Promise<Omit<IssueResult, 'owner'>> {
  const fs = opts.fs ?? realTokenFileOps
  if (!AGENT_NAME.test(opts.agent)) throw new Error(`invalid agent name: ${opts.agent}`)
  if (opts.out.isTty) throw new Error('the token goes to a pipe only, and the output is a terminal: nothing issued')
  const path = agentTokenPath(opts.root, opts.agent)
  if (fs.exists(path))
    throw new Error(`${path} already exists: revoke the old token and remove the file first, nothing issued`)
  const result = { status: 'dry-run' as IssueResult['status'], agent: opts.agent, path }
  if (!opts.apply) return result
  const minted = createPrincipalToken(db, opts.agent, { expiresInDays: opts.expiresInDays, now: opts.now })
  try {
    await opts.out.write(`${minted.token}\n`)
  } catch (error) {
    revokePrincipalToken(db, minted.id, opts.now)
    throw error
  }
  return { ...result, status: 'issued', id: minted.id }
}

export interface RevokeResult {
  status: 'dry-run' | 'revoked'
  agent: string
  /** the active principal_tokens rows of the agent (revoked, or to revoke) */
  ids: number[]
  path: string
  /** whether the token file was there (removed, or to remove) */
  file: boolean
}

/**
 * Takes an agent's own token away (the issuer's pair; acrovelIQ P0-1 5.2).
 * First every active row of the agent is revoked, then the file removed: if
 * the removal fails, the token is already worthless. Another agent's rows are
 * never touched. Dry run unless `apply`; nothing prints the token.
 *
 * After it, the agent's helpers fall back to the shared token, loudly, which
 * in `naplo` still carries everything: this is the runbook's way back.
 */
export function revokeAgentToken(
  db: Database.Database,
  opts: {
    root: string
    agent: string
    project?: string
    now: number
    apply: boolean
    /** revoke the rows only; the file is root's to remove (the pipe way) */
    dbOnly?: boolean
    fs?: TokenFileOps
  },
): RevokeResult {
  const fs = opts.fs ?? realTokenFileOps
  if (!AGENT_NAME.test(opts.agent)) throw new Error(`invalid agent name: ${opts.agent}`)
  const project = opts.project ?? DEFAULT_PROJECT
  const path = agentTokenPath(opts.root, opts.agent)
  const ids = (
    db
      .prepare('SELECT id FROM principal_tokens WHERE project = ? AND actor = ? AND revoked_at IS NULL ORDER BY id')
      .all(project, opts.agent) as { id: number }[]
  ).map((r) => r.id)
  const file = fs.exists(path)
  const result: RevokeResult = { status: 'dry-run', agent: opts.agent, ids, path, file }
  if (!opts.apply) return result
  for (const id of ids) revokePrincipalToken(db, id, opts.now)
  if (file && !opts.dbOnly) fs.unlink(path)
  return { ...result, status: 'revoked' }
}
