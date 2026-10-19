// The secret form's backend and its client of the mail relay (task parancssor-f-titok-urlap, contract v2 section 2.9).
// WHAT TURNS THIS RED: anyone but the owner's logged-in session reaching the relay (an agent token, the shared token,
// a device key, another user, no principal, the AcrovelIQ surface); the value in an answer or an error text; a
// relay's own words reaching the browser; the writer token read from a file other users can read; a settings value
// sending the token to a host that is not the relay or loopback; a redirect followed; a retry.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', DECISION_OWNER_USER: 'balazs' }
})

import { tryHandleTitokUrlap, type SecretDoorCaller } from '../web/routes/titok-urlap.js'
import type { RouteContext } from '../web/routes/types.js'
import { callSecretDoor } from '../web/titok-kozvetito.js'

type Auth = RouteContext['auth']
const SESSION: Auth = { kind: 'session', user: 'balazs' }
const NOBODY = 'nobody' as const
const VALUE = 'ZXQV-unique-panel-marker-5521'
const PATH = '/api/titok-urlap/oauth-client-secret'

async function call(
  verb: string,
  rawBody: string | undefined,
  who: Auth | typeof NOBODY,
  door: SecretDoorCaller,
  extra: Partial<RouteContext> = {},
  method = 'POST',
) {
  let status = 200
  let text = ''
  const res: any = {
    statusCode: 200,
    setHeader() {
      return res
    },
    writeHead(code: number) {
      status = code
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk) text += chunk.toString()
    },
  }
  const req: any = {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && rawBody) cb(Buffer.from(rawBody))
      if (event === 'end') cb()
    },
    destroy() {},
  }
  const url = new URL(`http://localhost:3420${PATH}/${verb}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: who === NOBODY ? undefined : who, ...extra } as unknown as RouteContext
  const handled = await tryHandleTitokUrlap(ctx, door)
  return { handled, status, text, body: text ? JSON.parse(text) : null }
}

const okDoor = () => {
  const calls: { target: string; verb: string; value: string | null }[] = []
  const door: SecretDoorCaller = async (target, verb, value) => {
    calls.push({ target, verb, value })
    return { status: 200, body: { cel: target, hossz: 40, verzio: 1, allapot: 'rotacio-nyitva' } }
  }
  return { calls, door }
}

describe('who may reach the relay through the form', () => {
  it("the owner's session does: the value goes to the relay, and the answer is the length, the version and the state", async () => {
    const { calls, door } = okDoor()
    const r = await call('ir', JSON.stringify({ ertek: VALUE }), SESSION, door)
    expect([r.handled, r.status, r.body]).toEqual([
      true,
      200,
      { cel: 'oauth-client-secret', hossz: 40, verzio: 1, allapot: 'rotacio-nyitva' },
    ])
    expect(calls).toEqual([{ target: 'oauth-client-secret', verb: 'ir', value: VALUE }])
    expect(r.text).not.toContain(VALUE)
  })

  it.each([
    ["the main agent's token", { kind: 'token', actor: 'acrobot', project: 'acropora' } as Auth],
    ["another agent's token", { kind: 'token', actor: 'nautilus', project: 'acropora' } as Auth],
    ['the shared token', { kind: 'token', actor: 'legacy' } as Auth],
    ['a token with no actor', { kind: 'token' } as Auth],
    ['a device key', { kind: 'device', device: 'telefon' } as Auth],
    ['a federation peer', { kind: 'federation', peer: 'masik' } as Auth],
    ['a session with no user', { kind: 'session', user: '' } as Auth],
    ['another dashboard user', { kind: 'session', user: 'luca' } as Auth],
    ["the owner's name in another case", { kind: 'session', user: 'Balazs' } as Auth],
    ['no principal at all', NOBODY],
  ])('%s: 403, and the relay is NOT called', async (_n, who) => {
    const { calls, door } = okDoor()
    for (const verb of ['ir', 'lezar', 'visszaall']) {
      const r = await call(verb, JSON.stringify(verb === 'ir' ? { ertek: VALUE } : {}), who, door)
      expect([r.handled, r.status]).toEqual([true, 403])
      expect(r.text).not.toContain(VALUE)
    }
    expect(calls).toEqual([])
  })

  it("the AcrovelIQ surface: 403 even for the owner's session, relay not called", async () => {
    const { calls, door } = okDoor()
    expect((await call('ir', JSON.stringify({ ertek: VALUE }), SESSION, door, { surface: 'acroveliq' })).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('it holds in EVERY access mode: a mode that only logs does not open it', async () => {
    const { calls, door } = okDoor()
    for (const accessMode of ['naplo', 'enforce', 'off'] as const) {
      const r = await call('ir', JSON.stringify({ ertek: VALUE }), { kind: 'token', actor: 'acrobot', project: 'acropora' }, door, {
        accessMode: accessMode as any,
      })
      expect(r.status).toBe(403)
    }
    expect(calls).toEqual([])
  })

  it("a path or method that is not the form's is not handled at all", async () => {
    const { calls, door } = okDoor()
    expect((await call('ir', JSON.stringify({ ertek: VALUE }), SESSION, door, {}, 'GET')).handled).toBe(false)
    const other = await call('torol', '{}', SESSION, door)
    expect(other.handled).toBe(false)
    const ctxOther = {
      req: {},
      res: {},
      path: '/api/titok-urlap/oauth-client-id/ir',
      method: 'POST',
      url: new URL('http://x/'),
      auth: SESSION,
    } as unknown as RouteContext
    expect(await tryHandleTitokUrlap(ctxOther, door)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('the body of the form', () => {
  const cases: [string, string, string | undefined, number, string][] = [
    ['not JSON', 'ir', `{"ertek": "${VALUE}`, 400, 'ervenytelen-keres'],
    ['not an object', 'ir', JSON.stringify([VALUE]), 400, 'ervenytelen-keres'],
    ['another key beside the value', 'ir', JSON.stringify({ ertek: VALUE, masik: 1 }), 400, 'ervenytelen-keres'],
    ['no value', 'ir', '{}', 400, 'ervenytelen-keres'],
    ['a value that is not a string', 'ir', JSON.stringify({ ertek: 12345678 }), 400, 'ervenytelen-keres'],
    ['a key on lezar', 'lezar', JSON.stringify({ ertek: VALUE }), 400, 'ervenytelen-keres'],
    ['a key on visszaall', 'visszaall', JSON.stringify({ x: 1 }), 400, 'ervenytelen-keres'],
    ['too large', 'ir', JSON.stringify({ ertek: VALUE.padEnd(3000, 'a') }), 413, 'torzs-tul-nagy'],
  ]
  it.each(cases)(
    '%s: refused with a fixed text that does not quote the body, and the relay is not called',
    async (_n, verb, raw, status, error) => {
      const { calls, door } = okDoor()
      const r = await call(verb, raw, SESSION, door)
      expect([r.status, r.body]).toEqual([status, { error }])
      expect(r.text).not.toContain(VALUE)
      expect(calls).toEqual([])
    },
  )

  it('lezar and visszaall go to the relay with no value, an empty body is fine', async () => {
    const { calls, door } = okDoor()
    expect((await call('lezar', undefined, SESSION, door)).status).toBe(200)
    expect((await call('visszaall', '{}', SESSION, door)).status).toBe(200)
    expect(calls).toEqual([
      { target: 'oauth-client-secret', verb: 'lezar', value: null },
      { target: 'oauth-client-secret', verb: 'visszaall', value: null },
    ])
  })

  it("the relay's answer, even an error, goes back as it came: status and fixed body", async () => {
    const door: SecretDoorCaller = async () => ({ status: 502, body: { error: 'frissito-token-hiba' } })
    const r = await call('ir', JSON.stringify({ ertek: VALUE }), SESSION, door)
    expect([r.status, r.body]).toEqual([502, { error: 'frissito-token-hiba' }])
  })
})

describe("the client of the relay's secret door", () => {
  let dir: string
  let tokenFile: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'titok-urlap-'))
    tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'writer-token-value\n', { mode: 0o400 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return respond(url, init)
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }
  const answer =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status })

  it('posts to the fixed relay address, the token only in the header, the value only in the body, no redirect followed', async () => {
    const { calls, fetchImpl } = fakeFetch(answer({ cel: 'oauth-client-secret', hossz: 40, verzio: 1, allapot: 'rotacio-nyitva' }))
    const out = await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl })
    expect(out).toEqual({ status: 200, body: { cel: 'oauth-client-secret', hossz: 40, verzio: 1, allapot: 'rotacio-nyitva' } })
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://levelkozvetito:8788/titok/oauth-client-secret/ir')
    expect((c.init.headers as Record<string, string>)['Authorization']).toBe('Bearer writer-token-value')
    expect(c.init.body).toBe(JSON.stringify({ ertek: VALUE }))
    expect(c.init.redirect).toBe('error')
    expect(c.url + JSON.stringify(c.init.headers)).not.toContain(VALUE)
  })

  it('lezar sends an empty object, never a value', async () => {
    const { calls, fetchImpl } = fakeFetch(answer({ cel: 'oauth-client-secret', hossz: 40, verzio: 1, allapot: 'aktiv' }))
    await callSecretDoor('oauth-client-secret', 'lezar', VALUE, { tokenFile, fetchImpl })
    expect(calls[0]!.init.body).toBe('{}')
  })

  it('a token file that other users can read is refused before any request', async () => {
    chmodSync(tokenFile, 0o640)
    const { calls, fetchImpl } = fakeFetch(answer({}))
    expect(await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl })).toEqual({
      status: 503,
      body: { error: 'iro-token-hiany' },
    })
    expect(calls).toEqual([])
  })

  it.each([
    ['a missing token file', () => join(dir, 'nincs')],
    [
      'an empty token file',
      () => {
        writeFileSync(join(dir, 'ures'), '\n', { mode: 0o400 })
        return join(dir, 'ures')
      },
    ],
    [
      'a token file with whitespace',
      () => {
        writeFileSync(join(dir, 'ketto'), 'a b', { mode: 0o400 })
        return join(dir, 'ketto')
      },
    ],
  ])('%s: refused before any request', async (_n, file) => {
    const { calls, fetchImpl } = fakeFetch(answer({}))
    expect((await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile: file(), fetchImpl })).status).toBe(503)
    expect(calls).toEqual([])
  })

  it('a URL setting counts only for loopback: any other host is ignored and the relay address is used', async () => {
    for (const url of [
      'http://evil.example:8788',
      'https://127.0.0.1:1',
      'http://127.0.0.1.evil.example',
      'http://localhost@evil.example',
    ]) {
      const { calls, fetchImpl } = fakeFetch(answer({ cel: 'oauth-client-secret', hossz: 1, verzio: 1, allapot: 'aktiv' }))
      await callSecretDoor('oauth-client-secret', 'lezar', null, { tokenFile, fetchImpl, url })
      expect(calls[0]!.url, url).toBe('http://levelkozvetito:8788/titok/oauth-client-secret/lezar')
    }
    const { calls, fetchImpl } = fakeFetch(answer({ cel: 'oauth-client-secret', hossz: 1, verzio: 1, allapot: 'aktiv' }))
    await callSecretDoor('oauth-client-secret', 'lezar', null, { tokenFile, fetchImpl, url: 'http://127.0.0.1:9999' })
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/titok/oauth-client-secret/lezar')
  })

  it('a relay error: only a word from the fixed list goes on; anything else is `kozvetito-hiba`, and the value is never in it', async () => {
    const reasons = [
      'caller',
      'foglalt',
      'rate-limit',
      'rotacio-nyitva',
      'nincs-nyitott-rotacio',
      'szolgaltato-elutasitotta',
      'frissito-token-hiba',
      'szolgaltato-nem-elerheto',
    ]
    for (const reason of reasons) {
      const { fetchImpl } = fakeFetch(answer({ error: reason }, 502))
      expect((await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl })).body).toEqual({ error: reason })
    }
    const echo = fakeFetch(answer({ error: `bad value ${VALUE} for balazs@acropora.example` }, 500))
    const out = await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl: echo.fetchImpl })
    expect(out).toEqual({ status: 500, body: { error: 'kozvetito-hiba' } })
    const bad400 = fakeFirst(400, { error: `ertek: ${VALUE}` })
    expect(await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl: bad400 })).toEqual({
      status: 400,
      body: { error: 'ervenytelen-keres' },
    })
  })

  function fakeFirst(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  }

  it('a success answer with another shape is not passed on as a success', async () => {
    const { fetchImpl } = fakeFetch(answer({ cel: 'oauth-client-secret', hossz: '40', verzio: 1, allapot: 'aktiv', ertek: VALUE }))
    const out = await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl })
    expect(out.status).toBe(502)
    expect(JSON.stringify(out)).not.toContain(VALUE)
  })

  it('a network failure whose message holds the value answers with a fixed word, once (no retry)', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      throw new Error(`connect ECONNREFUSED while sending ${VALUE}`)
    }) as unknown as typeof fetch
    const out = await callSecretDoor('oauth-client-secret', 'ir', VALUE, { tokenFile, fetchImpl })
    expect(out).toEqual({ status: 502, body: { error: 'kozvetito-nem-elerheto' } })
    expect(n).toBe(1)
  })
})
