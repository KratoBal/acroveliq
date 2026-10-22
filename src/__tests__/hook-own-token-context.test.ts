import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  The four CONTEXT hooks (session-recent-log, taskstate-replay, prior-art-recall, voice-reply-directive) and
  ledger_lib.hook_context_notice (P0-1, task p01-csendes-visszaeso-hivok, PR 2 of 4, acrobot 35229).
  What turns these red: a hook that presents the SHARED token without an own one (it used to, silently); a hook that
  stops the prompt for lack of a token (exit must be 0); a hook that brings nothing into the context WITHOUT saying
  so; the same line on every prompt instead of at most every ten minutes; a marker another user can pre-plant (it
  lives in the install's own dirs, never in the shared temp dir) or a link taken for one; the own token not
  presented when it exists.
*/

const REPO = process.cwd()
const MAIN = 'proba-fo'
let server: Server
let port = 0
let seen: { auth: string; path: string }[] = []
let root = ''
let home = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), path: req.url ?? '' })
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(req.url?.includes('/api/daily-log') ? '[]' : '{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
})

const HOOKS = ['session-recent-log.py', 'taskstate-replay.py', 'prior-art-recall.py', 'voice-reply-directive.py', 'ledger_lib.py']

function install(ownToken: string | null) {
  root = mkdtempSync(join(tmpdir(), 'hook-ctx-'))
  home = mkdtempSync(join(tmpdir(), 'hook-ctx-home-'))
  for (const d of ['scripts/hooks', 'scripts/lib', 'store/tokens', 'agents/al-agens']) mkdirSync(join(root, d), { recursive: true })
  for (const f of HOOKS) copyFileSync(join(REPO, 'scripts', 'hooks', f), join(root, 'scripts', 'hooks', f))
  copyFileSync(join(REPO, 'scripts', 'lib', 'dashboard_token.py'), join(root, 'scripts', 'lib', 'dashboard_token.py'))
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${MAIN}\nWEB_PORT=${port}\n`)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'KOZOS-TOKEN-NEM-HASZNALT\n')
  if (ownToken !== null) writeFileSync(join(root, 'store', 'tokens', `${MAIN}.token`), ownToken)
}

function fire(hook: string, payload: object, agent = MAIN): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-B', join(root, 'scripts', 'hooks', hook)], {
      env: {
        ...process.env,
        MARVEEN_AGENT_ID: agent,
        MAIN_AGENT_ID: MAIN,
        SERVICE_ID: MAIN,
        WEB_PORT: String(port),
        CLAUDE_PROJECT_DIR: root,
        HOME: home, // prior-art-recall reads ~/.claude/channels/discord/.env: never the real one
      },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.end(JSON.stringify(payload))
  })
}

const cleanup = () => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

const PROMPT = { prompt: 'Mikor lesz kesz a vizmeres jelentes tobb cimzettje a teszten?' }
const CASES = [
  { hook: 'session-recent-log.py', name: 'session-recent-log', payload: {}, agent: MAIN, route: '/api/daily-log', dir: 'store' },
  { hook: 'taskstate-replay.py', name: 'taskstate-replay', payload: { source: 'resume' }, agent: 'al-agens', route: '/api/agent-taskstate/al-agens/replay', dir: 'agents/al-agens' },
  { hook: 'prior-art-recall.py', name: 'prior-art-recall', payload: PROMPT, agent: MAIN, route: '/api/recall', dir: 'store' },
  {
    hook: 'voice-reply-directive.py',
    name: 'voice-reply-directive',
    payload: { prompt: '<channel source="x" chat_id="123" message_id="9">szia</channel>', cwd: '/x' },
    agent: MAIN,
    route: '/api/voice/directive',
    dir: 'store',
  },
] as const

describe.each(CASES)('$name', ({ hook, name, payload, agent, route, dir }) => {
  const marker = () => join(root, dir, `.hook-notice-${name}`)

  it('the own token is presented and nothing is noted', async () => {
    install('own-token\n')
    const r = await fire(hook, payload, agent)
    expect(r.code).toBe(0)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((q) => q.auth === 'Bearer own-token')).toBe(true)
    expect(seen.some((q) => q.path.startsWith(route))).toBe(true)
    expect(r.out).not.toContain(`[${name}]`)
    expect(existsSync(marker())).toBe(false)
    cleanup()
  })

  it('NO own token: exit 0, no request (the shared token is NOT presented), and the context is told', async () => {
    install(null)
    const r = await fire(hook, payload, agent)
    expect(r.code, 'a hook must never stop the prompt').toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.out).toContain(`[${name}] A hook nem tudta behozni a kontextusba`)
    expect(r.out).toContain('vezerlopulton')
    expect(r.out).not.toContain('KOZOS-TOKEN')
    expect(r.out).not.toContain('Balazs')
    expect(existsSync(marker())).toBe(true)
    cleanup()
  })

  it('an EMPTY own token is the same', async () => {
    install('')
    const r = await fire(hook, payload, agent)
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.out).toContain(`[${name}]`)
    cleanup()
  })

  it('the line is rate limited: once, silent inside ten minutes, again after the marker ages', async () => {
    install(null)
    const first = await fire(hook, payload, agent)
    expect(first.out).toContain(`[${name}]`)
    const second = await fire(hook, payload, agent)
    expect(second.code).toBe(0)
    expect(second.out, 'the same line on every prompt would bury the context').not.toContain(`[${name}]`)
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(marker(), old, old)
    const third = await fire(hook, payload, agent)
    expect(third.out).toContain(`[${name}]`)
    cleanup()
  })

  it('a LINK at the marker is ignored (the line comes again) and nothing is written through it', async () => {
    install(null)
    const target = join(root, 'celpont.txt')
    writeFileSync(target, 'ne irj ide\n')
    const recent = new Date(Date.now() - 60 * 1000)
    utimesSync(target, recent, recent) // FRESH: a link taken for a valid marker would mute the line
    symlinkSync(target, marker())
    const a = await fire(hook, payload, agent)
    const b = await fire(hook, payload, agent)
    expect(a.out).toContain(`[${name}]`)
    expect(b.out).toContain(`[${name}]`)
    expect(readFileSync(target, 'utf8')).toBe('ne irj ide\n')
    cleanup()
  })

  it('a marker planted in the SHARED temp dir does not mute it', async () => {
    install(null)
    writeFileSync(join(tmpdir(), `.hook-notice-${name}`), '')
    const r = await fire(hook, payload, agent)
    expect(r.out).toContain(`[${name}]`)
    rmSync(join(tmpdir(), `.hook-notice-${name}`), { force: true })
    cleanup()
  })
})

describe('prior-art-recall, outgoing-message entry point', () => {
  it('without an own token the notice rides as PreToolUse additionalContext', async () => {
    install(null)
    const r = await fire('prior-art-recall.py', { tool_input: { text: 'Mikor lesz kesz a vizmeres jelentes tobb cimzettje a teszten?' } })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out.trim())
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[prior-art-recall]')
    expect(seen).toHaveLength(0)
    cleanup()
  })
})

describe('taskstate-replay JSON shape', () => {
  it('without an own token the notice is a SessionStart additionalContext', async () => {
    install(null)
    const r = await fire('taskstate-replay.py', { source: 'resume' }, 'al-agens')
    const parsed = JSON.parse(r.out.trim())
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[taskstate-replay]')
    cleanup()
  })
})
