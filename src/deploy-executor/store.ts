// The executor's own record of every request (R), kept in a volume only its
// container sees (SB1 three-changes 1, "állapot"). The dashboard's SQLite is
// not consulted for anything: the fleet can write that file.
//
// One-time use is a state change persisted BEFORE the Coolify call (plan 3.1
// step 9): if the process dies between the two, the R is spent and a new
// approval is needed, never the other way round.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { ExecutorAction, GRANT_ACTION } from './config.js'

export type Relation =
  | { kind: 'forward'; runningSha: string }
  | { kind: 'same'; runningSha: string }
  | { kind: 'back'; runningSha: string }
  | { kind: 'diverged'; runningSha: string }
  | { kind: 'unmeasured' }

export type RequestStatus = 'open' | 'used'

export type DeploymentOutcome =
  /** the R is spent and the Coolify call is in flight */
  | 'calling'
  /** the executor stopped while 'calling': whether Coolify queued anything is not known */
  | 'interrupted'
  | 'queued'
  | 'not_queued'
  | 'finished_verified'
  | 'commit_mismatch'
  | 'failed'
  | 'unverified_timeout'
  /** a grant R: the gate's `alkalmaz` did not answer 0 (spent; the gate's own log says why) */
  | 'alkalmaz_hiba'
  /** a grant R: applied, but the plan run afterwards still shows changes */
  | 'terv_nem_ures'
  /** a grant R: applied, but the plan run afterwards could not be read */
  | 'utomeres_nem_olvashato'

/** What a grant R carries beyond the common fields; its presence is what makes the R a grant. */
export interface GrantRecord {
  /** the gate's container key and database, copied from the allowlist entry at request time */
  gateKey: string
  database: string
  listSha256: string
  /** the FULL plan digest the approval was given for; the execution compares all 64 digits */
  planSha256: string
  /** the plan, canonical order, `<+|-> <table> <column>` */
  ops: string[]
}

export interface RequestRecord {
  id: string
  env: string
  app: string
  /** a grant R has no Coolify: both are empty strings and `grant` is set */
  coolifyHost: string
  coolifyUuid: string
  action: ExecutorAction | typeof GRANT_ACTION
  /** the approval category the request text is built with; absent means coolify_deploy (the records before the grants) */
  category?: string
  grant?: GrantRecord
  sha: string
  requester: string
  relation: Relation
  canonicalLine: string
  /** unix seconds */
  createdAt: number
  expiresAt: number
  status: RequestStatus
  usedAt?: number
  /** evidence of the approval that was spent on this R */
  approval?: { requestMessageId: string; decisionMessageId: string; deciderId: string; code: string }
  deploymentUuid?: string
  outcome?: DeploymentOutcome
  /** what Coolify reported, never more than these fields */
  observed?: { commit: string | null; status: string | null }
}

interface StoreFile {
  version: 1
  requests: Record<string, RequestRecord>
}

export class RequestStore {
  private data: StoreFile
  private readonly file: string
  private readonly auditFile: string

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'requests.json')
    this.auditFile = join(dir, 'audit.log')
    if (existsSync(this.file)) {
      // a corrupt file must stop the executor, not reset every R to unused
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile
      if (parsed?.version !== 1 || typeof parsed.requests !== 'object' || parsed.requests === null) {
        throw new Error('executor state file has an unknown shape; refusing to start')
      }
      this.data = parsed
    } else {
      this.data = { version: 1, requests: {} }
    }
  }

  ids(): string[] {
    return Object.keys(this.data.requests)
  }

  has(id: string): boolean {
    return Object.hasOwn(this.data.requests, id)
  }

  get(id: string): RequestRecord | undefined {
    return this.has(id) ? structuredClone(this.data.requests[id]!) : undefined
  }

  /** Insert or replace, then write the whole file durably before returning. */
  put(rec: RequestRecord): void {
    const next: StoreFile = { version: 1, requests: { ...this.data.requests, [rec.id]: structuredClone(rec) } }
    this.write(next)
    this.data = next
  }

  /** Drop these records, durably, in one write. */
  remove(ids: readonly string[]): void {
    const requests = { ...this.data.requests }
    for (const id of ids) delete requests[id]
    const next: StoreFile = { version: 1, requests }
    this.write(next)
    this.data = next
  }

  /** Append-only audit trail: ids, shas, statuses, reasons; never a secret. */
  audit(event: string, fields: Record<string, string | number | boolean | null | undefined>): void {
    appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 })
  }

  private write(next: StoreFile): void {
    const tmp = `${this.file}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(next))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
    const dirFd = openSync(this.dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }
}
