#!/usr/bin/env tsx
// ANSWERS: Ki hívja még a vezérlőpultot a régi közös tokennel, és melyik útvonalon?
//
//   npx tsx scripts/legacy-callers.ts                  # az elmúlt 1 nap
//   npx tsx scripts/legacy-callers.ts --napok 7
//   npx tsx scripts/legacy-callers.ts --db /utvonal/masik.db   # another database (tests)
//   npx tsx scripts/legacy-callers.ts --json           # one JSON line, for a machine
//
// The P0-1 deployment steps, point 4: the residual shared-token calls by name.
// request_actors says only `legacy` for them; legacy_callers (src/web/auth-
// principals.ts) keeps three hints per call: the User-Agent's product token,
// a self-declared name (X-Fleet-Caller header or the `agent` query) and the
// remote address. A hint is not an identity: the shared token proves no name.
// `?` is a value that did not fit its pattern, `-` a missing one.
//
// The database name and the newest row are printed too: an empty list alone
// cannot tell "no shared-token call" from "nothing logged" (an older build
// without the table, or another database). Reads only; exit 0.

import { initDatabase, getDb } from '../src/db.js'
import { localDay } from '../src/web/auth-principals.js'

interface Row { method: string; path: string; ua: string; claimed: string; remote: string; count: number; first_seen: number; last_seen: number }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const days = Number(arg('--napok', '1'))
if (!Number.isInteger(days) || days < 1) {
  process.stderr.write('Használat: legacy-callers.ts [--napok N] [--db UTVONAL] [--json]\n')
  process.exit(2)
}

initDatabase(arg('--db', '') || undefined)
const since = localDay(Math.floor(Date.now() / 1000) - (days - 1) * 86400)
const rows = getDb()
  .prepare(
    `SELECT method, path, ua, claimed, remote, SUM(count) AS count, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
     FROM legacy_callers WHERE day >= ?
     GROUP BY method, path, ua, claimed, remote ORDER BY last_seen DESC`,
  )
  .all(since) as Row[]
const newest = (getDb().prepare('SELECT MAX(last_seen) AS t FROM legacy_callers').get() as { t: number | null }).t

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ since, rows, database: getDb().name, newest }))
  process.exit(0)
}
const at = (t: number) => new Date(t * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Budapest' })
console.log(`adatbázis: ${getDb().name}; legutóbbi sor: ${newest == null ? 'nincs' : at(newest)}`)
if (rows.length === 0) {
  console.log(`nincs közös tokenes hívás ${since} óta`)
  process.exit(0)
}
console.log(`${rows.length} hívó-útvonal pár ${since} óta (legutóbbi elöl):`)
for (const r of rows) {
  console.log(`  ${at(r.last_seen)}  ${r.method.padEnd(6)} ${r.path}  ${r.count}x  ua=${r.ua} nev=${r.claimed} cim=${r.remote}`)
}
