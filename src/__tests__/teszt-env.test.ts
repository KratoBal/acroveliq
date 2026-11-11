// scripts/teszt-env.sh (card 8f35a038, second slice; acrobot 46571, 46574). WHAT TURNS THESE RED: a secret-shaped,
// lower-case or malformed key, a multi-line value or an unknown uuid reaching the Coolify; a dry run sending a write;
// an existing key POSTed or a new one PATCHed; the write aimed at the preview row, or a preview-only key read as
// present; a write the read-back does not show passing as done; the token printed; the address not the fixed tailnet one;
// (barracuda, #354) a gap in the secret filter, a harmless key refused, the rw token loaded or sent outside the write.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'scripts', 'teszt-env.sh')
const UUID = 'vuxtvlowb1i7lqdybubb37nj'
const TOKEN = 'olvaso-teszt-token-123'
const TOKEN_RW = 'iro-teszt-token-456'

type Env = { key: string; is_preview: boolean; value?: string }
let envs: Env[] = []
let dropWrites = false
let calls: { method: string; path: string; body: unknown; auth: string | undefined }[] = []
let server: Server
let dir: string
let script: string

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
      if (req.url === `/api/v1/applications/${UUID}` && req.method === 'GET') return send(200, { name: 'acropora-stage-medusa' })
      if (req.url === `/api/v1/applications/${UUID}/envs`) {
        if (req.method === 'GET') return send(200, envs.map(({ key, is_preview }) => ({ key, is_preview })))
        if (req.method === 'POST' || req.method === 'PATCH') {
          const b = body as Env
          if (!dropWrites) {
            envs = envs.filter((e) => !(e.key === b.key && e.is_preview === b.is_preview))
            envs.push({ key: b.key, is_preview: b.is_preview, value: b.value })
          }
          return send(req.method === 'POST' ? 201 : 200, { uuid: 'x' })
        }
      }
      send(404, { message: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  dir = mkdtempSync(join(tmpdir(), 'teszt-env-'))
  writeFileSync(join(dir, 'token-ro'), `${TOKEN}\n`)
  writeFileSync(join(dir, 'token-rw'), `${TOKEN_RW}\n`)
  const port = (server.address() as AddressInfo).port
  script = join(dir, 'teszt-env.sh')
  writeFileSync(
    script,
    readFileSync(SRC, 'utf-8')
      .replace(/^COOLIFY=.*$/m, `COOLIFY="http://127.0.0.1:${port}"`)
      .replace(/^TOKEN_FILE_RO=.*$/m, `TOKEN_FILE_RO="${join(dir, 'token-ro')}"`)
      .replace(/^TOKEN_FILE_RW=.*$/m, `TOKEN_FILE_RW="${join(dir, 'token-rw')}"`),
  )
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  envs = [
    { key: 'SHOP_BANNER', is_preview: false },
    { key: 'SHOP_BANNER', is_preview: true },
    { key: 'CSAK_PREVIEW', is_preview: true },
  ]
  calls = []
  dropWrites = false
})

const run = (...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile('bash', [script, ...args], (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }),
    )
  })
const writes = () => calls.filter((c) => c.method !== 'GET')

describe('teszt-env.sh', () => {
  it('the address is the fixed tailnet one; the read token reads, the rw token writes', () => {
    const src = readFileSync(SRC, 'utf-8')
    expect(src).toMatch(/^COOLIFY="http:\/\/100\.88\.199\.87:8000"$/m)
    expect(src).toMatch(/^TOKEN_FILE_RO="\/home\/marveen\/marveen\/store\/\.coolify-token-ai"$/m)
    expect(src).toMatch(/^TOKEN_FILE_RW="\/home\/marveen\/marveen\/store\/\.coolify-token-ai-rw"$/m)
  })

  // barracuda, #354: the deny list's gaps. Every one of these exits 2 before any request.
  it.each([
    'CLIENT_SECRETS', 'API_TOKENS', 'PASSWORDS', 'PRIVATEKEY', 'APITOKEN', 'ACCESSTOKEN', 'CLIENTSECRET', 'AUTHTOKEN',
    'MEDUSA_DATABASE_URL', 'DIRECT_DATABASE_URL', 'CACHE_REDIS_URL', 'POSTGRES_URL', 'MONGO_URI', 'AMQP_URL',
    'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'DB_URL', 'JWT_SIGNING_KEY', 'PASSWORD_SALT', 'HMAC_VALUE',
    'TLS_CERT', 'SERVER_PEM', 'SESSION_COOKIE_VALUE', 'STRIPE_KEYS', 'ACCESSKEY',
  ])('refuses the secret-shaped key %s', async (key) => {
    const r = await run(UUID, key, 'x', '--vegrehajt')
    expect({ code: r.code, calls: calls.length }).toEqual({ code: 2, calls: 0 })
  })

  it.each(['STOREFRONT_URL', 'NEXT_PUBLIC_REGION', 'FEEDBACK_URL', 'MONKEY_MODE', 'SHOP_BANNER'])(
    'lets the harmless key %s through (dry run)',
    async (key) => {
      const r = await run(UUID, key, 'x')
      expect(r.code).toBe(0)
      expect(writes()).toEqual([])
    },
  )

  it('a dry run never loads the rw token: it reads with the read token, and runs without the rw file', async () => {
    rmSync(join(dir, 'token-rw'))
    try {
      const r = await run(UUID, 'SHOP_BANNER', 'x')
      expect(r.code).toBe(0)
      expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
    } finally {
      writeFileSync(join(dir, 'token-rw'), `${TOKEN_RW}\n`)
    }
  })

  it.each([
    ['a secret-shaped key', [UUID, 'MEDUSA_ADMIN_TOKEN', 'x']],
    ['a password key', [UUID, 'DB_PASSWORD', 'x']],
    ['an API key', [UUID, 'STRIPE_API_KEY', 'x']],
    ['a mail key', [UUID, 'GMAIL_USER', 'x']],
    ['the database URL', [UUID, 'DATABASE_URL', 'x']],
    ['a lower-case key', [UUID, 'shop_banner', 'x']],
    ['a multi-line value', [UUID, 'SHOP_BANNER', 'a\nb']],
    ['an unknown uuid shape', ['../../x', 'SHOP_BANNER', 'x']],
  ])('refuses %s with exit 2, before any request', async (_name, args) => {
    const r = await run(...args, '--vegrehajt')
    expect({ code: r.code, calls: calls.length }).toEqual({ code: 2, calls: 0 })
    expect(r.out).toContain('MEGTAGADVA')
  })

  it('a dry run reads and says, and writes nothing; the state is "present" without a value', async () => {
    const r = await run(UUID, 'SHOP_BANNER', 'Nyitva')
    expect(r.code).toBe(0)
    expect(writes()).toEqual([])
    expect(r.out).toContain('acropora-stage-medusa')
    expect(r.out).toContain('SHOP_BANNER  most: van (az erteket a Coolify nem adja)')
    expect(r.out).toContain('a nem-preview sor, a preview sor nem valtozik')
    expect(r.out).toContain('SZARAZ FUTAS')
  })

  it('an existing key: PATCH on the non-preview row, read back, no deploy', async () => {
    const r = await run(UUID, 'SHOP_BANNER', 'Nyitva', '--vegrehajt')
    expect(r.code).toBe(0)
    expect(writes().map((c) => [c.method, c.body])).toEqual([['PATCH', { key: 'SHOP_BANNER', value: 'Nyitva', is_preview: false }]])
    expect(r.out).toContain('nem ellenorizheto, csak a kulcs megleted')
    expect(r.out).toContain('telepitest ez a parancs nem indit')
    expect(calls.some((c) => c.path.includes('deploy'))).toBe(false)
  })

  it('a key present only as preview counts as new: POST', async () => {
    const r = await run(UUID, 'CSAK_PREVIEW', '1', '--vegrehajt')
    expect(r.code).toBe(0)
    expect(writes().map((c) => [c.method, (c.body as Env).is_preview])).toEqual([['POST', false]])
  })

  it('a write the read-back does not show is not done: exit 1, said', async () => {
    dropWrites = true
    const r = await run(UUID, 'UJ_KAPCSOLO', '1', '--vegrehajt')
    expect(r.code).toBe(1)
    expect(r.out).toContain('ELTERES')
    expect(r.out).not.toContain('telepitest ez a parancs nem indit')
  })

  it('the reads go with the read token, the write with the rw token, and neither is printed', async () => {
    const r = await run(UUID, 'SHOP_BANNER', 'x', '--vegrehajt')
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
    expect(writes().map((c) => c.auth)).toEqual([`Bearer ${TOKEN_RW}`])
    expect(r.out).not.toContain(TOKEN)
    expect(r.out).not.toContain(TOKEN_RW)
  })
})
