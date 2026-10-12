// The per-task usage commands of scripts/fleet-api.sh (acrovelIQ token brief,
// item 1), run for real against a throwaway HTTP server. WHAT TURNS THIS RED:
//   - task-usage does not stop (exit 3) on an overlapping window, or does not name it;
//   - task-usage hides the capacity kinds or the variants;
//   - task-event sends the time as something the server cannot read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'


const root = mkdtempSync(join(tmpdir(), 'fleet-api-task-usage-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let received: unknown = null
let receivedPath = ''
/** What the fake dashboard answers next: [status, body]. */
let answer: [number, unknown] = [200, {}]

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      receivedPath = req.url ?? ''
      received = raw ? JSON.parse(raw) : null
      res.writeHead(answer[0], { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer[1]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}


const totals = (calls: number, cacheRead: number) => ({
  calls, input: calls * 10, output: calls * 20, cache_read: cacheRead, cache_write: 0, first_call: null, last_call: null,
})
const empty = totals(0, 0)
const usage = (id: string, variant: string | null, valid: boolean) => ({
  task: { id, project: 'acropora', variant },
  valid,
  overlaps: valid ? [] : [{ call_id: 9, agent: 'murena', timestamp: 1760252700, tasks: [id, 'masik'] }],
  totals: totals(43, 7_990_000),
  by_capacity: { work: totals(40, 7_000_000), review: empty, fix: totals(3, 990_000), admin: empty, repeat: empty },
  by_agent: {}, by_session: {}, by_mode: { session: 0, window: 43 },
  duration_seconds: 900, repeated_of: null,
})

describe('fleet-api.sh task-usage', () => {
  it('FLEET-TASK-USAGE: prints the breakdown and the variants; an overlap stops with 3 and names it', async () => {
    answer = [200, { task: usage('m1', null, true), variants: [usage('m1-V1', 'V1', true)] }]
    const ok = await run(['task-usage', 'm1', 'variants'])
    const okPath = receivedPath
    answer = [200, usage('m1', null, false)]
    const bad = await run(['task-usage', 'm1'])
    expect([ok.code, okPath, /43 hivas .*cache-olv +7\.99M/.test(ok.out), /fix +3 hivas/.test(ok.out),
      ok.out.includes('m1-V1 (acropora, V1)'), bad.code, /ERVENYTELEN/.test(bad.out), /ATFEDES: murena .*m1, masik/.test(bad.out)],
    'FLEET-TASK-USAGE').toEqual([0, '/api/tasks/m1/usage?variants=1', true, true, true, 3, true, true])
  })

  it('FLEET-TASK-EVENT: the time and the reference go as given, the task id URL-encoded', async () => {
    answer = [201, { id: 1 }]
    const r = await run(['task-event', 'kartya 1', 'started', 'murena', '2026-10-12T07:03:00Z', 'msg 28421'])
    expect([r.code, receivedPath, received], 'FLEET-TASK-EVENT').toEqual([
      0, '/api/tasks/kartya%201/events', { kind: 'started', actor: 'murena', at: '2026-10-12T07:03:00Z', ref: 'msg 28421' },
    ])
  })
})
