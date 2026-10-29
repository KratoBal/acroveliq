#!/usr/bin/env tsx
// ANSWERS: Mit tiltana a vezérlőpult, ha az ACCESS_MODE-ot most átállítanám?
//
//   npx tsx scripts/access-preflight.ts                         # kikenyszerit, az elmúlt 1 nap
//   npx tsx scripts/access-preflight.ts --mode legacy-szukitett --napok 3
//   npx tsx scripts/access-preflight.ts --db /utvonal/masik.db           # another database (tests)
//   npx tsx scripts/access-preflight.ts --json                            # one JSON line, for a machine
//                                                                         # (scripts/access-preflight-napi.py)
//   npx tsx scripts/access-preflight.ts --since-ts 1792300000             # every row seen at or after this
//                                                                         # epoch second, whatever its day
//
// --since-ts IS THE DAILY RUN'S WINDOW (task preflight-ablak, 2026-10-19): --napok counts calendar days,
// so the 07:30 run with --napok 1 read today only, and the previous day's rows after 07:30 reached no
// report (acrobot's two `:ismeretlen` would-deny rows of 10-16 12:43 and 14:14). The daily run now passes
// the start of its previous good run: a row is in the window when its last_seen is, so a row seen again
// after the previous run is reported, and one the previous run already reported in full is not.
//
// The access check logs every denial, enforced or not, in access_decisions
// (src/web/access-enforcement.ts). This lists the logged-only ones
// (`would-deny`) the given mode would enforce, from the last N days: in
// legacy-szukitett only the old shared token's, in kikenyszerit every
// caller's except the session. Denials already enforced are not new. Exit 1 while
// the list holds anything (barracuda, #22: the switch does not turn until it
// is empty), 0 when it is empty. Reads only.
//
// A ROUTE NO RULE ANSWERS (`:ismeretlen ...`) IS LISTED APART, AND DOES NOT HOLD THE SWITCH (task
// p01-preflight-ismeretlen-utvonalak, 2026-10-29). No handler serves it (the route inventory test
// turns red on a handler without a rule), so the call got a 404 before the switch and gets a 403
// after it: a caller's wrong path, not a hole in the matrix, and the switch breaks nothing that
// worked. It is shown, never dropped: `unknown_routes` in the JSON, its own block in the text.

import { initDatabase, getDb } from '../src/db.js'
import { localDay } from '../src/web/auth-principals.js'
import { isUnknownRouteKey } from '../src/web/route-match.js'

interface Row { day: string; actor: string; method: string; path: string; reason: string; count: number }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const mode = arg('--mode', 'kikenyszerit')
const days = Number(arg('--napok', '1'))
const sinceTsArg = arg('--since-ts', '')
const sinceTs = sinceTsArg === '' ? null : Number(sinceTsArg)
if (!['kikenyszerit', 'legacy-szukitett'].includes(mode) || !Number.isInteger(days) || days < 1
    || (sinceTs !== null && (!Number.isInteger(sinceTs) || sinceTs < 1))
    || (sinceTs !== null && process.argv.includes('--napok'))) {
  process.stderr.write('Használat: access-preflight.ts [--mode kikenyszerit|legacy-szukitett] [--napok N | --since-ts <epoch mp>]\n')
  process.exit(2)
}

const dbPath = arg('--db', '')
initDatabase(dbPath || undefined)
// the window: a calendar day (a person's --napok), or every row last seen at or after an epoch second
const since = sinceTs !== null
  ? new Date(sinceTs * 1000).toISOString()
  : localDay(Math.floor(Date.now() / 1000) - (days - 1) * 86400)
const logged = getDb()
  .prepare(
    `SELECT day, actor, method, path, reason, SUM(count) AS count FROM access_decisions
     WHERE ${sinceTs !== null ? 'last_seen >= ?' : 'day >= ?'} AND outcome = 'would-deny' AND actor NOT LIKE 'session:%' ${mode === 'legacy-szukitett' ? "AND actor = 'legacy'" : ''}
     GROUP BY actor, method, path ORDER BY actor, path, method`,
  )
  .all(sinceTs !== null ? sinceTs : since) as Row[]
const rows = logged.filter((r) => !isUnknownRouteKey(r.path))
const unknownRoutes = logged.filter((r) => isUnknownRouteKey(r.path))

// The daily run reads this, not the text: a text format is for a person and may change.
// `database` and `newest` are the heartbeat (barracuda, #102): access_decisions holds only
// denials, so an empty list alone cannot tell "nothing denied" from "nothing logged" (the
// check off, or another database: a missing file is created empty by the open).
if (process.argv.includes('--json')) {
  const newest = (getDb().prepare('SELECT MAX(last_seen) AS t FROM access_decisions').get() as { t: number | null }).t
  console.log(JSON.stringify({ mode, since, since_ts: sinceTs, rows, unknown_routes: unknownRoutes, database: getDb().name, newest }))
  process.exit(rows.length === 0 ? 0 : 1)
}
const line = (r: Row) => `  ${r.actor.padEnd(18)} ${r.method.padEnd(6)} ${r.path}  (${r.count}x; ${r.reason})`
if (rows.length === 0) {
  console.log(`${mode}: nincs tiltandó hívás ${since} óta. A kapcsoló ebből a szempontból átállítható.`)
} else {
  console.log(`${mode}: ${rows.length} útvonal-szereplő pár kapna 403-at (${since} óta):`)
  for (const r of rows) console.log(line(r))
}
if (unknownRoutes.length) {
  console.log(`Szabály nélküli út (${unknownRoutes.length} pár): nincs kezelője, a kapcsoló előtt is 404 volt; a hívó útja hibás, nem a mátrix hiánya:`)
  for (const r of unknownRoutes) console.log(line(r))
}
process.exit(rows.length === 0 ? 0 : 1)
