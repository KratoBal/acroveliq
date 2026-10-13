// The handoff commands of scripts/fleet-api.sh (acrovelIQ token brief, item 3),
// run for real against a throwaway HTTP server. WHAT TURNS THIS RED:
//   - handoff-read does not stop (exit 3) on a mismatch, or does not print it;
//   - handoff-read does not name the next step when the state is in order;
//   - handoff-write hides the missing fields behind a short error;
//   - handoff-write changes the record on the way (a backtick, a dollar sign).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

import { M3_HANDOFF } from './fixtures/task-handoff-m3.js'

const root = mkdtempSync(join(tmpdir(), 'fleet-api-handoff-'))
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

const stored = (check: { ok: boolean; mismatches: string[] }) => ({
  id: 7, agent: 'murena', created_at: 1760259600, record: M3_HANDOFF, check,
})

describe('fleet-api.sh handoff-read', () => {
  it('HANDOFF-CLI-READ: in order, it names the next step; on a mismatch it stops with exit 3', async () => {
    answer = [200, stored({ ok: true, mismatches: [] })]
    const fine = await run(['handoff-read', 'hetfoi-lista-M3'])
    answer = [200, stored({ ok: false, mismatches: ['A feat/x ág feje bbbbbbb2, a rekordé aaaaaaa1.'] })]
    const stale = await run(['handoff-read', 'hetfoi-lista-M3'])
    expect([
      fine.code,
      fine.out.includes(`Kovetkezo lepes: ${M3_HANDOFF.next_step}`),
      stale.code,
      stale.out.includes('ELTERES, ALLJ MEG'),
      stale.out.includes('  - A feat/x ág feje bbbbbbb2, a rekordé aaaaaaa1.'),
      stale.out.includes('Kovetkezo lepes'),
    ], 'HANDOFF-CLI-READ').toEqual([0, true, 3, true, true, false])
  })
})

describe('fleet-api.sh handoff-write', () => {
  it('HANDOFF-CLI-WRITE: names every missing field, and sends the record unchanged', async () => {
    answer = [400, { error: 'missing required fields', missing: ['next_step', 'decisions[0].who'], required: ['task {id, goal, brief}', 'code {repo, branch, head, pr, merged} vagy null'] }]
    const refused = await run(['handoff-write', 'hetfoi-lista-M3', 'murena', '-'], '{}')
    const tricky = { ...M3_HANDOFF, next_step: 'run `pnpm test` with $HOME and "quotes"' }
    answer = [201, { id: 8 }]
    const written = await run(['handoff-write', 'hetfoi-lista-M3', 'murena', '-'], JSON.stringify(tricky))
    expect([
      refused.code,
      refused.out.includes('hianyzik: next_step'),
      refused.out.includes('hianyzik: decisions[0].who'),
      refused.out.includes('a rekord kotelezo mezoi:') && refused.out.includes('    task {id, goal, brief}') && refused.out.includes('    code {repo, branch, head'),
      written.code,
      received,
    ], 'HANDOFF-CLI-WRITE').toEqual([1, true, true, true, 0, { agent: 'murena', record: tricky }])
  })
})

describe('fleet-api.sh, the task id in the URL (barracuda, #16)', () => {
  it('HANDOFF-CLI-ENCODE: a space or a ? in the task id does not break the path', async () => {
    answer = [200, stored({ ok: true, mismatches: [] })]
    await run(['handoff-read', 'feladat 7?x'])
    expect(receivedPath, 'HANDOFF-CLI-ENCODE').toBe('/api/tasks/feladat%207%3Fx/handoffs/latest?verify=1')
  })
})
