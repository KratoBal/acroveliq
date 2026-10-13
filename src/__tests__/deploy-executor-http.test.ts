import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseExecutorConfig } from '../deploy-executor/config.js'
import { DeployExecutor } from '../deploy-executor/executor.js'
import { createExecutorServer, MAX_BODY_BYTES } from '../deploy-executor/http.js'
import { RequestStore } from '../deploy-executor/store.js'
import type { CoolifyClient, DiscordReader, GitHubReader } from '../deploy-executor/transports.js'
import { assertHungarianDates } from '../deploy-executor/verify-approval.js'

/*
  THE EXECUTOR'S DOOR AND ITS CONTAINER (SB1, slice 2). What turns these red:
  a refusal answered as anything but 403 with its reason; a non-JSON or
  oversized body reaching the executor; an outside failure's message (which
  could carry what an outside system sent) in the answer; the executor
  importing fleet code that the image does not contain; the image or the
  compose file losing read-only, cap_drop, no-new-privileges or the internal
  network, gaining a docker socket, a host port, a fleet path or a
  COPY of the whole tree.
*/

const SHA = `${'1'.repeat(8)}${'a'.repeat(32)}`
const LEAK = 'upstream-said-SECRET-0123'

let dir: string
let base: string
let close: () => Promise<void>
let githubFails: boolean

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-executor-http-'))
  githubFails = false
  const config = parseExecutorConfig({
    stateDir: join(dir, 'state'),
    discord: { channelId: '1540270627926183997', requestBotUserId: '1500000000000000001', deciderUserIds: ['1460000000000000001'], yes: 'igen', no: 'nem', tokenFile: '/run/secrets/d' },
    github: { tokenFile: '/run/secrets/g' },
    coolifyHosts: { 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', coolifyTokenFile: '/run/secrets/c' } },
    apps: [{ env: 'prod', name: 'acropora-api', coolifyHost: 'prod-gep', coolifyUuid: 'prodapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30 }],
  })
  const github: GitHubReader = {
    async compare(_repo, b) {
      if (githubFails) throw new Error(`GitHub said ${LEAK}`)
      return { status: 'ahead', baseSha: b }
    },
  }
  const coolify = {
    async listAppDeployments() {
      return []
    },
  } as unknown as CoolifyClient
  const discord = {} as DiscordReader
  const ex = new DeployExecutor({ config, store: new RequestStore(config.stateDir), discord, github, coolify })
  const server = createExecutorServer(ex, () => {})
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((res) => server.close(() => res()))
})
afterEach(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('the HTTP door', () => {
  it('a request answers 201 with the R and its line, and the R reads back', async () => {
    const resp = await post('/requests', { env: 'prod', app: 'acropora-api', action: 'deploy', sha: SHA, requester: 'acrobot' })
    expect(resp.status).toBe(201)
    const body = (await resp.json()) as { r: string; canonicalLine: string; status: string }
    expect(body.canonicalLine).toBe(`VEGREHAJTO R=${body.r} / prod / acropora-api / deploy / ${SHA} / VISZONY NEM MERT`)
    const again = await fetch(`${base}/requests/${body.r}`)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { status: string }).status).toBe('open')
  })

  it('a refusal is 403 with its reason', async () => {
    const resp = await post('/requests', { env: 'prod', app: 'acropora-commerce-medusa', action: 'deploy', sha: SHA, requester: 'acrobot' })
    expect(resp.status).toBe(403)
    expect(await resp.json()).toEqual({ error: 'application is not on the allowlist for this environment' })
  })

  it('an execution without an approval is 403, never a deployment', async () => {
    const resp = await post('/executions', { r: 'NOSUCHR2', requestMessageId: '1550000000000000000' })
    expect(resp.status).toBe(403)
  })

  it.each([
    ['not JSON', '{nope', undefined],
    ['a JSON array', '[]', undefined],
    ['another content type', '{}', { 'content-type': 'text/plain' }],
    ['an oversized body', JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }), undefined],
  ])('%s is 400', async (_n, body, headers) => {
    expect((await post('/requests', body, headers)).status).toBe(400)
  })

  it('an unknown path or method is 404, an unknown R is 404', async () => {
    expect((await fetch(`${base}/deploy`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/requests`)).status).toBe(404)
    expect((await fetch(`${base}/requests/ABCDEFGH`)).status).toBe(404)
  })

  it('an outside failure is 502 with a fixed text, not what the outside system said', async () => {
    githubFails = true
    const resp = await post('/requests', { env: 'prod', app: 'acropora-api', action: 'deploy', sha: SHA, requester: 'acrobot' })
    expect(resp.status).toBe(502)
    expect(await resp.text()).not.toContain(LEAK)
  })
})

describe('what goes into the image', () => {
  it('the executor imports only node built-ins, its own files and #33 pure Discord half', () => {
    const srcDir = join(__dirname, '..', 'deploy-executor')
    const allowed = /^(node:[a-z_/]+|\.\/[a-z-]+\.js|\.\.\/web\/approval-discord-core\.js)$/
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(8)
    const imports = files.flatMap((f) =>
      [...readFileSync(join(srcDir, f), 'utf8').matchAll(/^(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => `${f}: ${m[1]}`),
    )
    expect(imports.length).toBeGreaterThan(10)
    expect(imports.filter((i) => !allowed.test(i.split(': ')[1]!))).toEqual([])
    // and the core it shares imports nothing of the fleet either
    const core = readFileSync(join(__dirname, '..', 'web', 'approval-discord-core.ts'), 'utf8')
    expect([...core.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual(['node:crypto'])
  })

  it('the Dockerfile copies those files only, builds them, and runs as an unprivileged user', () => {
    const df = readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'Dockerfile'), 'utf8')
    const copies = [...df.matchAll(/^COPY (?!--from)(\S+)/gm)].map((m) => m[1])
    expect(copies).toEqual([
      'deploy-executor/build/package.json',
      'tsconfig.json',
      'deploy-executor/tsconfig.build.json',
      'src/deploy-executor',
      'src/web/approval-discord-core.ts',
      'deploy-executor/package.json',
    ])
    expect(df).toMatch(/^USER 10001:10001$/m)
    // the compiler from the lockfile, never a bare npm install; the base image only by digest
    expect(df).toMatch(/^RUN npm ci --ignore-scripts/m)
    expect(df).not.toMatch(/npm install/)
    expect(df).toMatch(/^ARG NODE_IMAGE$/m)
    expect(df).toMatch(/\*@sha256:\?{64}\)/)
    const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'build', 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>
    }
    const rootLock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8')) as typeof lock
    for (const [k, v] of Object.entries(lock.packages)) {
      if (!k) continue
      expect(v.integrity).toMatch(/^sha512-/)
      // the same package, the same bytes as the dashboard's own build
      expect([v.version, v.integrity]).toEqual([rootLock.packages[k]?.version, rootLock.packages[k]?.integrity])
    }
    const build = JSON.parse(readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'tsconfig.build.json'), 'utf8')) as { include: string[] }
    expect(build.include).toEqual(['../src/deploy-executor/*.ts', '../src/web/approval-discord-core.ts'])
  })

  it('the compose file keeps the container closed', () => {
    const c = readFileSync(join(__dirname, '..', '..', 'deploy-executor', 'compose.yaml'), 'utf8')
    const code = c.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    for (const must of [/NODE_IMAGE: \$\{VEGREHAJTO_NODE_IMAGE:\?/, /^\s+read_only: true$/m, /^\s+cap_drop:\n\s+- ALL$/m, /no-new-privileges:true/, /^\s+user: "10001:10001"$/m, /^\s+internal: true$/m, /^\s+context: \/opt\/vegrehajto\/src$/m]) {
      expect(code).toMatch(must)
    }
    for (const never of [/docker\.sock/, /\/opt\/marveen-docker/, /^\s+ports:/m, /privileged: true/, /pid: host/, /network_mode/, /\/home\/marveen/]) {
      expect(code).not.toMatch(never)
    }
  })

  it('this runtime renders the expiry as the dashboard does (the image runs the same check at start)', () => {
    expect(() => assertHungarianDates()).not.toThrow()
  })
})
