// The guarded approver (scripts/root/fleet-approve.py) reads the verdicts from the dashboard's own
// database, read-only and with no token (acrobot 31454, option 1). This binds its query to the REAL
// table: the database here is made by the app's own initDatabase (WAL mode, the real columns), the
// verdicts go in through the real events route, and the approver's Python reader reads that file.
// WHAT TURNS THIS RED:
//   - a renamed or dropped task_events column the approver's SELECT names;
//   - the reader missing verdicts that sit in the WAL and are not yet checkpointed;
//   - another task's verdict, or another kind, reaching the approver;
//   - the order not being the server's id order.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { initDatabase } from '../db.js'
import { taskCoreSettings, tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
const BARRACUDA: Auth = { kind: 'token', actor: 'barracuda', project: 'acropora' }
const APPROVER = join(process.cwd(), 'scripts', 'root', 'fleet-approve.py')
const HEAD = 'c'.repeat(40)

async function call(method: string, path: string, body: unknown, who: Auth): Promise<number> {
  let status = 200
  const res: any = { statusCode: 200, setHeader() { return res }, writeHead(code: number) { status = code; return res }, end() {} }
  const raw = JSON.stringify(body)
  const req: any = { headers: {}, on(e: string, cb: (c?: Buffer) => void) { if (e === 'data') cb(Buffer.from(raw)); if (e === 'end') cb() } }
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleTaskUsage({ req, res, path: url.pathname, method, url, auth: who } as unknown as RouteContext)
  return status
}

function pythonRead(db: string, task: string): { items: any[]; latest: unknown } {
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("fa", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'items = m.read_verdicts(sys.argv[3], sys.argv[2], drop=False)',
    'print(json.dumps({"items": items, "latest": m.latest_verdict(items, "barracuda", "KratoBal", "acroveliq", 202)}))',
  ].join('\n')
  return JSON.parse(execFileSync('python3', ['-I', '-c', code, APPROVER, db, task], { encoding: 'utf8' }))
}

let dir: string
let db: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-approve-db-'))
  db = join(dir, 'claudeclaw.db')
  initDatabase(db)
  taskCoreSettings.mode = 'naplo'
  taskCoreSettings.projectMode = 'naplo'
})
afterEach(() => {
  initDatabase(':memory:')
  rmSync(dir, { recursive: true, force: true })
})

describe('the approver reads the verdicts from the real table', () => {
  it('APPROVE-DB: the task\'s verdicts in id order, from the WAL too; not another task\'s, not another kind', async () => {
    await call('POST', '/api/tasks', { id: 't-a', title: 't', goal: 'g', assignee: 'nautilus', reviewer: 'barracuda', project: 'acropora' }, ACRO)
    await call('POST', '/api/tasks', { id: 't-b', title: 't', goal: 'g', assignee: 'nautilus', reviewer: 'barracuda', project: 'acropora' }, ACRO)
    const ev = (task: string, kind: string, ref: string) => call('POST', `/api/tasks/${task}/events`, { kind, actor: 'barracuda', ref }, BARRACUDA)
    const codes = [
      await ev('t-a', 'verdict', `CHANGES KratoBal/acroveliq#202 pr-marveen202 fej ${'d'.repeat(40)}`),
      await ev('t-a', 'verdict', `APPROVE KratoBal/acroveliq#202 pr-marveen202 fej ${HEAD}`),
      await ev('t-a', 'review_requested', `KratoBal/acroveliq#202 fej ${HEAD}`),
      await ev('t-b', 'verdict', `APPROVE KratoBal/acroveliq#202 pr-marveen202 fej ${'e'.repeat(40)}`),
    ]
    const out = pythonRead(db, 't-a')
    expect([
      codes,
      out.items.map((i: any) => [i.kind, i.actor, i.ref.split(' ')[0]]),
      out.items[0].id < out.items[1].id,
      out.latest,
    ], 'APPROVE-DB').toEqual([
      [201, 201, 201, 201],
      [['verdict', 'barracuda', 'CHANGES'], ['verdict', 'barracuda', 'APPROVE']],
      true,
      ['APPROVE', HEAD],
    ])
  })
})
