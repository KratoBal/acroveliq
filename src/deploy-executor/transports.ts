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
import { readFileSync } from 'node:fs'

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

export interface CoolifyDeployment {
  commit: string | null
  status: string | null
  pullRequestId: number
}

export interface CoolifyClient {
  rollback(host: string, appUuid: string, commit: string): Promise<{ deploymentUuid: string | null }>
  getDeployment(host: string, deploymentUuid: string): Promise<CoolifyDeployment | null>
  /** newest first */
  listAppDeployments(host: string, appUuid: string, take: number): Promise<CoolifyDeployment[]>
}

const TIMEOUT_MS = 15_000

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

export function githubRest(token: string, fetchImpl: typeof fetch = fetch): GitHubReader {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
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
  }
}

function toDeployment(raw: unknown): CoolifyDeployment {
  const o = (raw ?? {}) as { commit?: unknown; status?: unknown; pull_request_id?: unknown }
  // copy three fields and nothing else: the record may carry logs
  return {
    commit: typeof o.commit === 'string' ? o.commit : null,
    status: typeof o.status === 'string' ? o.status : null,
    pullRequestId: typeof o.pull_request_id === 'number' ? o.pull_request_id : 0,
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
