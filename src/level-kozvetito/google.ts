// The relay's only door to Google. The URL is built by the relay from a fixed set of shapes; a caller
// supplies ids and search text, never a URL. READING is GET on two fixed prefixes. WRITING (`postJson`) is
// refused unless the URL matches a shape the CALLER OF THIS MODULE named at construction: this file names
// none, so a bug here or above it cannot send, delete or change a mail. The only shapes ever passed are
// the two in `modify.ts` (create a label, change the labels of one message), and the source test allows the
// words for them in that file alone.
import { ACCOUNTS, type AccountId } from './config.js'

export const TOKEN_ERROR_CODES = ['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request'] as const
export type TokenErrorCode = (typeof TOKEN_ERROR_CODES)[number]

export class GoogleError extends Error {
  constructor(
    /** the HTTP status Google answered, or 0 when there was no answer */
    readonly status: number,
    /** a fixed word; Google's own text can echo an address or a query, so it is never kept */
    readonly kind: 'token' | 'request' | 'network',
    /** Google's `error` word of a refused token request, kept ONLY when it is one of the fixed words above */
    readonly code?: TokenErrorCode,
  ) {
    super(`google ${kind} ${status}`)
  }
}

/** Reads one JSON document of Google's API as the named account. */
export interface GoogleApi {
  getJson(account: AccountId, url: string): Promise<unknown>
  /** POSTs a JSON body to a URL that matches a shape named at construction; nothing else is ever posted. */
  postJson(account: AccountId, url: string, body: unknown): Promise<unknown>
}

/** The secret door's pre-flight, a separate type: the mail code is handed a `GoogleApi` and cannot reach it. */
export interface ClientSecretProbe {
  /**
   * Asks the token endpoint for an access token with a candidate client secret, trying each account's refresh
   * token; one success accepts it, otherwise it throws the most telling refusal. It changes nothing at Google
   * (a refresh only issues an access token) and keeps nothing, not even the access token it got:
   * the contract's pre-flight for a new `oauth-client-secret` (task parancssor-f-titok-urlap).
   */
  probeClientSecret(candidate: string): Promise<void>
}

const ALLOWED_PREFIXES = [
  'https://gmail.googleapis.com/gmail/v1/users/me/',
  'https://www.googleapis.com/calendar/v3/calendars/primary/events',
] as const
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TIMEOUT_MS = 15_000

export interface GoogleRestOptions {
  /** The URL shapes a POST may go to. Empty (the default): this transport cannot write at all. */
  writeShapes?: readonly RegExp[]
  /** a value, or a function read at the moment of use: the secret store can then change a value without a restart */
  clientId: string | (() => string)
  clientSecret: string | (() => string)
  refreshTokens: Readonly<Record<AccountId, string>>
  fetchImpl?: typeof fetch
  nowMs?: () => number
}

export function googleRest(opts: GoogleRestOptions): GoogleApi & ClientSecretProbe {
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

  const valueOf = (v: string | (() => string)): string => (typeof v === 'function' ? v() : v)

  /** The one place the token endpoint is called: the cached path and the candidate pre-flight both come here. */
  async function refresh(account: AccountId, clientSecret: string): Promise<{ token: string; seconds: number }> {
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: valueOf(opts.clientId),
        client_secret: clientSecret,
        refresh_token: opts.refreshTokens[account],
        grant_type: 'refresh_token',
      }),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null
    if (!res.ok) {
      // only a word from the fixed list survives; Google's own text can echo the request
      const word = (TOKEN_ERROR_CODES as readonly unknown[]).find((c) => c === body?.error) as TokenErrorCode | undefined
      throw new GoogleError(res.status, 'token', word)
    }
    if (!body || typeof body.access_token !== 'string' || body.access_token === '') throw new GoogleError(res.status, 'token')
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3000
    return { token: body.access_token, seconds }
  }

  async function accessToken(account: AccountId): Promise<string> {
    const hit = cache.get(account)
    if (hit && hit.until > now() + 60_000) return hit.token
    const { token, seconds } = await refresh(account, valueOf(opts.clientSecret))
    cache.set(account, { token, until: now() + seconds * 1000 })
    return token
  }

  const writeShapes = opts.writeShapes ?? []
  return {
    async probeClientSecret(candidate) {
      // BOTH refresh tokens are tried; ONE access token is enough to accept the candidate. A refusal that says
      // invalid_grant is about that account's refresh token (a withdrawn consent), not about the candidate, so the
      // other account may still prove it. The access tokens obtained here are dropped, never cached: the candidate
      // is not active yet.
      const failures: GoogleError[] = []
      for (const account of ACCOUNTS) {
        try {
          await refresh(account, candidate)
          return
        } catch (err) {
          if (!(err instanceof GoogleError)) throw err
          failures.push(err)
        }
      }
      // nothing succeeded: report the most telling failure (a refused client first, then a refused grant, then any other)
      throw failures.find((f) => f.code === 'invalid_client') ?? failures.find((f) => f.code === 'invalid_grant') ?? failures[0]!
    },
    async postJson(account, url, body) {
      if (!writeShapes.some((shape) => shape.test(url))) throw new GoogleError(0, 'request')
      const token = await accessToken(account)
      const res = await call(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new GoogleError(res.status, 'request')
      try {
        return await res.json()
      } catch {
        throw new GoogleError(res.status, 'request')
      }
    },
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
