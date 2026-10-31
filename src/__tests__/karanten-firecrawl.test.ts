// The quarantine reader's URL mode, the Firecrawl fallback (src/karanten-firecrawl.ts, task karanten-firecrawl; acrobot 39370).
// WHAT TURNS THIS RED:
//   - Firecrawl is asked for a page that downloaded fine, or answered 404, 500 or a plain 429 (only a 403 or a Cloudflare challenge starts it);
//   - a host the egress gate refuses, or a redirect Firecrawl reports to such a host, gets through; a URL with a secret in it is sent;
//   - the key is read without a clear stop when it is missing or unreadable, or reaches an output, the reader's folder, arguments or
//     environment, or the reader's answer may carry it; it goes to an address that is not public or is not the pinned one;
//   - Firecrawl's own error text reaches the caller, or a failure of Firecrawl lets content through;
//   - the markdown reaches the reader any other way than as a file, or the envelope does not say it came through Firecrawl and why;
//   - the reader's tool list changes.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksLikeChallenge, pinnedGet, pinnedPost, type DownloadDeps, type Response } from '../karanten-letolt.js'
import { karantenOlvasUrl, READER_ARGS } from '../karanten-olvas.js'
import { readFirecrawlKey, urlHasSecret } from '../karanten-firecrawl.js'

const KEY = 'fc-' + 'k'.repeat(30)
const GH = ['gh', 'p_', 'C'.repeat(36)].join('')
let server: http.Server
let port = 0
let posts: Array<{ url: string; pinned: string; headers: Record<string, string>; body: string }> = []
let dir: string
let store: string

const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>'

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const u = req.url ?? ''
      if (u === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>oldal</p>'); return }
      if (u === '/szoveg') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Cikk</title></head><body><p>Just a moment, ahogy a szerkeszto irta: ez egy cikk.</p></body></html>'); return }
      if (u === '/tiltott') { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return }
      if (u.startsWith('/tiltott?')) { res.writeHead(403); res.end('forbidden'); return }
      if (u === '/cf403') { res.writeHead(403, { server: 'cloudflare', 'content-type': 'text/html' }); res.end(CHALLENGE_HTML); return }
      if (u === '/kihivas200') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(CHALLENGE_HTML); return }
      if (u === '/kihivas503') { res.writeHead(503, { 'content-type': 'text/html' }); res.end(CHALLENGE_HTML); return }
      if (u === '/mitigated') { res.writeHead(429, { 'cf-mitigated': 'challenge' }); res.end('x'); return }
      if (u === '/404') { res.writeHead(404); res.end('nincs'); return }
      if (u === '/500') { res.writeHead(500); res.end('hiba'); return }
      if (u === '/429') { res.writeHead(429); res.end('lassabban'); return }
      if (u === '/503') { res.writeHead(503, { server: 'cloudflare' }); res.end('Error 503: the origin is down'); return }
      if (u === '/api/echo') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, headers: req.headers, body })); return }
      if (u === '/api/nagy') { res.writeHead(200); res.end('y'.repeat(5000)); return }
      res.writeHead(404); res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karanten-fc-'))
  store = join(dir, 'store')
  mkdirSync(store)
  writeFileSync(join(store, '.firecrawl-key'), KEY + '\n', { mode: 0o600 })
  posts = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const url = (path: string, host = 'pelda.test') => `http://${host}:${port}${path}`
const reply = (status: number, json: unknown): Response => ({ status, contentType: 'application/json', body: Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)) })
const page = (markdown = '# Szál\n\nTartalom a Firecrawl-tól.', extra: Record<string, unknown> = {}) => reply(200, { success: true, data: { markdown, metadata: { statusCode: 200, ...extra } } })

/** Test deps: names resolve from a table, the real pinned GET; the Firecrawl POST is a recording fake. */
function deps(o: { allowed?: (u: string) => boolean; answer?: () => Response | Promise<Response>; internal?: string[]; table?: Record<string, string[]> } = {}): DownloadDeps {
  const table = o.table ?? { 'pelda.test': ['127.0.0.1'], 'api.firecrawl.dev': ['203.0.113.7'], 'evil.test': ['127.0.0.1'] }
  return {
    allowed: o.allowed ?? ((u) => !u.includes('evil.test')),
    resolve: async (h) => { if (!table[h]) throw new Error('ENOTFOUND'); return table[h]! },
    isBlocked: (ip) => (o.internal ?? ['10.0.0.5']).includes(ip),
    get: pinnedGet,
    post: async (u, pinned, headers, body) => {
      posts.push({ url: u.href, pinned, headers, body })
      return (o.answer ?? (() => page()))()
    },
  }
}

/** A fake claude that records what it was given (folder listing, arguments, environment, the markdown file) and answers. */
function fakeClaude(answer = 'kivonat'): string {
  const f = join(dir, 'claude')
  writeFileSync(f, `#!/bin/bash
ls -A > "${join(dir, 'lista')}"
printf '%s\\n' "$@" > "${join(dir, 'args')}"
env > "${join(dir, 'env')}"
cp ./bemenet-oldal.md "${join(dir, 'latott')}" 2>/dev/null
cat ./bemenet-oldal.* > "${join(dir, 'minden')}" 2>/dev/null
printf '%s' ${JSON.stringify(answer)}
`, { mode: 0o755 })
  return f
}
const run = (path: string, d: DownloadDeps, more: object = {}) => karantenOlvasUrl({ url: url(path), claude: fakeClaude(), storeDir: store, timeoutMs: 5000, deps: d, ...more })

describe('when the fallback starts', () => {
  it('FC-NOT-ON-200: a page that downloads fine, or merely mentions the challenge words, never goes to Firecrawl', async () => {
    const d = deps()
    const ok = await run('/ok', d)
    const article = await run('/szoveg', d)
    expect([ok.code, article.code, posts.length]).toEqual([0, 0, 0])
    expect(readFileSync(join(dir, 'minden'), 'utf8')).toContain('Just a moment, ahogy')
  })

  it('FC-NOT-OTHER: a 404, a 500, a plain 429 and an origin that is down (503 behind Cloudflare) stop with the download\'s own reason; Firecrawl is not asked', async () => {
    const d = deps()
    const rs = [await run('/404', d), await run('/500', d), await run('/429', d), await run('/503', d)]
    expect(rs.map((r) => [r.code, r.out.includes('a valasz')])).toEqual([[2, true], [2, true], [2, true], [2, true]])
    expect(rs.map((r) => /a valasz (\d+)/.exec(r.out)?.[1])).toEqual(['404', '500', '429', '503'])
    expect(posts.length).toBe(0)
  })

  it('FC-ON-403: a 403 asks Firecrawl once, for the address that answered it, with exactly the fixed request; the markdown reaches the reader as a FILE, in an envelope that says Firecrawl and 403', async () => {
    const r = await run('/tiltott', deps())
    expect(posts.length).toBe(1)
    const sent = posts[0]!
    expect(sent.url).toBe('https://api.firecrawl.dev/v2/scrape')
    expect(sent.pinned).toBe('203.0.113.7')
    expect(JSON.parse(sent.body)).toEqual({ url: url('/tiltott'), formats: ['markdown'], onlyMainContent: true })
    expect([sent.headers.authorization, sent.headers['content-type']]).toEqual([`Bearer ${KEY}`, 'application/json'])
    expect(r.code).toBe(0)
    expect(r.out.startsWith('<untrusted source="karanten-url-firecrawl-403:bemenet-oldalmd">')).toBe(true)
    expect(readFileSync(join(dir, 'lista'), 'utf8').trim()).toBe('bemenet-oldal.md')
    const seen = readFileSync(join(dir, 'latott'), 'utf8')
    expect(seen.startsWith(`URL: ${url('/tiltott')}\nForras: Firecrawl (az oldal 403-at adott)\n\n# Szál\n\nTartalom a Firecrawl-tól.`)).toBe(true)
  })

  it('FC-ON-CHALLENGE: a Cloudflare challenge on a 200, on a 503 or marked by cf-mitigated starts it, labelled kihivas; a 403 from Cloudflare is the 403 branch', async () => {
    const out: string[] = []
    for (const p of ['/kihivas200', '/kihivas503', '/mitigated', '/cf403']) {
      const r = await run(p, deps())
      out.push(`${p}:${r.code}:${/source="([^:"]+)/.exec(r.out)?.[1]}`)
    }
    expect(out).toEqual(['/kihivas200:0:karanten-url-firecrawl-kihivas', '/kihivas503:0:karanten-url-firecrawl-kihivas', '/mitigated:0:karanten-url-firecrawl-kihivas', '/cf403:0:karanten-url-firecrawl-403'])
    expect(posts.length).toBe(4)
  })

  it('FC-CHALLENGE-TEST: the challenge detector: the header, the marks on a 403/429/503/small 200, not a big page, not a plain mention, not a 404', () => {
    const b = (s: string) => Buffer.from(s)
    expect([
      looksLikeChallenge(429, { cfMitigated: 'challenge' }, b('x')),
      looksLikeChallenge(403, { server: 'cloudflare' }, b('forbidden')),
      looksLikeChallenge(403, { server: 'nginx' }, b('forbidden')),
      looksLikeChallenge(403, {}, b(CHALLENGE_HTML)),
      looksLikeChallenge(503, { server: 'cloudflare' }, b('origin down')),
      looksLikeChallenge(503, {}, b(CHALLENGE_HTML)),
      looksLikeChallenge(200, {}, b(CHALLENGE_HTML)),
      looksLikeChallenge(200, {}, b(CHALLENGE_HTML + 'x'.repeat(130_000))),
      looksLikeChallenge(200, {}, b('<p>Just a moment, please read on</p>')),
      looksLikeChallenge(404, { server: 'cloudflare' }, b(CHALLENGE_HTML)),
    ]).toEqual([true, true, false, true, false, true, true, false, false, false])
  })
})

describe('what does not loosen', () => {
  it('FC-GATE: a host the gate refuses at the moment of the call, or a final address it refuses, never yields content', async () => {
    let n = 0
    const refuses = deps({ allowed: () => ++n === 1 })       // the download's own check passes, the one before the call does not
    const r1 = await run('/tiltott', refuses)
    const r2 = await run('/tiltott', deps({ answer: () => page('# x', { url: url('/valahol', 'evil.test') }) }))
    expect([r1.code, r1.out.includes('az egress-kapu nem engedi'), r2.code, r2.out.includes('nem engedelyezett helyre vitt')]).toEqual([2, true, 2, true])
    expect(posts.length).toBe(1)
    expect(r2.out).not.toContain('Tartalom')
  })

  it('FC-URL-SECRET: an address that carries a secret shape or a fleet token is not sent, and the message names the shape, not the secret', async () => {
    writeFileSync(join(store, '.dashboard-token'), 'dashboard-token-'.padEnd(40, 'z'))
    const r1 = await run(`/tiltott?token=${GH}`, deps())
    const r2 = await run(`/tiltott?t=${'dashboard-token-'.padEnd(40, 'z')}`, deps())
    expect([r1.code, r2.code, posts.length]).toEqual([2, 2, 0])
    expect(r1.out + r2.out).not.toContain(GH)
    expect(r1.out + r2.out).not.toContain('dashboard-token-zzzz')
    expect(urlHasSecret('https://pelda.test/x?a=1', [])).toBeNull()
  })

  it('FC-KEY-STOP: a missing key, an unreadable key and a key file that is not a key each stop with their own reason, say what made the command ask, and ask nobody', async () => {
    rmSync(join(store, '.firecrawl-key'))
    const missing = await run('/tiltott', deps())
    writeFileSync(join(store, '.firecrawl-key'), 'ket szo\n')
    const odd = await run('/kihivas200', deps())
    writeFileSync(join(store, '.firecrawl-key'), KEY)
    chmodSync(join(store, '.firecrawl-key'), 0o000)
    const unreadable = process.getuid?.() === 0 ? { code: 2, out: 'nem olvashato' } : await run('/tiltott', deps())
    chmodSync(join(store, '.firecrawl-key'), 0o600)
    expect([missing.code, odd.code, unreadable.code, posts.length]).toEqual([2, 2, 2, 0])
    expect(missing.out).toContain('az oldal 403-at adott')
    expect(missing.out).toContain('nincs Firecrawl-kulcs')
    expect(odd.out).toContain('az oldal Cloudflare-kihivast adott')
    expect(odd.out).toContain('nem kulcs-alaku')
    expect(unreadable.out).toMatch(/nem olvashat/)
    expect(readFirecrawlKey(store)).toEqual({ ok: true, key: KEY })
  })

  it('FC-KEY-NEVER: the key is in the request\'s authorization header and nowhere else: not in the output, the reader\'s folder, arguments or environment', async () => {
    const r = await run('/tiltott', deps())
    expect(r.code).toBe(0)
    for (const f of ['minden', 'args', 'env', 'lista']) expect(readFileSync(join(dir, f), 'utf8')).not.toContain(KEY)
    expect(r.out).not.toContain(KEY)
    expect(posts.map((p) => JSON.stringify([p.url, p.body])).join()).not.toContain(KEY)
    expect(READER_ARGS.join(' ')).not.toContain(KEY)
  })

  it('FC-KEY-ECHO: a reader that answers with the key (code 3): nothing comes through', async () => {
    const r = await karantenOlvasUrl({ url: url('/tiltott'), claude: fakeClaude(`itt a kulcs: ${KEY}`), storeDir: store, timeoutMs: 5000, deps: deps() })
    expect([r.code, r.out.includes(KEY)]).toEqual([3, false])
  })

  it('FC-API-PUBLIC: the key goes only to a PUBLIC address of the API host: an internal answer for it, or a name that does not resolve, sends nothing', async () => {
    const internal = await run('/tiltott', deps({ table: { 'pelda.test': ['127.0.0.1'], 'api.firecrawl.dev': ['10.0.0.5'] } }))
    const none = await run('/tiltott', deps({ table: { 'pelda.test': ['127.0.0.1'] } }))
    expect([internal.code, internal.out.includes('nem publikus'), none.code, none.out.includes('nem oldhato fel'), posts.length]).toEqual([2, true, 2, true, 0])
  })

  it('FC-PINNED: the POST connects to the pinned address whatever the name says, carries the headers and the body, and stops at the size limit', async () => {
    const r = await pinnedPost(new URL(`http://nincs-ilyen-nev.test:${port}/api/echo`), '127.0.0.1', { 'content-type': 'application/json', authorization: 'Bearer proba' }, '{"a":1}', 3000, 100_000)
    const echoed = JSON.parse(r.body.toString())
    expect([r.status, echoed.method, echoed.headers.authorization, echoed.headers['content-length'], echoed.body]).toEqual([200, 'POST', 'Bearer proba', '7', '{"a":1}'])
    await expect(pinnedPost(new URL(`http://x.test:${port}/api/nagy`), '127.0.0.1', {}, '{}', 3000, 1000)).rejects.toThrow('tul nagy')
  })
})

describe('when Firecrawl fails, nothing comes through, and its own words never do', () => {
  it('FC-ERRORS: each failure is a class with a fixed text; code 2; no content; the raw answer (a unique string) is nowhere in the output', async () => {
    const SECRETLY = 'PAYLOAD-AMIT-NEM-SZABAD-TOVABBITANI'
    const cases: Array<[string, () => Response | Promise<Response>, RegExp]> = [
      ['401', () => reply(401, { error: SECRETLY }), /elutasitotta a kulcsot/],
      ['402', () => reply(402, { error: SECRETLY }), /kredit elfogyott/],
      ['429', () => reply(429, { error: SECRETLY }), /korlatozza/],
      ['500', () => reply(500, { error: SECRETLY }), /valasza 500/],
      ['not JSON', () => reply(200, `<html>${SECRETLY}</html>`), /nem JSON/],
      ['success false', () => reply(200, { success: false, error: SECRETLY }), /nem adott markdownt/],
      ['no markdown', () => reply(200, { success: true, data: { html: SECRETLY } }), /nem adott markdownt/],
      ['empty markdown', () => page('   \n '), /ures markdownt/],
      ['the page said 403 to Firecrawl too', () => page(SECRETLY, { statusCode: 403 }), /is 403-t adott/],
      ['a challenge as the page', () => page(`Just a moment... ${SECRETLY}`), /Cloudflare kihivast kapta/],
      ['timeout', () => { throw new Error('idotullepes') }, /nem valaszolt idoben/],
      ['too big', () => { throw new Error('tul nagy') }, /tul nagy/],
      ['a network error', () => { throw new Error(`ECONNRESET ${SECRETLY}`) }, /hibaval allt le/],
    ]
    for (const [name, answer, expected] of cases) {
      const r = await run('/tiltott', deps({ answer }))
      expect([name, r.code, expected.test(r.out), r.out.includes(SECRETLY), r.out.includes(KEY), r.out.includes('a tartalom nem jott at')]).toEqual([name, 2, true, false, false, true])
    }
  })

  it('FC-HOST-STOP: a host the gate refuses from the start never reaches the fallback (the download stops it)', async () => {
    const d = deps({ allowed: () => false })
    const r = await run('/tiltott', d)
    expect([r.code, r.out.includes('az egress-kapu nem engedi'), posts.length]).toEqual([2, true, 0])
  })

  it('FC-ARGS: the reader\'s tool list is the one of the permission decision', () => {
    expect([...READER_ARGS]).toEqual(['-p', '--restricted', '--tools', 'Read', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'])
  })
})
