// Takes one agent's own dashboard token away (acrovelIQ P0-1, plan 5.2; the
// pair of issue-agent-token.ts):
//   npx tsx scripts/revoke-agent-token.ts <agent>           dry run
//   npx tsx scripts/revoke-agent-token.ts <agent> --apply   revoke
// Every active principal_tokens row of the agent gets revoked_at, then
// store/tokens/<agent>.token is removed. Its helpers fall back to the shared
// token, loudly. The token is never printed.
import { PROJECT_ROOT } from '../src/config.js'
import { getDb, initDatabase } from '../src/db.js'
import { revokeAgentToken } from '../src/web/agent-token-issue.js'

const args = process.argv.slice(2)
const agent = args.find((a) => !a.startsWith('--'))
const apply = args.includes('--apply')
if (!agent || args.some((a) => a.startsWith('--') && a !== '--apply')) {
  console.error('usage: revoke-agent-token.ts <agent> [--apply]')
  process.exit(2)
}

initDatabase()
const r = revokeAgentToken(getDb(), { root: PROJECT_ROOT, agent, now: Math.floor(Date.now() / 1000), apply })
const rows = r.ids.length ? `rows ${r.ids.join(', ')}` : 'no active row'
const file = r.file ? r.path : 'no token file'
console.log(
  r.status === 'revoked'
    ? `revoked: ${r.agent}: ${rows}; removed ${file}`
    : `dry run: would revoke ${r.agent}: ${rows}; would remove ${file}; add --apply`,
)
