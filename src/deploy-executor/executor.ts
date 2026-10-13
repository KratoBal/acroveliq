// The deploy executor's two operations (SB1 plan 3.1, three-changes 2):
//
//   request  {env, app, action, sha, requester} -> an R and its canonical line.
//            The app and action must be on the allowlist, the sha a full
//            commit on the app's branch. The running commit is compared with
//            it, and a step back is written into the line the owner approves.
//   execute  {r, requestMessageId} -> the approved commit queued in Coolify.
//            The owner's Discord answer is read back and checked
//            (verify-approval.ts), the sha and the relation measured again,
//            the R marked used, and only then the commit-pinned rollback call
//            made. Afterwards the deployment is followed until Coolify says
//            which commit it built.
//
// A refusal leaves the R unused (a wrong message id costs nothing); anything
// after the R is marked used spends it, including a failed Coolify call.
import { randomInt } from 'node:crypto'

import { CODE_ALPHABET, snowflakeAt } from '../web/approval-discord-core.js'
import { canonicalLine, sameRelation } from './canonical.js'
import { findApp, type ExecutorConfig } from './config.js'
import type { RequestRecord, RequestStore, Relation } from './store.js'
import type { CoolifyClient, DiscordReader, GitHubReader } from './transports.js'
import { verifyDiscordApproval, type ChannelMessage } from './verify-approval.js'

export class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export interface ExecutorDeps {
  config: ExecutorConfig
  store: RequestStore
  discord: DiscordReader
  github: GitHubReader
  coolify: CoolifyClient
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pickInt?: (n: number) => number
  /** how often and how long a queued deployment is followed */
  followEveryMs?: number
  followForMs?: number
}

export const SHA = /^[0-9a-f]{40}$/
const REQUESTER = /^[a-z][a-z0-9-]{0,31}$/
const SNOWFLAKE = /^\d{17,20}$/
const R_LENGTH = 8
const MAX_PAGES = 20

export interface PublicRecord {
  r: string
  env: string
  app: string
  action: string
  sha: string
  canonicalLine: string
  expiresAt: number
  status: string
  deploymentUuid: string | null
  outcome: string | null
}

/** What may leave the executor about an R: ids, shas and states, nothing Coolify sent besides. */
export function publicView(rec: RequestRecord): PublicRecord {
  return {
    r: rec.id,
    env: rec.env,
    app: rec.app,
    action: rec.action,
    sha: rec.sha,
    canonicalLine: rec.canonicalLine,
    expiresAt: rec.expiresAt,
    status: rec.status,
    deploymentUuid: rec.deploymentUuid ?? null,
    outcome: rec.outcome ?? null,
  }
}

export class DeployExecutor {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pickInt: (n: number) => number
  private chain: Promise<unknown> = Promise.resolve()
  /** follow-ups still running; tests await them */
  readonly following = new Set<Promise<void>>()

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)))
    this.pickInt = deps.pickInt ?? randomInt
  }

  /** One operation at a time: two executions of one R must not interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  request(input: { env?: unknown; app?: unknown; action?: unknown; sha?: unknown; requester?: unknown }): Promise<PublicRecord> {
    return this.serial(() => this.doRequest(input))
  }

  execute(input: { r?: unknown; requestMessageId?: unknown }): Promise<PublicRecord> {
    return this.serial(() => this.doExecute(input))
  }

  status(r: unknown): PublicRecord | null {
    if (typeof r !== 'string') return null
    const rec = this.deps.store.get(r)
    return rec ? publicView(rec) : null
  }

  private async doRequest(input: { env?: unknown; app?: unknown; action?: unknown; sha?: unknown; requester?: unknown }): Promise<PublicRecord> {
    const { config, store } = this.deps
    const { env, app, action, sha, requester } = input
    if (typeof env !== 'string' || typeof app !== 'string' || typeof action !== 'string') throw new Refusal('env, app and action are required')
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Refusal('sha must be a full 40-character lowercase commit')
    if (typeof requester !== 'string' || !REQUESTER.test(requester)) throw new Refusal('requester must be an agent name')
    const entry = findApp(config, env, app)
    if (!entry) throw new Refusal('application is not on the allowlist for this environment')
    if (!(entry.actions as readonly string[]).includes(action)) throw new Refusal('action is not allowed for this application')

    await this.requireOnBranch(entry.repo, entry.branch, sha)
    const relation = await this.measureRelation(entry.coolifyHost, entry.coolifyUuid, entry.repo, sha)

    let id = ''
    do id = Array.from({ length: R_LENGTH }, () => CODE_ALPHABET[this.pickInt(CODE_ALPHABET.length)]).join('')
    while (store.has(id))
    const createdAt = Math.floor(this.now() / 1000)
    const rec: RequestRecord = {
      id,
      env: entry.env,
      app: entry.name,
      coolifyHost: entry.coolifyHost,
      coolifyUuid: entry.coolifyUuid,
      action: action as RequestRecord['action'],
      sha,
      requester,
      relation,
      canonicalLine: canonicalLine({ id, env: entry.env, app: entry.name, action, sha, relation }),
      createdAt,
      expiresAt: createdAt + entry.approvalMinutes * 60,
      status: 'open',
    }
    store.put(rec)
    store.audit('request', { r: id, env: rec.env, app: rec.app, action: rec.action, sha, requester, relation: relation.kind })
    return publicView(rec)
  }

  private async doExecute(input: { r?: unknown; requestMessageId?: unknown }): Promise<PublicRecord> {
    const { config, store, discord, coolify } = this.deps
    const { r, requestMessageId } = input
    if (typeof r !== 'string' || typeof requestMessageId !== 'string' || !SNOWFLAKE.test(requestMessageId)) {
      throw new Refusal('r and requestMessageId are required')
    }
    const rec = store.get(r)
    if (!rec) throw new Refusal('unknown R')
    const refuse = (reason: string): never => {
      store.audit('refused', { r, reason, requestMessageId })
      throw new Refusal(reason)
    }
    if (rec.status !== 'open') return refuse('R was already used')
    if (this.now() >= rec.expiresAt * 1000) return refuse('R has expired')

    const request = await discord.getMessage(config.discord.channelId, requestMessageId)
    if (!request) return refuse('request message not found in the approval channel')
    const later = await this.readAfter(requestMessageId, rec.expiresAt)
    if (later === null) return refuse('too many messages after the request to read them all')
    const verdict = verifyDiscordApproval({ r: rec, request, later, discord: config.discord, nowMs: this.now() })
    if (!verdict.ok) return refuse(verdict.reason)

    // the world may have moved since the request: measure both claims again
    const entry = findApp(config, rec.env, rec.app)
    if (!entry || entry.coolifyHost !== rec.coolifyHost || entry.coolifyUuid !== rec.coolifyUuid || !(entry.actions as readonly string[]).includes(rec.action)) {
      return refuse('application is no longer on the allowlist')
    }
    await this.requireOnBranch(entry.repo, entry.branch, rec.sha).catch((e: unknown) => refuse(e instanceof Refusal ? e.reason : 'branch check failed'))
    const relation = await this.measureRelation(rec.coolifyHost, rec.coolifyUuid, entry.repo, rec.sha)
    if (!sameRelation(relation, rec.relation)) return refuse('the running version changed since the approval')

    // spend the R FIRST, durably; then the one outside call that deploys
    rec.status = 'used'
    rec.usedAt = Math.floor(this.now() / 1000)
    rec.approval = { requestMessageId, decisionMessageId: verdict.decisionMessageId, deciderId: verdict.deciderId, code: verdict.code }
    store.put(rec)
    store.audit('approved', { r, requestMessageId, decisionMessageId: verdict.decisionMessageId, deciderId: verdict.deciderId })

    let deploymentUuid: string | null = null
    try {
      deploymentUuid = (await coolify.rollback(rec.coolifyHost, rec.coolifyUuid, rec.sha)).deploymentUuid
    } catch (err) {
      store.audit('deploy_call_failed', { r, error: err instanceof Error ? err.message : 'unknown' })
    }
    if (!deploymentUuid) {
      rec.outcome = 'not_queued'
      store.put(rec)
      store.audit('not_queued', { r })
      return publicView(rec)
    }
    rec.deploymentUuid = deploymentUuid
    rec.outcome = 'queued'
    store.put(rec)
    store.audit('queued', { r, deploymentUuid, sha: rec.sha })
    // a follow-up that throws (a full disk, say) must not take the process down
    const follow = this.follow(rec.id)
      .catch((err: unknown) => console.error(JSON.stringify({ event: 'follow_failed', r: rec.id, error: err instanceof Error ? err.message : 'unknown' })))
      .finally(() => this.following.delete(follow))
    this.following.add(follow)
    return publicView(rec)
  }

  /** Every message after the request until the R's expiry, or null if it does not fit. */
  private async readAfter(requestMessageId: string, expiresAt: number): Promise<ChannelMessage[] | null> {
    const { discord, config } = this.deps
    const stop = BigInt(snowflakeAt(expiresAt * 1000))
    const out: ChannelMessage[] = []
    let after = requestMessageId
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await discord.listAfter(config.discord.channelId, after)
      if (batch.length === 0) return out
      out.push(...batch)
      const newest = batch.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after)
      if (BigInt(newest) >= stop || batch.length < 100) return out
      after = newest
    }
    return null
  }

  private async requireOnBranch(repo: string, branch: string, sha: string): Promise<void> {
    // base = the commit, head = the branch: "ahead" or "identical" means the
    // branch contains the commit
    const cmp = await this.deps.github.compare(repo, sha, branch)
    if (!cmp) throw new Refusal('commit not found on GitHub')
    if (cmp.baseSha !== sha) throw new Refusal('GitHub resolved the commit to another sha')
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') throw new Refusal('commit is not part of the branch')
  }

  private async measureRelation(host: string, appUuid: string, repo: string, sha: string): Promise<Relation> {
    try {
      const list = await this.deps.coolify.listAppDeployments(host, appUuid, 20)
      const running = list.find((d) => d.status === 'finished' && d.pullRequestId === 0)?.commit
      if (!running || !SHA.test(running)) return { kind: 'unmeasured' }
      const cmp = await this.deps.github.compare(repo, running, sha)
      if (!cmp || cmp.baseSha !== running) return { kind: 'unmeasured' }
      switch (cmp.status) {
        case 'ahead':
          return { kind: 'forward', runningSha: running }
        case 'identical':
          return { kind: 'same', runningSha: running }
        case 'behind':
          return { kind: 'back', runningSha: running }
        case 'diverged':
          return { kind: 'diverged', runningSha: running }
      }
    } catch {
      return { kind: 'unmeasured' }
    }
  }

  /** Follow the queued deployment until Coolify names the commit it built. */
  private async follow(r: string): Promise<void> {
    const { store, coolify } = this.deps
    const every = this.deps.followEveryMs ?? 10_000
    const deadline = this.now() + (this.deps.followForMs ?? 30 * 60_000)
    const rec = store.get(r)
    const deploymentUuid = rec?.deploymentUuid
    if (!rec || !deploymentUuid) return
    for (;;) {
      await this.sleep(every)
      let d = null
      try {
        d = await coolify.getDeployment(rec.coolifyHost, deploymentUuid)
      } catch {
        // a failed read is not an outcome; the next one retries
      }
      if (d && (d.status === 'finished' || d.status === 'failed' || (d.status ?? '').startsWith('cancelled'))) {
        rec.observed = { commit: d.commit, status: d.status }
        rec.outcome = d.status !== 'finished' ? 'failed' : d.commit === rec.sha ? 'finished_verified' : 'commit_mismatch'
        store.put(rec)
        store.audit(rec.outcome, { r, deploymentUuid, observedCommit: d.commit, status: d.status })
        return
      }
      if (this.now() >= deadline) {
        rec.outcome = 'unverified_timeout'
        store.put(rec)
        store.audit('unverified_timeout', { r, deploymentUuid })
        return
      }
    }
  }
}
