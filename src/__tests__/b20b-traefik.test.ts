// B20b step 4 (task b20b-coolify2-traefik): the Traefik file that keeps only /webhooks/ public on
// coolify2.acropora.hu. WHAT TURNS THIS RED:
//   - a router other than the three, or a webhook rule wider than Host && PathPrefix(`/webhooks/`);
//   - a closing router that no longer covers the whole host, or loses its deny middleware;
//   - the deny middleware letting anything but 127.0.0.1/32 in;
//   - a priority that would let one of Coolify's eight routers (default priority = rule length,
//     all under 100, measured in step 0) win, or the closing routers outranking the webhook one;
//   - an entryPoints list (their names were not measured; without one a router takes them all);
//   - the TLS pair broken: the https routers without the resolver, or a plain-http webhook router.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const raw = readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'host', 'b20b-csak-webhook.yaml'), 'utf8')
const code = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

/** The routers: name -> its indented block (four-space children of `  routers:`). */
function routers(): Record<string, string> {
  const lines = code.split('\n')
  const start = lines.indexOf('  routers:')
  expect(start).toBeGreaterThanOrEqual(0)
  const out: Record<string, string[]> = {}
  let cur: string | null = null
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(l)) break
    const m = /^ {4}([a-z0-9-]+):$/.exec(l)
    if (m) {
      cur = m[1]!
      out[cur] = []
    } else if (cur) out[cur]!.push(l)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}

const prio = (b: string) => Number(/^ {6}priority: (\d+)$/m.exec(b)?.[1] ?? NaN)
const HOST = 'Host(`coolify2.acropora.hu`)'

describe('B20b: coolify2 keeps only /webhooks/ public', () => {
  const r = routers()

  it('exactly three routers', () => {
    expect(Object.keys(r).sort()).toEqual(['b20b-webhook-https', 'b20b-zar-http', 'b20b-zar-https'])
  })

  it('the webhook router: only /webhooks/, https only, Coolify service, the highest priority', () => {
    const w = r['b20b-webhook-https']!
    expect(w).toMatch(new RegExp('^ {6}rule: ' + HOST.replace(/[()`.]/g, '\\$&') + ' && PathPrefix\\(`/webhooks/`\\)$', 'm'))
    expect(w).toMatch(/^ {6}service: coolify$/m)
    expect(w).toMatch(/^ {6}tls:\n {8}certResolver: letsencrypt$/m)
    expect(w).not.toMatch(/middlewares/)
    expect(prio(w)).toBeGreaterThan(prio(r['b20b-zar-https']!))
  })

  it('the closing routers: the whole host, denied, on both TLS and plain', () => {
    for (const name of ['b20b-zar-https', 'b20b-zar-http']) {
      const z = r[name]!
      expect(z).toMatch(new RegExp('^ {6}rule: ' + HOST.replace(/[()`.]/g, '\\$&') + '$', 'm'))
      expect(z).toMatch(/^ {6}middlewares:\n {8}- b20b-mindenki-kizarva$/m)
    }
    expect(r['b20b-zar-https']).toMatch(/^ {6}tls:\n {8}certResolver: letsencrypt$/m)
    expect(r['b20b-zar-http']).not.toMatch(/tls:/)
  })

  it('every router outranks Coolify\'s eight (default priority = rule length, all under 100)', () => {
    const longest = `${HOST} && PathPrefix(\`/terminal/ws\`)`.length
    expect(longest).toBeLessThan(100)
    for (const b of Object.values(r)) expect(prio(b)).toBeGreaterThan(longest)
  })

  it('the deny middleware lets only localhost in', () => {
    expect(code).toMatch(/^ {4}b20b-mindenki-kizarva:\n {6}ipAllowList:\n {8}sourceRange:\n {10}- 127\.0\.0\.1\/32\n {2}routers:$/m)
  })

  it('no entryPoints anywhere (not measured; none means all)', () => {
    expect(code).not.toMatch(/entryPoints/i)
  })
})
