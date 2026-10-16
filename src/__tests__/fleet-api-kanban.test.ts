import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  fleet-api.sh kanban-keres and kanban-archive (B29, task b29-fleet-api-kanban). What turns these
  red: a filter ignored or ORed instead of ANDed; the title prefix case-sensitive; a tab or newline
  in a title breaking the one-line-per-card output; no count line; an unknown switch or status
  accepted silently; archive not a POST to the encoded card path; a 404 not reported as FAIL.
*/

const root = mkdtempSync(join(tmpdir(), 'fleet-api-kanban-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let requests: { method: string; path: string; body: unknown }[] = []

const CARDS = [
  { id: 'a1b2c3d4', title: '[flotta] B29 elso', status: 'planned', assignee: 'murena', priority: 'high' },
  { id: 'a1ffffff', title: '[Flotta] masodik\tfullal', status: 'in_progress', assignee: 'acrobot', priority: 'normal' },
  { id: 'b9000000', title: '[os] harmadik\nsorral', status: 'planned', assignee: null, priority: 'low' },
]

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : null })
      if (req.method === 'GET' && req.url === '/api/kanban') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(CARDS))
      } else if (req.method === 'POST' && req.url === '/api/kanban/nincs/archive') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Kártya nem található' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  requests = []
})

// stdout only: the token resolver's stderr line (no per-agent token in this fake root) is not output
function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

const ids = (out: string) => out.trim().split('\n').slice(0, -1).map((l) => l.split('\t')[0])

describe('fleet-api.sh kanban-keres', () => {
  it('no filter: every open card, one line each, then the count', async () => {
    const r = await run(['kanban-keres'])
    expect(r.code).toBe(0)
    expect(ids(r.out)).toEqual(['a1b2c3d4', 'a1ffffff', 'b9000000'])
    expect(r.out.trim().split('\n').at(-1)).toBe('3 kartya')
    for (const line of r.out.trim().split('\n').slice(0, -1)) expect(line.split('\t')).toHaveLength(5)
  })

  it('the title prefix is case-insensitive, and filters are ANDed', async () => {
    expect(ids((await run(['kanban-keres', '--cim', '[flotta]'])).out)).toEqual(['a1b2c3d4', 'a1ffffff'])
    expect(ids((await run(['kanban-keres', '--cim', '[flotta]', '--statusz', 'planned'])).out)).toEqual(['a1b2c3d4'])
    expect(ids((await run(['kanban-keres', '--id', 'a1', '--felelos', 'acrobot'])).out)).toEqual(['a1ffffff'])
    expect((await run(['kanban-keres', '--id', 'zz'])).out.trim()).toBe('0 kartya')
  })

  it('a card with no assignee shows a dash; only one GET is made', async () => {
    const r = await run(['kanban-keres', '--id', 'b9'])
    expect(r.out.split('\n')[0]!.split('\t')[2]).toBe('-')
    expect(requests).toEqual([{ method: 'GET', path: '/api/kanban', body: null }])
  })

  it('an unknown switch, a bad status or a switch without a value: FAIL, exit 1', async () => {
    for (const args of [['kanban-keres', '--cimm', 'x'], ['kanban-keres', '--statusz', 'kesz'], ['kanban-keres', '--cim']]) {
      const r = await run(args)
      expect(r.code).toBe(1)
      expect(r.out).toContain('FAIL')
    }
  })
})

describe('fleet-api.sh kanban-archive', () => {
  it('POSTs to the encoded card path with an empty object', async () => {
    const r = await run(['kanban-archive', 'a1 b'])
    expect(r.code).toBe(0)
    expect(requests).toEqual([{ method: 'POST', path: '/api/kanban/a1%20b/archive', body: {} }])
  })

  it('a missing card is FAIL with the status, exit 1', async () => {
    const r = await run(['kanban-archive', 'nincs'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAIL http=404')
  })
})
