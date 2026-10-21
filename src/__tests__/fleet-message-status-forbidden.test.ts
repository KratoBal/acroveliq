import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
  fleet-api.sh message-status: a 403 is "not yours", not "no such message" (card 9bf16d71, P0-1).
  With a sub-agent's own token a message between two other agents is not the caller's, and the
  enforcement answers 403. The command printed "nincs <id> azonositoju uzenet" for it: a message
  that exists, maybe delivered, reported as missing. What turns these red: the 403 read as a
  missing message; the 404 or a real row changing how it reads; a non-zero exit lost.
*/

const root = mkdtempSync(join(tmpdir(), 'fleet-message-status-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0

const answers: Record<string, { status: number; body: unknown }> = {
  '/api/messages/5': { status: 403, body: { error: 'Forbidden', reason: 'not its own' } },
  '/api/messages/6': { status: 404, body: { error: 'message not found', id: 6 } },
  '/api/messages/7': {
    status: 200,
    body: { id: 7, from_agent: 'acrobot', to_agent: 'nautilus', status: 'delivered', created_at: 1792550000, content: 'x' },
  },
}

beforeAll(async () => {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    const a = req.url === '/api/agents' ? { status: 200, body: [{ name: 'acrobot' }, { name: 'nautilus' }] } : answers[req.url ?? '']
    res.writeHead(a?.status ?? 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(a?.body ?? { error: 'not found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function status(id: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, 'message-status', id], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

describe('fleet-api.sh message-status', () => {
  it('a 403 says the message is not yours, never that it does not exist', async () => {
    const r = await status('5')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL: a 5 uzenet nem a tied, vagy nem letezik \(403: not its own\)/)
    expect(r.out).not.toMatch(/nincs 5 azonositoju/)
  })

  it('a 404 still says there is no such message', async () => {
    const r = await status('6')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL: nincs 6 azonositoju uzenet/)
  })

  it('a real row still reads as before', async () => {
    const r = await status('7')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^7 \| acrobot -> nautilus \| delivered \| letrehozva /)
    expect(r.out).toMatch(/MEGKAPTA/)
  })
})
