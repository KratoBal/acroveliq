// The one-time consent for a mailbox (install step, run by the owner). It replaces `gcal.sh auth-url|auth-code` for
// the relay's two accounts, with the scope fixed IN CODE per account: the relay's tokens carry what the relay
// needs and nothing more. balazs@ gets gmail.modify (labels, archive; sending is not called by any code here, see
// modify.ts and the source test); info@ gets read access to mail and calendar and NOT gmail.send, which its old
// token (2026-08-21) still carries. A consent is Balázs's click; nothing here can do it for him.
import type { AccountId } from './config.js'

export const SCOPES: Readonly<Record<AccountId, readonly string[]>> = {
  info: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'],
  balazs: ['https://www.googleapis.com/auth/gmail.modify'],
}

/** Google's loopback redirect: the page does not load; the person copies the address bar (the code is in it). */
export const REDIRECT = 'http://localhost:8765/'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export class OauthError extends Error {}

export function consentUrl(clientId: string, account: AccountId, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES[account].join(' '),
    // without offline there is no refresh token, only an hour of access; without consent a repeat grant returns none
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH_URL}?${q.toString()}`
}

/**
 * The code from what the person pasted: the whole redirect address (preferred: its `state` must be the one we
 * issued, so a code from someone else's consent is refused) or the bare code.
 */
export function codeFrom(pasted: string, expectedState: string): string {
  const text = pasted.trim()
  if (!text.includes('code=')) {
    if (text === '' || /\s/.test(text)) throw new OauthError('no code in what was pasted')
    return text
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new OauthError('the pasted address does not parse')
  }
  if (url.searchParams.get('state') !== expectedState) throw new OauthError('the state does not match the consent we started')
  const code = url.searchParams.get('code')
  if (!code) throw new OauthError('no code in the pasted address')
  return code
}

/**
 * Exchanges the code for a refresh token and checks that the grant is EXACTLY the scope set of the account:
 * a broader grant (the person ticked more, or Google merged an older grant) refuses, so a token wider than the
 * relay's code assumes is never stored.
 */
export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; code: string; account: AccountId },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new OauthError('no answer from the token endpoint')
  }
  // Google's own error text can echo the request; only the status is kept
  if (!res.ok) throw new OauthError(`the token endpoint refused the code (HTTP ${res.status})`)
  const body = (await res.json().catch(() => null)) as { refresh_token?: unknown; scope?: unknown } | null
  if (!body || typeof body.refresh_token !== 'string' || body.refresh_token === '') {
    throw new OauthError('an access token came back but no refresh token: offline access or consent was not asked')
  }
  const granted = typeof body.scope === 'string' ? body.scope.split(' ').filter((s) => s !== '').sort() : []
  const wanted = [...SCOPES[opts.account]].sort()
  if (granted.length !== wanted.length || granted.some((s, i) => s !== wanted[i])) {
    throw new OauthError(`the granted scope is not exactly what ${opts.account} is meant to have: ${granted.join(' ') || '(none reported)'}`)
  }
  return body.refresh_token
}
