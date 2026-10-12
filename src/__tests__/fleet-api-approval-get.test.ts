import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

// fleet-api.sh approval-get (barracuda, #36): the approvals row carries
// `resolved_at` (epoch seconds) and `resolved_by`; the helper read a
// `decided_at` key that never existed, so the decision time never showed.
// Every agent's autonomy block calls this command since #36. What turns these
// red: the helper reading the wrong key again; a pending approval printing a
// decision line.

const root = mkdtempSync(join(tmpdir(), 'fleet-api-approval-get-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let answer: unknown = {}

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      { env: { ...process.env, MARVEEN_WEB_PORT: String(port), TZ: 'UTC' } },
      (_error, stdout) => resolve(stdout),
    )
  })
}

describe('fleet-api.sh approval-get', () => {
  it('a decided approval shows when and by whom', async () => {
    answer = {
      id: 'apr_1',
      status: 'approved',
      action_description: 'A teszt',
      resolved_at: 1791849600,
      resolved_by: 'owner',
    }
    const out = await run(['approval-get', 'apr_1'])
    expect(out).toContain('id: apr_1 | status: approved')
    expect(out).toContain('dontes ideje: 2026-10-13 00:00:00 +0000')
    expect(out).toContain('dontott: owner')
  })

  it('a pending approval has no decision line', async () => {
    answer = { id: 'apr_2', status: 'pending', resolved_at: null, resolved_by: null }
    const out = await run(['approval-get', 'apr_2'])
    expect(out).toContain('status: pending')
    expect(out).not.toContain('dontes ideje')
    expect(out).not.toContain('dontott')
  })
})
