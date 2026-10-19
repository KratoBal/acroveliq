// The relay's door (HTTP), its strict settings, and its single way to Google. WHAT TURNS THIS RED: an answer
// without the caller's bearer token; a body that is not JSON, too large, or not an object, being accepted;
// Google's own words reaching the caller; a settings file that starts with an unknown key, a duplicate token,
// a relative path or a missing field; a call to a URL outside the two fixed Google shapes; a redirect being followed;
// a Google error text being kept; the access token being fetched again on every call.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseRelayConfig } from '../level-kozvetito/config.js'
import { GoogleError, googleRest, type GoogleApi } from '../level-kozvetito/google.js'
import { createRelayServer, MAX_BODY_BYTES } from '../level-kozvetito/http.js'
import { MailRelay } from '../level-kozvetito/relay.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const BASE = {
  stateDir: '/var/lib/levelkozvetito',
  quarantineDir: '/var/lib/levelkozvetito/karanten',
  oauthClientIdFile: '/run/secrets/client-id',
  oauthClientSecretFile: '/run/secrets/client-secret',
  callers: [{ name: 'acrobot', tokenSha256: sha('token-acrobot') }],
  accounts: {
    info: { address: 'info@acropora.example', refreshTokenFile: '/run/secrets/info', calendar: true, redaction: 'all-short-numbers' },
    balazs: { address: 'balazs@acropora.example', refreshTokenFile: '/run/secrets/balazs', calendar: false, redaction: 'all-short-numbers' },
  },
  excludedSenders: { domains: ['bank.example'], addresses: [] },
  limits: { callsPerMinute: 60, maxAttachmentBytes: 1000 },
}

const clone = () => JSON.parse(JSON.stringify(BASE)) as Record<string, any>

describe('the settings are strict', () => {
  it('a good file parses, with the domains and addresses lower-cased', () => {
    const c = clone()
    c['excludedSenders'] = { domains: ['Bank.Example'], addresses: ['Biztonsag@Szolg.example'] }
    const parsed = parseRelayConfig(c)
    expect(parsed.excludedSenders).toEqual({ domains: ['bank.example'], addresses: ['biztonsag@szolg.example'] })
    expect(parsed.accounts.balazs.calendar).toBe(false)
  })

  it('the example in the repository parses (the shape an installer copies)', () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), 'level-kozvetito', 'config.example.json'), 'utf8'))
    const parsed = parseRelayConfig(example)
    expect([parsed.callers.length, parsed.accounts.info.calendar, parsed.accounts.balazs.calendar, parsed.excludedSenders.domains.includes('accounts.google.com')]).toEqual([1, true, false, true])
  })

  const bad: [string, (c: Record<string, any>) => void][] = [
    ['an unknown top-level key', (c) => { c['extra'] = 1 }],
    ['an unknown key in an account', (c) => { c['accounts'].info.scope = 'x' }],
    ['a missing field', (c) => { delete c['limits'] }],
    ['no callers', (c) => { c['callers'] = [] }],
    ['a duplicate caller name', (c) => { c['callers'].push({ name: 'acrobot', tokenSha256: sha('mas') }) }],
    ['one token for two callers', (c) => { c['callers'].push({ name: 'masik', tokenSha256: sha('token-acrobot') }) }],
    ['a token that is not a hex sha256', (c) => { c['callers'][0].tokenSha256 = 'token-acrobot' }],
    ['a relative path', (c) => { c['stateDir'] = 'var/lib' }],
    ['a path with ..', (c) => { c['quarantineDir'] = '/var/lib/../etc' }],
    ['an unknown redaction mode', (c) => { c['accounts'].info.redaction = 'none' }],
    ['a calendar flag that is not a boolean', (c) => { c['accounts'].info.calendar = 'igen' }],
    ['a limit out of range', (c) => { c['limits'].callsPerMinute = 0 }],
    ['a bad excluded domain', (c) => { c['excludedSenders'].domains = ['nem domain'] }],
    ['an account address that is not an address', (c) => { c['accounts'].balazs.address = 'balazs' }],
  ]
  it.each(bad)('refuses %s', (_name, change) => {
    const c = clone()
    change(c)
    expect(() => parseRelayConfig(c)).toThrow(/relay config/)
  })
})

describe('the HTTP door', () => {
  const servers: ReturnType<typeof createRelayServer>[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  })

  async function start(google: GoogleApi) {
    const relay = new MailRelay({ config: parseRelayConfig(clone()), google, log: () => {} })
    const server = createRelayServer(relay)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return (path: string, init: RequestInit & { token?: string } = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string>) },
      })
  }
  const quiet: GoogleApi = { getJson: async () => ({ messages: [] }) }

  it('answers healthz, and 404 elsewhere', async () => {
    const call = await start(quiet)
    expect((await call('/healthz')).status).toBe(200)
    expect((await call('/nincs')).status).toBe(404)
    expect((await call('/info/lista')).status).toBe(404) // GET on a verb path
  })

  it('without the bearer token: 403; with it: the answer', async () => {
    const call = await start(quiet)
    expect((await call('/info/lista', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await call('/info/lista', { method: 'POST', body: '{}', token: 'rossz' })).status).toBe(403)
    const ok = await call('/info/lista', { method: 'POST', body: '{}', token: 'token-acrobot' })
    expect([ok.status, await ok.json()]).toEqual([200, { items: [] }])
  })

  it('refuses a body that is not JSON, not an object, too large, or of another content type', async () => {
    const call = await start(quiet)
    const post = (body: string, headers?: Record<string, string>) => call('/info/lista', { method: 'POST', body, token: 'token-acrobot', headers })
    expect((await post('nem json')).status).toBe(400)
    expect((await post('[1,2]')).status).toBe(400)
    expect((await post(JSON.stringify({ q: 'x'.repeat(MAX_BODY_BYTES) }))).status).toBe(400)
    expect((await post('{}', { 'Content-Type': 'text/plain' })).status).toBe(400)
  })

  it('a verb that does not exist: 404 with a fixed text; a Google failure: 502 with a fixed text, not Google\'s', async () => {
    const failing: GoogleApi = { getJson: async () => { throw new GoogleError(500, 'request') } }
    const call = await start(failing)
    const missing = await call('/info/kuld', { method: 'POST', body: '{}', token: 'token-acrobot' })
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'no such verb' }])
    const down = await call('/info/lista', { method: 'POST', body: '{}', token: 'token-acrobot' })
    const text = JSON.stringify(await down.json())
    expect(down.status).toBe(502)
    expect(text).not.toMatch(/500|request/)
  })
})

/** The GoogleError a call fails with; a call that does not fail is itself a failure of the test. */
async function failure(call: Promise<unknown>): Promise<GoogleError> {
  try {
    await call
  } catch (e) {
    return e as GoogleError
  }
  throw new Error('the call was expected to fail')
}

describe('the single way to Google', () => {
  function transport(responses: ((url: string, init: RequestInit) => Response)[]) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = responses.shift()
      if (!next) throw new Error('unexpected call')
      return next(url, init)
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
  const opts = { clientId: 'cid', clientSecret: 'csecret', refreshTokens: { info: 'rt-info', balazs: 'rt-balazs' } }

  it('refreshes the access token per account, caches it, and sends it only to the two fixed shapes', async () => {
    const { calls, fetchImpl } = transport([
      json({ access_token: 'at-info', expires_in: 3600 }),
      json({ ok: 1 }),
      json({ ok: 2 }),
      json({ access_token: 'at-balazs', expires_in: 3600 }),
      json({ ok: 3 }),
    ])
    const api = googleRest({ ...opts, fetchImpl, nowMs: () => 1_000_000 })
    await api.getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=x')
    await api.getJson('info', 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1')
    await api.getJson('balazs', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=full')
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc',
    ])
    expect((calls[1]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-info')
    expect((calls[4]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-balazs')
    expect(String(calls[0]!.init.body)).toContain('refresh_token=rt-info')
    expect(String(calls[3]!.init.body)).toContain('refresh_token=rt-balazs')
  })

  it('never follows a redirect (the bearer header would go with it)', async () => {
    const { calls, fetchImpl } = transport([json({ access_token: 'at', expires_in: 3600 }), json({})])
    const api = googleRest({ ...opts, fetchImpl })
    await api.getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages')
    expect(calls.every((c) => c.init.redirect === 'error')).toBe(true)
  })

  it.each([
    ['another host', 'https://evil.example/gmail/v1/users/me/messages'],
    ['a lookalike host', 'https://gmail.googleapis.com.evil.example/gmail/v1/users/me/messages'],
    ['plain http', 'http://gmail.googleapis.com/gmail/v1/users/me/messages'],
    ['a Gmail path outside users/me', 'https://gmail.googleapis.com/gmail/v1/users/other/messages'],
    ['another calendar', 'https://www.googleapis.com/calendar/v3/calendars/other/events'],
    ['the Drive API', 'https://www.googleapis.com/drive/v3/files'],
  ])('refuses %s without a single call', async (_name, url) => {
    const { calls, fetchImpl } = transport([])
    const api = googleRest({ ...opts, fetchImpl })
    await expect(api.getJson('info', url)).rejects.toBeInstanceOf(GoogleError)
    expect(calls).toEqual([])
  })

  it('keeps no word of Google\'s answer in the error, and tells a token failure from a request failure', async () => {
    const tokenFail = transport([json({ error: 'invalid_grant', error_description: 'info@acropora.example' }, 400)])
    const e1 = await failure(googleRest({ ...opts, fetchImpl: tokenFail.fetchImpl }).getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages'))
    expect([e1.kind, e1.status, e1.message]).toEqual(['token', 400, 'google token 400'])
    const reqFail = transport([json({ access_token: 'at', expires_in: 3600 }), json({ error: { message: 'q=titkos' } }, 403)])
    const e2 = await failure(googleRest({ ...opts, fetchImpl: reqFail.fetchImpl }).getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages'))
    expect([e2.kind, e2.status, e2.message]).toEqual(['request', 403, 'google request 403'])
  })

  it('a network failure is a GoogleError of kind network, not a raw error', async () => {
    const fetchImpl = (async () => { throw new TypeError('connect ECONNREFUSED') }) as unknown as typeof fetch
    const e = await failure(googleRest({ ...opts, fetchImpl }).getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages'))
    expect([e.kind, e.status]).toEqual(['network', 0])
  })
})
