// The approval decided on the server from a Discord reply (acrovelIQ P0-1,
// PR 4; barracuda's review of #22, 28633: the enforcing mode cannot switch on
// while the decision still goes through a language model).
//
// TODAY a request reaches the owner on Telegram, he answers on Discord, the
// Discord plugin hands the answer to the main agent's session, and the main
// agent turns it into `PATCH /api/approvals/:id`. The server never sees the
// owner's words: a model does, and writes down what it understood.
//
// HERE the server posts the request to a Discord channel itself, with a code
// bound to that approval, and reads the channel back over REST (no gateway, so
// it does not compete with the plugin's connection). A reply decides only if
//   - its author is one of the configured Discord users (the owner), not a bot,
//   - it is exactly `<yes|no> <code>` for a code that is still pending,
//   - it is a Discord reply to that request's own message (on by default:
//     the owner answers what he READ, and a code shown elsewhere, for example
//     inside another agent's request text, cannot be used; barracuda #33),
//   - it was written after the request was created (an old answer read back
//     after a restart cannot decide a new request; barracuda #33),
//   - the approval has not timed out.
// A code is never given out twice, not even after its decision.
// The requesting agent's text goes out neutralised: one quoted line, no
// backticks, no mentions (`allowed_mentions` empty), with the code line first.
// The code is one-time by construction: it matches pending rows only, and the
// decision makes the row non-pending in the same UPDATE. It is bound to one
// approval, so to one action. The decision is recorded as the configured
// session user (S in the access matrix) with the Discord message as evidence.
//
// Off unless the channel, the users and the decider are all set: merging this
// changes nothing on a running install.
import {
  APPROVAL_DISCORD_CHANNEL_ID,
  APPROVAL_DISCORD_DECIDER,
  APPROVAL_DISCORD_NO,
  APPROVAL_DISCORD_POLL_SECONDS,
  APPROVAL_DISCORD_REQUIRE_REPLY,
  APPROVAL_DISCORD_USER_IDS,
  APPROVAL_DISCORD_YES,
} from '../config.js'
import {
  pendingDiscordApprovals,
  resolveApprovalWithRef,
  setApprovalDiscordCode,
  setApprovalDiscordMessageId,
  usedDiscordCodes,
  type Approval,
} from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'
import {
  buildDiscordApprovalText,
  matchDecisions,
  newApprovalCode,
  snowflakeAt,
  type DiscordMessage,
  type MatchedDecision,
} from './approval-discord-core.js'

// The pure half lives in approval-discord-core.ts (the deploy executor reads
// Discord back with the same code); re-exported so no caller changes.
export {
  buildDiscordApprovalText,
  CODE_ALPHABET,
  CODE_LENGTH,
  DESCRIPTION_MAX,
  formatApprovalExpiry,
  matchDecisions,
  neutralDescription,
  newApprovalCode,
  parseDecision,
  snowflakeAt,
  snowflakeMs,
  type DiscordMessage,
  type MatchedDecision,
  type ParsedDecision,
} from './approval-discord-core.js'

export interface ApprovalDiscordConfig {
  channelId: string
  userIds: readonly string[]
  decider: string
  yes: string
  no: string
  pollSeconds: number
  requireReply: boolean
}

export function approvalDiscordConfig(): ApprovalDiscordConfig {
  return {
    channelId: APPROVAL_DISCORD_CHANNEL_ID,
    userIds: APPROVAL_DISCORD_USER_IDS,
    decider: APPROVAL_DISCORD_DECIDER,
    yes: APPROVAL_DISCORD_YES,
    no: APPROVAL_DISCORD_NO,
    pollSeconds: APPROVAL_DISCORD_POLL_SECONDS,
    requireReply: APPROVAL_DISCORD_REQUIRE_REPLY,
  }
}

/** On only when all three are set; a half setting must not decide anything. */
export function approvalDiscordEnabled(cfg: ApprovalDiscordConfig): boolean {
  return Boolean(cfg.channelId && cfg.userIds.length && cfg.decider)
}

export interface DiscordTransport {
  /** Returns the posted message's id. */
  send(channelId: string, text: string): Promise<string>
  /** Messages after `afterId`, at most 100, in any order. */
  read(channelId: string, afterId: string): Promise<DiscordMessage[]>
}

export function restTransport(token: string, fetchImpl: typeof fetch = fetch): DiscordTransport {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${token}` }
  return {
    async send(channelId, text) {
      const resp = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers,
        // no mention in the request text may ping anyone (barracuda #33)
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TOOL_TIMEOUTS['discord']),
      })
      if (!resp.ok) throw new Error(`Discord API ${resp.status}`)
      return ((await resp.json()) as { id: string }).id
    },
    async read(channelId, afterId) {
      const resp = await fetchImpl(
        `https://discord.com/api/v10/channels/${channelId}/messages?after=${afterId}&limit=100`,
        { headers, signal: AbortSignal.timeout(TOOL_TIMEOUTS['discord']) },
      )
      if (!resp.ok) throw new Error(`Discord API ${resp.status}`)
      return (await resp.json()) as DiscordMessage[]
    },
  }
}

/** The live transport, with the Discord bot token read at call time; null without a token. */
export function discordTransportFromEnv(): DiscordTransport | null {
  const token = (readEnvFile()['DISCORD_BOT_TOKEN'] ?? '').trim()
  return token ? restTransport(token) : null
}

/**
 * Give a new approval its code and post it. Fire-and-forget at the call site,
 * like the Telegram notice: a failed post must not fail the request, but it is
 * logged loudly, because then only the dashboard can decide it.
 */
export async function postApprovalToDiscord(
  approval: Approval,
  transport: DiscordTransport,
  cfg: ApprovalDiscordConfig,
): Promise<string | null> {
  if (!approvalDiscordEnabled(cfg)) return null
  const code = newApprovalCode(usedDiscordCodes())
  setApprovalDiscordCode(approval.id, code)
  try {
    const messageId = await transport.send(cfg.channelId, buildDiscordApprovalText(approval, code, cfg))
    // the reply must point at this message (requireReply)
    setApprovalDiscordMessageId(approval.id, messageId)
    logger.info({ approvalId: approval.id }, 'approval posted to Discord with its code')
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'approval Discord post FAILED -- only the dashboard can decide it')
  }
  return code
}

/**
 * One poll: read the channel after `afterId`, decide what matches, and return
 * the newest message id seen (the next poll starts there).
 */
export async function pollApprovalDecisions(
  transport: DiscordTransport,
  cfg: ApprovalDiscordConfig,
  afterId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ afterId: string; decided: MatchedDecision[] }> {
  const messages = await transport.read(cfg.channelId, afterId)
  const newest = messages.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), afterId)
  const matches = matchDecisions(messages, pendingDiscordApprovals(), cfg, nowSeconds)
  const decided: MatchedDecision[] = []
  for (const m of matches) {
    const ref = `discord:${cfg.channelId}/${m.messageId}/${m.authorId}`
    if (resolveApprovalWithRef(m.approvalId, m.status, cfg.decider, ref)) {
      decided.push(m)
      logger.info({ approvalId: m.approvalId, status: m.status, ref }, 'approval decided from Discord')
    }
  }
  return { afterId: newest, decided }
}

export function startApprovalDiscordPoller(
  transport: DiscordTransport,
  cfg: ApprovalDiscordConfig = approvalDiscordConfig(),
): NodeJS.Timeout | null {
  if (!approvalDiscordEnabled(cfg)) {
    logger.info('approval Discord decisions off (APPROVAL_DISCORD_CHANNEL_ID, _USER_IDS, _DECIDER not all set)')
    return null
  }
  // a day back: an answer given before a restart to a still pending request counts
  let afterId = snowflakeAt(Date.now() - 24 * 3600 * 1000)
  let running = false
  return setInterval(() => {
    if (running) return
    running = true
    pollApprovalDecisions(transport, cfg, afterId)
      .then((r) => { afterId = r.afterId })
      .catch((err) => logger.warn({ err }, 'approval Discord poll failed; the next one retries'))
      .finally(() => { running = false })
  }, cfg.pollSeconds * 1000)
}
