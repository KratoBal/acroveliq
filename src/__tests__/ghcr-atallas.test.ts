// scripts/ghcr-atallas.sh (task t-20261117-ghcr-kepek, card 0529e916; acrobot 54755). WHAT TURNS THESE RED: a write sent by terv, meres or a dry
// run; the rw token read or sent outside a write; a drifted app (a recorded field, the env rows, a non-running status) switched anyway; a prod, game or
// reefclub app, a bad uuid or a tag that is not sha-<40 hex> (latest included) reaching Coolify; the switch body not exactly the three fields; a
// PATCH Coolify rejected, or one that also changed another field, going on to the env delete or the deploy; a delete that did not delete, a failed
// deploy, or a /health that does not say imageCommit == runtimeCommit == the tag's commit going on as done; the restore not writing the recorded values
// back (the null registry fields included), not re-creating the env row, or passing a field Coolify did not take; a token in the output or the journal.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'scripts', 'ghcr-atallas.sh')
const TOKEN_RO = 'olvaso-teszt-token-123'
const TOKEN_RW = 'iro-teszt-token-456'
const SHA = 'a'.repeat(40)
const GIT_HEAD = 'b'.repeat(40)
const API = 'vrjxxwffsxytstq8oepgbhii'
const WEB = 'euxxmlqsweb00000000000a1'
const PARTNER = 'jsmnmlfrpartner0000000aa1'
const JATEK = 'rv6j6yvmjatek00000000aaa'
const PROD_API = 't9gxx94eprodapi000000aaa'

const envRow = (key: string, over: Record<string, unknown> = {}) => ({ key, value: null, is_preview: false, is_build_time: false, is_runtime: true, ...over })
const baseApp = (name: string, uuid: string, fqdn: string, envs: unknown[], over: Record<string, unknown> = {}) => ({
  uuid,
  name,
  fqdn,
  build_pack: 'dockerfile',
  dockerfile_location: `/apps/${name.includes('api') ? 'api' : name.includes('web') ? 'web' : 'partner'}/Dockerfile`,
  dockerfile_target_build: null,
  base_directory: '/',
  docker_registry_image_name: null,
  docker_registry_image_tag: null,
  ports_exposes: '3001',
  ports_mappings: '3001:3001',
  git_repository: 'KratoBal/acropora-os',
  git_branch: 'main',
  git_commit_sha: 'HEAD',
  health_check_enabled: false,
  health_check_path: '/',
  status: 'running:healthy',
  envs,
  ...over,
})

type App = Record<string, any>
type Row = { uuid: string; key: string; is_preview: boolean; is_build_time: boolean; is_runtime: boolean; value?: string }
type Call = { method: string; path: string; body: any; auth: string | undefined }

let server: Server
let dir: string
let script: string
let journalDir: string
let port = 0
let calls: Call[] = []
// the mock Coolify's state
let apps: Record<string, App> = {}
let envRows: Record<string, Row[]> = {}
let patchMode: 'apply' | 'reject' | 'ignore-null' | 'also-change' = 'apply'
let deleteWorks = true
let deployStatus = 'finished'
let platformReleaseVar = false // the Coolify RELEASE_COMMIT_SHA row exists on the api: while it does, the runtime commit is the platform value
let healthStale = false
let autoPatchIgnored = false // the mock Coolify takes no is_auto_deploy_enabled write
let omitAutoField = false // the app answer carries no is_auto_deploy_enabled field
const AUTO_MEASURED: Record<string, boolean> = { 'acropora-stage-api': false, 'acropora-staging-web': true, 'acropora-staging-partner': true, 'acropora-staging-jatek': false }

const RECORDED_ENVS_API = [envRow('NODE_ENV', { is_build_time: true }), envRow('RELEASE_COMMIT_SHA', { is_build_time: true }), envRow('RELEASE_COMMIT_SHA', { is_preview: true, is_build_time: true })]
let recorded: any

function freshState() {
  recorded = {
    stage: [
      baseApp('acropora-stage-api', API, `http://127.0.0.1:${port}/api-host`, RECORDED_ENVS_API),
      baseApp('acropora-staging-web', WEB, `http://127.0.0.1:${port}/web-host`, [envRow('API_URL', { is_build_time: true })], { ports_exposes: '3000', ports_mappings: null }),
      baseApp('acropora-staging-partner', PARTNER, `http://127.0.0.1:${port}/partner-host`, [envRow('API_URL', { is_build_time: true })], { ports_exposes: '3002', ports_mappings: null }),
      baseApp('acropora-staging-jatek', JATEK, `http://127.0.0.1:${port}/jatek-host`, [], { ports_exposes: '3003' }),
    ],
    prod: [baseApp('acropora-api', PROD_API, 'https://api.acropora.hu', RECORDED_ENVS_API)],
  }
  writeFileSync(join(dir, 'recorded.json'), JSON.stringify(recorded))
  apps = {}
  envRows = {}
  for (const a of recorded.stage) {
    const { envs, ...rest } = a
    apps[a.uuid] = { ...rest, is_auto_deploy_enabled: AUTO_MEASURED[a.name] }
    envRows[a.uuid] = (envs as any[]).map((e, i) => ({ uuid: `env-${a.uuid.slice(0, 4)}-${i}`, key: e.key, is_preview: e.is_preview, is_build_time: e.is_build_time, is_runtime: e.is_runtime }))
  }
  platformReleaseVar = true
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      calls.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization })
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const url = new URL(req.url!, `http://127.0.0.1:${port}`)
      const m = /^\/api\/v1\/applications\/([a-z0-9]+)(\/envs(?:\/([\w-]+))?)?$/.exec(url.pathname)
      if (m) {
        const [, id, envPart, envUuid] = m
        const app = apps[id]
        if (!app) return send(404, { message: 'not found' })
        if (!envPart) {
          if (req.method === 'GET') {
            const { is_auto_deploy_enabled: _auto, ...withoutAuto } = app
            return send(200, omitAutoField ? withoutAuto : app)
          }
          if (req.method === 'PATCH') {
            if (patchMode === 'reject') return send(422, { message: 'The selected build pack is invalid.' })
            for (const [k, v] of Object.entries(body)) {
              if (patchMode === 'ignore-null' && v === null) continue
              if (autoPatchIgnored && k === 'is_auto_deploy_enabled') continue
              app[k] = v
            }
            if (patchMode === 'also-change') app.ports_exposes = '9999'
            return send(200, { uuid: id })
          }
        } else if (!envUuid) {
          if (req.method === 'GET') return send(200, envRows[id])
          if (req.method === 'POST') {
            envRows[id].push({ uuid: `env-new-${envRows[id].length}`, key: body.key, is_preview: !!body.is_preview, is_build_time: !!body.is_build_time, is_runtime: !!body.is_runtime, value: body.value })
            if (body.key === 'RELEASE_COMMIT_SHA' && !body.is_preview) platformReleaseVar = true
            return send(201, { uuid: 'new' })
          }
        } else if (req.method === 'DELETE') {
          if (deleteWorks) {
            const row = envRows[id].find((e) => e.uuid === envUuid)
            envRows[id] = envRows[id].filter((e) => e.uuid !== envUuid)
            if (row && row.key === 'RELEASE_COMMIT_SHA' && !row.is_preview) platformReleaseVar = false
          }
          return send(200, { message: 'deleted' })
        }
      }
      if (url.pathname === '/api/v1/deploy' && req.method === 'POST') return send(200, { deployments: [{ deployment_uuid: 'dep-1' }] })
      if (url.pathname === '/api/v1/deployments/dep-1') return send(200, { status: deployStatus })
      if (url.pathname === '/api-host/health') {
        const api = apps[API]
        const pulled = api.build_pack === 'dockerimage' && String(api.docker_registry_image_tag).startsWith('sha-')
        const imageCommit = pulled ? String(api.docker_registry_image_tag).slice(4) : GIT_HEAD
        // the platform value wins over the image default, even a literal one (release-info.util.ts)
        const runtimeCommit = platformReleaseVar ? (healthStale ? GIT_HEAD : GIT_HEAD) : imageCommit
        return send(200, { application: { status: 'ok', imageCommit, runtimeCommit, commitSourceState: imageCommit === runtimeCommit ? 'match' : 'mismatch' } })
      }
      if (url.pathname === '/web-host/' || url.pathname === '/partner-host/') return send(200, { ok: true })
      send(404, { message: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  dir = mkdtempSync(join(tmpdir(), 'ghcr-atallas-'))
  journalDir = join(dir, 'journal')
  writeFileSync(join(dir, 'token-ro'), `${TOKEN_RO}\n`)
  writeFileSync(join(dir, 'token-rw'), `${TOKEN_RW}\n`)
  script = join(dir, 'ghcr-atallas.sh')
  writeFileSync(
    script,
    readFileSync(SRC, 'utf-8')
      .replace(/^COOLIFY=.*$/m, `COOLIFY="http://127.0.0.1:${port}"`)
      .replace(/^TOKEN_FILE_RO=.*$/m, `TOKEN_FILE_RO="${join(dir, 'token-ro')}"`)
      .replace(/^TOKEN_FILE_RW=.*$/m, `TOKEN_FILE_RW="${join(dir, 'token-rw')}"`)
      .replace(/^RECORDED=.*$/m, `RECORDED="${join(dir, 'recorded.json')}"`)
      .replace(/^JOURNAL_DIR=.*$/m, `JOURNAL_DIR="${journalDir}"`)
      .replace(/^POLL_SECONDS=.*$/m, 'POLL_SECONDS=0.02')
      .replace(/^DEPLOY_TIMEOUT_SECONDS=.*$/m, 'DEPLOY_TIMEOUT_SECONDS=5')
      .replace(/^HEALTH_TIMEOUT_SECONDS=.*$/m, 'HEALTH_TIMEOUT_SECONDS=0.5'),
  )
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  mkdirSync(journalDir, { recursive: true })
  calls = []
  patchMode = 'apply'
  deleteWorks = true
  deployStatus = 'finished'
  healthStale = false
  autoPatchIgnored = false
  omitAutoField = false
  freshState()
  rmSync(join(journalDir, `atallas-${API}.jsonl`), { force: true })
})

function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], { timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr })
    })
  })
}

const writes = () => calls.filter((c) => c.method !== 'GET')
const wasWritten = () => writes().length > 0
const FWD_BODY = { build_pack: 'dockerimage', docker_registry_image_name: 'ghcr.io/kratobal/acropora-os-api', docker_registry_image_tag: `sha-${SHA}` }

describe('read only: terv and meres', () => {
  it('terv prints both plans, sends no write, and uses the read token only', async () => {
    const r = await run('terv', API)
    expect(r.code).toBe(0)
    expect(wasWritten()).toBe(false)
    expect(r.out).toContain('ELORE')
    expect(r.out).toContain('VISSZA')
    expect(r.out).toContain('"build_pack": "dockerimage"')
    expect(r.out).toContain('"build_pack": "dockerfile"')
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN_RO}`)).toBe(true)
  })

  it('meres of the api reads /health only, and says the commits', async () => {
    const r = await run('meres', API)
    expect(r.code).toBe(0)
    expect(r.out).toContain('/health: imageCommit=')
    expect(wasWritten()).toBe(false)
  })

  it('terv and meres refuse --vegrehajt', async () => {
    expect((await run('terv', API, '--vegrehajt')).code).toBe(2)
    expect((await run('meres', API, '--vegrehajt')).code).toBe(2)
    expect(calls.length).toBe(0)
  })
})

describe('refusals before anything is sent', () => {
  it('refuses a prod app, a game app and an unknown or malformed uuid, with no call to Coolify', async () => {
    for (const uuid of [PROD_API, JATEK, 'abcdefgh12345678', 'NOT-A-UUID!']) {
      const r = await run('elore', uuid, SHA, '--vegrehajt')
      expect(r.code, uuid).toBe(2)
    }
    expect(calls.length).toBe(0)
  })

  it('refuses a tag that is not sha-<40 lower-case hex>: latest, short, upper case, empty, a branch name', async () => {
    for (const bad of ['latest', 'a'.repeat(39), 'A'.repeat(40), 'main', `sha-${SHA}`]) {
      const r = await run('elore', API, bad)
      expect(r.code, bad).toBe(2)
    }
    expect(calls.length).toBe(0)
  })

  it('refuses a wrong number of arguments and an unknown mode', async () => {
    expect((await run()).code).toBe(2)
    expect((await run('elore', API)).code).toBe(2)
    expect((await run('vissza', API, SHA)).code).toBe(2)
    expect((await run('torles', API)).code).toBe(2)
    expect(calls.length).toBe(0)
  })
})

describe('a drifted app is not switched', () => {
  it('a recorded field that differs refuses terv and elore, and names the field, with no write', async () => {
    apps[API].ports_exposes = '4000'
    for (const args of [['terv', API], ['elore', API, SHA, '--vegrehajt']]) {
      calls = []
      const r = await run(...args)
      expect(r.code).toBe(1)
      expect(r.err).toContain('ports_exposes')
      expect(wasWritten()).toBe(false)
    }
  })

  it('an env row that is not in the record refuses', async () => {
    envRows[API].push({ uuid: 'env-x', key: 'NEW_KEY', is_preview: false, is_build_time: false, is_runtime: true })
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('env-sorok')
    expect(wasWritten()).toBe(false)
  })

  it('an app that is not running is not switched', async () => {
    apps[API].status = 'exited:unhealthy'
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain("nem 'running")
    expect(wasWritten()).toBe(false)
  })
})

describe('elore', () => {
  it('a dry run (no --vegrehajt) prints the plan and sends nothing, and never reads the rw token', async () => {
    const original = readFileSync(script, 'utf-8')
    writeFileSync(script, original.replace(/^TOKEN_FILE_RW=.*$/m, `TOKEN_FILE_RW="${join(dir, 'no-such-token')}"`))
    try {
      const r = await run('elore', API, SHA)
      expect(r.code).toBe(0)
      expect(r.out).toContain('SZARAZ FUTAS')
      expect(wasWritten()).toBe(false)
    } finally {
      writeFileSync(script, original)
    }
  })

  it('--vegrehajt on the api: the exact three-field PATCH, the RELEASE_COMMIT_SHA delete, the deploy, and a /health that matches; rw token on the writes only', async () => {
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ELORE KESZ')
    const w = writes()
    expect(w.map((c) => `${c.method} ${c.path.split('?')[0].replace(/env-[\w-]+$/, 'env-ROW')}`)).toEqual([
      `PATCH /api/v1/applications/${API}`,
      `DELETE /api/v1/applications/${API}/envs/env-ROW`,
      'POST /api/v1/deploy',
    ])
    expect(w[0].body).toEqual(FWD_BODY)
    expect(w.every((c) => c.auth === `Bearer ${TOKEN_RW}`)).toBe(true)
    expect(calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/v1/')).every((c) => c.auth === `Bearer ${TOKEN_RO}`)).toBe(true)
    // the Coolify token never goes to the application: the /health read carries no Authorization header
    const health = calls.filter((c) => c.path.endsWith('/health'))
    expect(health.length).toBeGreaterThan(0)
    expect(health.every((c) => c.auth === undefined)).toBe(true)
    // only the NON-preview RELEASE_COMMIT_SHA row went; the preview row stays
    expect(envRows[API].filter((e) => e.key === 'RELEASE_COMMIT_SHA').map((e) => e.is_preview)).toEqual([true])
  })

  it('no body ever carries latest or another registry', async () => {
    await run('elore', API, SHA, '--vegrehajt')
    const text = JSON.stringify(writes().map((c) => c.body))
    expect(text).not.toContain('latest')
    expect(text).toContain('ghcr.io/kratobal/')
    expect(text).not.toMatch(/docker\.io|quay\.io/)
  })

  it('web and partner get their own image names, no env step, and are measured by GET /', async () => {
    for (const [uuid, name] of [[WEB, 'acropora-os-web-stage'], [PARTNER, 'acropora-os-partner-stage']] as const) {
      calls = []
      const r = await run('elore', uuid, SHA, '--vegrehajt')
      expect(r.code, uuid).toBe(0)
      const patch = writes().find((c) => c.method === 'PATCH' && c.body.docker_registry_image_name)!
      expect(patch.body.docker_registry_image_name).toBe(`ghcr.io/kratobal/${name}`)
      expect(writes().some((c) => c.method === 'DELETE')).toBe(false)
    }
  })

  it('a PATCH Coolify rejects stops everything: no env delete, no deploy, and the app is unchanged', async () => {
    patchMode = 'reject'
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('HTTP 422')
    expect(r.err).toContain('valtozatlan')
    expect(writes().map((c) => c.method)).toEqual(['PATCH'])
    expect(apps[API].build_pack).toBe('dockerfile')
  })

  it('a PATCH that also changed another field stops at the read-back, names the field, and starts no env delete or deploy', async () => {
    patchMode = 'also-change'
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('ports_exposes')
    expect(r.err).toContain('vissza')
    expect(writes().map((c) => c.method)).toEqual(['PATCH'])
  })

  it('a delete that did not delete stops before the deploy', async () => {
    deleteWorks = false
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('NEM TORLODOTT')
    expect(writes().some((c) => c.path.startsWith('/api/v1/deploy'))).toBe(false)
  })

  it('a failed deploy is a failure that names the way back, and is not measured as done', async () => {
    deployStatus = 'failed'
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('TELEPITES NEM SIKERULT')
    expect(r.err).toContain(`vissza ${API}`)
    expect(r.out).not.toContain('ELORE KESZ')
  })

  it('a /health that does not match the tag is NOT done: the platform variable still wins (it was not deleted because the record has none)', async () => {
    // an api record without the RELEASE_COMMIT_SHA row: nothing to delete, but the mock platform value still stands
    const stale = JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf-8'))
    stale.stage[0].envs = stale.stage[0].envs.filter((e: any) => e.key !== 'RELEASE_COMMIT_SHA')
    writeFileSync(join(dir, 'recorded.json'), JSON.stringify(stale))
    envRows[API] = envRows[API].filter((e) => e.key !== 'RELEASE_COMMIT_SHA')
    platformReleaseVar = true
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('A MERES NEM IGAZOL')
    expect(r.err).toContain('runtimeCommit=' + GIT_HEAD)
  })
})

describe('vissza', () => {
  async function switchedApi() {
    const r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(0)
    calls = []
  }

  it('a dry run sends nothing', async () => {
    await switchedApi()
    const r = await run('vissza', API)
    expect(r.code).toBe(0)
    expect(r.out).toContain('SZARAZ FUTAS')
    expect(wasWritten()).toBe(false)
  })

  it('--vegrehajt writes the recorded values back (the null registry fields included), re-creates the env row exactly, deploys, and ends on the recorded state', async () => {
    await switchedApi()
    const r = await run('vissza', API, '--vegrehajt')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('VISSZA KESZ')
    const patch = writes().find((c) => c.method === 'PATCH')!
    expect(patch.body).toEqual({
      build_pack: 'dockerfile',
      dockerfile_location: '/apps/api/Dockerfile',
      base_directory: '/',
      dockerfile_target_build: null,
      docker_registry_image_name: null,
      docker_registry_image_tag: null,
    })
    const post = writes().find((c) => c.method === 'POST' && c.path.endsWith('/envs'))!
    expect(post.body).toEqual({ key: 'RELEASE_COMMIT_SHA', value: '${SOURCE_COMMIT}', is_preview: false, is_build_time: true, is_runtime: true })
    expect(writes().some((c) => c.path.startsWith('/api/v1/deploy'))).toBe(true)
    // the whole recorded app is back
    const { envs: _envs, status: _status, ...fields } = recorded.stage[0]
    for (const [k, v] of Object.entries(fields)) expect(apps[API][k], k).toEqual(v)
    expect(envRows[API].filter((e) => e.key === 'RELEASE_COMMIT_SHA').map((e) => e.is_preview).sort()).toEqual([false, true])
  })

  it('a registry field Coolify did not clear stops the restore at the read-back, before the env and the deploy', async () => {
    await switchedApi()
    patchMode = 'ignore-null'
    const r = await run('vissza', API, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('docker_registry_image_name')
    expect(writes().map((c) => c.method)).toEqual(['PATCH'])
  })

  it('on an app that was never switched it is idempotent: the same PATCH, no env row to re-create, a deploy', async () => {
    const r = await run('vissza', API, '--vegrehajt')
    expect(r.code).toBe(0)
    expect(writes().some((c) => c.method === 'POST' && c.path.endsWith('/envs'))).toBe(false)
  })
})

describe('the journal and the output', () => {
  it('the journal names the steps, and neither it nor the output carries a token', async () => {
    const r = await run('elore', API, SHA, '--vegrehajt')
    const journal = readFileSync(join(journalDir, `atallas-${API}.jsonl`), 'utf-8')
    const steps = journal.trim().split('\n').map((l) => JSON.parse(l).step)
    expect(steps).toEqual(['kezdet', 'atallitas', 'env-torles', 'deploy-inditas', 'deploy-vege', 'meres'])
    for (const secret of [TOKEN_RO, TOKEN_RW]) {
      expect(journal).not.toContain(secret)
      expect(r.out).not.toContain(secret)
      expect(r.err).not.toContain(secret)
    }
  })

  it('a refused or dry run writes no journal line for a write', async () => {
    await run('elore', API, SHA)
    expect(existsSync(join(journalDir, `atallas-${API}.jsonl`))).toBe(false)
  })

  it('the address and the token files are fixed constants in the script, and the rw token is loaded only inside the write call', () => {
    const text = readFileSync(SRC, 'utf-8')
    expect(text).toMatch(/^COOLIFY="http:\/\/100\.88\.199\.87:8000"$/m)
    expect(text).toMatch(/^TOKEN_FILE_RW="\/home\/marveen\/marveen\/store\/\.coolify-token-ai-rw"$/m)
    expect(text.match(/read_token\(token_rw_file\)/g)?.length).toBe(1)
    expect(text).not.toMatch(/os\.environ|getenv/)
  })
})

describe('the automatic deploy (acrobot 54774: off on the api, ON on web and partner)', () => {
  const AUTO_OFF = { is_auto_deploy_enabled: false }
  const AUTO_ON = { is_auto_deploy_enabled: true }
  const patches = () => writes().filter((c) => c.method === 'PATCH').map((c) => c.body)
  const deployIndex = () => writes().findIndex((c) => c.path.startsWith('/api/v1/deploy'))

  it('terv shows the auto-deploy step for web and partner, and for the api only that it is already off', async () => {
    for (const uuid of [WEB, PARTNER]) {
      const r = await run('terv', uuid)
      expect(r.out, uuid).toContain('"is_auto_deploy_enabled": false')
      expect(r.out, uuid).toContain('"is_auto_deploy_enabled": true')
    }
    const api = await run('terv', API)
    expect(api.out).toContain('mar ki van kapcsolva')
    expect(api.out).not.toContain('"is_auto_deploy_enabled": true')
    expect(wasWritten()).toBe(false)
  })

  it('refuses an app whose auto-deploy differs from the measured state, or whose answer has no such field, with no write', async () => {
    apps[WEB].is_auto_deploy_enabled = false
    let r = await run('elore', WEB, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('automatikus telepites')
    apps[API].is_auto_deploy_enabled = true
    r = await run('elore', API, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('automatikus telepites')
    omitAutoField = true
    for (const [mode, uuid] of [['elore', API], ['elore', PARTNER], ['terv', WEB], ['vissza', WEB]] as const) {
      r = await run(mode, uuid, ...(mode === 'elore' ? [SHA] : mode === 'vissza' ? ['--vegrehajt'] : []))
      expect(r.code, `${mode} ${uuid}`).toBe(1)
      // a clean refusal that says why, not a crash that happens to name the field
      expect(r.err).toContain('nem ellenorizheto')
      expect(r.err).not.toContain('Traceback')
    }
    expect(wasWritten()).toBe(false)
  })

  it('elore on web and partner turns it off BEFORE the switch PATCH and the deploy, and leaves it off', async () => {
    for (const uuid of [WEB, PARTNER]) {
      calls = []
      const r = await run('elore', uuid, SHA, '--vegrehajt')
      expect(r.code, uuid).toBe(0)
      const p = patches()
      expect(p[0]).toEqual(AUTO_OFF)
      expect(p[1].build_pack).toBe('dockerimage')
      expect(writes().findIndex((c) => c.method === 'PATCH' && c.body.build_pack === 'dockerimage')).toBeLessThan(deployIndex())
      expect(apps[uuid].is_auto_deploy_enabled).toBe(false)
    }
  })

  it('a write the Coolify does not take stops elore before the switch: no switch PATCH, no deploy', async () => {
    autoPatchIgnored = true
    const r = await run('elore', WEB, SHA, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('is_auto_deploy_enabled')
    expect(patches()).toEqual([AUTO_OFF])
    expect(deployIndex()).toBe(-1)
    expect(apps[WEB].build_pack).toBe('dockerfile')
  })

  it('elore on the api writes no auto-deploy flag at all', async () => {
    await run('elore', API, SHA, '--vegrehajt')
    expect(JSON.stringify(patches())).not.toContain('is_auto_deploy_enabled')
  })

  it('vissza on web turns it back on only AFTER its deploy, and ends on the measured value', async () => {
    expect((await run('elore', WEB, SHA, '--vegrehajt')).code).toBe(0)
    calls = []
    const r = await run('vissza', WEB, '--vegrehajt')
    expect(r.code).toBe(0)
    const w = writes()
    const last = w[w.length - 1]
    expect(last.method).toBe('PATCH')
    expect(last.body).toEqual(AUTO_ON)
    expect(w.findIndex((c) => c.path.startsWith('/api/v1/deploy'))).toBeLessThan(w.length - 1)
    expect(patches()[0].build_pack).toBe('dockerfile')
    expect(apps[WEB].is_auto_deploy_enabled).toBe(true)
  })

  it('a failed vissza deploy leaves it OFF and says so', async () => {
    expect((await run('elore', WEB, SHA, '--vegrehajt')).code).toBe(0)
    calls = []
    deployStatus = 'failed'
    const r = await run('vissza', WEB, '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.err).toContain('KIKAPCSOLVA marad')
    expect(patches().some((b) => b.is_auto_deploy_enabled === true)).toBe(false)
    expect(apps[WEB].is_auto_deploy_enabled).toBe(false)
  })

  it('vissza on the api writes no auto-deploy flag', async () => {
    expect((await run('elore', API, SHA, '--vegrehajt')).code).toBe(0)
    calls = []
    await run('vissza', API, '--vegrehajt')
    expect(JSON.stringify(patches())).not.toContain('is_auto_deploy_enabled')
  })

  it('a dry run of web sends nothing, whatever the auto-deploy says', async () => {
    const r = await run('elore', WEB, SHA)
    expect(r.code).toBe(0)
    expect(wasWritten()).toBe(false)
  })
})
