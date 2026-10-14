// Többmodelles V1, PR 1: the debate controller's Discord side (src/debates.ts holds the logic).
//
// The controller reads the allowed threads over REST, the way the approval path reads its
// channel (src/web/approval-discord.ts), and posts through the same transport, which sends no
// mention (`allowed_mentions: { parse: [] }`). It takes only the OWNER's messages (a configured
// Discord user, not a bot): an approval request, Acrobot's own report or anyone else's message in
// the thread is not the debate (barracuda 30721). Off unless DEBATE_DISCORD_THREADS is set and a
// bot token is there. GPT's runner comes from src/gpt-runner-client.ts: null (its turn skipped
// and said so) unless the switch is on AND the conversation package with its filters exists (PR 2).

import {
  APPROVAL_DISCORD_USER_IDS,
  DEBATE_DISCORD_THREADS,
  DEBATE_GPT_DAILY_CAP,
  DEBATE_GPT_RUNNER_ENABLED,
  DEBATE_GPT_RUNNER_TIMEOUT_SECONDS,
  DEBATE_GPT_RUNNER_TOKEN_FILE,
  DEBATE_GPT_RUNNER_URL,
  DEBATE_OWNER_IDS,
  DEBATE_PHASE_TIMEOUT_SECONDS,
  DEBATE_POLL_SECONDS,
  DEBATE_TURN_TIMEOUT_SECONDS,
  MAIN_AGENT_ID,
} from '../config.js'
import { createAgentMessage, getDb } from '../db.js'
import { handleOwnerMessage, sweepDebates, type DebateConfig, type DebateDeps } from '../debates.js'
import { GPT_FILTERS, makeRunGpt } from '../gpt-runner-client.js'
import { logger } from '../logger.js'
import { snowflakeAt } from './approval-discord-core.js'
import type { DiscordTransport } from './approval-discord.js'
import type Database from 'better-sqlite3'

export function debateConfig(): DebateConfig {
  return {
    threads: DEBATE_DISCORD_THREADS,
    ownerIds: DEBATE_OWNER_IDS.length ? DEBATE_OWNER_IDS : APPROVAL_DISCORD_USER_IDS,
    turnTimeoutSeconds: DEBATE_TURN_TIMEOUT_SECONDS,
    phaseTimeoutSeconds: DEBATE_PHASE_TIMEOUT_SECONDS,
    gptDailyCap: DEBATE_GPT_DAILY_CAP,
  }
}

// decided once per process: the switch, the address and the filters do not change while it runs,
// and the reason it stays off is said once, not at every hand-in
let runGptOnce: DebateDeps['runGpt'] | undefined
function runGpt(): DebateDeps['runGpt'] {
  if (runGptOnce === undefined) {
    runGptOnce = makeRunGpt({
      enabled: DEBATE_GPT_RUNNER_ENABLED,
      url: DEBATE_GPT_RUNNER_URL,
      tokenFile: DEBATE_GPT_RUNNER_TOKEN_FILE,
      timeoutMs: DEBATE_GPT_RUNNER_TIMEOUT_SECONDS * 1000,
      filters: GPT_FILTERS,
      log: (line) => logger.warn(line),
    })
  }
  return runGptOnce
}

export function debateDeps(transport: DiscordTransport): DebateDeps {
  return {
    post: (threadId, text) => transport.send(threadId, text),
    // the controller gives Acrobot the floor as an ordinary inter-agent message
    tellAcrobot: (content) => createAgentMessage('vita', MAIN_AGENT_ID, content).id,
    runGpt: runGpt(),
    now: () => Math.floor(Date.now() / 1000),
  }
}

/**
 * One pass: each allowed thread from its cursor (the first pass starts at now, an old message is
 * not a command), the owner's new messages in order, then the clocks.
 */
export async function pollDebates(db: Database.Database, transport: DiscordTransport, deps: DebateDeps, cfg: DebateConfig): Promise<void> {
  for (const threadId of cfg.threads) {
    const row = db.prepare('SELECT after_id FROM debate_cursors WHERE thread_id = ?').get(threadId) as { after_id: string } | undefined
    if (!row) {
      db.prepare('INSERT INTO debate_cursors (thread_id, after_id) VALUES (?, ?)').run(threadId, snowflakeAt(deps.now() * 1000))
      continue
    }
    const messages = await transport.read(threadId, row.after_id)
    const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    for (const m of ordered) {
      // the cursor moves first: a message that throws is not retried forever
      db.prepare('UPDATE debate_cursors SET after_id = ? WHERE thread_id = ?').run(m.id, threadId)
      if (m.author.bot || !cfg.ownerIds.includes(m.author.id) || !m.content.trim()) continue
      await handleOwnerMessage(db, deps, cfg, threadId, { id: m.id, content: m.content }, m.author.id)
    }
  }
  await sweepDebates(db, deps, cfg)
}

export function startDebatePoller(transport: DiscordTransport, cfg: DebateConfig = debateConfig()): NodeJS.Timeout | null {
  if (!cfg.threads.length || !cfg.ownerIds.length) {
    logger.info('debate controller off (DEBATE_DISCORD_THREADS or the owner ids not set)')
    return null
  }
  const deps = debateDeps(transport)
  let running = false
  return setInterval(() => {
    if (running) return
    running = true
    pollDebates(getDb(), transport, deps, cfg)
      .catch((err) => logger.warn({ err }, 'debate poll failed; the next one retries'))
      .finally(() => { running = false })
  }, DEBATE_POLL_SECONDS * 1000)
}
