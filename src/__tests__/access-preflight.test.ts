// scripts/access-preflight.ts, run for real on a throwaway database. WHAT
// TURNS THIS RED: the switch looks safe (exit 0) while a would-be denial is
// logged; legacy-szukitett lists another caller than the shared token; an
// already enforced denial or an old day is listed as new; --since-ts (the daily run's window, task
// preflight-ablak) dropping a row last seen after its start because its DAY is yesterday, or keeping one
// last seen before it; a route no rule answers (`:ismeretlen ...`) holding the switch, being listed as a
// hole in the matrix, or dropping out of the output (task p01-preflight-ismeretlen-utvonalak).
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

// the sixth value: how many of the row's 2 calls the dashboard answered with a 404 (not_found)
function database(rows: Array<[string, string, string, 'denied' | 'would-deny', number, number?]>): string {
  const file = join(root, `${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  ensureAccessDecisionSchema(db)
  const now = Math.floor(Date.now() / 1000)
  for (const [actor, method, path, outcome, daysAgo, notFound = 0] of rows) {
    db.prepare(
      `INSERT INTO access_decisions (day, project, actor, method, path, outcome, mode, reason, count, first_seen, last_seen, not_found)
       VALUES (?, 'acropora', ?, ?, ?, ?, 'naplo', 'csoport', 2, ?, ?, ?)`,
    ).run(localDay(now - daysAgo * 86400), actor, method, path, outcome, now, now, notFound)
  }
  db.close()
  return file
}

const preflight = (db: string, ...args: string[]) => {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'scripts', 'access-preflight.ts'), '--db', db, ...args], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('access preflight', () => {
  it('ACCESS-PREFLIGHT-SINCE-TS: the window is the last_seen time, not the day: yesterday after the start is in, before it is out', () => {
    const file = join(root, `${Math.random().toString(36).slice(2)}.db`)
    const db = new Database(file)
    ensureAccessDecisionSchema(db)
    const now = Math.floor(Date.now() / 1000)
    const start = now - 30 * 3600 // the previous good run, yesterday or the day before
    const put = (actor: string, path: string, outcome: 'denied' | 'would-deny', lastSeen: number) =>
      db.prepare(
        `INSERT INTO access_decisions (day, project, actor, method, path, outcome, mode, reason, count, first_seen, last_seen)
         VALUES (?, 'acropora', ?, 'GET', ?, ?, 'naplo', 'no rule for this route: default-deny', 1, ?, ?)`,
      ).run(localDay(lastSeen), actor, path, outcome, lastSeen, lastSeen)
    put('acrobot', ':ismeretlen /api/memories', 'would-deny', now - 26 * 3600) // the 10-16 case: after the start, an old day
    put('acrobot', ':ismeretlen /api/tasks', 'would-deny', now - 31 * 3600) // before the start: the previous run had it
    put('murena', '/api/x', 'would-deny', now) // today
    put('korall', '/api/y', 'denied', now - 3600) // already enforced: never new
    db.close()
    type Listed = Array<{ actor: string; path: string }>
    const json = (r: { out: string }) => JSON.parse(r.out.trim().split('\n').at(-1)!) as { since_ts: number | null; rows: Listed; unknown_routes: Listed }
    const both = (r: { out: string }) => [...json(r).rows, ...json(r).unknown_routes].map((x) => `${x.actor} ${x.path}`).sort()
    const win = preflight(file, '--since-ts', String(start), '--json')
    const oneDay = preflight(file, '--napok', '1', '--json')
    expect([
      win.code, json(win).since_ts, both(win),
      both(oneDay).includes('acrobot :ismeretlen /api/memories'),
      preflight(file, '--since-ts', String(start), '--napok', '1').code,
      preflight(file, '--since-ts', 'tegnap').code,
      preflight(file, '--since-ts', '0').code,
    ], 'ACCESS-PREFLIGHT-SINCE-TS').toEqual([
      1, start, ['acrobot :ismeretlen /api/memories', 'murena /api/x'],
      false, // the old --napok 1 window: the gap this closes
      2, 2, 2,
    ])
  }, 60_000) // seven tsx starts

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

  it('ACCESS-PREFLIGHT-UNKNOWN: a route no rule answers is listed apart only when every call got a 404; otherwise it holds', () => {
    // the 2026-10-28 shapes: every call a 404 (apart), none (a handler answered, or a row from before the count:
    // holds), one of two (holds); barracuda's CHANGES on #319
    const db = database([
      ['acrobot', 'POST', ':ismeretlen /api/kanban', 'would-deny', 0, 2],
      ['acrobot', 'GET', ':ismeretlen /api/tasks', 'would-deny', 0, 0],
      ['legacy', 'GET', ':ismeretlen', 'would-deny', 0, 1],
    ])
    const hole = database([
      ['acrobot', 'POST', ':ismeretlen /api/kanban', 'would-deny', 0, 2],
      ['murena', 'PATCH', '/api/approvals/:id', 'would-deny', 0],
    ])
    const last = (r: { out: string }) => JSON.parse(r.out.trim().split('\n').at(-1)!) as { rows: Array<{ path: string }>; unknown_routes: Array<{ actor: string; method: string; path: string }> }
    const only = preflight(db, '--json')
    const onlyText = preflight(db)
    const legacy = preflight(db, '--mode', 'legacy-szukitett', '--json')
    const mixed = preflight(hole, '--json')
    expect([
      only.code, last(only).rows.map((r) => r.path), last(only).unknown_routes.map((r) => `${r.actor} ${r.method} ${r.path}`),
      onlyText.code, onlyText.out.includes('nincs tiltandó hívás'), onlyText.out.includes('Szabály nélküli út (1 pár)'),
      onlyText.out.includes('  acrobot            POST   :ismeretlen /api/kanban'),
      legacy.code, last(legacy).unknown_routes.map((r) => r.actor),
      mixed.code, last(mixed).rows.map((r) => r.path), last(mixed).unknown_routes.map((r) => r.path),
    ], 'ACCESS-PREFLIGHT-UNKNOWN').toEqual([
      1, [':ismeretlen /api/tasks', ':ismeretlen'], ['acrobot POST :ismeretlen /api/kanban'],
      1, false, true,
      true,
      1, [],
      1, ['/api/approvals/:id'], [':ismeretlen /api/kanban'],
    ])
  }, 60_000) // four tsx starts

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
