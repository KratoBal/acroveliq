// The relay's only door to Google. The URL is built by the relay from a fixed set of shapes; a caller
// supplies ids and search text, never a URL. GET only: this file has no way to write to a mailbox, so a
// bug above it cannot send, delete or change a mail through it (slice 2 adds ONE narrow write beside it).
import type { AccountId } from './config.js'

export class GoogleError extends Error {
  constructor(
    /** the HTTP status Google answered, or 0 when there was no answer */
    readonly status: number,
    /** a fixed word; Google's own text can echo an address or a query, so it is never kept */
    readonly kind: 'token' | 'request' | 'network',
  ) {
    super(`google ${kind} ${status}`)
  }
}

/** Reads one JSON document of Google's API as the named account. */
export interface GoogleApi {
  getJson(account: AccountId, url: string): Promise<unknown>
}

const ALLOWED_PREFIXES = [
  'https://gmail.googleapis.com/gmail/v1/users/me/',
  'https://www.googleapis.com/calendar/v3/calendars/primary/events',
] as const
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TIMEOUT_MS = 15_000

export interface GoogleRestOptions {
  clientId: string
  clientSecret: string
  refreshTokens: Readonly<Record<AccountId, string>>
  fetchImpl?: typeof fetch
  nowMs?: () => number
}

export function googleRest(opts: GoogleRestOptions): GoogleApi {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.nowMs ?? Date.now
  const cache = new Map<AccountId, { token: string; until: number }>()

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      // redirect: 'error': a redirect would carry the bearer header to whatever host it names
      return await doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new GoogleError(0, 'network')
    }
  }

  async function accessToken(account: AccountId): Promise<string> {
    const hit = cache.get(account)
    if (hit && hit.until > now() + 60_000) return hit.token
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refresh_token: opts.refreshTokens[account],
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) throw new GoogleError(res.status, 'token')
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!body || typeof body.access_token !== 'string' || body.access_token === '') throw new GoogleError(res.status, 'token')
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3000
    cache.set(account, { token: body.access_token, until: now() + seconds * 1000 })
    return body.access_token
  }

  return {
    async getJson(account, url) {
      if (!ALLOWED_PREFIXES.some((p) => url.startsWith(p))) throw new GoogleError(0, 'request')
      const token = await accessToken(account)
      const res = await call(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new GoogleError(res.status, 'request')
      try {
        return await res.json()
      } catch {
        throw new GoogleError(res.status, 'request')
      }
    },
  }
}
