// scripts/legacy-callers.ts, run for real on a throwaway database. WHAT TURNS
// THIS RED: a shared-token call recorded by the server not listed with its
// hints; an old day listed inside the window; an empty list that does not say
// which database it read or that it holds no row at all.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { callerHint, ensurePrincipalSchema, recordRequestActor } from '../web/auth-principals.js'

const root = mkdtempSync(join(tmpdir(), 'legacy-callers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const list = (db: string, ...args: string[]) => {
  const r = spawnSync('npx', ['tsx', join(process.cwd(), 'scripts', 'legacy-callers.ts'), '--db', db, ...args], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('the legacy caller list', () => {
  it('LEGACY-CALLERS: lists the shared-token calls in the window with their hints, newest first', () => {
    const file = join(root, 'a.db')
    const db = new Database(file)
    ensurePrincipalSchema(db)
    const now = Math.floor(Date.now() / 1000)
    // written the way the server writes them
    recordRequestActor(db, { kind: 'token' }, 'POST', '/api/messages', now - 2, callerHint({ userAgent: 'curl/8.5.0', fleetCaller: 'channels-sh-guard', remoteAddress: '127.0.0.1' }))
    recordRequestActor(db, { kind: 'token' }, 'GET', '/api/kanban', now - 1, callerHint({ userAgent: 'python-urllib/3.11' }))
    recordRequestActor(db, { kind: 'token' }, 'GET', '/api/agents', now - 5 * 86400, callerHint({ userAgent: 'node' }))
    db.close()
    const day = list(file)
    const week = list(file, '--napok', '7')
    const json = list(file, '--json')
    const lines = (out: string) => out.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.replace(/^ {2}\S+ \S+ {2}/, ''))
    expect([day.code, lines(day.out), lines(week.out).length, (JSON.parse(json.out) as { rows: unknown[] }).rows.length], 'LEGACY-CALLERS').toEqual([
      0,
      [
        'GET    /api/kanban  1x  ua=python-urllib/3.11 nev=- cim=-',
        'POST   /api/messages  1x  ua=curl/8.5.0 nev=channels-sh-guard cim=127.0.0.1',
      ],
      3,
      2,
    ])
  })

  it('LEGACY-CALLERS-EMPTY: an empty list names the database and says it holds no row', () => {
    const file = join(root, 'b.db')
    const db = new Database(file)
    ensurePrincipalSchema(db)
    db.close()
    const r = list(file)
    expect([r.code, r.out.includes(`adatbázis: ${file}; legutóbbi sor: nincs`), r.out.includes('nincs közös tokenes hívás')], 'LEGACY-CALLERS-EMPTY').toEqual([0, true, true])
  })
})
