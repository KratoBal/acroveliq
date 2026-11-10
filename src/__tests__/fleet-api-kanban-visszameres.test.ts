import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  fleet-api.sh kanban-visszameres and the check before kanban-assign (T6.5 PR2, card b3d8174e; acrobot 45981). What turns
  these red: a DIVERGED card issued anyway; --akkor-is-ki with no reason accepted, or the reason not recorded on the card;
  a card issued when the check could not look WITHOUT saying so; a card with no basis stamped or held up; a stamp written for
  a result the check did not produce; the stamp carrying a time (the server's clock is the only one); an OK card refused;
  an ambiguous or unknown card id issued; the old assignment (the PUT) changed for a card with no basis.
*/

const root = mkdtempSync(join(tmpdir(), 'fleet-api-visszameres-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let dashboard: Server
let github: Server
let dashboardPort = 0
let githubPort = 0
let requests: { method: string; path: string; body: unknown }[] = []
let failPut = false

// the GitHub side: path -> status (and the text for a 200)
const GITHUB: Record<string, [number, string]> = {
  '/repos/KratoBal/acropora-os/contents/apps/api/src/a.ts': [200, 'export function canMove() {}'],
  '/repos/KratoBal/acropora-os/contents/apps/api/src/gone.ts': [404, ''],
  '/repos/KratoBal/acropora-os/contents/apps/api/src/flaky.ts': [500, ''],
}

const CARDS = [
  { id: 'aaaa1111', title: 'rendben', status: 'planned', basis: 'os:apps/api/src/a.ts#canMove' },
  { id: 'bbbb2222', title: 'elavult', status: 'planned', basis: 'os:apps/api/src/gone.ts' },
  { id: 'cccc3333', title: 'bizonytalan', status: 'planned', basis: 'os:apps/api/src/flaky.ts' },
  { id: 'dddd4444', title: 'nincs alap', status: 'planned', basis: null },
  { id: 'aaaa9999', title: 'ketertelmu', status: 'planned', basis: 'os:apps/api/src/a.ts' },
]

beforeAll(async () => {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  for (const f of ['fleet-api.sh', 'kartya-visszameres.py']) copyFileSync(join(process.cwd(), 'scripts', f), join(root, 'scripts', f))
  for (const f of ['kartya_visszameres.py', 'github_token.py']) copyFileSync(join(process.cwd(), 'scripts', 'lib', f), join(root, 'scripts', 'lib', f))
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  writeFileSync(join(root, 'store', 'github-owner-token'), 'gh-test-token')

  github = createServer((req, res) => {
    const [path] = (req.url ?? '').split('?')
    const hit = GITHUB[path ?? '']
    res.writeHead(hit ? hit[0] : 404)
    res.end(hit ? hit[1] : '')
  })
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve))
  githubPort = (github.address() as AddressInfo).port

  dashboard = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : null })
      if (req.method === 'PUT' && failPut) {
        res.writeHead(500)
        res.end('boom')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.method === 'GET' && req.url === '/api/kanban' ? CARDS : { ok: true }))
    })
  })
  await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve))
  dashboardPort = (dashboard.address() as AddressInfo).port
})
afterAll(() => {
  dashboard.close()
  github.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  requests = []
  failPut = false
})

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      {
        env: {
          ...process.env,
          MARVEEN_WEB_PORT: String(dashboardPort),
          FLEET_GITHUB_APP: 'off',
          KARTYA_VISSZAMERES_TOKEN_FILE: join(root, 'store', 'github-owner-token'),
          KARTYA_VISSZAMERES_GITHUB_API: `http://127.0.0.1:${githubPort}`,
          ...env,
        },
      },
      (error, stdout) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

const posted = (suffix: string) => requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix))
const puts = () => requests.filter((r) => r.method === 'PUT')

describe('fleet-api.sh kanban-visszameres', () => {
  it('OK: stamps the result and the note, no time, exit 0', async () => {
    const r = await run(['kanban-visszameres', 'aaaa1111'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('OK:')
    expect(posted('/measure')).toEqual([
      { method: 'POST', path: '/api/kanban/aaaa1111/measure', body: { result: 'OK', note: '1 hivatkozás igaz a main ágon' } },
    ])
  })

  it('DIVERGED: stamps it, names the missing file, exit 4', async () => {
    const r = await run(['kanban-visszameres', 'bbbb2222'])
    expect(r.code).toBe(4)
    expect(r.out).toContain('DIVERGED')
    expect(r.out).toContain('os:apps/api/src/gone.ts nincs a main ágon')
    expect((posted('/measure')[0]!.body as { result: string }).result).toBe('DIVERGED')
  })

  it('UNKNOWN: stamped as UNKNOWN, said, exit 0', async () => {
    const r = await run(['kanban-visszameres', 'cccc3333'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('UNKNOWN')
    expect((posted('/measure')[0]!.body as { result: string }).result).toBe('UNKNOWN')
  })

  it('a card with no basis: nothing to measure, no stamp, exit 0', async () => {
    const r = await run(['kanban-visszameres', 'dddd4444'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('nincs mit merni')
    expect(posted('/measure')).toEqual([])
  })

  it('an unknown or ambiguous card id is FAIL, nothing stamped', async () => {
    for (const id of ['nincs', 'aaaa']) {
      const r = await run(['kanban-visszameres', id])
      expect(r.code).toBe(1)
      expect(r.out).toContain('FAIL')
    }
    expect(posted('/measure')).toEqual([])
  })
})

describe('fleet-api.sh kanban-assign, the check before issuing', () => {
  it('DIVERGED: the card is NOT issued (no PUT), exit 4, and the way out is named', async () => {
    const r = await run(['kanban-assign', 'bbbb2222', 'murena'])
    expect(r.code).toBe(4)
    expect(r.out).toContain('FAIL 4')
    expect(r.out).toContain('--akkor-is-ki')
    expect(puts()).toEqual([])
  })

  it('--akkor-is-ki with a reason issues it, says so, and puts the reason on the card', async () => {
    const r = await run(['kanban-assign', 'bbbb2222', 'murena', '--akkor-is-ki', 'a fajl atkerult, az uj utat a kartya szovege mondja'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('ELTERES ellenere kiadva')
    expect(puts()).toEqual([{ method: 'PUT', path: '/api/kanban/bbbb2222', body: { assignee: 'murena' } }])
    const comment = posted('/comments')
    expect(comment).toHaveLength(1)
    expect((comment[0]!.body as { content: string }).content).toContain('a fajl atkerult, az uj utat a kartya szovege mondja')
  })

  it('--akkor-is-ki with no reason, an empty one, or another switch: FAIL, nothing issued or measured', async () => {
    for (const args of [
      ['kanban-assign', 'bbbb2222', 'murena', '--akkor-is-ki'],
      ['kanban-assign', 'bbbb2222', 'murena', '--akkor-is-ki', '   '],
      ['kanban-assign', 'bbbb2222', 'murena', '--erolteto', 'x'],
    ]) {
      const r = await run(args)
      expect(r.code, args.join(' ')).toBe(1)
    }
    expect(puts()).toEqual([])
    expect(requests.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('UNKNOWN: issued, and it SAYS the card was not measured', async () => {
    const r = await run(['kanban-assign', 'cccc3333', 'murena'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('NEM sikerult megmerni')
    expect(puts()).toHaveLength(1)
  })

  it('OK: issued, no warning', async () => {
    const r = await run(['kanban-assign', 'aaaa1111', 'murena'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('FIGYELEM')
    expect(puts()).toEqual([{ method: 'PUT', path: '/api/kanban/aaaa1111', body: { assignee: 'murena' } }])
  })

  it('a card with no basis is issued as before: no measurement, no stamp', async () => {
    const r = await run(['kanban-assign', 'dddd4444', 'murena'])
    expect(r.code).toBe(0)
    expect(puts()).toEqual([{ method: 'PUT', path: '/api/kanban/dddd4444', body: { assignee: 'murena' } }])
    expect(posted('/measure')).toEqual([])
  })

  it('an ambiguous card id is FAIL: nothing issued', async () => {
    const r = await run(['kanban-assign', 'aaaa', 'murena'])
    expect(r.code).toBe(1)
    expect(puts()).toEqual([])
  })
})

describe('the follow-up to #347 (barracuda 46012, acrobot 46015)', () => {
  it('a shortened card id: the measurement AND the PUT use the resolved full id', async () => {
    const r = await run(['kanban-assign', 'aaaa1', 'murena'])
    expect(r.code).toBe(0)
    expect(puts()).toEqual([{ method: 'PUT', path: '/api/kanban/aaaa1111', body: { assignee: 'murena' } }])
    expect(posted('/measure')[0]!.path).toBe('/api/kanban/aaaa1111/measure')
  })

  it('the override comment goes on the card only AFTER a successful PUT: a failed PUT leaves no comment', async () => {
    failPut = true
    const r = await run(['kanban-assign', 'bbbb2222', 'murena', '--akkor-is-ki', 'indok'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('FAIL')
    expect(posted('/comments')).toEqual([])
  })

  it('handing a card back to the main agent: no measurement, no stamp, no block, even on a diverged card', async () => {
    const r = await run(['kanban-assign', 'bbbb2222', 'acrobot'])
    expect(r.code).toBe(0)
    expect(puts()).toEqual([{ method: 'PUT', path: '/api/kanban/bbbb2222', body: { assignee: 'acrobot' } }])
    expect(posted('/measure')).toEqual([])
    expect(requests.filter((q) => q.method === 'GET')).toEqual([])
  })

  it('only GitHub itself or a loopback address may receive the token: any other base is UNKNOWN and said', async () => {
    for (const base of ['https://gyujto.example', 'http://127.0.0.1.evil.example', 'https://api.github.com@evil.example', 'http://api.github.com']) {
      requests = []
      const r = await run(['kanban-visszameres', 'aaaa1111'], { KARTYA_VISSZAMERES_GITHUB_API: base })
      expect(r.code, base).toBe(0)
      expect(r.out, base).toContain('UNKNOWN')
      expect(r.out, base).toContain('nem engedélyezett')
    }
  })
})
