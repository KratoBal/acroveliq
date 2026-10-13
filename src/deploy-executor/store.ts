// The executor's own record of every request (R), kept in a volume only its
// container sees (SB1 three-changes 1, "állapot"). The dashboard's SQLite is
// not consulted for anything: the fleet can write that file.
//
// One-time use is a state change persisted BEFORE the Coolify call (plan 3.1
// step 9): if the process dies between the two, the R is spent and a new
// approval is needed, never the other way round.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { ExecutorAction } from './config.js'

export type Relation =
  | { kind: 'forward'; runningSha: string }
  | { kind: 'same'; runningSha: string }
  | { kind: 'back'; runningSha: string }
  | { kind: 'diverged'; runningSha: string }
  | { kind: 'unmeasured' }

export type RequestStatus = 'open' | 'used'

export type DeploymentOutcome =
  | 'queued'
  | 'not_queued'
  | 'finished_verified'
  | 'commit_mismatch'
  | 'failed'
  | 'unverified_timeout'

export interface RequestRecord {
  id: string
  env: string
  app: string
  coolifyUuid: string
  action: ExecutorAction
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
