import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  fleet-api.sh agent-restart (TC-Lite L2). What turns these red: --task sent
  without --fresh (the server would refuse it, but the helper must not even
  ask); fresh sent as a string; task_id sent when not asked for; an unknown
  switch silently ignored; the agent name not URL-encoded into the path.
*/

const root = mkdtempSync(join(tmpdir(), 'fleet-api-agent-restart-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let requests: { method: string; path: string; body: unknown }[] = []

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
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, session_id: '0f8fad5b-d9cb-469f-a165-70867728950e' }))
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

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })
}

describe('fleet-api.sh agent-restart', () => {
  it('--fresh --task: POST restart with fresh true and the task id, the answer printed', async () => {
    const r = await run(['agent-restart', 'murena', '--fresh', '--task', 'tcl-l2'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('"session_id"')
    expect(requests).toEqual([{ method: 'POST', path: '/api/agents/murena/restart', body: { fresh: true, task_id: 'tcl-l2' } }])
  })

  it('the switches in either order', async () => {
    await run(['agent-restart', 'murena', '--task', 'tcl-l2', '--fresh'])
    expect(requests[0]!.body).toEqual({ fresh: true, task_id: 'tcl-l2' })
  })

  it('--fresh alone, and nothing at all: no task_id in the body', async () => {
    await run(['agent-restart', 'murena', '--fresh'])
    await run(['agent-restart', 'murena'])
    expect(requests.map((q) => q.body)).toEqual([{ fresh: true }, { fresh: false }])
  })

  it('--task without --fresh stops before any request', async () => {
    const r = await run(['agent-restart', 'murena', '--task', 'tcl-l2'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('--fresh')
    expect(requests).toEqual([])
  })

  it('an unknown switch stops before any request', async () => {
    const r = await run(['agent-restart', 'murena', '--frsh'])
    expect(r.code).not.toBe(0)
    expect(requests).toEqual([])
  })

  it('the agent name is encoded into the path', async () => {
    await run(['agent-restart', 'a/b', '--fresh'])
    expect(requests[0]!.path).toBe('/api/agents/a%2Fb/restart')
  })
})
