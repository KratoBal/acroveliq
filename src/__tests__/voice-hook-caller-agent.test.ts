import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/hooks/voice-reply-directive.py names the agent its token belongs to (P0-1 preflight,
  2026-10-21: acrobot GET /api/voice/directive 7x "not its own"). The hook took the agent from the
  session's cwd, the segment after agents/; the token from the calling OS user. When the main agent's
  session stood in agents/<x>/ (copying a hand-off file), the query named <x> with the main agent's
  token. What turns this red: the query naming the cwd's agent instead of the token's; a session at the
  project root no longer naming the main agent.

  The fixture root is owned by the test's user, so the resolver (scripts/lib/dashboard_token.py) reads
  this user as the install's owner, that is the main agent (MAIN_AGENT_ID in the fixture's .env).
*/

const root = mkdtempSync(join(tmpdir(), 'voice-hook-caller-'))
const hook = join(root, 'scripts', 'hooks', 'voice-reply-directive.py')
let server: Server
let queries: URLSearchParams[] = []

beforeAll(async () => {
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  mkdirSync(join(root, 'agents', 'nautilus', 'atadas'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'hooks', 'voice-reply-directive.py'), hook)
  // the hook imports ledger_lib (the rate-limited notice when it has no own token)
  copyFileSync(join(process.cwd(), 'scripts', 'hooks', 'ledger_lib.py'), join(root, 'scripts', 'hooks', 'ledger_lib.py'))
  copyFileSync(join(process.cwd(), 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  writeFileSync(join(root, 'store', 'tokens', 'acrobot.token'), 'acrobot-token')
  server = createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ directive: null, transcript: null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=acrobot\nWEB_PORT=${port}\n`)
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  queries = []
})

function runHook(cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile('python3', ['-B', hook], { env: { ...process.env, WEB_PORT: '' } }, () => resolve())
    child.stdin!.end(JSON.stringify({ prompt: '<channel chat_id="12345">szia</channel>', cwd }))
  })
}

describe('voice-reply-directive.py: the agent in the query is the token\'s own', () => {
  it('a main-agent session standing in agents/nautilus/ still asks as the main agent', async () => {
    await runHook(join(root, 'agents', 'nautilus', 'atadas'))
    expect(queries.map((q) => q.get('agent'))).toEqual(['acrobot'])
    expect(queries[0]!.get('chat')).toBe('12345')
  })

  it('a session at the project root asks as the main agent, as before', async () => {
    await runHook(root)
    expect(queries.map((q) => q.get('agent'))).toEqual(['acrobot'])
  })
})
