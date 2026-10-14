// scripts/access-preflight.ts, run for real on a throwaway database. WHAT
// TURNS THIS RED: the switch looks safe (exit 0) while a would-be denial is
// logged; legacy-szukitett lists another caller than the shared token; an
// already enforced denial or an old day is listed as new.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { ensureAccessDecisionSchema } from '../web/access-enforcement.js'
import { localDay } from '../web/auth-principals.js'

const root = mkdtempSync(join(tmpdir(), 'access-preflight-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function database(rows: Array<[string, string, string, 'denied' | 'would-deny', number]>): string {
  const file = join(root, `${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  ensureAccessDecisionSchema(db)
  const now = Math.floor(Date.now() / 1000)
  for (const [actor, method, path, outcome, daysAgo] of rows) {
    db.prepare(
      `INSERT INTO access_decisions (day, project, actor, method, path, outcome, mode, reason, count, first_seen, last_seen)
       VALUES (?, 'acropora', ?, ?, ?, ?, 'naplo', 'csoport', 2, ?, ?)`,
    ).run(localDay(now - daysAgo * 86400), actor, method, path, outcome, now, now)
  }
  db.close()
  return file
}

const preflight = (db: string, ...args: string[]) => {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'scripts', 'access-preflight.ts'), '--db', db, ...args], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('access preflight', () => {
  it('ACCESS-PREFLIGHT: lists what the mode would newly deny and stops the switch while the list holds anything', () => {
    const db = database([
      ['legacy', 'POST', '/api/schedules', 'would-deny', 0],
      ['murena', 'PATCH', '/api/approvals/:id', 'would-deny', 0],
      ['session:balazs', 'GET', '/api/x', 'would-deny', 0],
      ['nautilus', 'POST', '/api/settings', 'denied', 0], // already enforced: not new
      ['korall', 'POST', '/api/autonomy', 'would-deny', 5], // older than the window
    ])
    const full = preflight(db)
    const legacy = preflight(db, '--mode', 'legacy-szukitett')
    const wide = preflight(db, '--napok', '6')
    const empty = preflight(database([['nautilus', 'POST', '/api/settings', 'denied', 0]]))
    const listed = (out: string) => ['legacy', 'murena', 'session:balazs', 'nautilus', 'korall'].filter((a) => out.includes(`  ${a} `))
    expect(
      [full.code, listed(full.out), legacy.code, listed(legacy.out), listed(wide.out), empty.code],
      'ACCESS-PREFLIGHT',
    ).toEqual([1, ['legacy', 'murena'], 1, ['legacy'], ['legacy', 'murena', 'korall'], 0])
  })

  it('ACCESS-PREFLIGHT-JSON: --json gives the same rows as one JSON line, with the same exit code', () => {
    const db = database([
      ['legacy', 'POST', '/api/schedules', 'would-deny', 0],
      ['murena', 'PATCH', '/api/approvals/:id', 'would-deny', 0],
    ])
    const full = preflight(db, '--json')
    const empty = preflight(database([]), '--mode', 'legacy-szukitett', '--json')
    const parsed = JSON.parse(full.out.trim().split('\n').at(-1)!)
    expect(
      [full.code, parsed.mode, parsed.rows.map((r: { actor: string; path: string; count: number }) => [r.actor, r.path, r.count]), parsed.database, typeof parsed.newest, empty.code, JSON.parse(empty.out.trim().split('\n').at(-1)!).rows, JSON.parse(empty.out.trim().split('\n').at(-1)!).newest],
      'ACCESS-PREFLIGHT-JSON',
    ).toEqual([1, 'kikenyszerit', [['legacy', '/api/schedules', 2], ['murena', '/api/approvals/:id', 2]], db, 'number', 0, [], null])
  })
})
