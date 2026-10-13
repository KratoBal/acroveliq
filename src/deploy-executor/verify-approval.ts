// The executor reads the owner's Discord answer back itself (SB1 plan 3.1
// step 7). The dashboard runs as the same OS user as the main agent's
// session, so a row marked "approved" in its database proves nothing; the
// Discord message author does, because Discord sets it, not the bot.
//
// What must hold, all of it, or the execution is refused:
//   - the request message is in the configured channel, posted by the
//     configured request bot, after this R was created and before it expires,
//     and it was never edited (the bot could rewrite it after the owner read
//     it and back again; barracuda v2, 29362);
//   - its WHOLE text is exactly what #33's buildDiscordApprovalText makes from
//     this R: the canonical line as the description, the R's requester, the
//     coolify_deploy category, and an expiry not later than the R's own
//     (barracuda 29359, 1: the owner reads the whole message, not one line);
//   - the first decision on it, judged by #33's own matchDecisions with
//     replies required, is `yes <code>` from a configured decider, written
//     before both expiries;
//   - no decider reply to it was edited (an edited "no" read later as "yes"
//     would differ from what the dashboard recorded).
import {
  buildDiscordApprovalText,
  CODE_LENGTH,
  formatApprovalExpiry,
  matchDecisions,
  parseDecision,
  snowflakeMs,
  type DiscordMessage,
} from '../web/approval-discord-core.js'
import { APPROVAL_CATEGORY } from './canonical.js'
import type { ExecutorConfig } from './config.js'
import type { RequestRecord } from './store.js'

export type ChannelMessage = DiscordMessage & { channel_id?: string }

export type ApprovalVerdict =
  | { ok: true; code: string; decisionMessageId: string; deciderId: string; displayedExpiry: number }
  | { ok: false; reason: string }

const no = (reason: string): ApprovalVerdict => ({ ok: false, reason })

const CODE_LINE = new RegExp(`^\\*\\*JÓVÁHAGYÁS KELL, kód: ([A-Z0-9]{${CODE_LENGTH}})\\*\\*$`)
const EXPIRY_TAIL = / Lejárat: (.+)$/

/**
 * The expiry the request shows, as a unix second inside the R's own window.
 * Found by rendering with #33's own formatter, not by parsing a localised
 * date: the comparison is then exact by construction.
 */
export function findDisplayedExpiry(text: string, fromSec: number, toSec: number): number | null {
  const sec = /:(\d{2})$/.exec(text)
  if (!sec) return null
  const s = Number(sec[1])
  if (s > 59) return null
  // walk only the seconds that end in the shown :ss, newest first
  let t = toSec - ((((toSec - s) % 60) + 60) % 60)
  for (; t >= fromSec; t -= 60) if (formatApprovalExpiry(t) === text) return t
  return null
}

export function verifyDiscordApproval(input: {
  r: RequestRecord
  request: ChannelMessage
  /** every message in the channel after the request, any order */
  later: readonly ChannelMessage[]
  discord: ExecutorConfig['discord']
  nowMs: number
}): ApprovalVerdict {
  const { r, request, later, discord, nowMs } = input
  if (request.channel_id !== undefined && request.channel_id !== discord.channelId) return no('request message is in another channel')
  if (request.author.id !== discord.requestBotUserId) return no('request message is not from the request bot')
  if (request.edited_timestamp) return no('request message was edited')
  const postedMs = snowflakeMs(request.id)
  if (postedMs <= r.createdAt * 1000) return no('request message is older than the R')
  if (postedMs >= r.expiresAt * 1000) return no('request message was posted after the R expired')

  const lines = request.content.split('\n')
  if (lines.length !== 4) return no('request message does not have exactly four lines')
  const codeMatch = CODE_LINE.exec(lines[0]!)
  if (!codeMatch) return no('request message has no code line')
  const code = codeMatch[1]!
  if (!parseDecision(`${discord.yes} ${code}`, discord)) return no('request code is not a valid approval code')
  const tail = EXPIRY_TAIL.exec(lines[1]!)
  if (!tail) return no('request message shows no expiry')
  const displayedExpiry = findDisplayedExpiry(tail[1]!, r.createdAt, r.expiresAt)
  if (displayedExpiry === null) return no('request expiry is not within the R window')

  const expected = buildDiscordApprovalText(
    { agent_id: r.requester, category: APPROVAL_CATEGORY, action_description: r.canonicalLine, timeout_at: displayedExpiry },
    code,
    { yes: discord.yes, no: discord.no, requireReply: true },
  )
  if (request.content !== expected) return no('request message text differs from the R')

  const replies = later.filter((m) => m.message_reference?.message_id === request.id && discord.deciderUserIds.includes(m.author.id))
  if (replies.some((m) => m.edited_timestamp)) return no('a decider reply to the request was edited')

  const [first] = matchDecisions(
    later,
    [{ id: r.id, discord_code: code, timeout_at: displayedExpiry, requested_at: r.createdAt, discord_message_id: request.id }],
    { userIds: discord.deciderUserIds, yes: discord.yes, no: discord.no, requireReply: true },
    Math.floor(nowMs / 1000),
  )
  if (!first) return no('no decision on the request (or the request has expired)')
  if (first.status !== 'approved') return no('the owner rejected the request')
  if (snowflakeMs(first.messageId) > Math.min(displayedExpiry, r.expiresAt) * 1000) return no('the decision came after the expiry')
  return { ok: true, code, decisionMessageId: first.messageId, deciderId: first.authorId, displayedExpiry }
}
