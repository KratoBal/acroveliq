// The relay's secret door (task parancssor-f-titok-urlap, contract v2): a value handed to the relay goes into its own
// versioned store and nowhere else. WHAT TURNS THIS RED: the value (or a part of it) in an answer, a log line or an
// error text; a write by anyone but a secret writer; a target or a path that is not in the constant list being
// written; a half-written or lost ACTIVE value; a rotation that cannot be closed after a crash or a rollback; a
// candidate that Google refuses becoming active; the invalid_grant of a withdrawn consent reported as a bad
// candidate; the pre-flight's access token entering the cache; a mail caller writing or a writer reading mail;
// network code appearing in the two new modules.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRelayConfig } from '../level-kozvetito/config.js'
import { GoogleError, googleRest, type ClientSecretProbe, type GoogleApi } from '../level-kozvetito/google.js'
import { createRelayServer } from '../level-kozvetito/http.js'
import { MailRelay } from '../level-kozvetito/relay.js'
import { SecretStore } from '../level-kozvetito/secret-store.js'
import { SecretService } from '../level-kozvetito/titok.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const TARGET = 'oauth-client-secret'
const OLD = 'legacy-secret-value-0'
const NEW1 = 'NEWVALUE-one-4f9a2c71'
const NEW2 = 'NEWVALUE-two-b81d03e5'

const BASE = {
  stateDir: '/var/lib/levelkozvetito',
  quarantineDir: '/var/lib/levelkozvetito/karanten',
  oauthClientIdFile: '/run/secrets/client-id',
  oauthClientSecretFile: '/run/secrets/client-secret',
  callers: [{ name: 'acrobot', tokenSha256: sha('token-acrobot') }],
  accounts: {
    info: {
      address: 'info@acropora.example',
      refreshTokenFile: '/run/secrets/info',
      calendar: true,
      redaction: 'all-short-numbers',
    },
    balazs: {
      address: 'balazs@acropora.example',
      refreshTokenFile: '/run/secrets/balazs',
      calendar: false,
      redaction: 'all-short-numbers',
    },
  },
  excludedSenders: { domains: ['bank.example'], addresses: [] },
  limits: { callsPerMinute: 60, maxAttachmentBytes: 1000, archivePerDay: 100 },
}
const withDoor = (dir: string) => ({
  ...BASE,
  secretStoreDir: dir,
  secretWriters: [{ name: 'vezerlopult', tokenSha256: sha('token-vezerlopult') }],
})

let root: string
let storeDir: string
let legacyFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'titok-'))
  storeDir = join(root, 'titkok-ver')
  mkdirSync(storeDir)
  legacyFile = join(root, 'client-secret')
  writeFileSync(legacyFile, `${OLD}\n`, { mode: 0o400 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const newStore = () => new SecretStore({ dir: storeDir, legacy: { [TARGET]: legacyFile } })
const accept = async () => {}
const files = () => readdirSync(storeDir).sort()

describe('the versioned store', () => {
  it('reads the compose secret (version 0) while no pointer exists, and the rotation is closed', () => {
    const s = newStore()
    expect(s.read(TARGET)).toBe(OLD)
    expect(s.state(TARGET)).toEqual({ verzio: 0, rotacioNyitva: false })
    expect(files()).toEqual([])
  })

  it('a write makes the new value active at once, keeps the old one, and leaves only the version and the pointer on disk', async () => {
    const s = newStore()
    expect(await s.write(TARGET, NEW1, accept)).toEqual({
      verzio: 1,
      rotacioNyitva: true,
    })
    expect(s.read(TARGET)).toBe(NEW1)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v1`])
    expect(statSync(join(storeDir, `${TARGET}.v1`)).mode & 0o777).toBe(0o400)
    // the previous value is still there: the compose secret is never touched by the store
    expect(readFileSync(legacyFile, 'utf8').trim()).toBe(OLD)
    // a fresh store object (a restart) reads the same active value from disk
    expect(newStore().read(TARGET)).toBe(NEW1)
  })

  it('a second write while the rotation is open is refused (409) and changes nothing', async () => {
    const s = newStore()
    await s.write(TARGET, NEW1, accept)
    const before = files()
    await expect(s.write(TARGET, NEW2, accept)).rejects.toMatchObject({
      status: 409,
      reason: 'rotacio-nyitva',
    })
    expect(files()).toEqual(before)
    expect(s.read(TARGET)).toBe(NEW1)
  })

  it('closing deletes the previous value; with the compose secret as the previous there is nothing to delete, and it stays', async () => {
    const s = newStore()
    await s.write(TARGET, NEW1, accept)
    expect(s.close(TARGET)).toEqual({ verzio: 1, rotacioNyitva: false })
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v1`])
    expect(readFileSync(legacyFile, 'utf8').trim()).toBe(OLD)
    // the second rotation: v1 is the previous, and closing removes it
    await s.write(TARGET, NEW2, accept)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v1`, `${TARGET}.v2`])
    s.close(TARGET)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v2`])
    expect(s.read(TARGET)).toBe(NEW2)
  })

  it('closing without an open rotation is refused', () => {
    expect(() => newStore().close(TARGET)).toThrow(expect.objectContaining({ status: 409, reason: 'nincs-nyitott-rotacio' }))
  })

  it('a rollback puts the previous value back, and the discarded newer version is removed by the close that follows (one version file left)', async () => {
    const s = newStore()
    await s.write(TARGET, NEW1, accept)
    s.close(TARGET)
    await s.write(TARGET, NEW2, accept) // v2 active, v1 previous
    expect(s.rollBack(TARGET)).toEqual({ verzio: 1, rotacioNyitva: true })
    expect(s.read(TARGET)).toBe(NEW1)
    // the rotation stays open after a rollback: a new write is refused until someone closes
    await expect(s.write(TARGET, NEW2, accept)).rejects.toMatchObject({
      status: 409,
    })
    s.close(TARGET)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v1`])
    expect(s.read(TARGET)).toBe(NEW1)
  })

  it('a rollback onto the compose secret works, and a later write takes the next number', async () => {
    const s = newStore()
    await s.write(TARGET, NEW1, accept)
    expect(s.rollBack(TARGET)).toEqual({ verzio: 0, rotacioNyitva: true })
    expect(s.read(TARGET)).toBe(OLD)
    s.close(TARGET)
    expect(files()).toEqual([`${TARGET}.aktiv`])
    await s.write(TARGET, NEW2, accept)
    expect(s.read(TARGET)).toBe(NEW2)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v1`])
  })

  it('a rollback without an open rotation is refused', () => {
    expect(() => newStore().rollBack(TARGET)).toThrow(expect.objectContaining({ status: 409 }))
  })

  it('CRASH after the version rename, before the pointer: the active value is still the old one, and the NEXT write is not blocked', async () => {
    const s = newStore()
    await s.write(TARGET, NEW1, accept)
    s.close(TARGET)
    // the state a crash between the version rename and the pointer rename leaves: an unreferenced v2
    writeFileSync(join(storeDir, `${TARGET}.v2`), 'ORPHAN-value-never-active\n', { mode: 0o400 })
    expect(s.read(TARGET)).toBe(NEW1)
    expect(s.state(TARGET)).toEqual({ verzio: 1, rotacioNyitva: false })
    await s.write(TARGET, NEW2, accept)
    expect(s.read(TARGET)).toBe(NEW2)
    expect(readFileSync(join(storeDir, `${TARGET}.v2`), 'utf8').trim()).toBe(NEW2)
    s.close(TARGET)
    expect(files()).toEqual([`${TARGET}.aktiv`, `${TARGET}.v2`])
  })

  it("CRASH before the rename (a temp file is left): the next write removes it, but only this target's", async () => {
    const s = newStore()
    writeFileSync(join(storeDir, `.tmp-${TARGET}-123-abc`), 'half')
    writeFileSync(join(storeDir, '.tmp-other-target-123-abc'), 'not ours')
    await s.write(TARGET, NEW1, accept)
    expect(files()).toEqual(['.tmp-other-target-123-abc', `${TARGET}.aktiv`, `${TARGET}.v1`])
  })

  it('a refused pre-flight changes nothing on disk, not even a temp file', async () => {
    const s = newStore()
    await expect(
      s.write(TARGET, NEW1, async () => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    expect(files()).toEqual([])
    expect(s.read(TARGET)).toBe(OLD)
  })

  it.each(['../etc/passwd', `${TARGET}/..`, 'OAUTH-CLIENT-SECRET', 'oauth-client-id', '', 'constructor', '__proto__'])(
    'the target %j is not in the list: 404, nothing written or read',
    async (name) => {
      const s = newStore()
      await expect(s.write(name, NEW1, accept)).rejects.toMatchObject({
        status: 404,
        reason: 'ismeretlen-cel',
      })
      expect(() => s.read(name)).toThrow(expect.objectContaining({ status: 404 }))
      expect(files()).toEqual([])
    },
  )

  it('refuses to read a secret file that is empty or has whitespace in it', () => {
    rmSync(legacyFile)
    writeFileSync(legacyFile, '\n')
    expect(() => newStore().read(TARGET)).toThrow(/empty or has whitespace/)
    writeFileSync(legacyFile, 'two words')
    expect(() => newStore().read(TARGET)).toThrow(/empty or has whitespace/)
  })

  it('refuses a malformed pointer rather than guessing a version', () => {
    writeFileSync(join(storeDir, `${TARGET}.aktiv`), '{"aktiv":"1"}')
    expect(() => newStore().read(TARGET)).toThrow(/malformed/)
  })
})

describe('the secret service', () => {
  const logs: Record<string, unknown>[] = []
  let now = Date.parse('2026-10-19T12:00:00Z')
  let probe: (candidate: string) => Promise<void>

  function service() {
    const store = newStore()
    const config = parseRelayConfig(withDoor(storeDir))
    const google: ClientSecretProbe = { probeClientSecret: (c) => probe(c) }
    return new SecretService({
      config,
      google,
      store,
      log: (f) => logs.push(f),
      nowMs: () => now,
    })
  }
  const WRITER = 'token-vezerlopult'

  beforeEach(() => {
    logs.length = 0
    now = Date.parse('2026-10-19T12:00:00Z')
    probe = async () => {}
  })

  it('a write answers with the length, the version and the state, and nothing else', async () => {
    const answer = await service().handle(WRITER, TARGET, 'ir', {
      ertek: NEW1,
    })
    expect(answer).toEqual({
      cel: TARGET,
      hossz: NEW1.length,
      verzio: 1,
      allapot: 'rotacio-nyitva',
    })
    expect(newStore().read(TARGET)).toBe(NEW1)
  })

  it('THE VALUE APPEARS NOWHERE: not in the answer, the log, an error text, or any file name; only in its version file', async () => {
    const secretLike = 'ZXQV-unique-marker-81726354'
    const out: string[] = []
    const s = service()
    out.push(JSON.stringify(await s.handle(WRITER, TARGET, 'ir', { ertek: secretLike })))
    // every refusal that has the value in its request
    for (const [body, verb] of [
      [{ ertek: secretLike }, 'ir'], // the rotation is open now: 409
      [{ ertek: secretLike, masik: 1 }, 'ir'],
      [{ ertek: `${secretLike} with space` }, 'ir'],
      [{ ertek: secretLike }, 'lezar'],
    ] as [Record<string, unknown>, string][]) {
      try {
        out.push(JSON.stringify(await s.handle(WRITER, TARGET, verb, body)))
      } catch (e) {
        out.push(String((e as Error).message), JSON.stringify(e))
      }
    }
    probe = async () => {
      throw new GoogleError(401, 'token', 'invalid_client')
    }
    await s.handle(WRITER, TARGET, 'lezar', {}).catch((e: Error) => out.push(e.message))
    out.push(JSON.stringify(logs))
    expect(out.join('\n')).not.toContain(secretLike)
    expect(out.join('\n')).not.toContain(secretLike.slice(0, 12))
    // the value reached exactly one place on disk
    const holders = files().filter((f) => readFileSync(join(storeDir, f), 'utf8').includes(secretLike))
    expect(holders).toEqual([`${TARGET}.v1`])
  })

  it('the log carries a fixed set of keys: no value, no hash, no body', async () => {
    const s = service()
    await s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })
    await s.handle(WRITER, TARGET, 'lezar', {})
    await s.handle('nem-iro', TARGET, 'ir', { ertek: NEW2 }).catch(() => {})
    await s.handle(WRITER, 'masik-cel', 'ir', { ertek: NEW2 }).catch(() => {})
    const allowed = new Set(['at', 'event', 'hivo', 'cel', 'ige', 'hossz', 'verzio', 'rotacio', 'eredmeny', 'reason'])
    const keys = new Set(logs.flatMap((l) => Object.keys(l)))
    expect([...keys].filter((k) => !allowed.has(k))).toEqual([])
    expect(logs.map((l) => l['event'])).toEqual(['titok_ir', 'titok_lezar', 'titok_elutasitva', 'titok_elutasitva'])
    expect(logs[0]).toMatchObject({
      hivo: 'vezerlopult',
      cel: TARGET,
      hossz: NEW1.length,
      verzio: 1,
      eredmeny: 'ok',
    })
  })

  it.each([
    ['no token', undefined],
    ['a wrong token', 'rossz'],
    ["the mail caller's token", 'token-acrobot'],
  ])('%s: 403, nothing is written, the caller is logged as unknown', async (_n, token) => {
    await expect(service().handle(token, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({ status: 403, reason: 'caller' })
    expect(files()).toEqual([])
    expect(logs[0]).toMatchObject({ hivo: 'ismeretlen', reason: 'caller' })
    if (token) expect(JSON.stringify(logs)).not.toContain(token)
  })

  it('an unknown target and an unknown verb are refused with fixed texts, and nothing is written', async () => {
    const s = service()
    await expect(s.handle(WRITER, 'oauth-client-id', 'ir', { ertek: NEW1 })).rejects.toMatchObject({
      status: 404,
      reason: 'ismeretlen-cel',
    })
    await expect(s.handle(WRITER, '../x', 'ir', { ertek: NEW1 })).rejects.toMatchObject({ status: 404 })
    await expect(s.handle(WRITER, TARGET, 'torol', {})).rejects.toMatchObject({
      status: 404,
      reason: 'ismeretlen-ige',
    })
    expect(files()).toEqual([])
    // a path-like name is logged as a fixed word, never as the text the caller sent
    expect(logs.map((l) => l['cel'])).toEqual(['oauth-client-id', 'ervenytelen', TARGET])
  })

  it.each([
    ['too short', 'abc'],
    ['whitespace in it', 'aaaa bbbb cccc'],
    ['a line break', 'aaaaaaaa\nbbbbbbbb'],
    ['non-ASCII', 'aaaaaaaaé1234'],
    ['too long', 'a'.repeat(513)],
    ['not a string', 12345678],
  ])('refuses a value that is %s (400) and writes nothing', async (_n, value) => {
    await expect(service().handle(WRITER, TARGET, 'ir', { ertek: value })).rejects.toMatchObject({ status: 400 })
    expect(files()).toEqual([])
  })

  it('refuses a body with another key for ir, and any key for the other verbs', async () => {
    const s = service()
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1, extra: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(s.handle(WRITER, TARGET, 'ir', {})).rejects.toMatchObject({
      status: 400,
    })
    await s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })
    await expect(s.handle(WRITER, TARGET, 'lezar', { ertek: NEW2 })).rejects.toMatchObject({ status: 400 })
    await expect(s.handle(WRITER, TARGET, 'visszaall', { x: 1 })).rejects.toMatchObject({ status: 400 })
    expect(newStore().state(TARGET)).toEqual({
      verzio: 1,
      rotacioNyitva: true,
    })
  })

  it('the pre-flight failure has TWO causes with two fixed reasons, and neither becomes active', async () => {
    const s = service()
    probe = async () => {
      throw new GoogleError(401, 'token', 'invalid_client')
    }
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({
      status: 502,
      reason: 'szolgaltato-elutasitotta',
    })
    probe = async () => {
      throw new GoogleError(400, 'token', 'invalid_grant')
    }
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({ status: 502, reason: 'frissito-token-hiba' })
    probe = async () => {
      throw new GoogleError(0, 'network')
    }
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({
      status: 502,
      reason: 'szolgaltato-nem-elerheto',
    })
    expect(files()).toEqual([])
    expect(newStore().read(TARGET)).toBe(OLD)
    expect(logs.map((l) => l['reason'])).toEqual(['szolgaltato-elutasitotta', 'frissito-token-hiba', 'szolgaltato-nem-elerheto'])
  })

  it('the candidate reaches the pre-flight, and the pre-flight runs BEFORE anything is stored', async () => {
    const seen: { candidate: string; filesThen: string[] }[] = []
    probe = async (candidate) => {
      seen.push({ candidate, filesThen: files() })
    }
    await service().handle(WRITER, TARGET, 'ir', { ertek: NEW1 })
    expect(seen).toEqual([{ candidate: NEW1, filesThen: [] }])
  })

  it('lezar and visszaall go through the store: close, then a new write', async () => {
    const s = service()
    await s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })
    expect(await s.handle(WRITER, TARGET, 'visszaall', {})).toMatchObject({
      verzio: 0,
      hossz: OLD.length,
      allapot: 'rotacio-nyitva',
    })
    expect(await s.handle(WRITER, TARGET, 'lezar', {})).toMatchObject({
      verzio: 0,
      allapot: 'aktiv',
    })
    expect(await s.handle(WRITER, TARGET, 'ir', { ertek: NEW2 })).toMatchObject({ verzio: 1, hossz: NEW2.length })
  })

  it('five attempts an hour per target, then 429; an hour later it is open again. A refused attempt counts too', async () => {
    const s = service()
    probe = async () => {
      throw new GoogleError(401, 'token', 'invalid_client')
    }
    for (let i = 0; i < 5; i++) await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({ status: 502 })
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).rejects.toMatchObject({ status: 429, reason: 'rate-limit' })
    now += 3_600_001
    probe = async () => {}
    expect(await s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })).toMatchObject({ verzio: 1 })
  })

  it('a second write on a target while one is running: 409 foglalt, and the first one finishes', async () => {
    const s = service()
    let release: () => void = () => {}
    probe = () =>
      new Promise<void>((r) => {
        release = r
      })
    const first = s.handle(WRITER, TARGET, 'ir', { ertek: NEW1 })
    await new Promise((r) => setTimeout(r, 5))
    await expect(s.handle(WRITER, TARGET, 'ir', { ertek: NEW2 })).rejects.toMatchObject({ status: 409, reason: 'foglalt' })
    release()
    expect(await first).toMatchObject({ verzio: 1 })
    expect(newStore().read(TARGET)).toBe(NEW1)
  })
})

describe('the pre-flight at Google (googleRest.probeClientSecret)', () => {
  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status })
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
  const opts = {
    clientId: 'cid',
    clientSecret: 'active-secret',
    refreshTokens: { info: 'rt-info', balazs: 'rt-balazs' },
  }
  const failure = async (p: Promise<unknown>): Promise<GoogleError> => {
    try {
      await p
    } catch (e) {
      return e as GoogleError
    }
    throw new Error('expected to fail')
  }

  it('sends the CANDIDATE secret, not the active one, with a refresh token; one success accepts it', async () => {
    const { calls, fetchImpl } = transport([json({ access_token: 'at', expires_in: 3600 })])
    await googleRest({ ...opts, fetchImpl }).probeClientSecret('candidate-secret')
    expect(calls).toHaveLength(1)
    const body = String(calls[0]!.init.body)
    expect(body).toContain('client_secret=candidate-secret')
    expect(body).not.toContain('active-secret')
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
  })

  it("an invalid_grant on one account does not decide: the other account's access token accepts the candidate", async () => {
    const { calls, fetchImpl } = transport([json({ error: 'invalid_grant' }, 400), json({ access_token: 'at', expires_in: 3600 })])
    await googleRest({ ...opts, fetchImpl }).probeClientSecret('candidate-secret')
    expect(String(calls[0]!.init.body)).toContain('refresh_token=rt-info')
    expect(String(calls[1]!.init.body)).toContain('refresh_token=rt-balazs')
  })

  it('both refused: invalid_client wins over invalid_grant, and the code is the fixed word only', async () => {
    const a = transport([
      json(
        {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked for balazs@acropora.example',
        },
        400,
      ),
      json({ error: 'invalid_client' }, 401),
    ])
    const e1 = await failure(googleRest({ ...opts, fetchImpl: a.fetchImpl }).probeClientSecret('c'))
    expect([e1.kind, e1.status, e1.code]).toEqual(['token', 401, 'invalid_client'])
    const b = transport([json({ error: 'invalid_grant', error_description: 'x' }, 400), json({ error: 'invalid_grant' }, 400)])
    expect((await failure(googleRest({ ...opts, fetchImpl: b.fetchImpl }).probeClientSecret('c'))).code).toBe('invalid_grant')
    // Google's own text never survives: not in the message, not in a property
    expect(JSON.stringify(e1) + e1.message).not.toContain('acropora.example')
  })

  it('an error word outside the fixed list is not kept', async () => {
    const { fetchImpl } = transport([json({ error: 'quota for balazs@acropora.example' }, 400), json({ error: 'x' }, 400)])
    const e = await failure(googleRest({ ...opts, fetchImpl }).probeClientSecret('c'))
    expect(e.code).toBeUndefined()
    expect(JSON.stringify(e) + e.message).not.toContain('balazs')
  })

  it('the access token of the pre-flight is NOT cached: the next real call asks for its own', async () => {
    const { calls, fetchImpl } = transport([
      json({ access_token: 'candidate-at', expires_in: 3600 }),
      json({ access_token: 'active-at', expires_in: 3600 }),
      json({ messages: [] }),
    ])
    const api = googleRest({ ...opts, fetchImpl, nowMs: () => 1_000_000 })
    await api.probeClientSecret('candidate-secret')
    await api.getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages')
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    ])
    expect(String(calls[1]!.init.body)).toContain('client_secret=active-secret')
    expect((calls[2]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer active-at')
  })

  it('a client secret given as a function is read at each token request (a new value without a restart)', async () => {
    let current = 'first-secret'
    const { calls, fetchImpl } = transport([
      json({ access_token: 'a1', expires_in: 1 }),
      json({}),
      json({ access_token: 'a2', expires_in: 3600 }),
      json({}),
    ])
    let t = 1_000_000
    const api = googleRest({
      ...opts,
      clientSecret: () => current,
      fetchImpl,
      nowMs: () => t,
    })
    await api.getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages')
    current = 'second-secret'
    t += 120_000 // the first access token has expired
    await api.getJson('info', 'https://gmail.googleapis.com/gmail/v1/users/me/messages')
    expect(String(calls[0]!.init.body)).toContain('client_secret=first-secret')
    expect(String(calls[2]!.init.body)).toContain('client_secret=second-secret')
  })
})

describe('the settings of the secret door', () => {
  const clone = (extra: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(BASE)), ...extra }) as Record<string, any>

  it('absent: the door is off (null and an empty list), and the old settings file still parses', () => {
    const c = parseRelayConfig(clone())
    expect([c.secretStoreDir, c.secretWriters]).toEqual([null, []])
  })

  it('present: the directory and the writers parse', () => {
    const c = parseRelayConfig(withDoor('/var/lib/levelkozvetito/titkok-ver'))
    expect([c.secretStoreDir, c.secretWriters.map((w) => w.name)]).toEqual(['/var/lib/levelkozvetito/titkok-ver', ['vezerlopult']])
  })

  const bad: [string, (c: Record<string, any>) => void][] = [
    [
      'the directory without writers',
      (c) => {
        delete c['secretWriters']
      },
    ],
    [
      'writers without a directory',
      (c) => {
        delete c['secretStoreDir']
      },
    ],
    [
      'an empty writer list',
      (c) => {
        c['secretWriters'] = []
      },
    ],
    [
      'a relative directory',
      (c) => {
        c['secretStoreDir'] = 'titkok-ver'
      },
    ],
    [
      'a directory with ..',
      (c) => {
        c['secretStoreDir'] = '/var/lib/../etc'
      },
    ],
    [
      'a writer with the token of a mail caller',
      (c) => {
        c['secretWriters'][0].tokenSha256 = sha('token-acrobot')
      },
    ],
    [
      'a writer with the name of a mail caller',
      (c) => {
        c['secretWriters'][0].name = 'acrobot'
      },
    ],
    [
      'an unknown key in a writer',
      (c) => {
        c['secretWriters'][0].jog = 'mind'
      },
    ],
  ]
  it.each(bad)('refuses %s', (_n, change) => {
    const c = withDoor('/var/lib/levelkozvetito/titkok-ver') as Record<string, any>
    const copy = JSON.parse(JSON.stringify(c)) as Record<string, any>
    change(copy)
    expect(() => parseRelayConfig(copy)).toThrow(/relay config/)
  })
})

describe('the HTTP door of the secrets', () => {
  const servers: ReturnType<typeof createRelayServer>[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  })
  const quiet: GoogleApi = {
    getJson: async () => ({ messages: [] }),
    postJson: async () => ({}),
  }

  async function start(withSecrets: boolean) {
    const config = parseRelayConfig(withDoor(storeDir))
    const relay = new MailRelay({ config, google: quiet, log: () => {} })
    const secrets = withSecrets
      ? new SecretService({
          config,
          google: { probeClientSecret: async () => {} },
          store: newStore(),
          log: () => {},
        })
      : undefined
    const server = createRelayServer(relay, secrets)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return (path: string, token: string | undefined, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
  }

  it('a writer writes: 200 with the length; the answer text does not hold the value', async () => {
    const call = await start(true)
    const res = await call(`/titok/${TARGET}/ir`, 'token-vezerlopult', {
      ertek: NEW1,
    })
    const text = await res.text()
    expect([res.status, JSON.parse(text)]).toEqual([200, { cel: TARGET, hossz: NEW1.length, verzio: 1, allapot: 'rotacio-nyitva' }])
    expect(text).not.toContain(NEW1)
  })

  it('the mail caller cannot write, and the writer cannot read mail', async () => {
    const call = await start(true)
    expect((await call(`/titok/${TARGET}/ir`, 'token-acrobot', { ertek: NEW1 })).status).toBe(403)
    expect((await call('/info/lista', 'token-vezerlopult', {})).status).toBe(403)
    expect((await call('/info/lista', 'token-acrobot', {})).status).toBe(200)
    expect(files()).toEqual([])
  })

  it('without the bearer token: 403; an unknown target: 404; a malformed body: 400 and the text does not echo it', async () => {
    const call = await start(true)
    expect((await call(`/titok/${TARGET}/ir`, undefined, { ertek: NEW1 })).status).toBe(403)
    expect((await call('/titok/valami/ir', 'token-vezerlopult', { ertek: NEW1 })).status).toBe(404)
    const bad = await call(`/titok/${TARGET}/ir`, 'token-vezerlopult', {
      ertek: NEW1,
      extra: NEW2,
    })
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain(NEW2)
  })

  it('with no secret service (the settings name no writers) the door does not exist: the path is not served', async () => {
    const call = await start(false)
    const res = await call(`/titok/${TARGET}/ir`, 'token-vezerlopult', {
      ertek: NEW1,
    })
    expect([403, 404]).toContain(res.status)
    expect(files()).toEqual([])
  })
})

describe('the source of the two new modules', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'src', 'level-kozvetito', f), 'utf8')
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

  it.each(['secret-store.ts', 'titok.ts'])('%s calls no network: no fetch, http, https, net or tls module', (file) => {
    const text = code(read(file))
    expect(text).not.toMatch(/\bfetch\b|node:(http|https|http2|net|tls|dgram|dns)\b/)
    // the control: the scan reads the file and sees its own imports
    expect(text).toMatch(/from\s+'node:/)
  })

  it('the store writes only through replaceFile (temp, fsync, rename): no direct write of a final path', () => {
    const text = code(read('secret-store.ts'))
    expect(text).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|copyFileSync/)
    expect(text.match(/renameSync\(/g)).toHaveLength(1)
    expect(existsSync(join(process.cwd(), 'src', 'level-kozvetito', 'secret-store.ts'))).toBe(true)
  })

  it('the target list is the constant, and a request name is only looked up in it', () => {
    const text = code(read('titok.ts'))
    expect(text).toContain("export const SECRET_TARGETS = ['oauth-client-secret'] as const")
    expect(text).not.toMatch(/join\(/)
  })
})
