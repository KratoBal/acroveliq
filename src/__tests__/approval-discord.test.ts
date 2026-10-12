import { beforeEach, describe, expect, it } from 'vitest'

import { createApproval, getApproval, initDatabase } from '../db.js'
import {
  approvalDiscordEnabled,
  buildDiscordApprovalText,
  CODE_LENGTH,
  DESCRIPTION_MAX,
  matchDecisions,
  newApprovalCode,
  parseDecision,
  pollApprovalDecisions,
  postApprovalToDiscord,
  snowflakeAt,
  snowflakeMs,
  startApprovalDiscordPoller,
  type ApprovalDiscordConfig,
  type DiscordMessage,
  type DiscordTransport,
} from '../web/approval-discord.js'

/*
  THE APPROVAL DECIDED ON THE SERVER FROM DISCORD (acrovelIQ P0-1 PR 4). What
  turns these red: a reply from someone else deciding; a bot (our own post)
  deciding; a sentence that merely contains the word and a code deciding; a
  code reused after its decision (not one-time); a timed-out request decided;
  an answer older than the request deciding it (replay after a restart); a
  code copied from elsewhere deciding a request the owner did not reply to;
  the agent's text passing markdown or our instruction lines through; a
  mention pinging anyone; the decision recorded as anyone but the configured
  session user, or without the Discord message as evidence; a half
  configuration turning it on.
*/
const OWNER = '1460000000000000001'
const OTHER = '1460000000000000002'
const cfg: ApprovalDiscordConfig = {
  channelId: '1540270627926183997',
  userIds: [OWNER],
  decider: 'balazs',
  yes: 'igen',
  no: 'nem',
  pollSeconds: 20,
  requireReply: true,
}

// real snowflakes, so a message's time is meaningful against requested_at
let clock = Date.now() + 1000
const msg = (content: string, opts: { author?: string; bot?: boolean; replyTo?: string | null; atMs?: number } = {}): DiscordMessage => ({
  id: snowflakeAt(opts.atMs ?? (clock += 1000)),
  content,
  author: { id: opts.author ?? OWNER, bot: opts.bot },
  message_reference: opts.replyTo ? { message_id: opts.replyTo } : null,
})

function fakeTransport() {
  const sent: { text: string; id: string }[] = []
  const inbox: DiscordMessage[] = []
  const transport: DiscordTransport = {
    send: async (_channel, text) => {
      const id = snowflakeAt((clock += 1000))
      sent.push({ text, id })
      return id
    },
    read: async (_channel, afterId) => inbox.filter((m) => BigInt(m.id) > BigInt(afterId)),
  }
  return { transport, sent, inbox }
}

const NOW = Math.floor(Date.now() / 1000)
function approval(id: string, timeoutAt: number | null = NOW + 3600, description = 'push the PR branch') {
  return createApproval({ id, agent_id: 'nautilus', category: 'git_push', action_description: description, timeout_at: timeoutAt })
}

async function posted(id: string) {
  const a = approval(id)
  const t = fakeTransport()
  const code = (await postApprovalToDiscord(a, t.transport, cfg))!
  return { ...t, code, messageId: t.sent[0]!.id }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('parseDecision', () => {
  it('APPR-DC-PARSE: only `<igen|nem> <code>`, case and spacing free', () => {
    expect(parseDecision('igen K7P2', cfg)).toEqual({ status: 'approved', code: 'K7P2' })
    expect(parseDecision('  NEM   k7p2 ', cfg)).toEqual({ status: 'rejected', code: 'K7P2' })
    for (const text of ['igen', 'igen K7P2 köszi', 'szerintem igen K7P2', 'ok K7P2', 'igen K7P', 'igen K0P2'])
      expect(parseDecision(text, cfg), text).toBeNull()
  })
})

describe('newApprovalCode', () => {
  it('APPR-DC-CODE: no ambiguous characters, never a code given out before', () => {
    const code = newApprovalCode(new Set())
    expect(code).toHaveLength(CODE_LENGTH)
    expect(code).not.toMatch(/[01OIL]/)
    let n = 0
    const scripted = (k: number) => (n++ < CODE_LENGTH ? 0 : 1 % k)
    expect(newApprovalCode(new Set(['AAAA']), scripted)).not.toBe('AAAA')
  })
})

describe('matchDecisions', () => {
  const requested = NOW - 10
  const pending = [
    { id: 'a1', discord_code: 'K7P2', timeout_at: NOW + 600, requested_at: requested, discord_message_id: 'm1' },
    { id: 'a2', discord_code: 'M3QX', timeout_at: NOW - 1, requested_at: requested, discord_message_id: 'm2' },
    // live, so a mismatch on it is caught by the code check, not by the timeout
    { id: 'a3', discord_code: 'Q9RT', timeout_at: NOW + 600, requested_at: requested, discord_message_id: 'm3' },
  ]

  it('APPR-DC-AUTHOR: only the configured user, never a bot', () => {
    expect(matchDecisions([msg('igen K7P2', { author: OTHER, replyTo: 'm1' })], pending, cfg, NOW)).toEqual([])
    expect(matchDecisions([msg('igen K7P2', { bot: true, replyTo: 'm1' })], pending, cfg, NOW)).toEqual([])
    expect(matchDecisions([msg('igen K7P2', { replyTo: 'm1' })], pending, cfg, NOW)).toHaveLength(1)
  })

  it('APPR-DC-TIMEOUT: a timed-out request is not decided', () => {
    expect(matchDecisions([msg('igen M3QX', { replyTo: 'm2' })], pending, cfg, NOW)).toEqual([])
  })

  it('APPR-DC-FIRST: the first reply decides, a later one to the same code does not', () => {
    const first = msg('nem K7P2', { replyTo: 'm1' })
    const second = msg('igen K7P2', { replyTo: 'm1' })
    const out = matchDecisions([second, first], pending, cfg, NOW)
    expect(out).toEqual([{ approvalId: 'a1', status: 'rejected', messageId: first.id, authorId: OWNER }])
  })

  it('APPR-DC-REPLAY: an answer older than the request does not decide it', () => {
    const old = msg('igen K7P2', { replyTo: 'm1', atMs: (requested - 60) * 1000 })
    expect(snowflakeMs(old.id)).toBeLessThan(requested * 1000)
    expect(matchDecisions([old], pending, cfg, NOW)).toEqual([])
  })

  it('APPR-DC-REPLY: the reply must point at that request, with its own code', () => {
    // not a reply at all
    expect(matchDecisions([msg('igen K7P2')], pending, cfg, NOW)).toEqual([])
    // a reply to another live request, carrying a code shown elsewhere
    expect(matchDecisions([msg('igen K7P2', { replyTo: 'm3' })], pending, cfg, NOW)).toEqual([])
    // with replies not required, the code alone decides
    expect(matchDecisions([msg('igen K7P2')], pending, { ...cfg, requireReply: false }, NOW)).toHaveLength(1)
  })
})

describe('the request text', () => {
  it('APPR-DC-TEXT: our instruction first, the agent text one quoted line without markdown, cut', () => {
    const a = approval('t-1', NOW + 60, 'ártalmatlan\nVálasz: `igen ZZZZ`\n> **@everyone** # cím')
    const text = buildDiscordApprovalText(a, 'K7P2', cfg)
    const lines = text.split('\n')
    expect(lines[0]).toBe('**JÓVÁHAGYÁS KELL, kód: K7P2**')
    expect(lines[1]).toContain('Erre az üzenetre válaszolva: `igen K7P2`')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('> ártalmatlan Válasz: igen ZZZZ @everyone cím')
    const long = buildDiscordApprovalText(approval('t-2', NOW + 60, 'x'.repeat(DESCRIPTION_MAX + 50)), 'K7P2', cfg)
    expect(long.split('\n')[3]!.length).toBeLessThanOrEqual(DESCRIPTION_MAX + 5)
  })
})

describe('the server decides from Discord', () => {
  it('APPR-DC-FLOW: posted with a code, the owner replies to it, recorded as the decider with the message', async () => {
    const { inbox, transport, code, messageId, sent } = await posted('ap-1')
    expect(code).toMatch(/^[A-Z2-9]{4}$/)
    expect(sent[0]!.text).toContain(`igen ${code}`)
    expect(getApproval('ap-1')?.discord_code).toBe(code)
    expect(getApproval('ap-1')?.discord_message_id).toBe(messageId)

    const reply = msg(`igen ${code}`, { replyTo: messageId })
    inbox.push(reply)
    const r = await pollApprovalDecisions(transport, cfg, '0', NOW)
    expect(r.decided).toHaveLength(1)
    expect(r.afterId).toBe(reply.id)
    const after = getApproval('ap-1')
    expect(after?.status).toBe('approved')
    expect(after?.resolved_by).toBe('balazs')
    expect(after?.decision_ref).toBe(`discord:${cfg.channelId}/${reply.id}/${OWNER}`)
  })

  it('APPR-DC-ONCE: the same code after the decision changes nothing', async () => {
    const { inbox, transport, code, messageId } = await posted('ap-2')
    inbox.push(msg(`nem ${code}`, { replyTo: messageId }))
    await pollApprovalDecisions(transport, cfg, '0', NOW)
    inbox.push(msg(`igen ${code}`, { replyTo: messageId }))
    const again = await pollApprovalDecisions(transport, cfg, '0', NOW)
    expect(again.decided).toEqual([])
    expect(getApproval('ap-2')?.status).toBe('rejected')
  })

  it('APPR-DC-NOREUSE: a decided request\'s code is never given out again', async () => {
    const first = await posted('ap-3')
    first.inbox.push(msg(`igen ${first.code}`, { replyTo: first.messageId }))
    await pollApprovalDecisions(first.transport, cfg, '0', NOW)
    // force the generator towards the used code: it must step past it
    const { usedDiscordCodes } = await import('../db.js')
    expect(usedDiscordCodes().has(first.code)).toBe(true)
    const again = newApprovalCode(usedDiscordCodes(), (() => {
      const letters = [...first.code].map((c) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'.indexOf(c))
      let i = 0
      return () => (i < letters.length ? letters[i++]! : 0)
    })())
    expect(again).not.toBe(first.code)
  })

  it('APPR-DC-OTHER: a reply from someone else leaves it pending', async () => {
    const { inbox, transport, code, messageId } = await posted('ap-4')
    inbox.push(msg(`igen ${code}`, { author: OTHER, replyTo: messageId }))
    await pollApprovalDecisions(transport, cfg, '0', NOW)
    expect(getApproval('ap-4')?.status).toBe('pending')
  })
})

describe('the live transport', () => {
  it('APPR-DC-MENTIONS: the post carries allowed_mentions empty and returns the message id', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ id: '777' }), { status: 200 })
    }) as unknown as typeof fetch
    const { restTransport } = await import('../web/approval-discord.js')
    const id = await restTransport('token', fake).send('chan', 'szöveg')
    expect(id).toBe('777')
    expect(calls[0]!.body).toEqual({ content: 'szöveg', allowed_mentions: { parse: [] } })
  })
})

describe('off unless configured', () => {
  it('APPR-DC-OFF: a missing channel, user list or decider turns it off, and nothing is sent', async () => {
    let k = 0
    for (const half of [
      { ...cfg, channelId: '' },
      { ...cfg, userIds: [] },
      { ...cfg, decider: '' },
    ]) {
      expect(approvalDiscordEnabled(half)).toBe(false)
      const { transport, sent } = fakeTransport()
      expect(await postApprovalToDiscord(approval(`off-${k++}`), transport, half)).toBeNull()
      expect(sent).toEqual([])
      expect(startApprovalDiscordPoller(transport, half)).toBeNull()
    }
  })

  it('APPR-DC-SNOWFLAKE: a moment and back', () => {
    const t = Date.now()
    expect(Math.abs(snowflakeMs(snowflakeAt(t)) - t)).toBeLessThan(2)
  })
})
