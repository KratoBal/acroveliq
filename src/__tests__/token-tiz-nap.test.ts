import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
  scripts/token-tiz-nap.py: the V3 ten-day summary (acrobot 34138, task token-tiz-nap-osszesito).
  What turns these red: fresh/long/mixed read from the wrong timeline items; a 0-call task or a
  swallowing one (a registered session running far past the task) counted in the comparison; an
  invalid task counted; the window or the developer profiles ignored; read tokens not input +
  cache_read + cache_write; a bad call not exit 2, an unreachable dashboard not exit 3.
*/

const root = mkdtempSync(join(tmpdir(), 'token-tiz-nap-'))
const script = join(process.cwd(), 'scripts', 'token-tiz-nap.py')
const DAY = 86400
const T0 = Math.floor(new Date('2026-10-14T10:00:00').getTime() / 1000)

const tot = (calls: number, cache_read: number, output = 1000, last_call: number | null = null) => ({
  calls, input: calls, output, cache_read, cache_write: calls * 10, first_call: null, last_call,
})
type Fixture = { task: Record<string, unknown>; usage: Record<string, unknown>; items: Record<string, unknown>[] }
const ev = (kind: string, at: number) => ({ source: 'event', kind, at })
const fixtures: Fixture[] = [
  // fresh: a handoff record and a registered session; 40 calls, 8M read
  {
    task: { id: 'friss-1', assignee: 'nautilus', verification_profile: 'code_app', created_at: T0 },
    usage: { totals: tot(40, 8_000_000), valid: true, duration_seconds: 1200, by_mode: { session: 40, window: 0 }, by_session: { s1: tot(40, 8_000_000, 1000, T0 + 1200) } },
    items: [ev('started', T0), { source: 'handoff', at: T0 }, { source: 'session', at: T0 }, ev('merged', T0 + 1200)],
  },
  // long: neither; 20 calls, 12M read, one fix round
  {
    task: { id: 'hosszu-1', assignee: 'murena', verification_profile: 'code_fleet', created_at: T0 + 10 },
    usage: { totals: tot(20, 12_000_000), valid: true, duration_seconds: 900, by_mode: { session: 0, window: 20 }, by_session: {} },
    items: [ev('started', T0), ev('fix_started', T0 + 300), ev('done', T0 + 900)],
  },
  // mixed: a handoff only
  {
    task: { id: 'vegyes-1', assignee: 'nautilus', verification_profile: 'migration', created_at: T0 + 20 },
    usage: { totals: tot(10, 1_000_000), valid: true, duration_seconds: 60, by_mode: { session: 0, window: 10 }, by_session: {} },
    items: [ev('started', T0), { source: 'handoff', at: T0 }],
  },
  // 0 calls: its session is another task's
  {
    task: { id: 'nulla-1', assignee: 'nautilus', verification_profile: 'code_app', created_at: T0 + 30 },
    usage: { totals: tot(0, 0, 0), valid: true, duration_seconds: 600, by_mode: { session: 0, window: 0 }, by_session: {} },
    items: [ev('started', T0), ev('merged', T0 + 600)],
  },
  // swallowing: its registered session runs two hours past its last event
  {
    task: { id: 'elnyelo-1', assignee: 'murena', verification_profile: 'code_app', created_at: T0 + 40 },
    usage: { totals: tot(300, 99_000_000), valid: true, duration_seconds: 600, by_mode: { session: 300, window: 0 }, by_session: { s9: tot(300, 99_000_000, 1000, T0 + 600 + 7200) } },
    items: [ev('started', T0), { source: 'handoff', at: T0 }, { source: 'session', at: T0 }, ev('merged', T0 + 600)],
  },
  // invalid: a work call in two windows
  {
    task: { id: 'ervenytelen-1', assignee: 'murena', verification_profile: 'code_app', created_at: T0 + 50 },
    usage: { totals: tot(30, 50_000_000), valid: false, duration_seconds: 600, by_mode: { session: 0, window: 30 }, by_session: {} },
    items: [ev('started', T0)],
  },
  // not a developer profile: listed nowhere in the developer report
  {
    task: { id: 'docs-1', assignee: 'nautilus', verification_profile: 'docs', created_at: T0 + 60 },
    usage: { totals: tot(5, 1_000_000), valid: true, duration_seconds: 60, by_mode: { session: 0, window: 5 }, by_session: {} },
    items: [ev('started', T0)],
  },
  // outside the window (before 10-13)
  {
    task: { id: 'korabbi-1', assignee: 'nautilus', verification_profile: 'code_app', created_at: T0 - 5 * DAY },
    usage: { totals: tot(5, 1_000_000), valid: true, duration_seconds: 60, by_mode: { session: 0, window: 5 }, by_session: {} },
    items: [ev('started', T0 - 5 * DAY)],
  },
]

let server: Server
let base = ''
let lastAuth = ''

beforeAll(async () => {
  mkdirSync(join(root, 'store'), { recursive: true })
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    lastAuth = String(req.headers.authorization ?? '')
    const url = req.url ?? ''
    let body: unknown = { error: 'not found' }
    let status = 404
    if (url === '/api/tasks') { body = fixtures.map((f) => f.task); status = 200 }
    const m = url.match(/^\/api\/tasks\/([^/]+)\/(usage|timeline)$/)
    const f = m ? fixtures.find((x) => x.task.id === decodeURIComponent(m[1]!)) : undefined
    if (f && m![2] === 'usage') { body = f.usage; status = 200 }
    if (f && m![2] === 'timeline') { body = { items: f.items }; status = 200 }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], claw = base): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('python3', ['-B', script, ...args], { env: { ...process.env, CLAW_DIR: root, CLAW_BASE: claw } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    )
  })
}

describe('token-tiz-nap.py', () => {
  it('rows: mode from the handoff and session items, read = input + cache_read + cache_write, fix rounds, done', async () => {
    const json = join(root, 'sorok.json')
    const r = await run(['--tol', '2026-10-13', '--ig', '2026-10-24', '--ki', join(root, 'ki.md'), '--json', json])
    expect(r.code).toBe(0)
    expect(lastAuth).toBe('Bearer test-token')
    const sorok = JSON.parse(readFileSync(json, 'utf-8')) as Record<string, any>[]
    const by = Object.fromEntries(sorok.map((s) => [s.id, s]))
    expect(Object.keys(by).sort()).toEqual(['docs-1', 'elnyelo-1', 'ervenytelen-1', 'friss-1', 'hosszu-1', 'nulla-1', 'vegyes-1'])
    expect([by['friss-1'].mod, by['hosszu-1'].mod, by['vegyes-1'].mod]).toEqual(['friss', 'hosszú', 'vegyes'])
    expect(by['friss-1'].olvasott).toBe(40 + 8_000_000 + 400)
    expect(by['hosszu-1'].javitasi_kor).toBe(1)
    expect([by['hosszu-1'].kesz, by['vegyes-1'].kesz]).toEqual([true, false])
    expect([by['elnyelo-1'].elnyelo, by['friss-1'].elnyelo]).toEqual([true, false])
  })

  it('the report: coverage counted, and only the measurable developer rows in the comparison', async () => {
    const r = await run(['--tol', '2026-10-13', '--ig', '2026-10-24'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('- feladat az időszakban: 7, ebből fejlesztői: 6')
    expect(r.out).toContain('- mérhető (van hívás, nem elnyelő, érvényes): **3**')
    expect(r.out).toMatch(/- 0 hívás .*: 1\n/)
    expect(r.out).toMatch(/- elnyelő .*: 1\n/)
    expect(r.out).toMatch(/- érvénytelen .*: 1\n/)
    expect(r.out).toContain('| kicsi (1-49 hívás) | friss | 1 | 0.20M | 40 |')
    expect(r.out).toContain('| kicsi (1-49 hívás) | hosszú | 1 | 0.60M | 20 |')
    expect(r.out).not.toMatch(/\| nagy \(150\+\) \|/)
    expect(r.out).not.toContain('docs-1')
  })

  it('a bad call is exit 2, an unreachable dashboard exit 3', async () => {
    expect((await run(['--tol', '2026-13-01'])).code).toBe(2)
    expect((await run(['--tol', '2026-10-20', '--ig', '2026-10-13'])).code).toBe(2)
    expect((await run(['--tol', '2026-10-13'], 'http://127.0.0.1:1')).code).toBe(3)
  })
})
