// The PostToolUse hook logs a call and does not prune (acrovelIQ P0-1, step
// sheet L6 point 8). It used to POST /api/tool-log/prune on ~1% of calls, a
// route the access matrix gives only to the session and the main agent, so an
// agent's own token got a silent 403 there under enforcement. The server
// prunes hourly instead (src/web.ts).
//
// The hook runs for real: copied into a throwaway install root (its token,
// port and libraries resolved from there), against a local server that
// records the paths, with random.random pinned to 0.0, the value that took
// the old prune branch on every call.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = process.cwd()
let server: Server
let port = 0
const seen: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
})

function installRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mv-toollog-'))
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  for (const f of ['tool-log-capture.py', 'ledger_lib.py']) copyFileSync(join(REPO, 'scripts', 'hooks', f), join(root, 'scripts', 'hooks', f))
  copyFileSync(join(REPO, 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  // the hook presents the main agent's OWN token and never the shared one (P0-1): .env names the main agent
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=proba-fo\n')
  writeFileSync(join(root, 'store', 'tokens', 'proba-fo.token'), 'test-token\n', { mode: 0o600 })
  writeFileSync(join(root, 'store', '.dashboard-token'), 'KOZOS-NEM-HASZNALT\n', { mode: 0o600 })
  return root
}

describe('tool-log-capture.py', () => {
  it('TOOLLOG-NOPRUNE: logs the call and never calls the prune route, even when the old 1% branch would fire', async () => {
    const root = installRoot()
    const hook = join(root, 'scripts', 'hooks', 'tool-log-capture.py')
    const payload = JSON.stringify({ session_id: 's-1', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root })
    const runner = `import random, runpy, sys\nrandom.random = lambda: 0.0\nsys.argv = [sys.argv[1]]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n`
    seen.length = 0
    // async spawn: a synchronous one would block the event loop that serves the
    // recording server, and the hook's request would time out unseen
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('python3', ['-c', runner, hook], { env: { ...process.env, WEB_PORT: String(port) } })
      child.on('close', resolve)
      child.stdin.end(payload)
    })
    expect(code).toBe(0)
    expect(seen, 'TOOLLOG-NOPRUNE').toEqual(['POST /api/tool-log'])
  })
})
