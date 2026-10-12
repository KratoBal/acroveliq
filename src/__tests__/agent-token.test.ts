import { execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { ensurePrincipalSchema } from '../web/auth-principals.js'
import { agentTokenPath, issueAgentToken, realTokenFileOps, type TokenFileOps } from '../web/agent-token-issue.js'

/*
  AN AGENT'S OWN DASHBOARD TOKEN (acrovelIQ P0-1, plan step 5.2). What turns
  these red: a resolver that takes the shared token although the caller's own
  is there, or that stops instead of falling back, or falls back silently; a
  resolver that serves an unreadable file; the bash and Python resolvers
  disagreeing; an issuer that overwrites a token file, leaves it wider than
  0400, stores the raw token, returns or prints it, or keeps a row whose file
  failed.
*/
const REPO = process.cwd()
const ME = userInfo().username
const NOW = 1_800_000_000

function tree(opts: { runAsUser?: string; mainAgent?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mv-token-'))
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  writeFileSync(join(root, 'store', '.dashboard-token'), 'shared-token\n')
  if (opts.runAsUser !== undefined) {
    mkdirSync(join(root, 'agents', 'scout'), { recursive: true })
    writeFileSync(join(root, 'agents', 'scout', 'agent-config.json'), JSON.stringify({ runAsUser: opts.runAsUser }))
  }
  if (opts.mainAgent) writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${opts.mainAgent}\n`)
  return root
}

function viaBash(root: string) {
  const r = spawnSync('bash', ['-c', `. "${REPO}/scripts/lib/dashboard-token.sh"; dashboard_token_file "$1"`, '_', root], { encoding: 'utf8' })
  return { file: r.stdout.trim(), err: r.stderr.trim(), code: r.status }
}
function viaPython(root: string) {
  const r = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, "${REPO}/scripts/lib"); import dashboard_token; print(dashboard_token.token_file(sys.argv[1]))`, root], { encoding: 'utf8' })
  return { file: r.stdout.trim(), err: r.stderr.trim(), code: r.status }
}

describe.each([['bash', viaBash], ['python', viaPython]] as const)('the token resolver (%s)', (_lang, resolve) => {
  it('TOK-OWN: the caller\'s own readable token, silently', () => {
    const root = tree({ runAsUser: ME })
    writeFileSync(join(root, 'store', 'tokens', 'scout.token'), 'own\n')
    const r = resolve(root)
    expect(r.file).toBe(join(root, 'store', 'tokens', 'scout.token'))
    expect(r.err).toBe('')
  })

  it('TOK-FALLBACK: no own token, the shared one with one stderr line, no stop', () => {
    const root = tree({ runAsUser: ME })
    const r = resolve(root)
    expect(r.code).toBe(0)
    expect(r.file).toBe(join(root, 'store', '.dashboard-token'))
    expect(r.err.split('\n')).toHaveLength(1)
    expect(r.err).toMatch(/no readable per-agent token for user .* \(agent scout\)/)
  })

  it('TOK-UNREADABLE: an unreadable or empty own file is not served', () => {
    const root = tree({ runAsUser: ME })
    const own = join(root, 'store', 'tokens', 'scout.token')
    writeFileSync(own, '')
    expect(resolve(root).file).toBe(join(root, 'store', '.dashboard-token'))
    writeFileSync(own, 'own\n')
    chmodSync(own, 0o000)
    if (process.getuid?.() !== 0) expect(resolve(root).file).toBe(join(root, 'store', '.dashboard-token'))
  })

  it('TOK-MAIN: the install\'s owner without a runAsUser is the main agent', () => {
    const root = tree({ runAsUser: 'someone-else', mainAgent: 'boss' })
    writeFileSync(join(root, 'store', 'tokens', 'boss.token'), 'main\n')
    expect(resolve(root).file).toBe(join(root, 'store', 'tokens', 'boss.token'))
  })
})

describe('issueAgentToken', () => {
  let db: Database.Database
  let root: string
  const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
  beforeEach(() => {
    db = new Database(':memory:')
    ensurePrincipalSchema(db)
    root = mkdtempSync(join(tmpdir(), 'mv-issue-'))
  })
  const rows = () => db.prepare('SELECT actor, key_hash, revoked_at FROM principal_tokens').all() as {
    actor: string; key_hash: string; revoked_at: number | null
  }[]

  it('TOK-DRY: a dry run touches nothing', () => {
    const r = issueAgentToken(db, { root, agent: 'scout', owner: me, now: NOW, apply: false })
    expect(r.status).toBe('dry-run')
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(false)
    expect(rows()).toEqual([])
  })

  it('TOK-ISSUE: 0400 file, the row holds only the hash, the token never in the result', () => {
    const r = issueAgentToken(db, { root, agent: 'scout', owner: me, now: NOW, apply: true })
    const path = agentTokenPath(root, 'scout')
    expect(statSync(path).mode & 0o777).toBe(0o400)
    const token = readFileSync(path, 'utf8').trim()
    expect(token).toMatch(/^mvpt_/)
    expect(rows()).toEqual([{ actor: 'scout', key_hash: createHash('sha256').update(token).digest('hex'), revoked_at: null }])
    expect(JSON.stringify(r)).not.toContain(token)
    expect(JSON.stringify(rows())).not.toContain(token)
  })

  it('TOK-NOOVERWRITE: an existing file is refused, no new row', () => {
    issueAgentToken(db, { root, agent: 'scout', owner: me, now: NOW, apply: true })
    expect(() => issueAgentToken(db, { root, agent: 'scout', owner: me, now: NOW, apply: true })).toThrow(/already exists/)
    expect(rows()).toHaveLength(1)
  })

  it('TOK-ROLLBACK: a failed chown revokes the row and removes the file', () => {
    const failing: TokenFileOps = { ...realTokenFileOps, chown: () => { throw new Error('EPERM') } }
    expect(() => issueAgentToken(db, { root, agent: 'scout', owner: me, now: NOW, apply: true, fs: failing })).toThrow('EPERM')
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(false)
    expect(rows()[0]!.revoked_at).toBe(NOW)
  })

  it('TOK-NAME: a name that could leave the directory is refused', () => {
    expect(() => issueAgentToken(db, { root, agent: '../x', owner: me, now: NOW, apply: true })).toThrow(/invalid agent name/)
  })
})

describe('fleet-api.sh presents the resolved token (end to end)', () => {
  async function bearerSent(withOwnToken: boolean): Promise<string> {
    const root = tree({ runAsUser: ME })
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    copyFileSync(join(REPO, 'scripts', 'fleet-api.sh'), join(root, 'scripts', 'fleet-api.sh'))
    copyFileSync(join(REPO, 'scripts', 'lib', 'dashboard-token.sh'), join(root, 'scripts', 'lib', 'dashboard-token.sh'))
    if (withOwnToken) writeFileSync(join(root, 'store', 'tokens', 'scout.token'), 'own-token\n')
    let auth = ''
    const server = createServer((req, res) => {
      auth = String(req.headers.authorization ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.end('[]')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((r) =>
      execFile('bash', [join(root, 'scripts', 'fleet-api.sh'), 'kanban-list'], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, () => r()),
    )
    server.close()
    return auth
  }

  it('TOK-E2E: the own token when handed out, the shared one otherwise', async () => {
    expect(await bearerSent(true)).toBe('Bearer own-token')
    expect(await bearerSent(false)).toBe('Bearer shared-token')
  })
})
