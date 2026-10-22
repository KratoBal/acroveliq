import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  The telemetry hooks (tool-log-capture, skill-usage-capture) and the helper behind them,
  dashboard_token.own_token / ledger_lib.hook_token_failure (P0-1, task p01-csendes-visszaeso-hivok, acrobot 35229).
  What turns these red: a hook that presents the SHARED token when the own one is missing (it used to, silently);
  a hook that stops or fails the agent for lack of a token (exit must be 0); a skipped call that is SILENT (it must
  leave one line a day in the failure log); that line repeating on every tool call; a log written through a link;
  the own token not presented when it exists.
*/

const REPO = process.cwd()
const MAIN = 'proba-fo'
let server: Server
let port = 0
let seen: { auth: string; path: string }[] = []
let root = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), path: req.url ?? '' })
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
})

/** A fake install: the hooks and helpers copied in, the main agent named in .env, an own token on request. */
function install(ownToken: string | null) {
  root = mkdtempSync(join(tmpdir(), 'hook-own-token-'))
  for (const d of ['scripts/hooks', 'scripts/lib', 'store/tokens', 'agents/al-agens']) mkdirSync(join(root, d), { recursive: true })
  for (const f of ['tool-log-capture.py', 'skill-usage-capture.py', 'ledger_lib.py']) copyFileSync(join(REPO, 'scripts', 'hooks', f), join(root, 'scripts', 'hooks', f))
  copyFileSync(join(REPO, 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${MAIN}\nWEB_PORT=${port}\n`)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'KOZOS-TOKEN-NEM-HASZNALT\n')
  if (ownToken !== null) writeFileSync(join(root, 'store', 'tokens', `${MAIN}.token`), ownToken)
}

function fire(hook: string, payload: object, agent = MAIN): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-B', join(root, 'scripts', 'hooks', hook)], {
      env: { ...process.env, MARVEEN_AGENT_ID: agent, MAIN_AGENT_ID: MAIN, WEB_PORT: String(port) },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.end(JSON.stringify(payload))
  })
}

const TOOL = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' }
const SKILL = { session_id: 's1', tool_name: 'Skill', tool_input: { skill: 'fleet-helper' }, cwd: '/x' }
const logOf = (dir: string) => join(root, dir, '.hook-token-failures.log')

describe.each([
  ['tool-log-capture.py', TOOL, '/api/tool-log'],
  ['skill-usage-capture.py', SKILL, '/api/skill-usage'],
] as const)('%s', (hook, payload, route) => {
  it('the own token is presented, and nothing is noted', async () => {
    install('own-token\n')
    const r = await fire(hook, payload)
    expect(r.code).toBe(0)
    expect(seen).toEqual([{ auth: 'Bearer own-token', path: route }])
    expect(existsSync(logOf('store'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('NO own token: exit 0, no request (the shared token is NOT presented), one line in the failure log', async () => {
    install(null)
    const r = await fire(hook, payload)
    expect(r.code, 'a hook must never stop the agent').toBe(0)
    expect(seen).toHaveLength(0)
    const log = readFileSync(logOf('store'), 'utf8')
    expect(log.trim().split('\n')).toHaveLength(1)
    expect(log).toContain(hook.replace('.py', ''))
    expect(log).toMatch(/own dashboard token/)
    expect(log).not.toContain('KOZOS-TOKEN')
    rmSync(root, { recursive: true, force: true })
  })

  it('an EMPTY own token is the same: nothing sent, the skip is noted', async () => {
    install('')
    const r = await fire(hook, payload)
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(existsSync(logOf('store'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('the note is ONE line a day: a second tool call adds nothing', async () => {
    install(null)
    await fire(hook, payload)
    await fire(hook, payload)
    await fire(hook, payload)
    expect(readFileSync(logOf('store'), 'utf8').trim().split('\n')).toHaveLength(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('a sub-agent\'s note goes into its own directory, not into store/', async () => {
    install(null)
    const r = await fire(hook, payload, 'al-agens')
    expect(r.code).toBe(0)
    expect(existsSync(logOf('agents/al-agens'))).toBe(true)
    expect(existsSync(logOf('store'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('a LINK at the log path is never written through', async () => {
    install(null)
    const target = join(root, 'celpont.txt')
    writeFileSync(target, 'ne irj ide\n')
    symlinkSync(target, logOf('store'))
    const r = await fire(hook, payload)
    expect(r.code).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('ne irj ide\n')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('dashboard_token.own_token', () => {
  const probe = (r: string, mode: string) => {
    const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(r, 'scripts', 'lib'))}); import dashboard_token as d; print(repr(d.${mode}(${JSON.stringify(r)})))`
    return spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8' })
  }

  it('returns the own token and no reason; never the shared token', () => {
    install('own-token\n')
    expect(probe(root, 'own_token').stdout.trim()).toBe("('own-token', None)")
    rmSync(root, { recursive: true, force: true })
  })

  it('returns (None, why) when the own token is missing, and the why never names the shared file\'s content', () => {
    install(null)
    const out = probe(root, 'own_token').stdout.trim()
    expect(out).toMatch(/^\(None, '/)
    expect(out).not.toContain('KOZOS-TOKEN')
    rmSync(root, { recursive: true, force: true })
  })

  it('own_token_path refuses the shared path by its location even when the resolver returns it', () => {
    // a non-agent, non-owner caller: the resolver hands out the shared file (loudly); the helper must refuse it
    install('own-token\n')
    const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(root, 'scripts', 'lib'))}); import dashboard_token as d; d.os.geteuid = lambda: 424242; print(repr(d.own_token_path(${JSON.stringify(root)})))`
    const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8' })
    expect(r.stdout.trim()).toMatch(/^\(None, 'no own dashboard token/)
    rmSync(root, { recursive: true, force: true })
  })
})
