import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/infra-allapot.sh SAYS WHAT IT SAW (task flotta-or-es-infra-javitas, 2026-10-19).
  Measured that day: the AI machine's Coolify refused the fleet on its public name, and the stage section printed
  "a valasz nem JSON" instead of saying so. Since card 8f35a038 (2026-11-11) the fleet asks it on the tailnet. The probe
  asked /api/health, a path the sections never use; where that answered 200 and the API refused, the refusal read
  as a broken answer. What turns these red: a refusal printed as "not JSON"; the probe judging by a path other than
  the one the section uses; a 403 and a 502 or a dead connection told as the same thing; a non-JSON answer printed
  without its HTTP status; the script sending anything but GET; and the prod-tree hook line calling a stale hook
  current, or running an installer that does not know --check (it would reinstall).
  The script runs for real, from a copy whose three fixed lines (the install dir and the two Coolify addresses)
  point at local servers and a scratch tree; the real curl asks them.
*/

const ROOT = join(__dirname, '..', '..')

interface Reply {
  code: number
  type?: string
  body: string
}
type Routes = Record<string, Reply>

function makeServer(routes: () => Routes, log: { method: string; path: string }[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    log.push({ method: req.method ?? '', path: req.url ?? '' })
    const hit = routes()[(req.url ?? '').split('?')[0]!] ?? { code: 404, body: 'not found' }
    res.writeHead(hit.code, { 'Content-Type': hit.type ?? 'application/json' })
    res.end(hit.body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })))
}

let prod: { server: Server; port: number }
let ai: { server: Server; port: number }
let prodRoutes: Routes = {}
let aiRoutes: Routes = {}
const seen: { method: string; path: string }[] = []
let dir: string

beforeAll(async () => {
  prod = await makeServer(() => prodRoutes, seen)
  ai = await makeServer(() => aiRoutes, seen)
})
afterAll(() => {
  prod.server.close()
  ai.server.close()
})
beforeEach(() => {
  seen.length = 0
  prodRoutes = {}
  aiRoutes = {}
  dir = mkdtempSync(join(tmpdir(), 'infra-allapot-'))
  mkdirSync(join(dir, 'store'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'store', '.coolify-token-prod'), 'prod-token\n')
  writeFileSync(join(dir, 'store', '.coolify-token-ai-rw'), 'ai-token\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const apps = (names: string[]) => JSON.stringify(names.map((name) => ({ name, status: 'running:healthy', fqdn: `https://${name}.example` })))

/** Run the script from a copy pointed at the local servers; `aiPort` overrides the AI address (a closed port). */
function run(opts: { aiPort?: number } = {}): Promise<{ code: number; out: string }> {
  const src = readFileSync(join(ROOT, 'scripts', 'infra-allapot.sh'), 'utf8')
  const copy = src
    .replace(/^INSTALL_DIR=.*$/m, `INSTALL_DIR=${dir}`)
    .replace(/^COOLIFY_PROD_URL=.*$/m, `COOLIFY_PROD_URL="http://127.0.0.1:${prod.port}"`)
    .replace(/^AI_COOLIFY_URL=.*$/m, `AI_COOLIFY_URL="http://127.0.0.1:${opts.aiPort ?? ai.port}"`)
  expect(copy).toContain(`INSTALL_DIR=${dir}`)
  expect(copy).toContain(`COOLIFY_PROD_URL="http://127.0.0.1:${prod.port}"`)
  expect(copy).toContain(`AI_COOLIFY_URL="http://127.0.0.1:${opts.aiPort ?? ai.port}"`)
  const file = join(dir, 'infra-allapot-copy.sh')
  writeFileSync(file, copy)
  return new Promise((resolve) =>
    execFile('bash', [file], { timeout: 60000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )
}

const aiSection = (out: string) => out.slice(out.indexOf('===== AI GEP'), out.indexOf('TELEPITESI MOD'))

// card 8f35a038 (2026-11-11): the AI machine's Coolify is reached on the tailnet with the fleet's rw token; the public
// name is closed and the executor is gone. WHAT TURNS THESE RED: a refused token told as anything but a refused token,
// or pointing at the executor; the probe asking another path than the sections; a dead tailnet told as a refusal; the
// token file read from anywhere but store/.coolify-token-ai-rw; the fixed address not the tailnet one.
describe('the AI machine on the tailnet: what the answer was is said as it was', () => {
  it('the fixed address is the tailnet one, and the token is the fleet rw token', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'infra-allapot.sh'), 'utf-8')
    expect(src).toMatch(/^AI_COOLIFY_URL="http:\/\/100\.88\.199\.87:8000"$/m)
    expect(src).toMatch(/^AI_TOKEN="\$INSTALL_DIR\/store\/\.coolify-token-ai-rw"$/m)
    expect(src).not.toContain('vegrehajto.sh')
    // the deploy helper asks the same Coolify, with the same token
    const deploy = readFileSync(join(ROOT, 'scripts', 'kirakat-telepites.sh'), 'utf-8')
    expect(deploy).toMatch(/^COOLIFY=http:\/\/100\.88\.199\.87:8000$/m)
    expect(deploy).toMatch(/^TOKEN_FILE=\/home\/marveen\/marveen\/store\/\.coolify-token-ai-rw$/m)
    expect(deploy).not.toContain('coolify2.acropora.hu/')
  })

  it.each([401, 403])('HTTP %i on the API: the token was refused, named, with the way to the deploy state', async (code) => {
    aiRoutes = { '/api/v1/applications': { code, type: 'text/plain', body: 'Forbidden' } }
    const r = await run()
    const sec = aiSection(r.out)
    expect(sec).toContain(`A TOKENT ELUTASITOTTA (HTTP ${code})`)
    expect(sec).toContain('.coolify-token-ai-rw')
    expect(sec).toContain('kirakat-telepites.sh allapot')
    expect(r.out).not.toContain('a valasz nem JSON -- a felulet')
  })

  it('the probe asks the applications list (not /api/health)', async () => {
    aiRoutes = {
      '/api/health': { code: 200, body: 'OK', type: 'text/plain' },
      '/api/v1/applications': { code: 403, type: 'text/plain', body: 'Forbidden' },
    }
    await run()
    expect(seen.filter((q) => q.path === '/api/health')).toEqual([])
    expect(seen.some((q) => q.path === '/api/v1/applications')).toBe(true)
  })

  it('without the rw token file the probe still asks, and the refusal names the file', async () => {
    rmSync(join(dir, 'store', '.coolify-token-ai-rw'))
    aiRoutes = { '/api/v1/applications': { code: 401, type: 'text/plain', body: 'Unauthenticated' } }
    const r = await run()
    expect(aiSection(r.out)).toContain('A TOKENT ELUTASITOTTA (HTTP 401)')
    expect(seen.some((q) => q.path === '/api/v1/applications')).toBe(true)
  })

  it('a 200 prints the list', async () => {
    aiRoutes = {
      '/api/v1/applications': { code: 200, body: apps(['acropora-stage-api']) },
      '/api/v1/databases': { code: 200, body: '[]' },
      '/api/v1/services': { code: 200, body: '[]' },
    }
    const r = await run()
    const sec = aiSection(r.out)
    expect(sec).toContain('acropora-stage-api')
    expect(sec).not.toContain('ELUTASITOTTA')
    expect(sec).toContain('(egy sem)')
  })

  it.each([
    [502, '502'],
    [500, '500'],
  ])('HTTP %i is told with its code, not as a refused token', async (code, shown) => {
    aiRoutes = { '/api/v1/applications': { code, type: 'text/plain', body: 'x' } }
    const r = await run()
    const sec = aiSection(r.out)
    expect(sec).toContain(`HTTP ${shown}-t adott`)
    expect(sec).not.toContain('ELUTASITOTTA')
  })

  it('no connection at all (a closed port) is its own sentence: the tailnet, not a refusal', async () => {
    const dead = await makeServer(() => ({}), [])
    const closedPort = dead.port
    dead.server.close()
    const r = await run({ aiPort: closedPort })
    const sec = aiSection(r.out)
    expect(sec).toContain('A tailnet-cim nem valaszol (nincs kapcsolat)')
    expect(sec).not.toContain('ELUTASITOTTA')
  })

  it('the install-mode section says the same for the stage machine', async () => {
    aiRoutes = { '/api/v1/applications': { code: 403, type: 'text/plain', body: 'Forbidden' } }
    const r = await run()
    const mode = r.out.slice(r.out.indexOf(' --- AI GEP (teszt) ---'))
    expect(mode).toContain('A TOKENT ELUTASITOTTA (HTTP 403)')
  })
})

describe('a non-JSON answer carries its HTTP status', () => {
  it('the production machine: a 403 "Forbidden" is printed as HTTP 403 with its first words, not as a bare "not JSON"', async () => {
    prodRoutes = {
      '/api/v1/applications': { code: 403, type: 'text/plain', body: 'Forbidden' },
      '/api/v1/databases': { code: 502, type: 'text/html', body: '<html>Bad\n   gateway</html>' },
      '/api/v1/services': { code: 200, body: '[]' },
    }
    aiRoutes = { '/api/v1/applications': { code: 403, type: 'text/plain', body: 'Forbidden' } }
    const r = await run()
    expect(r.out).toContain('HTTP 403, a valasz nem JSON: Forbidden')
    expect(r.out).toContain('HTTP 502, a valasz nem JSON: <html>Bad gateway</html>')
    expect(r.out).not.toContain('a felulet elerheto egyaltalan')
  })

  it('a JSON list still prints name, status and address', async () => {
    prodRoutes = {
      '/api/v1/applications': { code: 200, body: apps(['acropora-api']) },
      '/api/v1/databases': { code: 200, body: '[]' },
      '/api/v1/services': { code: 200, body: '[]' },
    }
    aiRoutes = { '/api/v1/applications': { code: 403, body: 'Forbidden' } }
    const r = await run()
    expect(r.out).toMatch(/acropora-api\s+running:healthy\s+https:\/\/acropora-api\.example/)
  })

  it('the script only reads: every request it sent was a GET', async () => {
    aiRoutes = { '/api/v1/applications': { code: 403, body: 'Forbidden' } }
    prodRoutes = { '/api/v1/applications': { code: 200, body: '[]' } }
    await run()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((q) => q.method === 'GET')).toBe(true)
  })
})

describe('the prod-tree hook line', () => {
  const installerWith = (body: string) => {
    writeFileSync(join(dir, 'scripts', 'install-prod-tree-guard-hook.sh'), body)
    chmodSync(join(dir, 'scripts', 'install-prod-tree-guard-hook.sh'), 0o755)
  }
  const section = (out: string) => out.slice(out.indexOf('===== PROD-FA OR'), out.indexOf("FIGYELEM: az 'exited'"))

  it('an installer that knows --check and says the hook is stale: the line is shown and the alert path is named as at risk', async () => {
    installerWith('#!/usr/bin/env bash\n# supports --check\n[ "$1" = "--check" ] || exit 9\necho "prod-tree-guard: ELAVULT a telepitett post-checkout hook"\nexit 1\n')
    const r = await run()
    const sec = section(r.out)
    expect(sec).toContain('ELAVULT a telepitett post-checkout hook')
    expect(sec).toContain('egy valtas riasztasa elveszhet')
  })

  it('a current hook: its line, and no warning', async () => {
    installerWith('#!/usr/bin/env bash\n# supports --check\n[ "$1" = "--check" ] || exit 9\necho "prod-tree-guard: a telepitett hook aktualis (a riasztas cimzettje: acrobot)"\nexit 0\n')
    const sec = section((await run()).out)
    expect(sec).toContain('aktualis (a riasztas cimzettje: acrobot)')
    expect(sec).not.toContain('elveszhet')
  })

  it('an installer that does not know --check is NOT run (it would reinstall, not check)', async () => {
    const marker = join(dir, 'ran.txt')
    installerWith(`#!/usr/bin/env bash\necho ran > ${marker}\nexit 0\n`)
    const sec = section((await run()).out)
    expect(sec).toContain('meg nem tud --check-et')
    expect(existsSync(marker)).toBe(false)
  })

  it('no installer in the tree: said, not crashed', async () => {
    const sec = section((await run()).out)
    expect(sec).toContain('nincs telepito a futo fan')
  })
})
