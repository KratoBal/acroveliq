// The scheduled-task fields that run something as the dashboard's own user
// (command, preCheck) or in another agent's session (targetSession) are
// written through the API only from Balázs's session, IN EVERY ACCESS MODE,
// `naplo` included (Balázs, 2026-10-12 11:18:50 UTC: a running path for shell
// commands, closed apart from the P0-1 setting). Run for real: the schedules
// route behind an HTTP server, its task directory under a temporary HOME, an
// in-memory database. WHAT TURNS THIS RED:
//   - in any mode, the shared token, an agent token or a device sets one of
//     them (403 expected) or changes task-config.json while trying;
//   - a refusal leaves no `denied` row, or the row holds a value;
//   - a non-session caller makes a task a command task, on create or update;
//   - the session cannot set them, or the agents lose `task` and `heartbeat`;
//   - re-saving a task with its current values (the dashboard form) is refused.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const home = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'schedule-fields-'))
  process.env.HOME = dir
  return dir
})

import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { initDatabase, getDb } from '../db.js'
import type { AccessMode } from '../web/access-enforcement.js'
import { tryHandleSchedules } from '../web/routes/schedules.js'
import { SCHEDULED_TASKS_DIR, writeScheduledTask } from '../web/scheduled-tasks-io.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const L: Auth = { kind: 'token', actor: 'legacy', project: 'acropora' }
const G: Auth = { kind: 'token', actor: 'murena', project: 'acropora' }
const D: Auth = { kind: 'device', device: 'telefon', actor: 'device:telefon', project: 'acropora' }
const S: Auth = { kind: 'session', user: 'balazs', actor: 'session:balazs', project: 'acropora' }

let server: Server
let port = 0
let auth: Auth = L
let mode: AccessMode = 'kikenyszerit'

beforeAll(async () => {
  initDatabase(':memory:')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void tryHandleSchedules({ req, res, path: url.pathname, method: req.method ?? 'GET', url, auth, accessMode: mode }).then((handled) => {
      if (!handled) { res.writeHead(404); res.end() }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server?.close()
  rmSync(home, { recursive: true, force: true })
})

const config = (name: string) => {
  const file = join(SCHEDULED_TASKS_DIR, name, 'task-config.json')
  return existsSync(file) ? readFileSync(file, 'utf-8') : null
}

async function call(as: Auth, method: string, path: string, body: unknown, inMode: AccessMode = 'kikenyszerit'): Promise<number> {
  auth = as
  mode = inMode
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: JSON.stringify(body) })
  await res.text()
  return res.status
}

describe('scheduled task: session-only fields', () => {
  it('SCHEDULE-SESSION-ONLY-NAPLO: in naplo too the shared token is refused, the config stays byte for byte, and a denied row holds the fields, not their values', async () => {
    writeScheduledTask('naplos', { prompt: 'p', schedule: '0 8 * * *', agent: 'murena', type: 'task' })
    const before = config('naplos')
    getDb().prepare('DELETE FROM access_decisions').run()
    const status = await call(L, 'PUT', '/api/schedules/naplos', { type: 'command', command: 'echo titkos-parancs' }, 'naplo')
    const rows = getDb().prepare('SELECT actor, method, path, outcome, mode, reason FROM access_decisions').all() as Array<Record<string, string>>
    expect(
      [status, config('naplos') === before, rows.length, rows[0]?.actor, rows[0]?.path, rows[0]?.outcome, rows[0]?.reason.includes('command, type'), JSON.stringify(rows).includes('titkos-parancs')],
      'SCHEDULE-SESSION-ONLY-NAPLO',
    ).toEqual([403, true, 1, 'legacy', '/api/schedules/:name', 'denied', true, false])
  })

  it('SCHEDULE-SESSION-ONLY-EVERY-MODE: the shared token, an agent and a device are refused in each of the three positions', async () => {
    writeScheduledTask('mindegyik', { prompt: 'p', schedule: '0 8 * * *', agent: 'murena', type: 'task' })
    const before = config('mindegyik')
    const statuses: number[] = []
    for (const mode of ['naplo', 'legacy-szukitett', 'kikenyszerit'] as const)
      for (const [as, body] of [[L, { command: 'id' }], [G, { preCheck: '/tmp/x.sh' }], [D, { targetSession: 'agent-nautilus' }]] as const)
        statuses.push(await call(as, 'PUT', '/api/schedules/mindegyik', body, mode))
    expect([statuses, config('mindegyik') === before], 'SCHEDULE-SESSION-ONLY-EVERY-MODE').toEqual([statuses.map(() => 403), true])
  })

  it('SCHEDULE-SESSION-ONLY: no token or device sets command, preCheck, targetSession or a command type; the config stays byte for byte', async () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(home), 'the task directory is the temporary one').toBe(true)
    writeScheduledTask('meglevo', { prompt: 'p', schedule: '0 8 * * *', agent: 'murena', type: 'task' })
    const before = config('meglevo')
    const refused: Array<[Auth, unknown]> = [
      [L, { command: 'touch /tmp/nem-szabad' }],
      [L, { type: 'command' }],
      [L, { command: null }],
      [G, { preCheck: '/tmp/szkript.sh' }],
      [G, { targetSession: 'agent-nautilus' }],
      [G, { type: 'command', command: 'id' }],
      [D, { command: 'id' }],
    ]
    const updates: number[] = []
    for (const [as, body] of refused) updates.push(await call(as, 'PUT', '/api/schedules/meglevo', body))
    const created = [
      await call(L, 'POST', '/api/schedules', { name: 'uj-parancs', prompt: 'p', schedule: '0 8 * * *', type: 'command' }),
      await call(G, 'POST', '/api/schedules', { name: 'uj-celmunkamenet', prompt: 'p', schedule: '0 8 * * *', targetSession: 'agent-nautilus' }),
    ]
    expect(
      [updates, config('meglevo') === before, created, config('uj-parancs'), config('uj-celmunkamenet')],
      'SCHEDULE-SESSION-ONLY',
    ).toEqual([refused.map(() => 403), true, [403, 403], null, null])
  })

  it('SCHEDULE-SESSION-ONLY-UNCHANGED: re-saving a command task with its own values is not a change (the form sends type on every save); changing them is', async () => {
    writeScheduledTask('operator-parancs', { prompt: 'p', schedule: '0 8 * * *', agent: 'murena', type: 'command', command: 'echo ok', targetSession: 'agent-murena' })
    const resave = await call(D, 'PUT', '/api/schedules/operator-parancs', { prompt: 'p2', type: 'command', targetSession: 'agent-murena' })
    const afterResave = config('operator-parancs')
    const changed = await call(D, 'PUT', '/api/schedules/operator-parancs', { type: 'command', command: 'id' })
    expect(
      [resave, JSON.parse(afterResave!).command, changed, config('operator-parancs') === afterResave],
      'SCHEDULE-SESSION-ONLY-UNCHANGED',
    ).toEqual([200, 'echo ok', 403, true])
  })

  it('SCHEDULE-SESSION-ONLY-ALLOWED: the session sets them; an agent still writes task and heartbeat tasks', async () => {
    writeScheduledTask('masik', { prompt: 'p', schedule: '0 8 * * *', agent: 'murena', type: 'task' })
    const session = await call(S, 'PUT', '/api/schedules/masik', { command: 'echo ok', type: 'command' })
    const sessionConfig = JSON.parse(config('masik')!) as { command?: string; type?: string }
    const agentType = await call(G, 'PUT', '/api/schedules/masik', { type: 'heartbeat', prompt: 'q' })
    const agentCreate = await call(L, 'POST', '/api/schedules', { name: 'sziv', prompt: 'p', schedule: '0 8 * * *', type: 'heartbeat' })
    expect(
      [session, sessionConfig.command, agentType, (JSON.parse(config('masik')!) as { type?: string }).type, agentCreate, config('sziv') !== null],
      'SCHEDULE-SESSION-ONLY-ALLOWED',
    ).toEqual([200, 'echo ok', 200, 'heartbeat', 200, true])
  })
})
