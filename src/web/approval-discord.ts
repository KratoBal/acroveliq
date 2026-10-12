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
//   - its author is one of the configured Discord users (the owner),
//   - it is exactly `<yes|no> <code>` for a code that is still pending,
//   - the approval has not timed out.
// The code is one-time by construction: it matches pending rows only, and the
// decision makes the row non-pending in the same UPDATE. It is bound to one
// approval, so to one action. The decision is recorded as the configured
// session user (S in the access matrix) with the Discord message as evidence.
//
// Off unless the channel, the users and the decider are all set: merging this
// changes nothing on a running install.
import { randomInt } from 'node:crypto'

import {
  APPROVAL_DISCORD_CHANNEL_ID,
  APPROVAL_DISCORD_DECIDER,
  APPROVAL_DISCORD_NO,
  APPROVAL_DISCORD_POLL_SECONDS,
  APPROVAL_DISCORD_USER_IDS,
  APPROVAL_DISCORD_YES,
} from '../config.js'
import {
  pendingDiscordApprovals,
  resolveApprovalWithRef,
  setApprovalDiscordCode,
  type Approval,
} from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

export interface ApprovalDiscordConfig {
  channelId: string
  userIds: readonly string[]
  decider: string
  yes: string
  no: string
  pollSeconds: number
}

export function approvalDiscordConfig(): ApprovalDiscordConfig {
  return {
    channelId: APPROVAL_DISCORD_CHANNEL_ID,
    userIds: APPROVAL_DISCORD_USER_IDS,
    decider: APPROVAL_DISCORD_DECIDER,
    yes: APPROVAL_DISCORD_YES,
    no: APPROVAL_DISCORD_NO,
    pollSeconds: APPROVAL_DISCORD_POLL_SECONDS,
  }
}

/** On only when all three are set; a half setting must not decide anything. */
export function approvalDiscordEnabled(cfg: ApprovalDiscordConfig): boolean {
  return Boolean(cfg.channelId && cfg.userIds.length && cfg.decider)
}

// No 0/O, 1/I/L: a code read off a phone must not be ambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 4

export function newApprovalCode(taken: ReadonlySet<string>, pick: (n: number) => number = randomInt): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[pick(CODE_ALPHABET.length)]
    if (!taken.has(code)) return code
  }
  throw new Error('no free approval code after 100 attempts')
}

export interface ParsedDecision {
  status: 'approved' | 'rejected'
  code: string
}

/**
 * The whole message must be `<yes|no> <code>`, nothing else: a sentence that
 * happens to contain the word and a code does not decide. Case and the
 * surrounding whitespace do not matter.
 */
export function parseDecision(text: string, cfg: Pick<ApprovalDiscordConfig, 'yes' | 'no'>): ParsedDecision | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const [word, rawCode] = [parts[0]!.toLowerCase(), parts[1]!.toUpperCase()]
  if (rawCode.length !== CODE_LENGTH || [...rawCode].some((c) => !CODE_ALPHABET.includes(c))) return null
  if (word === cfg.yes) return { status: 'approved', code: rawCode }
  if (word === cfg.no) return { status: 'rejected', code: rawCode }
  return null
}

export interface DiscordMessage {
  id: string
  content: string
  author: { id: string; bot?: boolean }
}

export interface MatchedDecision {
  approvalId: string
  status: 'approved' | 'rejected'
  messageId: string
  authorId: string
}

/**
 * Which messages decide which approval. Pure. Oldest first, and one decision
 * per approval: a second reply to the same code finds the row decided.
 */
export function matchDecisions(
  messages: readonly DiscordMessage[],
  pending: readonly Pick<Approval, 'id' | 'discord_code' | 'timeout_at'>[],
  cfg: Pick<ApprovalDiscordConfig, 'userIds' | 'yes' | 'no'>,
  nowSeconds: number,
): MatchedDecision[] {
  const byCode = new Map(
    pending.filter((a) => a.discord_code).map((a) => [a.discord_code!.toUpperCase(), a]),
  )
  const decided = new Set<string>()
  const out: MatchedDecision[] = []
  const oldestFirst = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  for (const m of oldestFirst) {
    if (m.author.bot || !cfg.userIds.includes(m.author.id)) continue
    const parsed = parseDecision(m.content, cfg)
    if (!parsed) continue
    const approval = byCode.get(parsed.code)
    if (!approval || decided.has(approval.id)) continue
    if (approval.timeout_at != null && approval.timeout_at <= nowSeconds) continue
    decided.add(approval.id)
    out.push({ approvalId: approval.id, status: parsed.status, messageId: m.id, authorId: m.author.id })
  }
  return out
}

/** The request as the owner reads it on Discord. Plain text, outgoing copy. */
export function buildDiscordApprovalText(approval: Approval, code: string, cfg: Pick<ApprovalDiscordConfig, 'yes' | 'no'>): string {
  const expires = approval.timeout_at
    ? new Date(approval.timeout_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
    : 'nincs'
  return [
    `[JÓVÁHAGYÁS KELL] ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    `Lejárat: ${expires}`,
    `Válasz: \`${cfg.yes} ${code}\` vagy \`${cfg.no} ${code}\` (csak ez a két alak dönt)`,
  ].join('\n')
}

export interface DiscordTransport {
  send(channelId: string, text: string): Promise<void>
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
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(TOOL_TIMEOUTS['discord']),
      })
      if (!resp.ok) throw new Error(`Discord API ${resp.status}`)
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

/** A Discord snowflake for a moment: the poll starts this far back. */
export function snowflakeAt(ms: number): string {
  const DISCORD_EPOCH = 1420070400000n
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString()
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
  const taken = new Set(pendingDiscordApprovals().map((a) => (a.discord_code ?? '').toUpperCase()))
  const code = newApprovalCode(taken)
  setApprovalDiscordCode(approval.id, code)
  try {
    await transport.send(cfg.channelId, buildDiscordApprovalText(approval, code, cfg))
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
