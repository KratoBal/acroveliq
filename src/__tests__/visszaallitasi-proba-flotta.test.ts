// scripts/visszaallitasi-proba-flotta.py (card 1c3b73dc; acrobot 59582, 59585): the fleet branch of the weekly restore probe.
// WHAT TURNS THIS RED: a backup whose CONTENT is older than what the live database held at the file's time passing (the name
// alone carried the time before); a missing table skipped in silence; a quiet fleet (no message for two days) failing a good
// backup; a millisecond created_at misread; a file name without a time passing.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const SCRIPT = join(process.cwd(), 'scripts', 'visszaallitasi-proba-flotta.py')
const root = mkdtempSync(join(tmpdir(), 'proba-flotta-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const NAME = 'acrobot-fleet-2026-11-22_03-40-05.db.gz'
// the file's time in the local zone, as fleet-backup.sh names it and the checker reads it
const AT = Math.floor(new Date(2026, 10, 22, 3, 40, 5).getTime() / 1000)
const HOUR = 3600

let n = 0
/** A database with the four tables (and padding tables to reach ten), rows at the given created_at values per table. */
function db(rows: Partial<Record<'memories' | 'kanban_cards' | 'agent_messages' | 'daily_logs', number[]>>, skip: string[] = []): string {
  n += 1
  const file = join(root, `db${n}.sqlite`)
  const d = new Database(file)
  for (const t of ['memories', 'kanban_cards', 'agent_messages', 'daily_logs']) {
    if (skip.includes(t)) continue
    d.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)`)
    const ins = d.prepare(`INSERT INTO ${t} (created_at) VALUES (?)`)
    for (const at of rows[t as keyof typeof rows] ?? [AT - 5 * HOUR]) ins.run(at)
  }
  for (let i = 0; i < 8; i++) d.exec(`CREATE TABLE pad${i} (x INTEGER)`)
  d.close()
  return file
}
const check = (bak: string, live: string, name = NAME) => {
  const r = spawnSync('python3', [SCRIPT, bak, live, name], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('visszaallitasi-proba-flotta.py: the fleet backup is whole and as fresh as live was at its time', () => {
  it('a good backup: the newest rows reach what live held at the file time (live has newer rows after it): exit 0', () => {
    const bak = db({ agent_messages: [AT - 2 * HOUR, AT - 60], memories: [AT - 3 * HOUR] })
    const live = db({ agent_messages: [AT - 2 * HOUR, AT - 60, AT + 5 * HOUR], memories: [AT - 3 * HOUR, AT + HOUR] })
    const r = check(bak, live)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toMatch(/FAIL/)
  })

  it('stale content under a fresh name: the backup newest is three days behind what live held at the file time: FAIL', () => {
    const bak = db({ agent_messages: [AT - 72 * HOUR], memories: [AT - 3 * HOUR] })
    const live = db({ agent_messages: [AT - 72 * HOUR, AT - 30 * 60], memories: [AT - 3 * HOUR] })
    const r = check(bak, live)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/FAIL\[fleet\]: agent_messages: a mentes legfrissebb sora/)
  })

  it('a quiet fleet: no message for two days before the file time, the backup holds the same newest row: exit 0', () => {
    const quiet = AT - 48 * HOUR
    const bak = db({ agent_messages: [quiet], memories: [quiet] })
    const live = db({ agent_messages: [quiet, AT + 2 * HOUR], memories: [quiet] })
    expect(check(bak, live).code).toBe(0)
  })

  it('a missing table is a FAIL, not skipped', () => {
    const bak = db({}, ['daily_logs'])
    const live = db({})
    const r = check(bak, live)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/hianyzo tabla: daily_logs/)
  })

  it('created_at in milliseconds is read as such: a fresh one passes, a stale one fails', () => {
    const ms = (s: number) => s * 1000
    const live = db({ agent_messages: [ms(AT - 60)], memories: [ms(AT - 60)] })
    expect(check(db({ agent_messages: [ms(AT - 60)], memories: [ms(AT - 60)] }), live).code).toBe(0)
    expect(check(db({ agent_messages: [ms(AT - 72 * HOUR)], memories: [ms(AT - 60)] }), live).code).toBe(1)
  })

  it('more rows in the backup than live, or a file name without a time: FAIL', () => {
    const live = db({ agent_messages: [AT - 60] })
    expect(check(db({ agent_messages: [AT - 120, AT - 60] }), live).out).toMatch(/agent_messages sorszama gyanus/)
    expect(check(db({}), db({}), 'acrobot-fleet-nincs-ido.db.gz').out).toMatch(/nem olvashato ki az ido/)
  })
})
