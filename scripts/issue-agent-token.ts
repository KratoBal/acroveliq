// Hands one agent its own dashboard token (acrovelIQ P0-1, plan step 5.2):
//   npx tsx scripts/issue-agent-token.ts <agent> [--expires-days N]          dry run
//   npx tsx scripts/issue-agent-token.ts <agent> [--expires-days N] --apply  issue
// Run by the install's operator (chown needs it). The agent's OS user is its
// `runAsUser`; the main agent's is the install's owner. The token is written to
// store/tokens/<agent>.token only, never printed.
//
//   npx tsx scripts/issue-agent-token.ts <agent> [--expires-days N] --apply --stdout
// The pipe way (the P0-1 step sheet, L2): run as the install's owner, the row
// is written and the token goes to stdout, which must be a pipe into root's
// base-system step that places the file; nothing goes to a terminal. Every
// message then goes to stderr, so the pipe carries the token alone.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { MAIN_AGENT_ID, PROJECT_ROOT } from '../src/config.js'
import { getDb, initDatabase } from '../src/db.js'
import { readAgentRunAsUser } from '../src/web/agent-config.js'
import { issueAgentToken, issueAgentTokenToPipe } from '../src/web/agent-token-issue.js'

const args = process.argv.slice(2)
const agent = args.find((a) => !a.startsWith('--'))
const apply = args.includes('--apply')
const toStdout = args.includes('--stdout')
const daysAt = args.indexOf('--expires-days')
const expiresInDays = daysAt >= 0 ? Number(args[daysAt + 1]) : undefined
if (!agent || (expiresInDays !== undefined && !(expiresInDays > 0))) {
  console.error('usage: issue-agent-token.ts <agent> [--expires-days N] [--apply] [--stdout]')
  process.exit(2)
}

function ownerOf(name: string): { uid: number; gid: number; user: string } {
  const runAs = name === MAIN_AGENT_ID ? null : readAgentRunAsUser(name)
  if (runAs) {
    const uid = Number(execFileSync('id', ['-u', runAs]).toString().trim())
    const gid = Number(execFileSync('id', ['-g', runAs]).toString().trim())
    return { uid, gid, user: runAs }
  }
  if (name !== MAIN_AGENT_ID) {
    console.error(`${name} has no runAsUser: it runs as the install's owner, so its own token would be no gate`)
    process.exit(2)
  }
  const st = statSync(join(PROJECT_ROOT, 'store'))
  return { uid: st.uid, gid: st.gid, user: `uid ${st.uid}` }
}

const owner = ownerOf(agent)
initDatabase()
if (toStdout) {
  const piped = issueAgentTokenToPipe(getDb(), {
    root: PROJECT_ROOT,
    agent,
    expiresInDays,
    now: Math.floor(Date.now() / 1000),
    apply,
    out: { isTty: process.stdout.isTTY === true, write: (text) => { process.stdout.write(text) } },
  })
  console.error(
    piped.status === 'issued'
      ? `issued to the pipe: ${piped.agent}, principal_tokens id ${piped.id}; root places it at ${piped.path} (0400, ${owner.user})`
      : `dry run: would issue ${piped.agent} to the pipe, for ${piped.path} (0400, ${owner.user}); add --apply`,
  )
} else {
  const result = issueAgentToken(getDb(), {
    root: PROJECT_ROOT,
    agent,
    owner: { uid: owner.uid, gid: owner.gid },
    expiresInDays,
    now: Math.floor(Date.now() / 1000),
    apply,
  })
  console.log(
    result.status === 'issued'
      ? `issued: ${result.agent} -> ${result.path} (0400, ${owner.user}), principal_tokens id ${result.id}`
      : `dry run: would issue ${result.agent} -> ${result.path} (0400, ${owner.user}); add --apply`,
  )
}
