#!/usr/bin/env tsx
// ANSWERS: Mit tiltana a vezérlőpult, ha az ACCESS_MODE-ot most átállítanám?
//
//   npx tsx scripts/access-preflight.ts                         # kikenyszerit, az elmúlt 1 nap
//   npx tsx scripts/access-preflight.ts --mode legacy-szukitett --napok 3
//   npx tsx scripts/access-preflight.ts --db /utvonal/masik.db           # another database (tests)
//   npx tsx scripts/access-preflight.ts --json                            # one JSON line, for a machine
//                                                                         # (scripts/access-preflight-napi.py)
//
// The access check logs every denial, enforced or not, in access_decisions
// (src/web/access-enforcement.ts). This lists the logged-only ones
// (`would-deny`) the given mode would enforce, from the last N days: in
// legacy-szukitett only the old shared token's, in kikenyszerit every
// caller's except the session. Denials already enforced are not new. Exit 1 while
// the list holds anything (barracuda, #22: the switch does not turn until it
// is empty), 0 when it is empty. Reads only.

import { initDatabase, getDb } from '../src/db.js'
import { localDay } from '../src/web/auth-principals.js'

interface Row { day: string; actor: string; method: string; path: string; reason: string; count: number }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const mode = arg('--mode', 'kikenyszerit')
const days = Number(arg('--napok', '1'))
if (!['kikenyszerit', 'legacy-szukitett'].includes(mode) || !Number.isInteger(days) || days < 1) {
  process.stderr.write('Használat: access-preflight.ts [--mode kikenyszerit|legacy-szukitett] [--napok N]\n')
  process.exit(2)
}

const dbPath = arg('--db', '')
initDatabase(dbPath || undefined)
const since = localDay(Math.floor(Date.now() / 1000) - (days - 1) * 86400)
const rows = getDb()
  .prepare(
    `SELECT day, actor, method, path, reason, SUM(count) AS count FROM access_decisions
     WHERE day >= ? AND outcome = 'would-deny' AND actor NOT LIKE 'session:%' ${mode === 'legacy-szukitett' ? "AND actor = 'legacy'" : ''}
     GROUP BY actor, method, path ORDER BY actor, path, method`,
  )
  .all(since) as Row[]

// The daily run reads this, not the text: a text format is for a person and may change.
// `database` and `newest` are the heartbeat (barracuda, #102): access_decisions holds only
// denials, so an empty list alone cannot tell "nothing denied" from "nothing logged" (the
// check off, or another database: a missing file is created empty by the open).
if (process.argv.includes('--json')) {
  const newest = (getDb().prepare('SELECT MAX(last_seen) AS t FROM access_decisions').get() as { t: number | null }).t
  console.log(JSON.stringify({ mode, since, rows, database: getDb().name, newest }))
  process.exit(rows.length === 0 ? 0 : 1)
}
if (rows.length === 0) {
  console.log(`${mode}: nincs tiltandó hívás ${since} óta. A kapcsoló ebből a szempontból átállítható.`)
  process.exit(0)
}
console.log(`${mode}: ${rows.length} útvonal-szereplő pár kapna 403-at (${since} óta):`)
for (const r of rows) console.log(`  ${r.actor.padEnd(18)} ${r.method.padEnd(6)} ${r.path}  (${r.count}x; ${r.reason})`)
process.exit(1)
