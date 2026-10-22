import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/hooks/inbox-drain.py: the main agent's ONLY inbound path (P0-1, task p01-inbox-drain-token, acrobot 35215).
  What turns these red: the hook presents anything but the main agent's OWN token (the shared file as a fallback
  included); a refused or failed drain, or a missing token, that is silent (the main agent would never learn its
  inbox stopped); the same notice on EVERY prompt instead of at most every ten minutes; a notice carrying the
  token; the hook blocking the prompt (any exit but 0); a sub-agent's session draining the main inbox.
*/

const REPO = process.cwd()
const MAIN = 'proba-fo'
let server: Server
let port = 0
let seen: { auth: string; path: string }[] = []
let mode: 'ok' | '403' | '500' = 'ok'
let root = ''
let tmp = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), path: req.url ?? '' })
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (mode === 'ok') return void res.end(JSON.stringify({ text: 'BEJOVO-UZENET-PROBA' }))
      res.statusCode = mode === '403' ? 403 : 500
      res.end(JSON.stringify({ error: 'x' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())

/** A fake install: the hook and its two helpers copied in, the main agent named in .env, an own token on request. */
function install(ownToken: string | null) {
  root = mkdtempSync(join(tmpdir(), 'inbox-drain-'))
  tmp = mkdtempSync(join(tmpdir(), 'inbox-drain-tmp-'))
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  for (const f of ['inbox-drain.py', 'ledger_lib.py']) copyFileSync(join(REPO, 'scripts', 'hooks', f), join(root, 'scripts', 'hooks', f))
  copyFileSync(join(REPO, 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${MAIN}\n`)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'KOZOS-TOKEN-NEM-HASZNALT\n')
  if (ownToken !== null) writeFileSync(join(root, 'store', 'tokens', `${MAIN}.token`), ownToken)
}

function fire(agent = MAIN): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-B', join(root, 'scripts', 'hooks', 'inbox-drain.py')], {
      env: { ...process.env, MARVEEN_AGENT_ID: agent, MAIN_AGENT_ID: MAIN, WEB_PORT: String(port), TMPDIR: tmp },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.end('{}')
  })
}

beforeEach(() => {
  seen = []
  mode = 'ok'
})

describe('inbox-drain.py', () => {
  it('the own token drains, and the messages enter the context with no notice', async () => {
    install('own-token\n')
    const r = await fire()
    expect(r.code).toBe(0)
    expect(r.out).toContain('BEJOVO-UZENET-PROBA')
    expect(r.out).not.toContain('[inbox-drain]')
    expect(seen).toEqual([{ auth: 'Bearer own-token', path: `/api/agents/${MAIN}/drain-inbox` }])
    rmSync(root, { recursive: true, force: true })
  })

  it('NO own token: exit 0, no request at all (the shared file is NOT used), and the main agent is told', async () => {
    install(null)
    const r = await fire()
    expect(r.code).toBe(0)
    expect(seen, 'the shared token must not be presented').toHaveLength(0)
    expect(r.out).toContain('[inbox-drain] A bejovo inter-agent uzenetek NEM erkeznek')
    expect(r.out).toMatch(/own dashboard token/)
    expect(r.out).not.toContain('KOZOS-TOKEN')
    rmSync(root, { recursive: true, force: true })
  })

  it('an EMPTY own token is the same: nothing sent, the main agent is told', async () => {
    install('')
    const r = await fire()
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.out).toContain('[inbox-drain]')
    rmSync(root, { recursive: true, force: true })
  })

  it('a REFUSED drain (403) or a server error (500): exit 0, never blocks, and the main agent is told with the status', async () => {
    install('own-token\n')
    mode = '403'
    const a = await fire()
    expect(a.code).toBe(0)
    expect(a.out).toContain('[inbox-drain]')
    expect(a.out).toContain('HTTP 403')
    expect(a.out).not.toContain('own-token')
    rmSync(join(tmp, `inbox-drain-notice-${process.getuid?.() ?? 0}`), { force: true })
    mode = '500'
    const b = await fire()
    expect(b.code).toBe(0)
    expect(b.out).toContain('HTTP 500')
    rmSync(root, { recursive: true, force: true })
  })

  it('the notice is rate limited: once, then silent inside ten minutes, then again after', async () => {
    install(null)
    const first = await fire()
    expect(first.out).toContain('[inbox-drain]')
    const second = await fire()
    expect(second.code).toBe(0)
    expect(second.out, 'the same line on every prompt would bury the context').toBe('')
    const marker = join(tmp, `inbox-drain-notice-${process.getuid?.() ?? 0}`)
    expect(existsSync(marker)).toBe(true)
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(marker, old, old)
    const third = await fire()
    expect(third.out).toContain('[inbox-drain]')
    rmSync(root, { recursive: true, force: true })
  })

  it('a sub-agent\'s session does not drain the main inbox: no request, no output', async () => {
    install('own-token\n')
    const r = await fire('valami-al-agens')
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.out).toBe('')
    rmSync(root, { recursive: true, force: true })
  })
})
