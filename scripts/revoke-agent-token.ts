// Takes one agent's own dashboard token away (acrovelIQ P0-1, plan 5.2; the
// pair of issue-agent-token.ts):
//   npx tsx scripts/revoke-agent-token.ts <agent>           dry run
//   npx tsx scripts/revoke-agent-token.ts <agent> --apply   revoke
// Every active principal_tokens row of the agent gets revoked_at, then
// store/tokens/<agent>.token is removed. Its helpers fall back to the shared
// token, loudly. The token is never printed.
//
//   npx tsx scripts/revoke-agent-token.ts <agent> --apply --db-only
// The pipe way's pair (the P0-1 step sheet, L2): the install's owner revokes
// the rows; the file, in root's store/tokens, is root's to remove with rm.
import { PROJECT_ROOT } from '../src/config.js'
import { getDb, initDatabase } from '../src/db.js'
import { revokeAgentToken } from '../src/web/agent-token-issue.js'

const args = process.argv.slice(2)
const agent = args.find((a) => !a.startsWith('--'))
const apply = args.includes('--apply')
const dbOnly = args.includes('--db-only')
if (!agent || args.some((a) => a.startsWith('--') && a !== '--apply' && a !== '--db-only')) {
  console.error('usage: revoke-agent-token.ts <agent> [--apply] [--db-only]')
  process.exit(2)
}

initDatabase()
const r = revokeAgentToken(getDb(), { root: PROJECT_ROOT, agent, now: Math.floor(Date.now() / 1000), apply, dbOnly })
const rows = r.ids.length ? `rows ${r.ids.join(', ')}` : 'no active row'
const file = r.file ? r.path : 'no token file'
const fileStep = dbOnly
  ? (r.file ? `kept ${file}: root removes it (rm -f)` : 'no token file')
  : `${r.status === 'revoked' ? 'removed' : 'would remove'} ${file}`
console.log(
  r.status === 'revoked'
    ? `revoked: ${r.agent}: ${rows}; ${fileStep}`
    : `dry run: would revoke ${r.agent}: ${rows}; ${fileStep}; add --apply`,
)
