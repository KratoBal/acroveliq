// The consent for the relay's two mailboxes: the scope is fixed in code per account, the pasted address must carry
// the state we issued, and a grant that is not exactly the account's scope set is never stored.
import { describe, expect, it } from 'vitest'

import { codeFrom, consentUrl, exchangeCode, OauthError, REDIRECT, SCOPES } from '../level-kozvetito/oauth.js'

function tokenEndpoint(reply: { status?: number; body: unknown }, seen?: { body?: URLSearchParams }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (seen) seen.body = init?.body as URLSearchParams
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
}

const base = { clientId: 'cid', clientSecret: 'csecret', code: 'abc' }

describe('the consent address', () => {
  it('asks for offline access and a fresh consent, with the account scope and our state', () => {
    const url = new URL(consentUrl('cid', 'balazs', 'st123'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st123',
    })
  })

  it('info@ is asked for reading only: no send, no modify, no calendar write', () => {
    const scopes = new URL(consentUrl('cid', 'info', 's')).searchParams.get('scope')!
    expect(scopes.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ])
    for (const account of ['info', 'balazs'] as const) {
      expect(SCOPES[account].join(' ')).not.toMatch(/gmail\.(send|compose)|mail\.google\.com/)
    }
  })
})

describe('the code from what was pasted', () => {
  it('takes the code from the whole redirect address when the state is ours', () => {
    expect(codeFrom('http://localhost:8765/?state=st1&code=4%2Fabc&scope=x', 'st1')).toBe('4/abc')
  })
  it('refuses an address whose state is not the one we issued', () => {
    expect(() => codeFrom('http://localhost:8765/?state=other&code=abc', 'st1')).toThrow(OauthError)
  })
  it('refuses an address without a state at all', () => {
    expect(() => codeFrom('http://localhost:8765/?code=abc', 'st1')).toThrow(OauthError)
  })
  it('accepts a bare code, and refuses an empty or spaced paste', () => {
    expect(codeFrom('  4/abc\n', 'st1')).toBe('4/abc')
    expect(() => codeFrom('   ', 'st1')).toThrow(OauthError)
    expect(() => codeFrom('two words', 'st1')).toThrow(OauthError)
  })
})

describe('the exchange', () => {
  it('returns the refresh token when the grant is exactly the account scope set', async () => {
    const seen: { body?: URLSearchParams } = {}
    const f = tokenEndpoint({ body: { refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.modify' } }, seen)
    await expect(exchangeCode({ ...base, account: 'balazs' }, f)).resolves.toBe('rt')
    expect(seen.body?.get('grant_type')).toBe('authorization_code')
    expect(seen.body?.get('redirect_uri')).toBe(REDIRECT)
  })
  it('compares the scope set regardless of order', async () => {
    const f = tokenEndpoint({
      body: { refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/gmail.readonly' },
    })
    await expect(exchangeCode({ ...base, account: 'info' }, f)).resolves.toBe('rt')
  })
  it('refuses a WIDER grant than the account is meant to have', async () => {
    const f = tokenEndpoint({
      body: { refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.readonly' },
    })
    await expect(exchangeCode({ ...base, account: 'info' }, f)).rejects.toThrow(/not exactly/)
  })
  it('refuses a NARROWER grant, and a reply that names no scope', async () => {
    await expect(
      exchangeCode({ ...base, account: 'info' }, tokenEndpoint({ body: { refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.readonly' } })),
    ).rejects.toThrow(/not exactly/)
    await expect(exchangeCode({ ...base, account: 'balazs' }, tokenEndpoint({ body: { refresh_token: 'rt' } }))).rejects.toThrow(/not exactly/)
  })
  it('refuses an answer without a refresh token', async () => {
    const f = tokenEndpoint({ body: { access_token: 'at', scope: 'https://www.googleapis.com/auth/gmail.modify' } })
    await expect(exchangeCode({ ...base, account: 'balazs' }, f)).rejects.toThrow(/no refresh token/)
  })
  it('refuses an EMPTY refresh token the same way', async () => {
    const f = tokenEndpoint({ body: { refresh_token: '', scope: 'https://www.googleapis.com/auth/gmail.modify' } })
    await expect(exchangeCode({ ...base, account: 'balazs' }, f)).rejects.toThrow(/no refresh token/)
  })
  it('keeps only the status of a refusal, never the endpoint text', async () => {
    const f = tokenEndpoint({ status: 400, body: { error: 'invalid_grant', error_description: 'secret csecret echoed' } })
    const err = await exchangeCode({ ...base, account: 'balazs' }, f).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OauthError)
    expect((err as Error).message).toBe('the token endpoint refused the code (HTTP 400)')
  })
})
