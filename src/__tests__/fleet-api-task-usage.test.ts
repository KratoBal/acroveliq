// The per-task usage commands of scripts/fleet-api.sh (acrovelIQ token brief,
// item 1), run for real against a throwaway HTTP server. WHAT TURNS THIS RED:
//   - task-usage does not stop (exit 3) on an overlapping window, or does not name it;
//   - task-usage hides the capacity kinds or the variants;
//   - task-event sends the time as something the server cannot read;
//   - L1: task-event retries without its key, or with a NEW key (a lost answer
//     would then make two rows), or two runs share one key; --data does not
//     reach the body, or a non-object goes out; task-new - drops a field.
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
/** Answers used before `answer`, one per request. */
let queue: [number, unknown][] = []
/** Every request: its path, Idempotency-Key header and body. */
let requests: { path: string; key: string | undefined; body: unknown }[] = []

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
      const key = req.headers['idempotency-key']
      requests.push({ path: receivedPath, key: Array.isArray(key) ? key[0] : key, body: received })
      const [status, body] = queue.shift() ?? answer
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
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
  unassigned: { admin: totals(4, 2_000_000), review: empty },
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
      ok.out.includes('m1-V1 (acropora, V1)'), /admin: nem rendelheto, 4 hivas/.test(ok.out), /review: nem rendelheto/.test(ok.out), bad.code, /ERVENYTELEN/.test(bad.out), /ATFEDES: murena .*m1, masik/.test(bad.out)],
    'FLEET-TASK-USAGE').toEqual([0, '/api/tasks/m1/usage?variants=1', true, true, true, true, false, 3, true, true])
  })

  it('FLEET-TASK-EVENT: the time and the reference go as given, the task id URL-encoded', async () => {
    answer = [201, { id: 1 }]
    const r = await run(['task-event', 'kartya 1', 'started', 'murena', '2026-10-12T07:03:00Z', 'msg 28421'])
    expect([r.code, receivedPath, received], 'FLEET-TASK-EVENT').toEqual([
      0, '/api/tasks/kartya%201/events', { kind: 'started', actor: 'murena', at: '2026-10-12T07:03:00Z', ref: 'msg 28421' },
    ])
  })

  it('FLEET-TASK-EVENT-IDEM: a run retries a 500 with the SAME key; the next run has a new one', async () => {
    requests = []
    queue = [[500, { error: 'x' }]]
    answer = [201, { id: 7 }]
    const first = await run(['task-event', 't1', 'fix_started', 'murena'])
    const second = await run(['task-event', 't1', 'fix_started', 'murena'])
    const keys = requests.map((r) => r.key)
    expect([first.code, second.code, requests.length, keys[0] === keys[1], keys[1] === keys[2], /^[0-9a-f-]{36}$/.test(keys[0] ?? '')],
      'FLEET-TASK-EVENT-IDEM').toEqual([0, 0, 3, true, false, true])
  })

  it('FLEET-TASK-EVENT-DATA: --data - sends the object from STDIN; a non-object stops before any request', async () => {
    requests = []
    answer = [201, { id: 8 }]
    const ok = await run(['task-event', 't1', 'merged', 'acrobot', '', 'PR #41', '--data', '-'], '{"repo":"KratoBal/marveen","pr":41,"merge_sha":"' + 'a'.repeat(40) + '"}')
    const sent = requests.length
    const bad = await run(['task-event', 't1', 'merged', 'acrobot', '--data', '-'], '[1,2]')
    expect([ok.code, received, sent, bad.code, requests.length, /JSON objektum/.test(bad.out)], 'FLEET-TASK-EVENT-DATA').toEqual([
      0, { kind: 'merged', actor: 'acrobot', ref: 'PR #41', data: { repo: 'KratoBal/marveen', pr: 41, merge_sha: 'a'.repeat(40) } }, 1, 1, 1, true,
    ])
  })

  it('FLEET-TASK-NEW-JSON: task-new <id> - takes every field from STDIN, the id from the argument', async () => {
    answer = [201, { id: 'tcl-x' }]
    const r = await run(['task-new', 'tcl-x', '-'], '{"id":"masik","title":"Cím","assignee":"murena","verification_profile":"code_fleet","acceptance":["zöld"]}')
    expect([r.code, receivedPath, received], 'FLEET-TASK-NEW-JSON').toEqual([
      0, '/api/tasks', { id: 'tcl-x', title: 'Cím', assignee: 'murena', verification_profile: 'code_fleet', acceptance: ['zöld'] },
    ])
  })

  it('FLEET-TASK-TIMELINE: one line per item, and the count', async () => {
    answer = [200, { task: 't1', items: [
      { at: 1760252580, source: 'event', id: 1, kind: 'started', actor: 'murena', ref: null, data: null },
      { at: 1760252590, source: 'session', agent: 'murena', session_id: 'sess-1' },
      { at: 1760252600, source: 'handoff', id: 3, agent: 'murena', status: 'in_progress', next_step: 'x' },
    ] }]
    const r = await run(['task-timeline', 't1'])
    expect([r.code, receivedPath, /esemeny  started +murena/.test(r.out), /session  sess-1/.test(r.out), /atadas   rekord 3/.test(r.out), /-- 3 tetel, t1/.test(r.out)],
      'FLEET-TASK-TIMELINE').toEqual([0, '/api/tasks/t1/timeline', true, true, true, true])
  })
})
