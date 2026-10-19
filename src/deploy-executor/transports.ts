// The three outside systems the executor talks to, behind small interfaces so
// the decision logic is tested without any of them. The REST implementations
// read their token once, from a file the executor's container gets as a
// compose secret; the token is never part of a return value, an error message
// or a log line (errors carry the HTTP status only, not the body).
//
// Sources for the request shapes:
//   Discord  API v10: GET /channels/{id}/messages/{id}, GET /channels/{id}/messages?after=&limit=
//            (the list call is the one #33 already uses).
//   GitHub   REST 2022-11-28: GET /repos/{owner}/{repo}/compare/{base}...{head};
//            `status` is ahead | behind | identical | diverged, `base_commit.sha` the resolved base.
//   Coolify  v4.4.6 (tag f55efc8, read in source): routes/api.php:283
//            POST /applications/{uuid}/rollback {"commit"} with the deploy ability, answers
//            {message, deployment_uuid} (or {message} alone when the queue skipped it);
//            :155 GET /deployments/{uuid} and :157 GET /deployments/applications/{uuid}?skip&take
//            with the read ability, newest first (Application::deployments).
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { GateConfig } from './config.js'
import type { ChannelMessage } from './verify-approval.js'

export interface DiscordReader {
  getMessage(channelId: string, messageId: string): Promise<ChannelMessage | null>
  /** up to 100 messages after `afterId`, any order */
  listAfter(channelId: string, afterId: string): Promise<ChannelMessage[]>
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged'

export interface GitHubReader {
  /** null when GitHub does not know one of the two commits (404) */
  compare(repo: string, base: string, head: string): Promise<{ status: CompareStatus; baseSha: string } | null>
}

/** A pull request as the rule path reads it: which commit it merged as, into which branch, from which head. */
export interface PullInfo {
  number: number
  merged: boolean
  mergeCommitSha: string | null
  baseRef: string
  headSha: string
}

export interface ReviewInfo {
  login: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING */
  state: string
  commitId: string | null
}

export interface CheckRunInfo {
  name: string
  /** queued, in_progress, completed */
  status: string
  /** success, failure, neutral, cancelled, skipped, timed_out, action_required, null while running */
  conclusion: string | null
}

/** The GitHub reads of the rule path (task vegrehajto-szabaly-jovahagyas). Each list is read whole, or the call throws. */
export interface GitHubRuleReader {
  /** the pull requests GitHub associates with the commit */
  pullsForCommit(repo: string, sha: string): Promise<PullInfo[]>
  /** every review of the pull request, oldest first */
  reviews(repo: string, pr: number): Promise<ReviewInfo[]>
  /** every check run on the commit */
  checkRuns(repo: string, sha: string): Promise<CheckRunInfo[]>
  /** every file the pull request changes, with the old path of a rename (GitHub lists at most 3000: a longer list throws) */
  pullFiles(repo: string, pr: number): Promise<{ path: string; previousPath: string | null }[]>
}

/** Pages of 100; a list longer than this many pages is not judged (it throws). */
export const RULE_MAX_PAGES = 30

export interface CoolifyDeployment {
  commit: string | null
  status: string | null
  pullRequestId: number
  /** the fields recover() matches a lost answer by; null when Coolify did not send them */
  deploymentUuid?: string | null
  rollback?: boolean
  /** ms; only from a timestamp with an explicit zone, a bare one would be read as local time */
  createdAtMs?: number | null
}

const ZONED = /(Z|[+-]\d{2}:\d{2})$/

export interface CoolifyClient {
  rollback(host: string, appUuid: string, commit: string): Promise<{ deploymentUuid: string | null }>
  getDeployment(host: string, deploymentUuid: string): Promise<CoolifyDeployment | null>
  /** newest first */
  listAppDeployments(host: string, appUuid: string, take: number): Promise<CoolifyDeployment[]>
}

/** One look at an application's public health address. */
export interface HealthProbe {
  /** the HTTP status, or null when nothing answered (refused, timed out, DNS); a redirect is NOT followed and is its own status */
  status(url: string): Promise<number | null>
}

const TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 5_000

export function readSecretFile(path: string): string {
  const v = readFileSync(path, 'utf8').trim()
  if (!v) throw new Error(`secret file is empty: ${path}`)
  return v
}

class HttpError extends Error {
  constructor(readonly service: string, readonly status: number) {
    super(`${service} API ${status}`)
  }
}

async function getJson(fetchImpl: typeof fetch, service: string, url: string, headers: Record<string, string>, allow404 = false): Promise<unknown> {
  const resp = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (allow404 && resp.status === 404) return null
  if (!resp.ok) throw new HttpError(service, resp.status)
  return resp.json()
}

/** The probe reads the status only: no body is read, no redirect followed, no header sent but the default ones. */
export function healthHttp(fetchImpl: typeof fetch = fetch): HealthProbe {
  return {
    async status(url) {
      try {
        const resp = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        await resp.body?.cancel()
        return resp.status
      } catch {
        return null
      }
    },
  }
}

export function discordRest(token: string, fetchImpl: typeof fetch = fetch): DiscordReader {
  const headers = { Authorization: `Bot ${token}` }
  const base = 'https://discord.com/api/v10'
  return {
    async getMessage(channelId, messageId) {
      return (await getJson(fetchImpl, 'Discord', `${base}/channels/${channelId}/messages/${messageId}`, headers, true)) as ChannelMessage | null
    },
    async listAfter(channelId, afterId) {
      return (await getJson(fetchImpl, 'Discord', `${base}/channels/${channelId}/messages?after=${afterId}&limit=100`, headers)) as ChannelMessage[]
    },
  }
}

export function githubRest(token: string, fetchImpl: typeof fetch = fetch): GitHubReader & GitHubRuleReader {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const api = (repo: string) => `https://api.github.com/repos/${repo}`
  /** every item of a paginated list, 100 a page; more than RULE_MAX_PAGES pages throws rather than judging a part */
  const pages = async (url: string, items: (body: unknown) => unknown[]): Promise<unknown[]> => {
    const out: unknown[] = []
    for (let page = 1; page <= RULE_MAX_PAGES; page++) {
      const batch = items(await getJson(fetchImpl, 'GitHub', `${url}?per_page=100&page=${page}`, headers))
      out.push(...batch)
      if (batch.length < 100) return out
    }
    throw new Error('GitHub list longer than the rule path reads')
  }
  return {
    async compare(repo, base, head) {
      const body = (await getJson(
        fetchImpl,
        'GitHub',
        `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        headers,
        true,
      )) as { status?: string; base_commit?: { sha?: string } } | null
      if (body === null) return null
      const status = body.status
      if (status !== 'ahead' && status !== 'behind' && status !== 'identical' && status !== 'diverged') {
        throw new Error('GitHub compare: unexpected status')
      }
      return { status, baseSha: String(body.base_commit?.sha ?? '') }
    },
    async pullsForCommit(repo, sha) {
      const list = (await getJson(fetchImpl, 'GitHub', `${api(repo)}/commits/${sha}/pulls?per_page=100`, headers)) as unknown[]
      return list.map((raw) => {
        const p = (raw ?? {}) as { number?: unknown; merged_at?: unknown; merge_commit_sha?: unknown; base?: { ref?: unknown }; head?: { sha?: unknown } }
        return {
          number: Number(p.number),
          merged: typeof p.merged_at === 'string' && p.merged_at !== '',
          mergeCommitSha: typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : null,
          baseRef: String(p.base?.ref ?? ''),
          headSha: String(p.head?.sha ?? ''),
        }
      })
    },
    async reviews(repo, pr) {
      const all = await pages(`${api(repo)}/pulls/${pr}/reviews`, (b) => b as unknown[])
      return all.map((raw) => {
        const r = (raw ?? {}) as { user?: { login?: unknown }; state?: unknown; commit_id?: unknown }
        return { login: String(r.user?.login ?? ''), state: String(r.state ?? ''), commitId: typeof r.commit_id === 'string' ? r.commit_id : null }
      })
    },
    async checkRuns(repo, sha) {
      const all = await pages(`${api(repo)}/commits/${sha}/check-runs`, (b) => ((b ?? {}) as { check_runs?: unknown[] }).check_runs ?? [])
      return all.map((raw) => {
        const c = (raw ?? {}) as { name?: unknown; status?: unknown; conclusion?: unknown }
        return { name: String(c.name ?? ''), status: String(c.status ?? ''), conclusion: typeof c.conclusion === 'string' ? c.conclusion : null }
      })
    },
    async pullFiles(repo, pr) {
      // GitHub lists at most 3000 files (30 pages): a list that fills them may be cut, and `pages` throws then
      const all = await pages(`${api(repo)}/pulls/${pr}/files`, (b) => b as unknown[])
      return all.map((raw) => {
        const f = (raw ?? {}) as { filename?: unknown; previous_filename?: unknown }
        return { path: String(f.filename ?? ''), previousPath: typeof f.previous_filename === 'string' ? f.previous_filename : null }
      })
    },
  }
}

function toDeployment(raw: unknown): CoolifyDeployment {
  const o = (raw ?? {}) as {
    commit?: unknown
    status?: unknown
    pull_request_id?: unknown
    deployment_uuid?: unknown
    rollback?: unknown
    created_at?: unknown
  }
  const created = typeof o.created_at === 'string' && ZONED.test(o.created_at) ? Date.parse(o.created_at) : NaN
  // copy these fields and nothing else: the record may carry logs
  return {
    commit: typeof o.commit === 'string' ? o.commit : null,
    status: typeof o.status === 'string' ? o.status : null,
    pullRequestId: typeof o.pull_request_id === 'number' ? o.pull_request_id : 0,
    deploymentUuid: typeof o.deployment_uuid === 'string' && o.deployment_uuid ? o.deployment_uuid : null,
    rollback: o.rollback === true,
    createdAtMs: Number.isFinite(created) ? created : null,
  }
}

export function coolifyRest(
  hosts: Readonly<Record<string, { coolifyApiUrl: string; token: string }>>,
  fetchImpl: typeof fetch = fetch,
): CoolifyClient {
  const env = (name: string) => {
    const e = Object.hasOwn(hosts, name) ? hosts[name] : undefined
    if (!e) throw new Error(`no Coolify settings for host ${name}`)
    return { base: e.coolifyApiUrl, headers: { Authorization: `Bearer ${e.token}`, Accept: 'application/json' } }
  }
  return {
    async rollback(envName, appUuid, commit) {
      const { base, headers } = env(envName)
      const resp = await fetchImpl(`${base}/applications/${appUuid}/rollback`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!resp.ok) throw new HttpError('Coolify', resp.status)
      const body = (await resp.json()) as { deployment_uuid?: unknown }
      return { deploymentUuid: typeof body.deployment_uuid === 'string' && body.deployment_uuid ? body.deployment_uuid : null }
    },
    async getDeployment(envName, deploymentUuid) {
      const { base, headers } = env(envName)
      const body = await getJson(fetchImpl, 'Coolify', `${base}/deployments/${deploymentUuid}`, headers, true)
      return body === null ? null : toDeployment(body)
    },
    async listAppDeployments(envName, appUuid, take) {
      const { base, headers } = env(envName)
      const body = (await getJson(fetchImpl, 'Coolify', `${base}/deployments/applications/${appUuid}?skip=0&take=${take}`, headers)) as {
        deployments?: unknown[]
      }
      return Array.isArray(body.deployments) ? body.deployments.map(toDeployment) : []
    },
  }
}

/** What the gate answered: its exit code and everything it printed (stdout and stderr together). */
export interface GateRun {
  code: number
  output: string
}

/**
 * The B8 gate on the host (scripts/host/fleet-gate.sh), reached by SSH with the executor's own key. One shape only:
 * `fleet-ro-grant <key> <database> <commit> terv|alkalmaz`. The key and database come from the allowlist, the commit is
 * checked as 40 hex digits by the caller, the mode is one of two words: nothing a request says reaches the command line
 * in any other way.
 */
export interface GateClient {
  run(mode: 'terv' | 'alkalmaz', gateKey: string, database: string, commit: string): Promise<GateRun>
}

const GATE_TIMEOUT_MS = 90_000
const GATE_MAX_OUTPUT = 256 * 1024
const COMMIT = /^[0-9a-f]{40}$/
const GATE_KEY_WORD = /^[a-z0-9]{8,64}$/
const DATABASE_WORD = /^[a-z][a-z0-9_]{0,62}$/

/** The argument list of the one ssh call. Exported so the test reads it as the code builds it. */
export function gateSshArgs(gate: GateConfig, mode: 'terv' | 'alkalmaz', gateKey: string, database: string, commit: string): string[] {
  if (mode !== 'terv' && mode !== 'alkalmaz') throw new Error('gate mode must be terv or alkalmaz')
  if (!GATE_KEY_WORD.test(gateKey) || !DATABASE_WORD.test(database) || !COMMIT.test(commit)) throw new Error('gate arguments have a bad shape')
  return [
    // no user or system config, no agent, no terminal, no prompt, no forwarding, no fallback to other keys
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${gate.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'RequestTTY=no',
    '-o', 'ConnectTimeout=15',
    '-i', gate.keyFile,
    '-p', String(gate.port),
    '--',
    `${gate.user}@${gate.host}`,
    `fleet-ro-grant ${gateKey} ${database} ${commit} ${mode}`,
  ]
}

export function gateSsh(gate: GateConfig, sshPath = '/usr/bin/ssh'): GateClient {
  return {
    run(mode, gateKey, database, commit) {
      const args = gateSshArgs(gate, mode, gateKey, database, commit)
      return new Promise<GateRun>((resolve, reject) => {
        execFile(
          sshPath,
          args,
          // a clean environment: nothing of the process's own (no SSH_AUTH_SOCK, no proxy) reaches ssh
          { timeout: GATE_TIMEOUT_MS, maxBuffer: GATE_MAX_OUTPUT, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' } },
          (err, stdout, stderr) => {
            const output = `${stdout}\n${stderr}`
            if (!err) return resolve({ code: 0, output })
            const e = err as NodeJS.ErrnoException & { killed?: boolean }
            // an exit code is the gate's answer; anything else (no ssh, a timeout, a full buffer) is no answer at all
            if (typeof e.code === 'number') return resolve({ code: e.code, output })
            reject(new Error(e.killed ? 'gate call timed out' : 'gate call did not run'))
          },
        )
      })
    },
  }
}
