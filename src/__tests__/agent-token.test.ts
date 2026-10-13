import { execFile, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { ensurePrincipalSchema } from '../web/auth-principals.js'
import { agentTokenPath, issueAgentToken, issueAgentTokenToPipe, realTokenFileOps, revokeAgentToken, type TokenFileOps } from '../web/agent-token-issue.js'
import { resolvePrincipalToken } from '../web/auth-principals.js'

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
function viaPython(root: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, "${REPO}/scripts/lib"); import dashboard_token; print(dashboard_token.token_file(sys.argv[1]))`, root], { encoding: 'utf8', env })
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

describe('the Python resolver asks the effective uid, not the environment (barracuda #34)', () => {
  it('TOK-EUID: USER and LOGNAME naming someone else do not change the agent', () => {
    const root = tree({ runAsUser: ME })
    writeFileSync(join(root, 'store', 'tokens', 'scout.token'), 'own\n')
    const r = viaPython(root, { ...process.env, USER: 'marveen', LOGNAME: 'marveen', LNAME: 'marveen', USERNAME: 'marveen' })
    expect(r.file).toBe(join(root, 'store', 'tokens', 'scout.token'))
  })
})

describe('the bash resolver matches the user name literally', () => {
  it('TOK-LITERAL: a dot in the caller\'s name does not match another character', () => {
    // the pattern is built from the caller's name; a regex dot in it would let
    // user "a.b" take the agent whose runAsUser is "axb"
    const root = tree({ runAsUser: 'axb' })
    const r = spawnSync('bash', ['-c', `. "${REPO}/scripts/lib/dashboard-token.sh"; dashboard_token_agent "$1" "$2"`, '_', root, 'a.b'], { encoding: 'utf8' })
    // not axb's agent; the temp tree is the caller's, so the owner branch may
    // still name the main agent, which is a different, legitimate answer
    expect(r.stdout.trim()).not.toBe('scout')
    const exact = spawnSync('bash', ['-c', `. "${REPO}/scripts/lib/dashboard-token.sh"; dashboard_token_agent "$1" "$2"`, '_', root, 'axb'], { encoding: 'utf8' })
    expect(exact.stdout.trim()).toBe('scout')
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

describe('issueAgentTokenToPipe (the step sheet: root runs no repository code)', () => {
  let db: Database.Database
  let root: string
  beforeEach(() => {
    db = new Database(':memory:')
    ensurePrincipalSchema(db)
    root = mkdtempSync(join(tmpdir(), 'mv-pipe-'))
  })
  const rows = () => db.prepare('SELECT actor, key_hash, revoked_at FROM principal_tokens').all() as {
    actor: string; key_hash: string; revoked_at: number | null
  }[]
  const pipe = () => {
    const written: string[] = []
    return { written, out: { isTty: false, write: (t: string) => { written.push(t) } } }
  }

  it('TOK-PIPE: the token goes to the pipe only, the row holds its hash, no file is written', async () => {
    const p = pipe()
    const r = await issueAgentTokenToPipe(db, { root, agent: 'scout', now: NOW, apply: true, out: p.out })
    expect(r.status).toBe('issued')
    expect(p.written).toHaveLength(1)
    const token = p.written[0]!.trim()
    expect(token).toMatch(/^mvpt_/)
    expect(p.written[0]).toBe(`${token}\n`)
    expect(rows()).toEqual([{ actor: 'scout', key_hash: createHash('sha256').update(token).digest('hex'), revoked_at: null }])
    expect(resolvePrincipalToken(db, token, NOW + 1)).not.toBeNull()
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(false)
    expect(existsSync(join(root, 'store', 'tokens'))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(token)
  })

  it('TOK-PIPE-TTY: a terminal is refused before any row is written', async () => {
    const written: string[] = []
    await expect(issueAgentTokenToPipe(db, {
      root, agent: 'scout', now: NOW, apply: true, out: { isTty: true, write: (t) => { written.push(t) } },
    })).rejects.toThrow(/terminal/)
    expect(written).toEqual([])
    expect(rows()).toEqual([])
  })

  it('TOK-PIPE-EXISTS: an existing file is refused, no row', async () => {
    mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
    writeFileSync(agentTokenPath(root, 'scout'), 'old\n')
    const p = pipe()
    await expect(issueAgentTokenToPipe(db, { root, agent: 'scout', now: NOW, apply: true, out: p.out })).rejects.toThrow(/already exists/)
    expect(p.written).toEqual([])
    expect(rows()).toEqual([])
  })

  // The real pipe, not a throwing mock (barracuda, #80): a child runs the
  // CLI's writer on its own process.stdout, and Node reports a closed reader
  // as an 'error' EVENT, which used to end the process with the row live.
  const probe = (closeReader: boolean) => new Promise<{ code: number | null; err: string; out: string; db: string }>((resolve) => {
    const dbPath = join(root, 'probe.db')
    const child = spawn('npx', ['tsx', join(process.cwd(), 'src', '__tests__', 'fixtures', 'token-pipe-probe.ts'), dbPath, root, '700'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    if (closeReader) child.stdout.destroy()
    else child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, err, out, db: dbPath }))
  })
  const probeRows = (dbPath: string) => {
    const pdb = new Database(dbPath, { readonly: true })
    try {
      return pdb.prepare('SELECT key_hash, revoked_at FROM principal_tokens').all() as { key_hash: string; revoked_at: number | null }[]
    } finally {
      pdb.close()
    }
  }

  it('TOK-PIPE-EPIPE: a pipe whose reader is gone revokes the row, and the process does not crash', async () => {
    const r = await probe(true)
    expect([r.code, r.err.trim()], 'TOK-PIPE-EPIPE').toEqual([3, 'rejected EPIPE'])
    expect(probeRows(r.db).map((x) => x.revoked_at !== null)).toEqual([true])
  }, 30_000)

  it('TOK-PIPE-REAL: the same writer into a live reader: the token arrives and its row stays live', async () => {
    const r = await probe(false)
    expect([r.code, r.err.trim()], 'TOK-PIPE-REAL').toEqual([0, 'issued 1'])
    const token = r.out.trim()
    expect(token).toMatch(/^mvpt_/)
    expect(probeRows(r.db)).toEqual([{ key_hash: createHash('sha256').update(token).digest('hex'), revoked_at: null }])
  }, 30_000)

  it('TOK-PIPE-DRY: a dry run writes nothing and adds no row', async () => {
    const p = pipe()
    expect((await issueAgentTokenToPipe(db, { root, agent: 'scout', now: NOW, apply: false, out: p.out })).status).toBe('dry-run')
    expect(p.written).toEqual([])
    expect(rows()).toEqual([])
  })

  it('TOK-PIPE-NAME: a name that could leave the directory is refused', async () => {
    const p = pipe()
    await expect(issueAgentTokenToPipe(db, { root, agent: '../x', now: NOW, apply: true, out: p.out })).rejects.toThrow(/invalid agent name/)
    expect(rows()).toEqual([])
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

describe('revokeAgentToken', () => {
  let db: Database.Database
  let root: string
  const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
  beforeEach(() => {
    db = new Database(':memory:')
    ensurePrincipalSchema(db)
    root = mkdtempSync(join(tmpdir(), 'mv-revoke-'))
  })
  const issue = (agent: string) => {
    issueAgentToken(db, { root, agent, owner: me, now: NOW, apply: true })
    return readFileSync(agentTokenPath(root, agent), 'utf8').trim()
  }

  it('TOK-REVOKE-DRY: a dry run names the rows and the file, and changes nothing', () => {
    const token = issue('scout')
    const r = revokeAgentToken(db, { root, agent: 'scout', now: NOW + 1, apply: false })
    expect(r).toMatchObject({ status: 'dry-run', ids: [1], file: true })
    expect(resolvePrincipalToken(db, token, NOW + 2)).not.toBeNull()
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(true)
    expect(JSON.stringify(r)).not.toContain(token)
  })

  it('TOK-REVOKE: the agent\'s rows revoked, its file gone, another agent untouched', () => {
    const mine = issue('scout')
    const other = issue('ranger')
    const r = revokeAgentToken(db, { root, agent: 'scout', now: NOW + 1, apply: true })
    expect(r.status).toBe('revoked')
    expect(resolvePrincipalToken(db, mine, NOW + 2)).toBeNull()
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(false)
    expect(resolvePrincipalToken(db, other, NOW + 2)).not.toBeNull()
    expect(existsSync(agentTokenPath(root, 'ranger'))).toBe(true)
  })

  it('TOK-REVOKE-AGAIN: a second run has nothing to do, and no file is fine', () => {
    issue('scout')
    revokeAgentToken(db, { root, agent: 'scout', now: NOW + 1, apply: true })
    expect(revokeAgentToken(db, { root, agent: 'scout', now: NOW + 2, apply: true })).toMatchObject({ ids: [], file: false })
  })

  it('TOK-REVOKE-FIRST: the row is revoked even if the file removal fails', () => {
    const token = issue('scout')
    const failing: TokenFileOps = { ...realTokenFileOps, unlink: () => { throw new Error('EBUSY') } }
    expect(() => revokeAgentToken(db, { root, agent: 'scout', now: NOW + 1, apply: true, fs: failing })).toThrow('EBUSY')
    expect(resolvePrincipalToken(db, token, NOW + 2)).toBeNull()
  })

  it('TOK-REVOKE-DBONLY: the rows revoked, the file left for root', () => {
    const token = issue('scout')
    const r = revokeAgentToken(db, { root, agent: 'scout', now: NOW + 1, apply: true, dbOnly: true })
    expect(r).toMatchObject({ status: 'revoked', ids: [1], file: true })
    expect(resolvePrincipalToken(db, token, NOW + 2)).toBeNull()
    expect(existsSync(agentTokenPath(root, 'scout'))).toBe(true)
  })

  it('TOK-REVOKE-NAME: a path-like name is refused', () => {
    expect(() => revokeAgentToken(db, { root, agent: '../x', now: NOW, apply: true })).toThrow(/invalid agent name/)
  })
})
