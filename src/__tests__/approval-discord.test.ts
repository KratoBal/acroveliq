import { beforeEach, describe, expect, it } from 'vitest'

import { createApproval, getApproval, initDatabase } from '../db.js'
import {
  approvalDiscordEnabled,
  CODE_LENGTH,
  matchDecisions,
  newApprovalCode,
  parseDecision,
  pollApprovalDecisions,
  postApprovalToDiscord,
  snowflakeAt,
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
  the decision recorded as anyone but the configured session user, or without
  the Discord message as evidence; a half configuration turning it on.
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
}

let nextId = 1000n
const msg = (content: string, author = OWNER, bot = false): DiscordMessage => ({
  id: String(++nextId),
  content,
  author: { id: author, bot },
})

function fakeTransport(inbox: DiscordMessage[] = []) {
  const sent: string[] = []
  const transport: DiscordTransport = {
    send: async (_channel, text) => { sent.push(text) },
    read: async (_channel, afterId) => inbox.filter((m) => BigInt(m.id) > BigInt(afterId)),
  }
  return { transport, sent, inbox }
}

const NOW = Math.floor(Date.now() / 1000)
function approval(id: string, timeoutAt: number | null = NOW + 3600) {
  return createApproval({
    id,
    agent_id: 'nautilus',
    category: 'git_push',
    action_description: 'push the PR branch',
    timeout_at: timeoutAt,
  })
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
  it('APPR-DC-CODE: no ambiguous characters, never a code still pending', () => {
    const code = newApprovalCode(new Set())
    expect(code).toHaveLength(CODE_LENGTH)
    expect(code).not.toMatch(/[01OIL]/)
    let n = 0
    const scripted = (k: number) => (n++ < CODE_LENGTH ? 0 : 1 % k)
    expect(newApprovalCode(new Set(['AAAA']), scripted)).not.toBe('AAAA')
  })
})

describe('matchDecisions', () => {
  const pending = [
    { id: 'a1', discord_code: 'K7P2', timeout_at: NOW + 60 },
    { id: 'a2', discord_code: 'M3QX', timeout_at: NOW - 1 },
  ]

  it('APPR-DC-AUTHOR: only the configured user, never a bot', () => {
    expect(matchDecisions([msg('igen K7P2', OTHER)], pending, cfg, NOW)).toEqual([])
    expect(matchDecisions([msg('igen K7P2', OWNER, true)], pending, cfg, NOW)).toEqual([])
    expect(matchDecisions([msg('igen K7P2')], pending, cfg, NOW)).toHaveLength(1)
  })

  it('APPR-DC-TIMEOUT: a timed-out request is not decided', () => {
    expect(matchDecisions([msg('igen M3QX')], pending, cfg, NOW)).toEqual([])
  })

  it('APPR-DC-FIRST: the first reply decides, a later one to the same code does not', () => {
    const first = msg('nem K7P2')
    const second = msg('igen K7P2')
    const out = matchDecisions([second, first], pending, cfg, NOW)
    expect(out).toEqual([{ approvalId: 'a1', status: 'rejected', messageId: first.id, authorId: OWNER }])
  })
})

describe('the server decides from Discord', () => {
  it('APPR-DC-FLOW: posted with a code, the owner replies, recorded as the decider with the message', async () => {
    const a = approval('ap-1')
    const { transport, sent, inbox } = fakeTransport()
    const code = await postApprovalToDiscord(a, transport, cfg)
    expect(code).toMatch(/^[A-Z2-9]{4}$/)
    expect(sent[0]).toContain(`igen ${code}`)
    expect(getApproval('ap-1')?.discord_code).toBe(code)

    const reply = msg(`igen ${code}`)
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
    approval('ap-2')
    const { transport, inbox } = fakeTransport()
    const code = await postApprovalToDiscord(getApproval('ap-2')!, transport, cfg)
    inbox.push(msg(`nem ${code}`))
    await pollApprovalDecisions(transport, cfg, '0', NOW)
    inbox.push(msg(`igen ${code}`))
    const again = await pollApprovalDecisions(transport, cfg, '0', NOW)
    expect(again.decided).toEqual([])
    expect(getApproval('ap-2')?.status).toBe('rejected')
  })

  it('APPR-DC-OTHER: a reply from someone else leaves it pending', async () => {
    approval('ap-3')
    const { transport, inbox } = fakeTransport()
    const code = await postApprovalToDiscord(getApproval('ap-3')!, transport, cfg)
    inbox.push(msg(`igen ${code}`, OTHER))
    await pollApprovalDecisions(transport, cfg, '0', NOW)
    expect(getApproval('ap-3')?.status).toBe('pending')
  })
})

describe('off unless configured', () => {
  it('APPR-DC-OFF: a missing channel, user list or decider turns it off, and nothing is sent', async () => {
    for (const half of [
      { ...cfg, channelId: '' },
      { ...cfg, userIds: [] },
      { ...cfg, decider: '' },
    ]) {
      expect(approvalDiscordEnabled(half)).toBe(false)
      const { transport, sent } = fakeTransport()
      expect(await postApprovalToDiscord(approval(`off-${sent.length}-${half.decider}${half.channelId}`), transport, half)).toBeNull()
      expect(sent).toEqual([])
      expect(startApprovalDiscordPoller(transport, half)).toBeNull()
    }
  })

  it('APPR-DC-SNOWFLAKE: a moment as a Discord id, later moments larger', () => {
    expect(BigInt(snowflakeAt(Date.now()))).toBeGreaterThan(BigInt(snowflakeAt(Date.now() - 1000)))
  })
})
