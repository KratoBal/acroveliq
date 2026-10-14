// Dontéseim V1, the backend (task dontesek-v1-backend). Balázs's decision B,
// 2026-10-14 08:52:26 UTC (msg 1559851364950220852), six requirements; each block below
// names the one it holds. A refusal is checked by what did NOT happen (the row, the
// timeline, the memory, the message queue), not only by its status code.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'acrobot', TELEGRAM_BOT_TOKEN: '', DECISION_OWNER_USER: 'balazs' }
})

import { getDb, getPendingMessages, initDatabase, pendingDiscordApprovals, setApprovalDiscordCode } from '../db.js'
import { decisionItems, decisionOwner, discordMessageIds } from '../decisions.js'
import { insertTaskHandoff, validateHandoffRecord } from '../task-handoff.js'
import { upsertTask } from '../task-usage.js'
import { acroveliqAllows } from '../web/acroveliq-host.js'
import { ACCESS_MODES } from '../web/access-enforcement.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { tryHandleDecisions } from '../web/routes/decisions.js'
import { tryHandleTaskUsage } from '../web/routes/task-usage.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']
const SESSION: Auth = { kind: 'session', user: 'balazs' }
const ACRO: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
/** no principal at all; a sentinel, because an `undefined` argument takes a parameter's default */
const NOBODY = 'nobody' as const
const OTHERS: (Auth | typeof NOBODY)[] = [
  { kind: 'token', actor: 'acrobot', project: 'acropora' },
  { kind: 'token', actor: 'nautilus', project: 'acropora' },
  { kind: 'token', actor: 'legacy' },
  { kind: 'token' },
  { kind: 'device', device: 'telefon' },
  { kind: 'federation', peer: 'masik' },
  { kind: 'session', user: '' },
  // another dashboard user is not the owner (barracuda, #104)
  { kind: 'session', user: 'luca' },
  { kind: 'session', user: 'Balazs' },
  NOBODY,
]

async function call(
  handler: (ctx: RouteContext) => Promise<boolean>,
  method: string,
  path: string,
  body: unknown,
  who: Auth | typeof NOBODY,
  extra: Partial<RouteContext> = {},
): Promise<{ handled: boolean; status: number; body: any }> {
  const auth = who === NOBODY ? undefined : who
  let status = 200
  let text = ''
  const res: any = {
    statusCode: 200,
    setHeader() { return res },
    writeHead(code: number) { status = code; return res },
    end(chunk?: string | Buffer) { if (chunk) text += chunk.toString() },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && raw) cb(Buffer.from(raw))
      if (event === 'end') cb()
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth, ...extra } as unknown as RouteContext
  const handled = await handler(ctx)
  return { handled, status, body: text ? JSON.parse(text) : null }
}

const NOW = () => Math.floor(Date.now() / 1000)
const payload = (task = 'tsk-1', over: Record<string, unknown> = {}) =>
  JSON.stringify({ task_id: task, summary: 'A NAS jogosultsag szukitese', reason: 'jelszo-hashes mentest olvas', consequence: 'a regi dumpok 600-ra allnak', ...over })

async function newDecision(agent: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }, task = 'tsk-1'): Promise<string> {
  const r = await call(tryHandleApprovals, 'POST', '/api/approvals',
    { category: 'dontes', action_description: 'NAS', action_payload: payload(task) }, agent)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

const row = (id: string) => getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any
const decisionEvents = (task = 'tsk-1') =>
  getDb().prepare("SELECT * FROM task_events WHERE task_id = ? AND kind = 'decision'").all(task) as any[]
const decisionMemories = (id: string) =>
  getDb().prepare("SELECT * FROM memories WHERE agent_id = 'acrobot' AND keywords LIKE ?").all(`%approval ${id}%`) as any[]
const decide = (id: string, action: string, auth: Auth | typeof NOBODY = SESSION, extra: Partial<RouteContext> = {}) =>
  call(tryHandleDecisions, 'POST', `/api/decisions/${id}`, { action }, auth, extra)

beforeEach(() => {
  initDatabase(':memory:')
  upsertTask(getDb(), { id: 'tsk-1', type: null, parent_task: null, variant: null, brief_ref: null, title: 'NAS', assignee: 'acrobot', reviewer: null }, NOW() - 100)
})

describe('a decision row: bound to a task, with the three texts (requirement 2)', () => {
  it('a missing field or an unknown task is a 400 that names it, and makes no row', async () => {
    const r = await call(tryHandleApprovals, 'POST', '/api/approvals',
      { category: 'dontes', action_description: 'x', action_payload: JSON.stringify({ task_id: 'tsk-1', summary: 's' }) }, ACRO)
    expect(r.status).toBe(400)
    expect(r.body.missing).toEqual(['action_payload.reason', 'action_payload.consequence'])
    const r2 = await call(tryHandleApprovals, 'POST', '/api/approvals',
      { category: 'dontes', action_description: 'x', action_payload: payload('nincs-ilyen') }, ACRO)
    expect(r2.status).toBe(400)
    expect(r2.body.missing[0]).toContain('no task nincs-ilyen')
    const r3 = await call(tryHandleApprovals, 'POST', '/api/approvals', { category: 'dontes', action_description: 'x' }, ACRO)
    expect(r3.status).toBe(400)
    expect((getDb().prepare('SELECT count(*) AS n FROM approvals').get() as { n: number }).n).toBe(0)
  })

  it('lives a week whatever the caller asks', async () => {
    const r = await call(tryHandleApprovals, 'POST', '/api/approvals',
      { category: 'dontes', action_description: 'x', action_payload: payload(), timeout_seconds: 60 }, ACRO)
    expect(r.status).toBe(201)
    expect(r.body.timeout_at - NOW()).toBeGreaterThan(7 * 24 * 3600 - 10)
  })

  it('gets one notice: no in-band fallback to the requester and no Discord code; another category still gets both paths', async () => {
    await newDecision()
    expect(getPendingMessages('acrobot')).toHaveLength(0)
    // the control: the same requester, another category, no Telegram token -> the fallback fires
    await call(tryHandleApprovals, 'POST', '/api/approvals', { category: 'email_send', action_description: 'y' },
      { kind: 'token', actor: 'acrobot', project: 'acropora' })
    expect(getPendingMessages('acrobot').map((m) => m.content)).toEqual([expect.stringContaining('[OWNER_UNREACHED')])
    // another agent's decision row reaches the main agent once, as any request does
    await newDecision({ kind: 'token', actor: 'murena', project: 'acropora' })
    expect(getPendingMessages('acrobot').filter((m) => m.content.includes('category=dontes'))).toHaveLength(1)
  })

  it('the Discord-code path never sees a decision row, even one that carries a code', async () => {
    const id = await newDecision()
    const other = await call(tryHandleApprovals, 'POST', '/api/approvals', { category: 'email_send', action_description: 'y' }, { kind: 'token', actor: 'murena', project: 'acropora' })
    setApprovalDiscordCode(id, 'AAAA')
    setApprovalDiscordCode(other.body.id, 'BBBB')
    expect(pendingDiscordApprovals().map((a) => a.id)).toEqual([other.body.id])
  })
})

describe('only the owner\'s session decides, in every access mode, on both surfaces (requirement 1)', () => {
  it('every other caller: 403, and the row, the timeline, the memory and the queue are untouched', async () => {
    const id = await newDecision()
    const before = JSON.stringify(row(id))
    for (const mode of ACCESS_MODES) for (const surface of ['dashboard', 'acroveliq'] as const) for (const auth of OTHERS)
      for (const action of ['approve', 'reject', 'discuss']) {
        const r = await decide(id, action, auth, { accessMode: mode, surface })
        expect(r.status, `${mode} ${surface} ${JSON.stringify(auth)} ${action}`).toBe(403)
      }
    expect(JSON.stringify(row(id))).toBe(before)
    expect(decisionEvents()).toHaveLength(0)
    expect(decisionMemories(id)).toHaveLength(0)
    expect(getPendingMessages('acrobot')).toHaveLength(0)
  })

  it('the owner is a configured name: unset, nobody decides; set, only that session', () => {
    expect(decisionOwner({ kind: 'session', user: 'balazs' }, 'S', '')).toMatchObject({ ok: false })
    // closed by the name check too; the explicit branch says WHY (the setting is missing)
    const unset = decisionOwner({ kind: 'session', user: 'balazs' }, 'S', '')
    expect(unset.ok ? '' : unset.error).toContain('DECISION_OWNER_USER')
    expect(decisionOwner({ kind: 'session', user: 'luca' }, 'S', 'balazs')).toMatchObject({ ok: false })
    expect(decisionOwner({ kind: 'token', user: 'balazs' }, 'A', 'balazs')).toMatchObject({ ok: false })
    expect(decisionOwner({ kind: 'session', user: ' balazs ' }, 'S', 'balazs')).toEqual({ ok: true, user: 'balazs' })
    // the refusal does not name the owner
    const r = decisionOwner({ kind: 'session', user: 'luca' }, 'S', 'balazs')
    expect(r.ok ? '' : r.error).not.toContain('balazs')
  })

  it('the session decides, in every access mode, on both surfaces', async () => {
    for (const mode of ACCESS_MODES) for (const surface of ['dashboard', 'acroveliq'] as const) {
      const id = await newDecision()
      expect((await decide(id, 'approve', SESSION, { accessMode: mode, surface })).status).toBe(200)
      expect(row(id).status).toBe('approved')
    }
  })

  it('PATCH /api/approvals/:id on a decision row: the same rule, and the same record', async () => {
    const id = await newDecision()
    for (const auth of OTHERS) for (const mode of ACCESS_MODES) {
      const r = await call(tryHandleApprovals, 'PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: 'balazs' }, auth, { accessMode: mode })
      expect(r.status, `${JSON.stringify(auth)} ${mode}`).toBe(403)
    }
    expect(row(id).status).toBe('pending')
    const t = await call(tryHandleApprovals, 'PATCH', `/api/approvals/${id}`, { status: 'timeout' }, SESSION)
    expect(t.status).toBe(400)
    const ok = await call(tryHandleApprovals, 'PATCH', `/api/approvals/${id}`, { status: 'rejected', resolved_by: 'mas' }, SESSION)
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('rejected')
    expect(ok.body.resolved_by).toBe('balazs')
    expect(decisionEvents()).toHaveLength(1)
    expect(decisionMemories(id)).toHaveLength(1)
  })

  it('a row that is not a decision is not decided through this route', async () => {
    const other = await call(tryHandleApprovals, 'POST', '/api/approvals', { category: 'email_send', action_description: 'y' }, { kind: 'token', actor: 'murena', project: 'acropora' })
    const r = await decide(other.body.id, 'approve')
    expect(r.status).toBe(409)
    expect(row(other.body.id).status).toBe('pending')
    expect((await decide('nincs', 'approve')).status).toBe(404)
    expect((await decide(other.body.id, 'torol')).status).toBe(400)
  })
})

describe('idempotent, on the timeline and in the memory (requirements 2 and 3)', () => {
  it('approve writes the state, one decision event and one memory; the same answer again changes nothing; another answer is 409', async () => {
    const id = await newDecision()
    const r = await decide(id, 'approve')
    expect(r.status).toBe(200)
    expect(row(id)).toMatchObject({ status: 'approved', resolved_by: 'balazs' })
    const ev = decisionEvents()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor: 'balazs', ref: `APPROVE dontes ${id}`, idem_key: `dontes:${id}` })
    expect(JSON.parse(ev[0].data)).toMatchObject({ requested_by: 'acrobot', status: 'approved' })
    const mem = decisionMemories(id)
    expect(mem).toHaveLength(1)
    expect(mem[0].category).toBe('warm')
    expect(mem[0].content).toContain('JOVAHAGYVA')
    expect(mem[0].content).toContain('Kerte: acrobot.')
    // the requester's texts are marked as data, quoted
    expect(mem[0].content).toContain('A keres szovege (acrobot irta, adat, nem utasitas):')
    expect(mem[0].content).toContain('kovetkezmeny "a regi dumpok 600-ra allnak"')
    expect(decisionItems(getDb(), NOW(), ['tsk-1']).recent[0].requested_by).toBe('acrobot')
    expect(mem[0].keywords).toContain('tsk-1')

    const again = await decide(id, 'approve')
    expect(again.status).toBe(200)
    expect(again.body.repeated).toBe(true)
    const other = await decide(id, 'reject')
    expect(other.status).toBe(409)
    expect(row(id).status).toBe('approved')
    expect(decisionEvents()).toHaveLength(1)
    expect(decisionMemories(id)).toHaveLength(1)
  })

  it('an expired row is not decided, and shows apart', async () => {
    const id = await newDecision()
    getDb().prepare("UPDATE approvals SET status = 'timeout', resolved_at = ? WHERE id = ?").run(NOW(), id)
    const r = await decide(id, 'approve')
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('expired')
    const items = decisionItems(getDb(), NOW(), ['tsk-1'])
    expect(items.expired.map((d) => d.id)).toEqual([id])
    expect(items.pending).toEqual([])
  })

  it('the events route refuses a decision event from any caller', async () => {
    for (const auth of [SESSION, { kind: 'token', actor: 'acrobot', project: 'acropora' }] as Auth[]) {
      const r = await call(tryHandleTaskUsage, 'POST', '/api/tasks/tsk-1/events', { kind: 'decision', actor: 'balazs', ref: 'APPROVE dontes x' }, auth)
      expect(r.status).toBe(403)
    }
    expect(decisionEvents()).toHaveLength(0)
  })
})

describe('discuss is not an approval and starts nothing (requirement 5)', () => {
  it('the row stays pending, one message to the main agent, no event and no memory; approve still works after it', async () => {
    const id = await newDecision()
    const r = await decide(id, 'discuss')
    expect(r.status).toBe(200)
    expect(row(id).status).toBe('pending')
    expect(row(id).discuss_requested_at).toBeGreaterThan(0)
    const msgs = getPendingMessages('acrobot')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('[DONTES_MEGBESZELES]')
    expect(msgs[0].content).toContain('Ez nem jovahagyas')
    expect((await decide(id, 'discuss')).body.repeated).toBe(true)
    expect(getPendingMessages('acrobot')).toHaveLength(1)
    expect(decisionEvents()).toHaveLength(0)
    expect(decisionMemories(id)).toHaveLength(0)
    const items = decisionItems(getDb(), NOW(), ['tsk-1'])
    expect(items.discuss.map((d) => d.id)).toEqual([id])
    expect(items.pending).toEqual([])
    expect((await decide(id, 'approve')).status).toBe(200)
    expect((await decide(id, 'discuss')).status).toBe(409)
  })
})

describe('a decision made on Discord makes no second item (requirement 4)', () => {
  const A: Auth = { kind: 'token', actor: 'acrobot', project: 'acropora' }
  const reply = (id: string, message_id: string, auth: Auth | typeof NOBODY = A, extra: Partial<RouteContext> = {}) =>
    call(tryHandleDecisions, 'POST', `/api/decisions/${id}/discord-reply`, { message_id }, auth, extra)

  it('only the main agent attaches, only on the dashboard, only a Discord message id; it decides nothing', async () => {
    const id = await newDecision()
    for (const auth of [SESSION, { kind: 'token', actor: 'nautilus', project: 'acropora' }, { kind: 'token' }] as Auth[])
      expect((await reply(id, '1559851364950220852', auth)).status).toBe(403)
    expect((await reply(id, '1559851364950220852', A, { surface: 'acroveliq' })).status).toBe(403)
    expect((await reply(id, '30213')).status).toBe(400)
    expect(row(id).discord_reply_ref).toBeNull()
    expect((await reply(id, '1559851364950220852')).status).toBe(200)
    expect(row(id).status).toBe('pending')
    expect((await reply(id, '1559851364950220852')).body.repeated).toBe(true)
    const items = decisionItems(getDb(), NOW(), ['tsk-1'])
    expect(items.discord_replied.map((d) => d.id)).toEqual([id])
    expect(items.pending).toEqual([])
  })

  it('one message, one row; the confirmed decision carries it as evidence', async () => {
    const a = await newDecision()
    const b = await newDecision()
    expect((await reply(a, '1559851364950220852')).status).toBe(200)
    expect((await reply(b, '1559851364950220852')).status).toBe(409)
    expect(row(b).discord_reply_ref).toBeNull()
    expect((await decide(a, 'approve')).status).toBe(200)
    expect(row(a).decision_ref).toBe('1559851364950220852')
    expect(decisionEvents()[0].ref).toBe(`APPROVE dontes ${a} msg 1559851364950220852`)
    expect(decisionMemories(a)[0].keywords).toContain('msg 1559851364950220852')
  })

  it('the recent list: a handoff decision whose message a row has already is dropped, the same message in two tasks is one item', async () => {
    const db = getDb()
    upsertTask(db, { id: 'tsk-2', type: null, parent_task: null, variant: null, brief_ref: null, title: 't2', assignee: 'acrobot', reviewer: null }, NOW())
    const id = await newDecision()
    await reply(id, '1559851364950220852')
    await decide(id, 'approve')
    const handoff = (task: string, decisions: unknown[]) => {
      const rec = validateHandoffRecord({
        task: { id: task, goal: 'g', brief: 'b' }, status: 'in_progress', decisions, prohibitions: [], code: null,
        files: [], next_step: 'x', open_questions: [],
      })
      if (!rec.ok) throw new Error(rec.missing.join(','))
      insertTaskHandoff(db, 'acrobot', rec.record, NOW())
    }
    const where = (msg: string) => `Acroveliq szal 1559470238783770624, msg ${msg}`
    handoff('tsk-1', [
      { what: 'B valtozat', who: 'Balazs', where: where('1559851364950220852') },
      { what: 'domain elokeszites', who: 'Balázs', where: where('1559634758932242504') },
      { what: 'belso', who: 'acrobot', where: where('1559000000000000001') },
      { what: 'rovid szam', who: 'Balazs', where: 'msg_id:30213' },
    ])
    handoff('tsk-2', [
      { what: 'domain elokeszites', who: 'Balazs', where: 'https://discord.com/channels/1/1559470238783770624/1559634758932242504' },
      // a reference naming the question and the answer: the row has the answer, so it is the row's item
      { what: 'B valtozat megint', who: 'Balazs', where: 'kerdes msg 1559000000000000777, valasz msg 1559851364950220852' },
    ])
    const items = decisionItems(db, NOW(), ['tsk-1', 'tsk-2'])
    expect(items.recent.map((d) => d.id)).toEqual([id])
    expect(items.recent_discord.map((h) => h.discord_messages)).toEqual([['1559634758932242504']])
  })

  it('the link to the answer: with the channel and the guild, a discord.com link; without either, none; a wrong channel id is refused', async () => {
    const withChannel = (id: string, body: Record<string, unknown>) =>
      call(tryHandleDecisions, 'POST', `/api/decisions/${id}/discord-reply`, body, A)
    const a = await newDecision()
    const b = await newDecision()
    const c = await newDecision()
    expect((await withChannel(c, { message_id: '1559851364950220852', channel_id: 'javascript:1' })).status).toBe(400)
    expect(row(c).discord_reply_ref).toBeNull()
    expect((await withChannel(a, { message_id: '1559851364950220852', channel_id: '1540270627926183997' })).status).toBe(200)
    expect((await withChannel(b, { message_id: '1559851364950220999' })).status).toBe(200)
    const url = (items: ReturnType<typeof decisionItems>, id: string) => items.discord_replied.find((d) => d.id === id)?.discord_url
    const guild = decisionItems(getDb(), NOW(), ['tsk-1'], '1538520890822885418')
    const noGuild = decisionItems(getDb(), NOW(), ['tsk-1'], '')
    expect([url(guild, a), url(guild, b), url(noGuild, a)]).toEqual([
      'https://discord.com/channels/1538520890822885418/1540270627926183997/1559851364950220852', null, null,
    ])
  })

  // The main channel is a DM (acrobot, 2026-10-14: Discord type 1, no guild): there the link is
  // @me in the guild's place, with or without a guild set; a thread keeps the guild. RED: the DM
  // message linked under the guild, or no link without a guild.
  it('the link to an answer in a DM channel: @me in the guild place; a thread keeps the guild', async () => {
    const reply = (id: string, body: Record<string, unknown>) =>
      call(tryHandleDecisions, 'POST', `/api/decisions/${id}/discord-reply`, body, A)
    const dm = await newDecision()
    const thread = await newDecision()
    expect((await reply(dm, { message_id: '1559851364950220852', channel_id: '1538522302277353505' })).status).toBe(200)
    expect((await reply(thread, { message_id: '1559851364950220999', channel_id: '1540270627926183997' })).status).toBe(200)
    const dms = new Set(['1538522302277353505'])
    const url = (items: ReturnType<typeof decisionItems>, id: string) => items.discord_replied.find((d) => d.id === id)?.discord_url
    const withGuild = decisionItems(getDb(), NOW(), ['tsk-1'], '1538520890822885418', dms)
    const noGuild = decisionItems(getDb(), NOW(), ['tsk-1'], '', dms)
    expect([url(withGuild, dm), url(withGuild, thread), url(noGuild, dm), url(noGuild, thread)]).toEqual([
      'https://discord.com/channels/@me/1538522302277353505/1559851364950220852',
      'https://discord.com/channels/1538520890822885418/1540270627926183997/1559851364950220999',
      'https://discord.com/channels/@me/1538522302277353505/1559851364950220852',
      null,
    ])
  })

  it('the message id reader: a labelled number or a link\'s last number, 17-20 digits; a thread id alone is not a message', () => {
    expect(discordMessageIds('Acroveliq szal 1559470238783770624, msg 1559847481821626421')).toEqual(['1559847481821626421'])
    expect(discordMessageIds('message_id 1559139791860123456')).toEqual(['1559139791860123456'])
    expect(discordMessageIds('https://discord.com/channels/111/1559470238783770624/1559634758932242504')).toEqual(['1559634758932242504'])
    expect(discordMessageIds('msg_id:30213')).toEqual([])
    expect(discordMessageIds('szal 1559470238783770624')).toEqual([])
    expect(discordMessageIds('msg 155947023878377062412345')).toEqual([])
  })
})

describe('the AcrovelIQ host: exactly the decision write (requirement 6)', () => {
  it('lets POST /api/decisions/:id through, and nothing beside it', () => {
    expect(acroveliqAllows('POST', '/api/decisions/abc')).toBe(true)
    for (const [m, p] of [['POST', '/api/decisions/abc/discord-reply'], ['PATCH', '/api/approvals/abc'], ['GET', '/api/decisions/abc'],
      ['POST', '/api/decisions'], ['POST', '/api/agents/acrobot/restart'], ['POST', '/api/settings'], ['PUT', '/api/settings']])
      expect(acroveliqAllows(m!, p!), `${m} ${p}`).toBe(false)
  })
})

describe('a coordination question names whom the answer comes from', () => {
  it('the task\'s own id there is refused (koord-pr81)', () => {
    const rec = validateHandoffRecord({
      task: { id: 'koord-pr81', goal: 'g', brief: 'b' }, kind: 'coordination', status: 'in_progress',
      state: { phase: 'reszben', summary: 'a koordinacio folyik, valaszra var' }, decisions: [], prohibitions: [], code: null, files: [],
      next_steps: [{ what: 'x', who: 'acrobot' }],
      open_questions: [{ from: 'koord-pr81', what: 'Mehet-e a #69?' }, { from: 'Balazs', what: 'ok' }],
    })
    expect(rec.ok).toBe(false)
    if (!rec.ok) expect(rec.missing).toEqual(["open_questions[0].from (whom the answer comes from, not the task's own id)"])
  })
})
