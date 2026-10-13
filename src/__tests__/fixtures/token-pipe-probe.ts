// The pipe way of issue-agent-token.ts, with the CLI's own writer
// (writeToPipe on the real process.stdout), against a throwaway database:
//   tsx token-pipe-probe.ts <db> <root> <delay-ms>
// Waits <delay-ms> first, so the parent can close its end of the pipe. Says
// on stderr what happened: `issued <id>` or `rejected <code>`, exit 0 or 3.
import Database from 'better-sqlite3'

import { ensurePrincipalSchema } from '../../web/auth-principals.js'
import { issueAgentTokenToPipe, writeToPipe } from '../../web/agent-token-issue.js'

const [dbPath, root, delay] = process.argv.slice(2)
const db = new Database(dbPath!)
ensurePrincipalSchema(db)
await new Promise((resolve) => setTimeout(resolve, Number(delay)))
try {
  const r = await issueAgentTokenToPipe(db, {
    root: root!,
    agent: 'scout',
    now: 1_800_000_000,
    apply: true,
    out: { isTty: process.stdout.isTTY === true, write: (text) => writeToPipe(process.stdout, text) },
  })
  process.stderr.write(`issued ${r.id}\n`)
} catch (error) {
  process.stderr.write(`rejected ${(error as NodeJS.ErrnoException).code ?? String(error)}\n`)
  process.exitCode = 3
}
