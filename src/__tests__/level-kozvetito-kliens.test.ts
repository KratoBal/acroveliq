// The fleet's side of the mail relay: scripts/level-kozvetito.sh and the GCAL_KOZVETITO switch of scripts/gcal.sh,
// run as a real process against the REAL relay server (HTTP) with a fake Google behind it. WHAT TURNS THIS RED: the
// switch on but a call going anywhere else; the token reaching an output or a process argument; a failure answered
// as success; an excluded sender's text written to disk; a mail id that is not hex becoming a folder name; the
// switch off changing the old behaviour.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRelayConfig } from '../level-kozvetito/config.js'
import { GoogleError, type GoogleApi } from '../level-kozvetito/google.js'
import { createRelayServer } from '../level-kozvetito/http.js'
import { MailRelay } from '../level-kozvetito/relay.js'

const run = promisify(execFile)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const GCAL = join(process.cwd(), 'scripts', 'gcal.sh')
const LVK = join(process.cwd(), 'scripts', 'level-kozvetito.sh')
const LVK_PY = join(process.cwd(), 'scripts', 'level-kozvetito-kliens.py')
const TOKEN = 'token-kliens-proba'

interface Msg { from: string; subject: string; text: string; attachments?: { filename: string; data: Buffer }[] }
const MESSAGES: Record<string, Msg> = {
  aaaa1111: { from: 'Beszallito Kft <rendeles@beszallito.example>', subject: 'Szamla 2026/0381', text: 'Kedves Partner! A kod 482913, a szamlaszam 2026/0381.', attachments: [{ filename: 'szamla.pdf', data: Buffer.from('PDFDATA') }] },
  bbbb2222: { from: 'Google <no-reply@accounts.google.com>', subject: 'Biztonsagi kod 771234', text: 'A belepesi kodod: 771234' },
}
const EVENTS = [{ start: { dateTime: '2026-10-19T09:00:00+02:00' }, end: { dateTime: '2026-10-19T10:00:00+02:00' }, summary: 'Szallito megbeszeles' }, { start: { dateTime: '2026-10-19T11:00:00+02:00' }, end: { dateTime: '2026-10-19T12:00:00+02:00' }, summary: 'Masodik\nHAMIS | sor' }]

function fakeGoogle(): { api: GoogleApi; urls: string[] } {
  const urls: string[] = []
  const att = new Map<string, Buffer>()
  return {
    urls,
    api: {
      async postJson() { throw new GoogleError(0, 'request') },
      async getJson(_account, url) {
        urls.push(url)
        if (/\/messages\?/.test(url)) return { messages: Object.keys(MESSAGES).map((id) => ({ id })) }
        const a = /\/messages\/([0-9a-f]+)\/attachments\/(.+)$/.exec(url)
        if (a) return { data: b64(att.get(decodeURIComponent(a[2]!)) ?? Buffer.alloc(0)) }
        const one = /\/messages\/([0-9a-f]+)\?format=(full|metadata)/.exec(url)
        if (one) {
          const m = MESSAGES[one[1]!]
          if (!m) throw new GoogleError(404, 'request')
          const parts: unknown[] = [{ mimeType: 'text/plain', body: { data: b64(m.text) } }]
          for (const [i, x] of (m.attachments ?? []).entries()) {
            const attachmentId = `att-${one[1]}-${i}-abcdefgh`
            att.set(attachmentId, x.data)
            parts.push({ mimeType: 'application/pdf', filename: x.filename, body: { attachmentId, size: x.data.length } })
          }
          return { id: one[1], payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: 'Mon, 19 Oct 2026 08:00:00 +0200' }], parts } }
        }
        if (url.includes('/calendar/v3/')) return { items: EVENTS }
        throw new GoogleError(0, 'request')
      },
    },
  }
}

let root: string
let server: ReturnType<typeof createRelayServer>
let url: string
let google: ReturnType<typeof fakeGoogle>
let hits = 0

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lvk-kliens-'))
  mkdirSync(join(root, 'karanten'))
  writeFileSync(join(root, 'token'), `${TOKEN}\n`, { mode: 0o600 })
  google = fakeGoogle()
  const config = parseRelayConfig({
    stateDir: join(root, 'state'),
    quarantineDir: join(root, 'karanten'),
    oauthClientIdFile: '/run/secrets/client-id',
    oauthClientSecretFile: '/run/secrets/client-secret',
    callers: [{ name: 'acrobot', tokenSha256: sha(TOKEN) }],
    accounts: {
      info: { address: 'info@acropora.example', refreshTokenFile: '/run/secrets/info', calendar: true, redaction: 'all-short-numbers' },
      balazs: { address: 'balazs@acropora.example', refreshTokenFile: '/run/secrets/balazs', calendar: false, redaction: 'all-short-numbers' },
    },
    excludedSenders: { domains: ['accounts.google.com'], addresses: [] },
    limits: { callsPerMinute: 100, maxAttachmentBytes: 1000, archivePerDay: 100 },
  })
  server = createRelayServer(new MailRelay({ config, google: google.api, log: () => {} }))
  hits = 0
  server.on('request', () => { hits += 1 })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
})

const env = (over: Record<string, string> = {}) => ({
  PATH: process.env['PATH'] ?? '',
  HOME: root,
  GCAL_KOZVETITO: '1',
  LVK_URL: url,
  LVK_TOKEN_FILE: join(root, 'token'),
  LVK_KARANTEN_DIR: join(root, 'karanten'),
  ...over,
})
async function gcal(args: string[], over: Record<string, string> = {}) {
  try {
    const r = await run('bash', [GCAL, ...args], { env: env(over), timeout: 60_000 })
    return { code: 0, out: r.stdout, err: r.stderr }
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string }
    return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' }
  }
}

describe('gcal.sh through the relay', () => {
  it('mail: from | subject, each in an envelope, the code taken out, the excluded sender named by domain only', async () => {
    const r = await gcal(['mail', '12'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('<untrusted source="gmail">Beszallito Kft')
    expect(r.out).toContain('Szamla 2026/0381')
    expect(r.out).toContain('KIZARVA (accounts.google.com)')
    expect(r.out).not.toContain('771234')
    expect(r.out).not.toContain('Biztonsagi')
  })

  it('search: a count, then id | date | from | subject; the excluded one has no subject', async () => {
    const r = await gcal(['search', 'from:beszallito.example', '10'])
    expect(r.out).toMatch(/^talalat: 2/)
    expect(r.out).toContain('aaaa1111 | ')
    expect(r.out).toMatch(/bbbb2222 \| .* \| KIZARVA \(accounts\.google\.com\)/)
    expect(r.out).not.toContain('Biztonsagi')
  })

  it('search over 50 says so and asks the relay for 50', async () => {
    const r = await gcal(['search', 'x', '500'])
    expect(r.out).toContain('legfeljebb 50')
    expect(google.urls.find((u) => u.includes('/messages?'))).toContain('maxResults=50')
  })

  it('events: start | summary, in an envelope', async () => {
    const r = await gcal(['events', '2'])
    expect(r.out).toContain('2026-10-19T09:00:00+02:00 | <untrusted source="gcal">Szallito megbeszeles</untrusted>')
    // a line break inside a title does not start a line of its own: two events, two lines
    expect(r.out.trim().split('\n')).toHaveLength(2)
  })

  it('fetch: headers and body on disk (redacted), the attachment in the quarantine folder, the content not printed', async () => {
    const out = join(root, 'out')
    const r = await gcal(['fetch', 'aaaa1111', out])
    expect(r.code).toBe(0)
    const body = readFileSync(join(out, 'aaaa1111', 'body.txt'), 'utf8')
    expect(body).toContain('[KOD]')
    expect(body).not.toContain('482913')
    expect(readFileSync(join(out, 'aaaa1111', 'headers.txt'), 'utf8')).toContain('Subject: <untrusted source="gmail">')
    expect(r.out).toContain(join(root, 'karanten', 'info', 'aaaa1111', '0-szamla.pdf'))
    expect(readFileSync(join(root, 'karanten', 'info', 'aaaa1111', '0-szamla.pdf'), 'utf8')).toBe('PDFDATA')
    expect(r.out).not.toContain('PDFDATA')
    expect(r.out).not.toContain('Kedves Partner')
  })

  it('fetch of an excluded sender writes nothing to disk', async () => {
    const out = join(root, 'out')
    const r = await gcal(['fetch', 'bbbb2222', out])
    expect(r.out).toContain('KIZARVA (accounts.google.com)')
    expect(() => readdirSync(out)).toThrow()
  })

  it('fetch refuses an id that is not hex before it makes a folder', async () => {
    const out = join(root, 'out')
    const r = await gcal(['fetch', '../../etc', out])
    expect(r.code).not.toBe(0)
    expect(() => readdirSync(out)).toThrow()
    // the client says no by itself: the relay was not even asked
    expect(hits).toBe(0)
  })

  it('check reaches the relay; a wrong token is a failure, with the relay\'s reason and without the token', async () => {
    expect((await gcal(['check'])).out).toContain('KOZVETITO  OK')
    writeFileSync(join(root, 'rossz'), 'nem-ez-a-token\n')
    const r = await gcal(['mail'], { LVK_TOKEN_FILE: join(root, 'rossz') })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('403 caller')
    expect(r.err + r.out).not.toContain('nem-ez-a-token')
  })

  it('the old consent commands are not the relay\'s, and a third account is not known', async () => {
    expect((await gcal(['auth-url'])).err).toContain('README')
    expect((await gcal(['mail'], { GC_ACCOUNT: 'ticket' })).err).toContain('csak az info es a balazs')
  })

  it('without the switch the old path is taken: no refresh token, the old refusal', async () => {
    const r = await gcal(['mail'], { GCAL_KOZVETITO: '' })
    expect(r.err).toContain('nincs refresh token')
  })
})

describe('level-kozvetito.sh', () => {
  async function lvk(args: string[], input: string, over: Record<string, string> = {}) {
    const child = promisify(execFile)
    return await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = execFile('bash', [LVK, ...args], { env: env(over), timeout: 30_000 }, (e, stdout, stderr) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
      )
      p.stdin?.end(input)
      void child
    })
  }

  it('answers the relay\'s JSON on 200', async () => {
    const r = await lvk(['info', 'lista'], '{"q":"in:inbox","max":2}')
    expect(JSON.parse(r.out).items).toHaveLength(2)
  })
  it('a refusal: exit 1, FAIL and the relay\'s fixed reason, nothing on stdout', async () => {
    const r = await lvk(['balazs', 'naptar'], '{}')
    expect([r.code, r.out]).toEqual([1, ''])
    expect(r.err).toBe('FAIL 404 no such verb\n')
  })
  it('refuses a bad account, a bad verb and a body that is not a JSON object, before any request', async () => {
    expect((await lvk(['ticket', 'lista'], '{}')).code).toBe(2)
    expect((await lvk(['info', '../x'], '{}')).code).toBe(2)
    expect((await lvk(['info', 'lista'], '[1]')).code).toBe(2)
    expect((await lvk(['info', 'lista'], 'nem json')).code).toBe(2)
    expect(google.urls).toEqual([])
  })
  it('never prints the token, and refuses an empty token file or an odd LVK_URL', async () => {
    writeFileSync(join(root, 'ures'), '\n')
    const r = await lvk(['info', 'lista'], '{}', { LVK_TOKEN_FILE: join(root, 'ures') })
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty or holds whitespace')
    expect(google.urls).toEqual([])
    const bad = await lvk(['info', 'lista'], '{}', { LVK_URL: 'file:///etc/passwd' })
    expect(bad.err).toContain('LVK_URL')
    const ok = await lvk(['info', 'lista'], '{}')
    expect(ok.out + ok.err).not.toContain(TOKEN)
  })
  it('does not follow a redirect: the token header goes to the address given and nowhere else', async () => {
    let seenAtTarget = 0
    const target = createServer((_req, res) => { seenAtTarget += 1; res.end('{}') })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`
    const hop = createServer((_req, res) => { res.writeHead(302, { Location: targetUrl }); res.end() })
    await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r))
    try {
      const r = await lvk(['info', 'lista'], '{}', { LVK_URL: `http://127.0.0.1:${(hop.address() as AddressInfo).port}` })
      expect(r.code).toBe(1)
      expect(seenAtTarget).toBe(0)
    } finally {
      await Promise.all([new Promise((r) => target.close(r)), new Promise((r) => hop.close(r))])
    }
  })
  it('LVK_URL cannot carry the token to another host: only a loopback address counts, everything else is refused before any request', async () => {
    let seen = 0
    let auth = ''
    const fake = createServer((req, res) => { seen += 1; auth = String(req.headers['authorization'] ?? ''); res.end('{}') })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
    const port = (fake.address() as AddressInfo).port
    try {
      // a name that resolves to the fake server would have received the token; none of these may
      for (const host of ['http://pelda.example', 'http://127.0.0.1.pelda.example', `http://pelda.example:${port}`, `http://user@pelda.example:${port}`, `http://localhost.pelda.example:${port}`, 'https://127.0.0.1', `http://127.0.0.1:${port}@pelda.example`, `http://127.0.0.1:${port}/x`]) {
        const r = await lvk(['info', 'lista'], '{}', { LVK_URL: host })
        expect([host, r.code]).toEqual([host, 1])
        expect(r.err).toContain('nothing was sent')
      }
      expect([seen, auth]).toEqual([0, ''])
      // the loopback address the tests use still works (and reaches the fake, which is not the relay)
      await lvk(['info', 'lista'], '{}', { LVK_URL: `http://127.0.0.1:${port}` })
      expect(seen).toBe(1)
    } finally {
      await new Promise((r) => fake.close(r))
    }
  })
  it('with no LVK_URL the address is the fixed internal name of the relay (it cannot be observed from here: the name does not resolve, so the source is read)', () => {
    const src = readFileSync(LVK_PY, 'utf8')
    expect(src).toContain('FIXED_URL = "http://levelkozvetito:8788"')
    expect(src).toContain('return FIXED_URL')
  })
  it('health answers without a token', async () => {
    const r = await lvk(['health'], '', { LVK_TOKEN_FILE: '/nonexistent' })
    expect(JSON.parse(r.out)).toEqual({ ok: true })
  })
})
