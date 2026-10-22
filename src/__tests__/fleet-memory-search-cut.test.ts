import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  The memory search helpers say when their list may be cut (card 1daee3a5, acrobot 34053).
  GET /api/memories answers at most `limit` rows (50 by default). fleet-api.sh memory-search and
  fleet.py search_memory asked with no limit, so the list stopped after the 50th hit, silently, and
  a "no such memory" could stand on a cut list. What turns these red: no explicit limit in the
  request; no warning when the answer reached the limit or the server capped it (X-Limit-Capped);
  a warning on a list that is not cut; the warning on stdout (callers parse the JSON there).
*/

const root = mkdtempSync(join(tmpdir(), 'fleet-memory-search-cut-'))
const script = join(root, 'scripts', 'fleet-api.sh')
const fleetPy = join(root, 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py')
let server: Server
let port = 0
let requests: string[] = []
let answer: { rows: number; capped?: string } = { rows: 0 }

beforeAll(async () => {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'seed-skills', 'fleet-helper', 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  copyFileSync(join(process.cwd(), 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py'), fleetPy)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  // the caller is the install's owner here: the resolver needs the main agent's name and its own token file
  // (scripts/lib/dashboard_token.py: no .env or no own token is an error, not a shared-token fallback)
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=proba-fo\n')
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  writeFileSync(join(root, 'store', 'tokens', 'proba-fo.token'), 'test-token')
  server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const rows = Array.from({ length: answer.rows }, (_, i) => ({ id: i + 1, content: `emlek ${i + 1}` }))
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (answer.capped) headers['X-Limit-Capped'] = answer.capped
    res.writeHead(200, headers)
    res.end(JSON.stringify(rows))
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

function exec(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    )
  })
}

const viaShell = () => exec('bash', [script, 'memory-search', 'nautilus', 'kulcs'], { MARVEEN_WEB_PORT: String(port) })
const viaPython = () =>
  exec('python3', [fleetPy, 'mem-search', 'nautilus', 'kulcs'], { CLAW_DIR: root, CLAW_BASE: `http://127.0.0.1:${port}` })

describe.each([
  ['fleet-api.sh memory-search', viaShell],
  ['fleet.py mem-search', viaPython],
])('%s', (_name, run) => {
  it('asks with an explicit limit', async () => {
    answer = { rows: 3 }
    await run()
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!, 'http://x').searchParams.get('limit')).toBe('50')
  })

  it('a list below the limit: no warning, the JSON array as before', async () => {
    answer = { rows: 49 }
    const r = await run()
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toHaveLength(49)
    expect(r.err).not.toMatch(/FIGYELEM/)
  })

  it('a list that reached the limit: a loud warning on stderr, stdout still the JSON array', async () => {
    answer = { rows: 50 }
    const r = await run()
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toHaveLength(50)
    expect(r.err).toMatch(/FIGYELEM: a lista elerte a limitet \(50 sor\)/)
    expect(r.out).not.toMatch(/FIGYELEM/)
  })

  it('a list the server capped (X-Limit-Capped): says it is cut', async () => {
    answer = { rows: 20, capped: '200' }
    const r = await run()
    expect(r.err).toMatch(/FIGYELEM: a lista VAGOTT: a szerver 200 sornal levagta/)
  })
})
