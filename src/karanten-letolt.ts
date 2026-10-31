// The quarantine reader's URL mode, the download half: P1-00f point 3 (task t-20261015-p1-00f-impl;
// plan v4, barracuda 31016 and 31019).
//
// The reader NEVER gets WebFetch: with --restricted it would also lose the egress gate (that hook
// lives in the shared settings it does not load) and could fetch any address an injection asks for
// (the dashboard on localhost, the stage, the Docker networks): an SSRF path, wider than today's
// quarantine. So the COMMAND fetches the page, in code, and hands the reader a file:
//   1. the egress gate's own decision, with the quarantine agent type: the same list as today's
//      quarantine-reader (the gate runs as a child, exactly as the hook runs; only an explicit
//      allow counts, anything else is a refusal);
//   2. the host resolved ONCE per hop, and every address checked against the internal ranges, IPv4
//      and IPv6 (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96 and 6to4 2002::/16 by their embedded
//      IPv4 too; Teredo and site-local blocked whole);
//   3. the connection PINNED to the checked address (a lookup that returns only it): a DNS answer
//      that changes between the check and the connect (rebinding) never reaches a socket;
//   4. a redirect is a new hop: the gate, the resolve and the check again, at most 5;
//   5. the size counted on the bytes as they arrive (a Content-Length can lie), and a time limit
//      over the whole download, enforced as an absolute timer in each request too (the socket's
//      `timeout` is only idle time: a trickling server would stay under it).
import { spawnSync } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 5
export const DOWNLOAD_TIMEOUT_MS = 20_000

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks', 'egress-gate.mjs')

/** The egress gate's decision for a URL, as the quarantine-reader: only exit 0 with NO output is an allow. */
export function gateAllows(url: string, gate = GATE): boolean {
  const r = spawnSync(process.execPath, [gate], {
    input: JSON.stringify({ tool_name: 'WebFetch', tool_input: { url }, agent_type: 'quarantine-reader' }),
    encoding: 'utf8',
    timeout: 10_000,
  })
  return r.status === 0 && r.stdout.trim() === ''
}

// IPv4 ranges that are not the public internet: this host, private, CGNAT and the tailnet,
// loopback, link-local (cloud metadata), IETF, benchmarking, multicast, reserved, broadcast
const V4 = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) V4.addSubnet(a, p, 'ipv4')
// IPv6: unspecified, loopback, link-local, unique-local, multicast, documentation, discard
const V6 = new net.BlockList()
for (const [a, p] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fec0::', 10], ['fc00::', 7], ['2001::', 32], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]] as const) V6.addSubnet(a, p, 'ipv6')

/** The 8 hextets of an IPv6 address (with an embedded dotted IPv4 tail), or null. */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4tail) {
    const o = v4tail[1]!.split('.').map(Number)
    s = s.slice(0, -v4tail[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  if (s.includes('::') && h.length + t.length > 7) return null
  const parts = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  if (parts.length !== 8) return null
  const n = parts.map((x) => parseInt(x, 16))
  return n.some((x) => !(x >= 0 && x <= 0xffff)) ? null : n
}

/** True for every address that is not the public internet; anything unparsable is blocked too. */
export function blockedAddress(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) return V4.check(ip, 'ipv4')
  if (kind !== 6) return true
  const h = hextets(ip.replace(/%.*$/, ''))
  if (!h) return true
  const embedded = `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64): judged by the IPv4 inside
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return h[5] === 0 && h[6] === 0 ? V6.check(ip, 'ipv6') : V4.check(embedded, 'ipv4')
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return V4.check(embedded, 'ipv4')
  // 2002:aabb:ccdd::/48 (6to4) carries a.b.c.d in hextets 2 and 3; a host 6to4 route could reach it
  // (barracuda, #175). Teredo (2001::/32) hides its IPv4 XOR-ed: blocked whole, in V6 above.
  if (h[0] === 0x2002) return V4.check(`${h[1]! >> 8}.${h[1]! & 0xff}.${h[2]! >> 8}.${h[2]! & 0xff}`, 'ipv4')
  return V6.check(ip, 'ipv6')
}

export interface Response { status: number; location?: string; contentType?: string; server?: string; cfMitigated?: string; body: Buffer }

/**
 * True for a Cloudflare challenge page ("Just a moment..."): Cloudflare's own header on a challenge (cf-mitigated); a 403 that carries the
 * challenge's marks or comes from a Cloudflare server; a 429 or 503 with the marks; or a SMALL 200 page with the marks. A normal page that
 * merely mentions the words is not one: a 200 needs the challenge's title or script, and has to be small.
 */
export function looksLikeChallenge(status: number, res: { server?: string; cfMitigated?: string }, body: Buffer): boolean {
  if ((res.cfMitigated ?? '').toLowerCase().includes('challenge')) return true
  const text = body.subarray(0, 120_000).toString('utf8').toLowerCase()
  const marker = /<title>\s*just a moment|cf-chl-|challenge-platform|performing security verification/.test(text)
  if (status === 403) return marker || (res.server ?? '').toLowerCase().includes('cloudflare')
  // a 429 or 503 is a challenge only with the marks of one (an origin that is down also answers 503 behind Cloudflare)
  if (status === 429 || status === 503) return marker
  return status === 200 && marker && body.length < 120_000
}

export interface DownloadDeps {
  allowed(url: string): boolean
  resolve(host: string): Promise<string[]>
  isBlocked(ip: string): boolean
  /** One GET to `url`, connecting ONLY to `pinned`; must enforce `maxBytes` on the arriving bytes. */
  get(url: URL, pinned: string, timeoutMs: number, maxBytes: number): Promise<Response>
  /** One POST, pinned the same way (the Firecrawl fallback); the tests replace it, the default is pinnedPost. */
  post?(url: URL, pinned: string, headers: Record<string, string>, body: string, timeoutMs: number, maxBytes: number): Promise<Response>
}

/** `challenge` on a 200 page: it is a Cloudflare challenge, not the page. A failure carries the status and the address that answered, and `challenge`. */
export type DownloadResult =
  | { ok: true; body: Buffer; finalUrl: string; contentType: string; challenge: boolean }
  | { ok: false; why: string; status?: number; url?: string; challenge?: boolean }

async function resolveAll(host: string): Promise<string[]> {
  const r = await dnsLookup(host, { all: true, verbatim: true })
  return r.map((a) => a.address)
}

export interface RequestInit { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }

/** One request over a socket pinned to one address; the bytes are counted as they arrive. */
export function pinnedRequest(url: URL, pinned: string, timeoutMs: number, maxBytes: number, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const family = net.isIP(pinned)
    const mod = url.protocol === 'https:' ? https : http
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = init.headers ?? { 'user-agent': 'acroveliq-karanten/1', accept: 'text/html,text/plain,application/pdf,*/*;q=0.5' }
    if (init.body != null) headers['content-length'] = String(Buffer.byteLength(init.body))
    const req = mod.request(url, {
      method,
      headers,
      // the ONLY address this socket may use (TLS still checks the certificate against the name)
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        opts?.all ? cb(null, [{ address: pinned, family }]) : cb(null, pinned, family)) as never,
      // the socket's IDLE time only: a server trickling a byte at a time stays under it for ever
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBytes) { over = true; res.destroy(); req.destroy(); done(() => reject(new Error('tul nagy'))); return }
        chunks.push(c)
      })
      const h = (k: string) => (typeof res.headers[k] === 'string' ? (res.headers[k] as string) : undefined)
      // a single chunk past the limit ends the response too: it must not come back as a short, complete-looking body
      res.on('end', () => done(() => over ? reject(new Error('tul nagy')) : resolve({
        status: res.statusCode ?? 0,
        location: h('location'),
        contentType: h('content-type'),
        server: h('server'),
        cfMitigated: h('cf-mitigated'),
        body: Buffer.concat(chunks),
      })))
      res.on('error', (e) => done(() => reject(e)))
    })
    // the WHOLE request's limit, from the first byte to the last (barracuda, #175): the caller's
    // timeoutMs is the time left of the download, not a per-read allowance
    const whole = setTimeout(() => req.destroy(new Error('idotullepes')), timeoutMs)
    const done = (f: () => void) => { clearTimeout(whole); f() }
    req.on('timeout', () => req.destroy(new Error('idotullepes')))
    req.on('error', (e) => done(() => reject(e)))
    if (init.body != null) req.write(init.body)
    req.end()
  })
}

/** A GET over a socket pinned to one address. */
export function pinnedGet(url: URL, pinned: string, timeoutMs: number, maxBytes: number): Promise<Response> {
  return pinnedRequest(url, pinned, timeoutMs, maxBytes)
}

/** A POST over a socket pinned to one address (the Firecrawl call: the key goes only to a checked public address). */
export function pinnedPost(url: URL, pinned: string, headers: Record<string, string>, body: string, timeoutMs: number, maxBytes: number): Promise<Response> {
  return pinnedRequest(url, pinned, timeoutMs, maxBytes, { method: 'POST', headers, body })
}

export const DEFAULT_DEPS: DownloadDeps = { allowed: (u) => gateAllows(u), resolve: resolveAll, isBlocked: blockedAddress, get: pinnedGet }

/** Downloads a page for the reader, or says why not (never with content). */
export async function letolt(start: string, deps: DownloadDeps = DEFAULT_DEPS, limits = { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS }): Promise<DownloadResult> {
  const deadline = Date.now() + limits.timeoutMs
  let url: URL
  try { url = new URL(start) } catch { return { ok: false, why: 'nem URL' } }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: `nem http(s): ${url.protocol}` }
    if (url.username || url.password) return { ok: false, why: 'hitelesito adat az URL-ben' }
    if (!deps.allowed(url.href)) return { ok: false, why: `az egress-kapu nem engedi: ${url.hostname}` }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let addrs: string[]
    try { addrs = net.isIP(host) ? [host] : await deps.resolve(host) } catch { return { ok: false, why: `a nev nem oldhato fel: ${host}` } }
    if (!addrs.length) return { ok: false, why: `a nev nem oldhato fel: ${host}` }
    const bad = addrs.find((a) => deps.isBlocked(a))
    if (bad) return { ok: false, why: `belso vagy nem publikus cimre mutat: ${host}` }
    const left = deadline - Date.now()
    if (left <= 0) return { ok: false, why: 'idotullepes' }
    let res: Response
    try { res = await deps.get(url, addrs[0]!, left, limits.maxBytes) } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return { ok: false, why: m === 'tul nagy' ? `nagyobb, mint ${limits.maxBytes} bajt` : m === 'idotullepes' ? 'idotullepes' : 'a letoltes hibaval allt le' }
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      try { url = new URL(res.location, url) } catch { return { ok: false, why: 'hibas atiranyitas' } }
      continue
    }
    if (res.status !== 200) return { ok: false, why: `a valasz ${res.status}`, status: res.status, url: url.href, challenge: looksLikeChallenge(res.status, res, res.body) }
    return { ok: true, body: res.body, finalUrl: url.href, contentType: res.contentType ?? '', challenge: looksLikeChallenge(200, res, res.body) }
  }
  return { ok: false, why: `tobb, mint ${MAX_REDIRECTS} atiranyitas` }
}
