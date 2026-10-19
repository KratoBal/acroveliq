import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { decide } from '../web/route-access.js'
import { matchRouteRule } from '../web/route-match.js'

/*
  THE PROD-TREE GUARD'S ALERT REACHES THE MAIN AGENT (task flotta-or-es-infra-javitas, 2026-10-19).
  Measured that day: the installed post-checkout hook (written 2026-10-14) sent the alert with the shared
  token and from/to "marveen", and the dashboard answered 403, so the coordinator never heard of a branch
  switch that the guard had correctly reverted. The installer had been fixed on 2026-10-16 but is only run
  by the dashboard's update, so the installed copy stayed stale.
  What turns these red: the alert going out with a token that cannot send, or to an id that is not the main
  agent's (a message to an id nobody has is ACCEPTED and delivered to nobody), or a hook with no recipient
  guessing one instead of saying so; a branch name breaking the JSON; and `--check` calling a stale, missing
  or recipient-less hook current, or changing anything.
  The hook runs for real with the real curl against a local server that decides with the dashboard's own
  access rules (route-access.ts decide), so "2xx" here is the route's answer, not a stub's.
*/

const ROOT = join(__dirname, '..', '..')
const ME = userInfo().username
const AGENT_TOKEN = 'agent-own-token-0123456789'
const SHARED_TOKEN = 'shared-token-0123456789'
const MAIN_ID = 'acrobot'
const RULE = matchRouteRule('POST', '/api/messages')

let server: Server
let port = 0
let seen: { auth: string | undefined; body: Record<string, string> }[] = []
let stage: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      let body: Record<string, string> = {}
      let valid = true
      try {
        body = JSON.parse(raw)
      } catch {
        valid = false
      }
      seen.push({ auth: req.headers.authorization, body })
      // the dashboard's own decision for this route: an agent's token is column A, the shared one is column L
      const caller = token === AGENT_TOKEN ? { column: 'A' as const, name: 'probe' } : { column: 'L' as const, name: 'legacy' }
      const d = decide(RULE, caller, caller.name === 'probe' ? [body['from'] ?? ''] : null)
      const known = token === AGENT_TOKEN || token === SHARED_TOKEN
      const ok = known && valid && d.allowed
      res.writeHead(ok ? 200 : valid ? 403 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok ? { id: seen.length } : { error: valid ? d.reason : 'bad json' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
  stage = realpathSync(mkdtempSync(join(tmpdir(), 'prod-guard-alert-')))
})
afterEach(() => rmSync(stage, { recursive: true, force: true }))

interface Setup {
  repo: string
  hook: string
  hooks: string
}

/** A scratch main checkout with the hook installed the way the owner's update installs it. */
function setup(opts: { env?: string | null; agentToken?: boolean; unreadableEnv?: boolean } = {}): Setup {
  const repo = join(stage, 'repo')
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(repo, 'store', 'tokens'), { recursive: true })
  mkdirSync(join(repo, 'agents', 'probe'), { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
  writeFileSync(join(repo, 'x.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  cpSync(join(ROOT, 'scripts', 'install-prod-tree-guard-hook.sh'), join(repo, 'scripts', 'install-prod-tree-guard-hook.sh'))
  cpSync(join(ROOT, 'scripts', 'lib', 'dashboard-token.sh'), join(repo, 'scripts', 'lib', 'dashboard-token.sh'))
  writeFileSync(join(repo, 'store', '.dashboard-token'), `${SHARED_TOKEN}\n`)
  if (opts.agentToken !== false) {
    writeFileSync(join(repo, 'agents', 'probe', 'agent-config.json'), JSON.stringify({ runAsUser: ME }))
    writeFileSync(join(repo, 'store', 'tokens', 'probe.token'), `${AGENT_TOKEN}\n`)
  }
  if (opts.env !== null) writeFileSync(join(repo, '.env'), opts.env ?? `MAIN_AGENT_ID=${MAIN_ID}\nOTHER=1\n`)
  if (opts.unreadableEnv) chmodSync(join(repo, '.env'), 0o000)
  const r = installerOut(repo, [])
  expect(r.code).toBe(0)
  return { repo, hook: join(repo, '.git', 'hooks', 'post-checkout'), hooks: join(repo, '.git', 'hooks') }
}

function installerOut(repo: string, args: string[]): { code: number; out: string } {
  // stdout and stderr together, whatever the exit code
  try {
    const out = execFileSync('/bin/bash', ['-c', `bash "${join(repo, 'scripts', 'install-prod-tree-guard-hook.sh')}" ${args.join(' ')} 2>&1`], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string }
    return { code: err.status, out: err.stdout }
  }
}

/** Park the checkout on a feature branch with the hook waived, then run the hook as git would after a switch. */
function fire(s: Setup, branch = 'feature-probe', env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  execFileSync('git', ['-C', s.repo, 'checkout', '-q', '-B', branch], { env: { ...process.env, MARVEEN_PROD_CHECKOUT_OK: '1' } })
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      [s.hook, 'a'.repeat(40), 'b'.repeat(40), '1'],
      { cwd: s.repo, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: stage, MARVEEN_DASHBOARD_ORIGIN: `http://127.0.0.1:${port}`, ...env }, timeout: 20000 },
      (error, _stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }),
    )
  })
}

const hashDir = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => (f.isDirectory() ? `${f.name}/\n${hashDir(join(dir, f.name))}` : `${f.name}:${createHash('sha256').update(readFileSync(join(dir, f.name))).digest('hex')}`))
    .join('\n')

describe('the premise: which token can send', () => {
  it("the dashboard's own rules: an agent's token may POST /api/messages, the shared token may not", () => {
    expect(RULE).not.toBeNull()
    expect(decide(RULE, { column: 'A', name: 'probe' }, ['probe']).allowed).toBe(true)
    expect(decide(RULE, { column: 'L', name: 'legacy' }, null).allowed).toBe(false)
  })
})

describe('the hook delivers the alert', () => {
  it('as a caller with an own token: HTTP 2xx, quiet, the own token, and the MAIN agent as recipient (not "marveen")', async () => {
    const s = setup()
    const r = await fire(s)
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('NEM ert celba')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(seen[0]!.body['to']).toBe(MAIN_ID)
    expect(seen[0]!.body['from']).toBe(MAIN_ID)
    expect(seen[0]!.body['to']).not.toBe('marveen')
    expect(seen[0]!.body['content']).toContain('[PROD-FA ORSEG, post-checkout hook]')
    expect(seen[0]!.body['content']).toContain('feature-probe')
  })

  it('with only the shared token (the 2026-10-14 hook\'s situation): the route says 403 and the hook is LOUD, exit 0', async () => {
    const s = setup({ agentToken: false })
    const r = await fire(s)
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toBe(`Bearer ${SHARED_TOKEN}`)
    expect(r.stderr).toContain('NEM ert celba (HTTP 403)')
  })

  it('MARVEEN_GUARD_ALERT_TO still redirects the recipient (the sender stays the main agent)', async () => {
    const s = setup()
    await fire(s, 'feature-probe', { MARVEEN_GUARD_ALERT_TO: 'barracuda' })
    expect(seen[0]!.body['to']).toBe('barracuda')
    expect(seen[0]!.body['from']).toBe(MAIN_ID)
  })

  it('a branch name with a quote does not break the JSON: still delivered, the quote shown as ?', async () => {
    const s = setup()
    const r = await fire(s, 'feat"quote')
    expect(r.stderr).not.toContain('NEM ert celba')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body['content']).toContain('feat?quote')
  })

  it('MAIN_AGENT_ID unset in .env is the app default (marveen), read at install, not guessed by the hook', async () => {
    const s = setup({ env: 'OTHER=1\n' })
    await fire(s)
    expect(seen[0]!.body['to']).toBe('marveen')
  })
})

describe('a hook with no recipient says so and sends nothing', () => {
  it.skipIf(process.getuid?.() === 0)('an installer that cannot read .env writes no conf; the hook then says there is no recipient and posts NOTHING', async () => {
    const s = setup({ unreadableEnv: true })
    const out = installerOut(s.repo, [])
    expect(out.out).toContain('WARNING: no prod-tree-guard.conf written')
    const r = await fire(s)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('nincs cimzett')
    expect(r.stderr).toContain('NEM ert celba')
    expect(seen).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('an installer that cannot read .env keeps the conf that is there', async () => {
    const s = setup()
    chmodSync(join(s.repo, '.env'), 0o000)
    const out = installerOut(s.repo, [])
    expect(out.out).toContain('kept the existing prod-tree-guard.conf')
    await fire(s)
    expect(seen[0]!.body['to']).toBe(MAIN_ID)
  })

  it('a malformed MAIN_AGENT_ID is not written into the conf', () => {
    const s = setup({ env: 'MAIN_AGENT_ID=Bad Name;rm\n' })
    const conf = (() => {
      try {
        return readFileSync(join(s.hooks, 'prod-tree-guard.conf'), 'utf8')
      } catch {
        return null
      }
    })()
    expect(conf).toBeNull()
  })
})

describe('--check: is the installed hook the one this script would write', () => {
  it('a fresh install: current, exit 0, the recipient named, and it changes nothing', () => {
    const s = setup()
    const before = hashDir(s.hooks)
    const r = installerOut(s.repo, ['--check'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`aktualis (a riasztas cimzettje: ${MAIN_ID})`)
    expect(hashDir(s.hooks)).toBe(before)
  })

  it('a stale hook (any difference from what the installer writes): ELAVULT, exit 1, with the way out', () => {
    const s = setup()
    writeFileSync(s.hook, `${readFileSync(s.hook, 'utf8')}# an older copy would differ here\n`)
    const before = hashDir(s.hooks)
    const r = installerOut(s.repo, ['--check'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('ELAVULT')
    expect(r.out).toContain('install-prod-tree-guard-hook.sh')
    expect(hashDir(s.hooks)).toBe(before)
  })

  it('the hook of 2026-10-14 (the shared token and "marveen" in the body) is stale', () => {
    const s = setup()
    const now = readFileSync(s.hook, 'utf8')
    const old = now
      .replace(/MAIN_ID="\$\(sed[^\n]*\n/, '')
      .replace('ALERT_TO="${MARVEEN_GUARD_ALERT_TO:-$MAIN_ID}"', 'ALERT_TO="${MARVEEN_GUARD_ALERT_TO:-marveen}"')
    writeFileSync(s.hook, old)
    expect(installerOut(s.repo, ['--check']).code).toBe(1)
  })

  it('no hook at all: exit 1', () => {
    const s = setup()
    rmSync(s.hook)
    const r = installerOut(s.repo, ['--check'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('NINCS telepitve')
  })

  it('a current hook with no conf: exit 1, no recipient', () => {
    const s = setup()
    rmSync(join(s.hooks, 'prod-tree-guard.conf'))
    const r = installerOut(s.repo, ['--check'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('prod-tree-guard.conf')
  })

  it('a conf that disagrees with .env (the main agent was renamed): exit 1 where .env can be read', () => {
    const s = setup()
    writeFileSync(join(s.repo, '.env'), 'MAIN_AGENT_ID=masik\n')
    const r = installerOut(s.repo, ['--check'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('masik')
  })

  it.skipIf(process.getuid?.() === 0)('an agent user that cannot read .env still gets an answer: current when the hook and conf are', () => {
    const s = setup()
    chmodSync(join(s.repo, '.env'), 0o000)
    expect(installerOut(s.repo, ['--check']).code).toBe(0)
  })

  it('re-running the installer makes a stale hook current (the owner\'s one command)', () => {
    const s = setup()
    writeFileSync(s.hook, '#!/usr/bin/env bash\n# marveen-prod-tree-guard : an older copy\nexit 0\n')
    expect(installerOut(s.repo, ['--check']).code).toBe(1)
    expect(installerOut(s.repo, []).code).toBe(0)
    expect(installerOut(s.repo, ['--check']).code).toBe(0)
  })
})
