// The pure half of the Discord approval (acrovelIQ P0-1 PR 4, #33): how a
// request reads on Discord and which reply decides it. No database, no config,
// no logger: the separate deploy executor (SB1, `src/deploy-executor/`) reads
// the same Discord messages back and must judge them with THIS code, letter
// for letter, not with a copy that can drift. `approval-discord.ts` re-exports
// everything here, so its callers did not change.
import { randomInt } from 'node:crypto'

/** The words that decide, and whether a reply must answer the request message itself. */
export interface DecisionRules {
  userIds: readonly string[]
  yes: string
  no: string
  requireReply: boolean
}

// No 0/O, 1/I/L: a code read off a phone must not be ambiguous.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
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
export function parseDecision(text: string, cfg: Pick<DecisionRules, 'yes' | 'no'>): ParsedDecision | null {
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
  /** set when the message is a Discord reply */
  message_reference?: { message_id?: string } | null
  /** set by Discord when the message was edited after it was posted */
  edited_timestamp?: string | null
}

export interface MatchedDecision {
  approvalId: string
  status: 'approved' | 'rejected'
  messageId: string
  authorId: string
}

/** The fields of an approval row the decision depends on. */
export interface PendingApprovalRef {
  id: string
  discord_code?: string | null
  timeout_at: number | null
  requested_at: number
  discord_message_id?: string | null
}

/**
 * Which messages decide which approval. Pure. Oldest first, and one decision
 * per approval: a second reply to the same code finds the row decided.
 */
export function matchDecisions(
  messages: readonly DiscordMessage[],
  pending: readonly PendingApprovalRef[],
  cfg: DecisionRules,
  nowSeconds: number,
): MatchedDecision[] {
  const byCode = new Map(
    pending.filter((a) => a.discord_code).map((a) => [a.discord_code!.toUpperCase(), a]),
  )
  const byMessage = new Map(
    pending.filter((a) => a.discord_message_id).map((a) => [a.discord_message_id!, a]),
  )
  const decided = new Set<string>()
  const out: MatchedDecision[] = []
  const oldestFirst = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  for (const m of oldestFirst) {
    if (m.author.bot || !cfg.userIds.includes(m.author.id)) continue
    const parsed = parseDecision(m.content, cfg)
    if (!parsed) continue
    // with replies required, the request is the one REPLIED TO, and the code
    // must be that request's own: a code copied from elsewhere does not match
    const approval = cfg.requireReply
      ? byMessage.get(m.message_reference?.message_id ?? '')
      : byCode.get(parsed.code)
    if (!approval || decided.has(approval.id)) continue
    if ((approval.discord_code ?? '').toUpperCase() !== parsed.code) continue
    if (snowflakeMs(m.id) <= approval.requested_at * 1000) continue
    if (approval.timeout_at != null && approval.timeout_at <= nowSeconds) continue
    decided.add(approval.id)
    out.push({ approvalId: approval.id, status: parsed.status, messageId: m.id, authorId: m.author.id })
  }
  return out
}

export const DESCRIPTION_MAX = 500

/**
 * The requesting agent's words, made inert: one line, no markdown characters,
 * cut to a limit, quoted. Any agent may create a request, so its text must
 * not be able to look like our instructions (barracuda #33).
 */
export function neutralDescription(text: string): string {
  const flat = text.replace(/[`>#*_~|]/g, ' ').replace(/\s+/g, ' ').trim()
  const cut = flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX)}...` : flat
  return `> ${cut}`
}

/** The expiry as the request prints it. */
export function formatApprovalExpiry(timeoutAt: number | null): string {
  return timeoutAt
    ? new Date(timeoutAt * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
    : 'nincs'
}

/** The fields of an approval row the request text depends on. */
export interface ApprovalTextFields {
  agent_id: string
  category: string
  action_description: string
  timeout_at: number | null
}

/** The request as the owner reads it on Discord: our instruction first, the agent's words last, quoted. */
export function buildDiscordApprovalText(
  approval: ApprovalTextFields,
  code: string,
  cfg: Pick<DecisionRules, 'yes' | 'no' | 'requireReply'>,
): string {
  const expires = formatApprovalExpiry(approval.timeout_at)
  const how = cfg.requireReply ? 'Erre az üzenetre válaszolva' : 'Válaszként'
  return [
    `**JÓVÁHAGYÁS KELL, kód: ${code}**`,
    `${how}: \`${cfg.yes} ${code}\` vagy \`${cfg.no} ${code}\` (csak ez a két alak dönt). Lejárat: ${expires}`,
    `Kérő: ${approval.agent_id} | ${approval.category.replace(/[^\w.-]/g, '')}`,
    neutralDescription(approval.action_description),
  ].join('\n')
}

/** When a Discord id (snowflake) was made, in ms. */
export function snowflakeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n)
}

/** A Discord snowflake for a moment: the poll starts this far back. */
export function snowflakeAt(ms: number): string {
  const DISCORD_EPOCH = 1420070400000n
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString()
}
