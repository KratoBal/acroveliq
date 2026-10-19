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
import { canonicalLine, GRANT_APPROVAL_CATEGORY, grantCanonicalLine, GrantLineError, sameRelation } from './canonical.js'
import { findApp, findGrant, GRANT_ACTION, type ExecutorConfig, type GrantEntry } from './config.js'
import { parseGateOutput, planText, type GatePlan } from './grant-plan.js'
import type { RequestRecord, RequestStore, Relation } from './store.js'
import type { CoolifyClient, DiscordReader, GateClient, GitHubReader } from './transports.js'
import { verifyDiscordApproval, type ChannelMessage } from './verify-approval.js'

export class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** Too many calls: the HTTP door answers 429 (barracuda, #49 review 3). */
export class RateLimited extends Refusal {}

/**
 * The door is not authenticated (the right to deploy is the owner's answer),
 * so a flood must not fill the disk with Rs or spend the GitHub token's hourly
 * budget: each request costs two GitHub calls and a Coolify read, each
 * execution Discord reads besides.
 */
export const MAX_OPEN_REQUESTS = 10
export const REQUESTS_PER_MINUTE = 6
export const EXECUTIONS_PER_MINUTE = 12
/** a deployment Coolify recorded this long before usedAt still counts (clock skew) */
export const RECOVER_SKEW_MS = 60_000
/** finished Rs older than this leave the state file (the audit log keeps them) */
export const PRUNE_AFTER_DAYS = 30

export interface ExecutorDeps {
  config: ExecutorConfig
  store: RequestStore
  discord: DiscordReader
  github: GitHubReader
  coolify: CoolifyClient
  /** the SSH door to the B8 gate; absent when the settings name no grants */
  gate?: GateClient
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
  /** a grant R: what the plan run after the apply showed (ures | nem-ures | nem-olvashato), null before it and for a deploy */
  planAfter: string | null
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
    planAfter: rec.grant?.utana ?? null,
  }
}

export class DeployExecutor {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pickInt: (n: number) => number
  private chain: Promise<unknown> = Promise.resolve()
  private readonly calls = { request: [] as number[], execute: [] as number[] }
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

  // The window is checked BEFORE the serial chain (barracuda, #51 review 1):
  // inside it, a flood would queue every call first and refuse it only on its
  // turn, holding memory and connections the whole time.
  request(input: { env?: unknown; app?: unknown; action?: unknown; sha?: unknown; requester?: unknown }): Promise<PublicRecord> {
    try {
      this.throttle('request', REQUESTS_PER_MINUTE)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.serial(() => this.doRequest(input))
  }

  execute(input: { r?: unknown; requestMessageId?: unknown }): Promise<PublicRecord> {
    try {
      this.throttle('execute', EXECUTIONS_PER_MINUTE)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.serial(() => this.doExecute(input))
  }

  /**
   * Forget finished Rs older than PRUNE_AFTER_DAYS (barracuda, #51 review 2):
   * used ones whose follow-up is over, and open ones long expired. A used R
   * still 'calling' or 'queued' is kept, whatever its age. The audit log keeps
   * every R's history; this only bounds the state file.
   */
  prune(): string[] {
    const { store } = this.deps
    const before = Math.floor(this.now() / 1000) - PRUNE_AFTER_DAYS * 86_400
    const gone = store.ids().filter((id) => {
      const r = store.get(id)!
      if (r.createdAt >= before) return false
      if (r.status === 'open') return r.expiresAt < before
      return r.outcome !== 'calling' && r.outcome !== 'queued'
    })
    if (gone.length) {
      store.remove(gone)
      store.audit('pruned', { count: gone.length, before })
    }
    return gone
  }

  /**
   * After a restart (barracuda, #48 and #50 reviews). An R left 'calling' is
   * spent and its answer was lost: Coolify's own list of the app's
   * deployments is read back, and exactly one commit-pinned rollback of this
   * sha, made after the R was spent and not claimed by any other R, is taken
   * as its deployment and followed. Anything else (none, more than one, an
   * unreadable list) stays 'interrupted': spent, result unknown. A 'queued'
   * R is followed again, since the previous process's follow-up died with it.
   */
  async recover(): Promise<{ interrupted: string[]; recovered: string[]; following: string[] }> {
    const { store } = this.deps
    const interrupted: string[] = []
    const recovered: string[] = []
    const following: string[] = []
    const claimed = new Set(store.ids().map((id) => store.get(id)!.deploymentUuid).filter((u): u is string => Boolean(u)))
    for (const id of store.ids()) {
      const rec = store.get(id)!
      if (rec.outcome === 'calling' && rec.grant) {
        // a grant R spent while the gate's `alkalmaz` was in flight: whether it ran is not known here, and there is no
        // Coolify list to match; the gate's own log and a `terv` run say (the plan is empty once it has been applied)
        rec.outcome = 'interrupted'
        store.put(rec)
        store.audit('interrupted', { r: id, reason: 'grant apply was in flight when the executor stopped' })
        interrupted.push(id)
      } else if (rec.outcome === 'calling') {
        const found = await this.findLostDeployment(rec, claimed)
        if (found.uuid) {
          rec.outcome = 'queued'
          rec.deploymentUuid = found.uuid
          claimed.add(found.uuid)
          store.put(rec)
          store.audit('recovered_queued', { r: id, deploymentUuid: found.uuid })
          this.startFollow(id)
          recovered.push(id)
        } else {
          rec.outcome = 'interrupted'
          store.put(rec)
          store.audit('interrupted', { r: id, reason: found.why })
          interrupted.push(id)
        }
      } else if (rec.outcome === 'queued' && rec.deploymentUuid) {
        this.startFollow(id)
        following.push(id)
      }
    }
    return { interrupted, recovered, following }
  }

  private async findLostDeployment(rec: RequestRecord, claimed: ReadonlySet<string>): Promise<{ uuid: string | null; why: string }> {
    if (rec.usedAt === undefined) return { uuid: null, why: 'no usedAt' }
    const since = rec.usedAt * 1000 - RECOVER_SKEW_MS
    let list
    try {
      list = await this.deps.coolify.listAppDeployments(rec.coolifyHost, rec.coolifyUuid, 20)
    } catch {
      return { uuid: null, why: 'deployment list unreadable' }
    }
    const matches = list.filter(
      (d) =>
        d.rollback === true &&
        d.commit === rec.sha &&
        d.pullRequestId === 0 &&
        typeof d.deploymentUuid === 'string' &&
        !claimed.has(d.deploymentUuid) &&
        typeof d.createdAtMs === 'number' &&
        d.createdAtMs >= since,
    )
    if (matches.length === 1) return { uuid: matches[0]!.deploymentUuid!, why: '' }
    return { uuid: null, why: matches.length === 0 ? 'no matching rollback' : 'more than one matching rollback' }
  }

  /** A sliding one-minute window per operation; checked before any outside call. */
  private throttle(op: 'request' | 'execute', perMinute: number): void {
    const now = this.now()
    const recent = this.calls[op].filter((t) => t > now - 60_000)
    if (recent.length >= perMinute) {
      this.calls[op] = recent
      throw new RateLimited(`too many ${op} calls, at most ${perMinute} a minute`)
    }
    recent.push(now)
    this.calls[op] = recent
  }

  status(r: unknown): PublicRecord | null {
    if (typeof r !== 'string') return null
    const rec = this.deps.store.get(r)
    return rec ? publicView(rec) : null
  }

  private async doRequest(input: { env?: unknown; app?: unknown; action?: unknown; sha?: unknown; requester?: unknown }): Promise<PublicRecord> {
    const { config, store } = this.deps
    this.prune()
    const nowSec = Math.floor(this.now() / 1000)
    const open = store.ids().filter((id) => {
      const r = store.get(id)!
      return r.status === 'open' && r.expiresAt > nowSec
    }).length
    if (open >= MAX_OPEN_REQUESTS) throw new RateLimited(`too many open requests (${open}), wait for one to expire or be used`)
    const { env, app, action, sha, requester } = input
    if (typeof env !== 'string' || typeof app !== 'string' || typeof action !== 'string') throw new Refusal('env, app and action are required')
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Refusal('sha must be a full 40-character lowercase commit')
    if (typeof requester !== 'string' || !REQUESTER.test(requester)) throw new Refusal('requester must be an agent name')
    if (action === GRANT_ACTION) return this.doGrantRequest(env, app, sha, requester)
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

    if (rec.grant) return this.executeGrant(rec, verdict, requestMessageId, refuse)

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
    rec.outcome = 'calling'
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
    this.startFollow(rec.id)
    return publicView(rec)
  }

  /**
   * The gate's `terv` for a commit, read as a plan. A refusal of the gate, an output that is not exactly a plan, or a plan
   * for another commit refuses; a transport failure (no ssh, a timeout) is thrown as it is and answers 502.
   */
  private async gatePlan(entry: GrantEntry, mode: 'terv' | 'alkalmaz', sha: string): Promise<GatePlan> {
    const gate = this.deps.gate
    if (!gate) throw new Refusal('the grant door is not configured')
    const run = await gate.run(mode, entry.gateKey, entry.database, sha)
    if (run.code !== 0) {
      this.deps.store.audit('gate_refused', { mode, sha, code: run.code, head: visible(run.output) })
      throw new Refusal(`the gate refused the ${mode} (exit ${run.code}): ${visible(run.output).slice(0, 160)}`)
    }
    try {
      return parseGateOutput(run.output, { mode, commit: sha })
    } catch (err) {
      this.deps.store.audit('plan_unreadable', { mode, sha, why: err instanceof Error ? err.message : 'unknown', head: visible(run.output) })
      throw new Refusal('the gate output could not be read as a plan')
    }
  }

  private async doGrantRequest(env: string, app: string, sha: string, requester: string): Promise<PublicRecord> {
    const { config, store } = this.deps
    const entry = findGrant(config, env, app)
    if (!entry) throw new Refusal('grant target is not on the allowlist for this environment')
    if (!this.deps.gate || !config.gate) throw new Refusal('the grant door is not configured')
    await this.requireOnBranch(entry.repo, entry.branch, sha)
    const plan = await this.gatePlan(entry, 'terv', sha)
    // an empty plan has nothing to approve; the owner is not asked to answer for nothing
    if (plan.ops.length === 0) throw new Refusal('the plan is empty: nothing to approve')

    let id = ''
    do id = Array.from({ length: R_LENGTH }, () => CODE_ALPHABET[this.pickInt(CODE_ALPHABET.length)]).join('')
    while (store.has(id))
    let line: string
    try {
      line = grantCanonicalLine({ id, env: entry.env, app: entry.name, sha, listSha256: plan.listSha256, planSha256: plan.planSha256, planText: planText(plan.ops) })
    } catch (err) {
      if (err instanceof GrantLineError) throw new Refusal(`terv-nem-fer-a-gombra: ${err.length} characters, split the list into two commits`)
      throw err
    }
    const createdAt = Math.floor(this.now() / 1000)
    const rec: RequestRecord = {
      id,
      env: entry.env,
      app: entry.name,
      coolifyHost: '',
      coolifyUuid: '',
      action: GRANT_ACTION,
      category: GRANT_APPROVAL_CATEGORY,
      grant: {
        gateKey: entry.gateKey,
        database: entry.database,
        listSha256: plan.listSha256,
        planSha256: plan.planSha256,
        ops: plan.ops.map((o) => `${o.sign} ${o.table} ${o.column}`),
      },
      sha,
      requester,
      relation: { kind: 'unmeasured' },
      canonicalLine: line,
      createdAt,
      expiresAt: createdAt + entry.approvalMinutes * 60,
      status: 'open',
    }
    store.put(rec)
    store.audit('request', { r: id, env: rec.env, app: rec.app, action: rec.action, sha, requester, planSha256: plan.planSha256, ops: plan.ops.length })
    return publicView(rec)
  }

  /**
   * The approved grant, applied. The Discord answer is already verified. Order, all of it: the allowlist and the branch
   * again; a SECOND `terv`, whose plan must be the approved one in all 64 digits of its digest; the R spent; the gate's
   * `alkalmaz`; and a THIRD `terv` that must show no change, or the outcome says so.
   */
  private async executeGrant(
    rec: RequestRecord,
    verdict: Extract<ReturnType<typeof verifyDiscordApproval>, { ok: true }>,
    requestMessageId: string,
    refuse: (reason: string) => never,
  ): Promise<PublicRecord> {
    const { config, store } = this.deps
    const grant = rec.grant!
    const entry = findGrant(config, rec.env, rec.app)
    if (!entry || !this.deps.gate || entry.gateKey !== grant.gateKey || entry.database !== grant.database) {
      return refuse('grant target is no longer on the allowlist')
    }
    await this.requireOnBranch(entry.repo, entry.branch, rec.sha).catch((e: unknown) => refuse(e instanceof Refusal ? e.reason : 'branch check failed'))
    let plan: GatePlan
    try {
      plan = await this.gatePlan(entry, 'terv', rec.sha)
    } catch (e) {
      return refuse(e instanceof Refusal ? e.reason : 'plan check failed')
    }
    // the whole digest of the record, not the 16 digits the line shows
    if (plan.planSha256 !== grant.planSha256) return refuse('the plan changed since the approval')

    rec.status = 'used'
    rec.outcome = 'calling'
    rec.usedAt = Math.floor(this.now() / 1000)
    rec.approval = { requestMessageId, decisionMessageId: verdict.decisionMessageId, deciderId: verdict.deciderId, code: verdict.code }
    store.put(rec)
    store.audit('approved', { r: rec.id, requestMessageId, decisionMessageId: verdict.decisionMessageId, deciderId: verdict.deciderId })

    let applied: { code: number; output: string } | null = null
    try {
      applied = await this.deps.gate.run('alkalmaz', entry.gateKey, entry.database, rec.sha)
    } catch (err) {
      store.audit('apply_call_failed', { r: rec.id, error: err instanceof Error ? err.message : 'unknown' })
    }
    if (!applied || applied.code !== 0) {
      // a timeout is not proof that nothing ran: a gate that answered after its COMMIT has applied the grants, so the plan is
      // measured on this branch too, and the outcome carries what it showed (barracuda, #253 review, note 1)
      rec.outcome = 'alkalmaz_hiba'
      grant.utana = await this.planAfter(entry, rec.sha)
      store.put(rec)
      store.audit('alkalmaz_hiba', { r: rec.id, code: applied ? applied.code : -1, head: applied ? visible(applied.output) : '', planAfter: grant.utana })
      return publicView(rec)
    }
    store.audit('applied', { r: rec.id, sha: rec.sha, planSha256: grant.planSha256 })
    grant.utana = await this.planAfter(entry, rec.sha)
    rec.outcome = grant.utana === 'ures' ? 'finished_verified' : grant.utana === 'nem-ures' ? 'terv_nem_ures' : 'utomeres_nem_olvashato'
    store.put(rec)
    store.audit(rec.outcome, { r: rec.id, sha: rec.sha })
    return publicView(rec)
  }

  /** One `terv` after the apply: is anything left to change? Never throws: an unreadable run is a state of its own. */
  private async planAfter(entry: GrantEntry, sha: string): Promise<'ures' | 'nem-ures' | 'nem-olvashato'> {
    try {
      return (await this.gatePlan(entry, 'terv', sha)).ops.length === 0 ? 'ures' : 'nem-ures'
    } catch {
      return 'nem-olvashato'
    }
  }

  private startFollow(r: string): void {
    // a follow-up that throws (a full disk, say) must not take the process down
    const follow = this.follow(r)
      .catch((err: unknown) => console.error(JSON.stringify({ event: 'follow_failed', r, error: err instanceof Error ? err.message : 'unknown' })))
      .finally(() => this.following.delete(follow))
    this.following.add(follow)
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

/** A gate's output as one short printable line for the audit trail and a refusal text: ASCII only, no secrets in it by construction. */
function visible(output: string): string {
  const first = output.split('\n').find((l) => l.trim() !== '') ?? ''
  return first.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)
}
