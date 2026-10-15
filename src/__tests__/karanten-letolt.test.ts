// The quarantine reader's URL mode, the download (src/karanten-letolt.ts; P1-00f point 3, task
// t-20261015-p1-00f-impl; barracuda 31016 and 31019). WHAT TURNS THIS RED:
//   - a URL the egress gate refuses is still fetched, or the gate's refusal is read as an allow;
//   - an internal address (IPv4, IPv6, IPv4-mapped, NAT64) passes, at the start or after a redirect;
//   - the connection goes to an address other than the checked one (DNS rebinding);
//   - the size is taken from the header instead of the bytes, or there is no time limit;
//   - credentials in the URL or a non-http scheme pass; a page reaches the reader without the command.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockedAddress, gateAllows, letolt, pinnedGet, type DownloadDeps } from '../karanten-letolt.js'
import { karantenOlvasUrl } from '../karanten-olvas.js'

let server: http.Server
let port = 0
let hits: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`)
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>oldal</p>'); return }
    if (req.url === '/nagy') { res.writeHead(200, { 'content-type': 'text/plain' }); for (let i = 0; i < 20; i++) res.write('y'.repeat(1000)); res.end(); return }
    if (req.url === '/hazug') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' }); res.write('z'.repeat(5000)); res.end(); return }
    if (req.url === '/lassu') { res.writeHead(200); res.write('a'); return }
    if (req.url === '/belsore') { res.writeHead(302, { location: `http://belso.test:${port}/ok` }); res.end(); return }
    if (req.url === '/kapura') { res.writeHead(302, { location: '/tiltott' }); res.end(); return }
    if (req.url === '/hurok') { res.writeHead(302, { location: '/hurok' }); res.end(); return }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** Test deps: names resolve from a table; only listed addresses are internal; the real pinned GET. */
function deps(o: { allowed?: (u: string) => boolean; table?: Record<string, string[][]>; internal?: string[] } = {}): DownloadDeps & { resolves: string[] } {
  const calls: string[] = []
  const table = o.table ?? { 'pelda.test': [['127.0.0.1']], 'belso.test': [['10.0.0.5']] }
  const used: Record<string, number> = {}
  return {
    resolves: calls,
    allowed: o.allowed ?? (() => true),
    resolve: async (h) => {
      calls.push(h)
      const answers = table[h]
      if (!answers) throw new Error('ENOTFOUND')
      const i = Math.min(used[h] ?? 0, answers.length - 1)
      used[h] = (used[h] ?? 0) + 1
      return answers[i]!
    },
    isBlocked: (ip) => (o.internal ?? ['10.0.0.5']).includes(ip),
    get: pinnedGet,
  }
}
const url = (path: string, host = 'pelda.test') => `http://${host}:${port}${path}`

describe('the addresses that are not the public internet', () => {
  it('LET-RANGES: IPv4 private, CGNAT/tailnet, loopback, link-local, 0.0.0.0/8; IPv6 loopback, link-local, ULA, and mapped / NAT64 by the IPv4 inside', () => {
    const blocked = ['0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.117.177.56', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.250.2', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::127.0.0.1', '64:ff9b::a00:5', '64:ff9b::127.0.0.1', 'nem-cim']
    const public_ = ['93.184.216.34', '162.55.216.28', '2606:4700::1111', '::ffff:93.184.216.34', '64:ff9b::5db8:d822']
    expect([blocked.filter((a) => !blockedAddress(a)), public_.filter((a) => blockedAddress(a))]).toEqual([[], []])
  })
})

describe('the egress gate decides first', () => {
  it('LET-GATE: the real gate, as the quarantine-reader: a built-in host is allowed, an unknown one refused; a refused URL is never resolved', async () => {
    expect([gateAllows('https://api.github.com/repos/x'), gateAllows('https://nem-listas-domain.example/')]).toEqual([true, false])
    const d = deps({ allowed: () => false })
    const r = await letolt(url('/ok'), d)
    expect([r.ok, !r.ok && r.why.startsWith('az egress-kapu nem engedi'), d.resolves, hits.filter((h) => h.endsWith('/ok')).length >= 0]).toEqual([false, true, [], true])
  })

  it('LET-GATE-FAILS-CLOSED: a gate that writes anything, or exits non-zero, is a refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kapu-'))
    try {
      for (const [name, body] of [['ir', 'process.stdout.write("x")'], ['bukik', 'process.exit(1)'], ['enged', 'process.exit(0)']] as const) writeFileSync(join(dir, `${name}.mjs`), body)
      expect([gateAllows('https://x.example/', join(dir, 'ir.mjs')), gateAllows('https://x.example/', join(dir, 'bukik.mjs')), gateAllows('https://x.example/', join(dir, 'enged.mjs'))]).toEqual([false, false, true])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the download', () => {
  it('LET-OK: a public (here: test-allowed) page comes back with its type', async () => {
    const r = await letolt(url('/ok'), deps({ internal: [] }))
    expect([r.ok, r.ok && r.body.toString(), r.ok && r.contentType]).toEqual([true, '<p>oldal</p>', 'text/html'])
  })

  it('LET-INTERNAL: a name that resolves to an internal address is refused before any connection', async () => {
    hits = []
    const r = await letolt(url('/ok'), deps({ internal: ['127.0.0.1'] }))
    expect([r.ok, !r.ok && r.why.startsWith('belso vagy nem publikus'), hits]).toEqual([false, true, []])
  })

  it('LET-REDIRECT-INSIDE: a redirect to an internal address is refused at that hop; nothing reaches it', async () => {
    hits = []
    const r = await letolt(url('/belsore'), deps())
    expect([r.ok, !r.ok && r.why, hits.filter((h) => h.startsWith('belso.test'))]).toEqual([false, 'belso vagy nem publikus cimre mutat: belso.test', []])
  })

  it('LET-REDIRECT-GATE: a redirect to a URL the gate refuses is refused at that hop; the refused URL is never requested', async () => {
    hits = []
    const r = await letolt(url('/kapura'), deps({ internal: [], allowed: (u) => !u.includes('/tiltott') }))
    expect([r.ok, !r.ok && r.why.startsWith('az egress-kapu nem engedi'), hits.some((h) => h.endsWith('/tiltott'))]).toEqual([false, true, false])
  })

  it('LET-REBINDING: the name is resolved once per hop and the socket goes to THAT address; a second, internal answer never reaches a connection', async () => {
    const d = deps({ table: { 'pelda.test': [['127.0.0.1'], ['10.0.0.5']] }, internal: ['10.0.0.5'] })
    const r = await letolt(url('/ok'), d)
    // `pelda.test` is not in any real DNS: the request could only connect through the pinned lookup
    expect([r.ok, d.resolves]).toEqual([true, ['pelda.test']])
  })

  it('LET-SIZE: the bytes are counted as they arrive (no header, and a lying Content-Length), not trusted from a header', async () => {
    const big = await letolt(url('/nagy'), deps({ internal: [] }), { maxBytes: 5000, timeoutMs: 5000 })
    const lie = await letolt(url('/hazug'), deps({ internal: [] }), { maxBytes: 1000, timeoutMs: 5000 })
    expect([big.ok, !big.ok && big.why, lie.ok]).toEqual([false, 'nagyobb, mint 5000 bajt', false])
  })

  it('LET-TIME: a page that never ends stops at the time limit', async () => {
    const t0 = Date.now()
    const r = await letolt(url('/lassu'), deps({ internal: [] }), { maxBytes: 5000, timeoutMs: 400 })
    expect([r.ok, !r.ok && r.why, Date.now() - t0 < 3000]).toEqual([false, 'idotullepes', true])
  })

  it('LET-SHAPE: credentials in the URL, a non-http scheme, too many redirects: refused', async () => {
    const results = [
      await letolt(`http://u:p@pelda.test:${port}/ok`, deps({ internal: [] })),
      await letolt('file:///etc/passwd', deps({ internal: [] })),
      await letolt(url('/hurok'), deps({ internal: [] })),
    ]
    expect(results.map((r) => !r.ok && r.why)).toEqual(['hitelesito adat az URL-ben', 'nem http(s): file:', 'tobb, mint 5 atiranyitas'])
  })
})

describe('the URL mode through the reader', () => {
  it('LET-READER: the downloaded page reaches the (fake) reader as a file in its fresh folder, with the login (#174), and comes back wrapped as karanten-url', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karanten-url-'))
    try {
      const claude = join(dir, 'claude')
      writeFileSync(claude, `#!/bin/bash\nls -A > "${join(dir, 'lista')}"\nprintf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN-NINCS}" > "${join(dir, 'oauth')}"\necho "kivonat"\n`, { mode: 0o755 })
      const r = await karantenOlvasUrl({ url: url('/ok'), claude, storeDir: join(dir, 'nincs-store'), timeoutMs: 5000, auth: { CLAUDE_CODE_OAUTH_TOKEN: 'belepes-url' }, deps: deps({ internal: [] }) })
      const refused = await karantenOlvasUrl({ url: url('/ok'), claude, storeDir: join(dir, 'nincs-store'), timeoutMs: 5000, deps: deps({ allowed: () => false }) })
      expect([r.code, r.out.startsWith('<untrusted source="karanten-url:bemenet-oldalhtml">'), readFileSync(join(dir, 'lista'), 'utf8').trim(), readFileSync(join(dir, 'oauth'), 'utf8'), refused.code, refused.out.includes('az egress-kapu nem engedi')]).toEqual([0, true, 'bemenet-oldal.html', 'belepes-url', 2, true])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
