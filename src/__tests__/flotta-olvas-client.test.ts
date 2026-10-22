import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/flotta-olvas.sh (B29, task b29-flotta-olvas). What turns these red: a parameter not
  URL-encoded; a request sent for an unknown question or a malformed parameter; the rows not one
  JSON object per line with the count after; a refusal not FAIL with the server's reason and exit 1.
*/

const root = mkdtempSync(join(tmpdir(), 'flotta-olvas-'))
let server: Server
let port = 0
let requests: { method: string; path: string; auth: string }[] = []

beforeAll(async () => {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  for (const f of ['flotta-olvas.sh', 'dashboard-fejlec.sh', 'lib/dashboard-token.sh']) copyFileSync(join(process.cwd(), 'scripts', f), join(root, 'scripts', f))
  writeFileSync(join(root, 'store', '.dashboard-token'), 'proba-token')
  // the caller is the install's owner here: the resolver needs the main agent's name and its own token file
  // (scripts/lib/dashboard_token.py: no .env or no own token is an error, not a shared-token fallback)
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=proba-fo\n')
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  writeFileSync(join(root, 'store', 'tokens', 'proba-fo.token'), 'proba-token')
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', auth: String(req.headers['authorization'] ?? '') })
    if ((req.url ?? '').startsWith('/api/fleet-reads/uzenet?id=403')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'csak a session és a fő ágens' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sorok: [{ kulcs: 'Bash: curl', darab: 2 }, { kulcs: 'Read', darab: 1 }], darab: 2 }))
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
    execFile('bash', [join(root, 'scripts', 'flotta-olvas.sh'), ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

describe('flotta-olvas.sh', () => {
  it('builds the encoded query, sends the token header, prints one row per line and the count', async () => {
    const r = await run(['tool-log-minta', 'agens=acrobot', 'elotag=Bash: curl', 'napok=7'])
    expect(r.code).toBe(0)
    expect(requests).toEqual([{ method: 'GET', path: '/api/fleet-reads/tool-log-minta?agens=acrobot&elotag=Bash%3A+curl&napok=7', auth: 'Bearer proba-token' }])
    expect(r.out.trim().split('\n')).toEqual(['{"kulcs": "Bash: curl", "darab": 2}', '{"kulcs": "Read", "darab": 1}', '2 sor'])
  })

  it('a refusal is FAIL with the server reason, exit 1', async () => {
    const r = await run(['uzenet', 'id=403'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAIL http=403: csak a session és a fő ágens')
  })

  it('an unknown question or a malformed parameter: exit 2, no request', async () => {
    expect((await run(['sql', 'x=1'])).code).toBe(2)
    expect((await run(['uzenet', 'id'])).code).toBe(2)
    expect((await run(['uzenet', 'ID=1'])).code).toBe(2)
    expect(requests).toEqual([])
  })
})
