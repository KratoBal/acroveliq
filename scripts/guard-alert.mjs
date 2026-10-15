#!/usr/bin/env node
// The channels.sh guard's alert to the main agent, written server-side.
//
// Why (task channels-guard-riasztas, 2026-10-15): the guard posted to /api/messages with the shared
// token and from=channels-sh-guard. That route refuses a sender that is no registered agent (the
// shared token is readable by every sub-agent, so the route must not take its word for a name),
// and the alert never arrived: "WARN guard alert POST failed (HTTP 403)" at 07:30:44 and 09:17:41,
// the two boots that fell to the shared ~/.claude. channels.sh runs as the router user, the one
// that owns the database, so it writes the message the way the dashboard's own server-side
// senders do (the quota gate's notice, the debate controller): one row in agent_messages, which
// the message router delivers. The main agent reads it in an untrusted envelope, as data.
//
// Usage: printf '%s' "<text>" | node scripts/guard-alert.mjs <to-agent>
// Prints "OK id=<n>" and exits 0, or says why and exits 1 (2 for a bad call).
// GUARD_ALERT_DB_PATH overrides the database (tests).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const to = process.argv[2] ?? ''
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(to)) {
  process.stderr.write('guard-alert: usage: printf TEXT | node scripts/guard-alert.mjs <to-agent>\n')
  process.exit(2)
}
const text = readFileSync(0, 'utf-8').trim()
if (!text) {
  process.stderr.write('guard-alert: empty text on stdin\n')
  process.exit(2)
}
const dbPath = process.env.GUARD_ALERT_DB_PATH || join(HERE, '..', 'store', 'claudeclaw.db')
try {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  // the same columns createAgentMessage (src/db.ts) writes; a test reads the row back through it
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('channels-sh-guard', to, text, 'pending', Math.floor(Date.now() / 1000))
  db.close()
  process.stdout.write(`OK id=${Number(info.lastInsertRowid)}\n`)
} catch (err) {
  process.stderr.write(`guard-alert: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
