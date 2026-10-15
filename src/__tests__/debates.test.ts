// Többmodelles V1, PR 1: the debate controller (task t-20261014-tobbmodelles-vezerlo). WHAT TURNS THIS RED:
//   - a debate starts from a message that is not the owner's, from a bot, or in a thread not allowed;
//   - a round counts twice (a second hand-in with the same token), or a bot message moves the counter;
//   - a phase runs past MAX_ROUNDS, or does not stop early when a speaker marks its answer final;
//   - GPT speaks without a runner, past the daily cap, or a `gpt:` run opens a round;
//   - `állj` leaves a round open, an Acrobot round that never comes leaves the debate `fut`;
//   - an owner message during a phase moves the counter, or one after the phase does not open a new one;
//   - the text posted to the thread keeps an em dash, an embedded link, or a piece over 2000 characters;
//   - GPT's answer reaches Acrobot outside the untrusted wrapper.
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import {
  DISCORD_LIMIT,
  MAX_ROUNDS,
  debateTurns,
  getDebate,
  handleOwnerMessage,
  outboundPieces,
  parseOwnerCommand,
  submitAcrobotTurn,
  sweepDebates,
  type DebateConfig,
  type DebateDeps,
  type GptAnswer,
} from '../debates.js'
import { pollDebates } from '../web/debates-discord.js'
import { setDebateTransportForTest, tryHandleDebates } from '../web/routes/debates.js'
import { MAIN_AGENT_ID } from '../config.js'
import { FINAL_MARK, GptBlocked } from '../gpt-package.js'
import type { RouteContext } from '../web/routes/types.js'

const THREAD = '1559470238783770624'
const OWNER = '111'
const cfg: DebateConfig = { threads: [THREAD], ownerIds: [OWNER], turnTimeoutSeconds: 900, phaseTimeoutSeconds: 3600, gptDailyCap: 40 }

let now = 1_792_000_000
let posts: { thread: string; text: string }[]
let told: string[]
let gptAnswers: GptAnswer[]
let gptCalls: string[]

function deps(runGpt: boolean): DebateDeps {
  return {
    post: async (thread, text) => { posts.push({ thread, text }); return String(9000 + posts.length) },
    tellAcrobot: (content) => { told.push(content); return told.length },
    runGpt: runGpt ? async (_d, prompt) => { gptCalls.push(prompt); return gptAnswers.shift() ?? { text: 'GPT válasz', final: false } } : null,
    now: () => now,
  }
}

const tokenOf = (message: string) => /vita-valasz \S+ (\S+)/.exec(message)![1]!
const db = () => getDb()

async function start(text = 'vita os: Hogyan legyen a számlázás?', runGpt = false) {
  await handleOwnerMessage(db(), deps(runGpt), cfg, THREAD, { id: String(++now), content: text }, OWNER)
  const id = (db().prepare('SELECT id FROM debates ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
  return id
}

beforeEach(() => {
  initDatabase(':memory:')
  posts = []
  told = []
  gptAnswers = []
  gptCalls = []
})

describe('the owner\'s commands', () => {
  it('DEB-PARSE: start with a project (and gpt), the steering words with and without accents, gpt: and plain text', () => {
    expect([
      parseOwnerCommand('vita os: Mi legyen?'),
      parseOwnerCommand('Vita reefclub gpt: kérdés\nkét sor'),
      parseOwnerCommand('Állj!').kind, parseOwnerCommand('stop').kind, parseOwnerCommand('folytasd').kind,
      parseOwnerCommand('Összegezd').kind, parseOwnerCommand('zárd le').kind, parseOwnerCommand('GPT be').kind,
      parseOwnerCommand('gpt: mit gondolsz?'), parseOwnerCommand('szerintem nem jó').kind,
    ]).toEqual([
      { kind: 'start', project: 'os', gpt: false, topic: 'Mi legyen?' },
      { kind: 'start', project: 'reefclub', gpt: true, topic: 'kérdés\nkét sor' },
      'stop', 'stop', 'continue', 'summary', 'close', 'invite_gpt',
      { kind: 'gpt', text: 'mit gondolsz?' }, 'message',
    ])
  })
})

describe('a debate, Acrobot only (the PR 1 state: no GPT runner)', () => {
  it('DEB-START: the owner starts it in the thread, bound to the project; Acrobot gets the floor with a one-time token', async () => {
    const id = await start('vita acropora-os: Mi legyen a számlázással?')
    const d = getDebate(db(), id)!
    const turns = debateTurns(db(), id)
    expect([d.project, d.status, d.gpt_invited, d.phase, turns.length, turns[0]!.status, turns[0]!.token!.length >= 10,
      told[0]!.includes(`vita-valasz ${id} ${turns[0]!.token}`), /Vita indul/.test(posts[0]!.text)], 'DEB-START').toEqual([
      'os', 'fut', 0, 1, 1, 'open', true, true, true,
    ])
  })

  it('DEB-START-REFUSED: an unknown project, or a second debate in the same thread, starts nothing', async () => {
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: '1', content: 'vita webshop: x' }, OWNER)
    const unknown = (db().prepare('SELECT COUNT(*) AS n FROM debates').get() as { n: number }).n
    await start()
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: '2', content: 'vita os: masik' }, OWNER)
    const after = (db().prepare('SELECT COUNT(*) AS n FROM debates').get() as { n: number }).n
    expect([unknown, /Ismeretlen projekt: webshop/.test(posts[0]!.text), after, posts.some((p) => /már van vita/.test(p.text))]).toEqual([0, true, 1, true])
  })

  it('DEB-ONE-ANSWER: Acrobot\'s answer is posted by the controller; without GPT the debate waits on Balázs; a second hand-in is refused', async () => {
    const id = await start()
    const token = tokenOf(told[0]!)
    const first = await submitAcrobotTurn(db(), deps(false), cfg, id, token, 'Szerintem — így — legyen.', false)
    const second = await submitAcrobotTurn(db(), deps(false), cfg, id, token, 'még egyszer', false)
    const acro = posts.filter((p) => p.text.startsWith('[Acrobot]'))
    expect([first.status, getDebate(db(), id)!.status, acro.length, acro[0]!.text, second.status], 'DEB-ONE-ANSWER').toEqual([
      200, 'var_balazsra', 1, '[Acrobot] Szerintem, így, legyen.', 409,
    ])
  })

  it('DEB-GPT-NO-RUNNER: GPT invited but no runner: its turn is skipped and said so, nothing is run, the debate waits', async () => {
    const id = await start('vita os gpt: kérdés')
    await submitAcrobotTurn(db(), deps(false), cfg, id, tokenOf(told[0]!), 'válasz', false)
    const gptTurns = debateTurns(db(), id).filter((t) => t.speaker === 'gpt')
    expect([gptTurns.map((t) => t.status), posts.some((p) => /GPT-futtató nincs bekapcsolva/.test(p.text)), getDebate(db(), id)!.status], 'DEB-GPT-NO-RUNNER')
      .toEqual([['skipped'], true, 'var_balazsra'])
  })
})

describe('rounds, with a fake GPT runner (the counting PR 2 relies on)', () => {
  it('DEB-ROUNDS: Acrobot and GPT alternate; after MAX_ROUNDS the controller stops, both summarise, then it waits', async () => {
    const id = await start('vita os gpt: kérdés', true)
    for (let r = 1; r <= MAX_ROUNDS; r++) {
      const open = debateTurns(db(), id).filter((t) => t.status === 'open')
      expect(open.map((t) => [t.speaker, t.round, t.kind]), `round ${r}`).toEqual([['acrobot', r, 'turn']])
      await submitAcrobotTurn(db(), deps(true), cfg, id, open[0]!.token!, `Acrobot ${r}`, false)
    }
    const summary = debateTurns(db(), id).filter((t) => t.status === 'open')
    await submitAcrobotTurn(db(), deps(true), cfg, id, summary[0]!.token!, 'Közös: ... Nézeteltérés: ...', false)
    const turns = debateTurns(db(), id)
    expect([
      turns.filter((t) => t.kind === 'turn' && t.speaker === 'gpt').length,
      turns.filter((t) => t.kind === 'turn' && t.speaker === 'acrobot').length,
      turns.filter((t) => t.kind === 'summary').map((t) => t.speaker),
      getDebate(db(), id)!.status,
      // GPT's answer reaches Acrobot only wrapped as untrusted data
      told.filter((m) => m.includes('GPT előző válasza')).every((m) => m.includes('<untrusted source="gpt">')),
    ], 'DEB-ROUNDS').toEqual([MAX_ROUNDS, MAX_ROUNDS, ['gpt', 'acrobot'], 'var_balazsra', true])
  })

  it('DEB-EARLY: a final answer ends the phase early (GPT agrees in round 1; Acrobot alone answers a simple question)', async () => {
    const a = await start('vita os gpt: kérdés', true)
    gptAnswers = [{ text: 'Egyetértek.', final: true }]
    await submitAcrobotTurn(db(), deps(true), cfg, a, tokenOf(told[0]!), 'javaslat', false)
    const aTurns = debateTurns(db(), a).filter((t) => t.kind === 'turn')
    await handleOwnerMessage(db(), deps(true), cfg, THREAD, { id: 'z1', content: 'zárd le' }, OWNER)
    const b = await start('vita os gpt: egyszerű kérdés', true)
    const calls = gptCalls.length
    await submitAcrobotTurn(db(), deps(true), cfg, b, tokenOf(told[told.length - 1]!), 'egyszerű válasz', true)
    expect([aTurns.length, debateTurns(db(), a).filter((t) => t.kind === 'summary').length > 0, gptCalls.length - calls, getDebate(db(), b)!.status], 'DEB-EARLY')
      .toEqual([2, true, 0, 'var_balazsra'])
  })

  it('DEB-CAP: GPT stops at the daily cap; a gpt: run counts in it and opens no round', async () => {
    const small = { ...cfg, gptDailyCap: 1 }
    const id = await start('vita os gpt: kérdés', true)
    await handleOwnerMessage(db(), deps(true), small, THREAD, { id: 'g1', content: 'gpt: mit gondolsz?' }, OWNER)
    const directOpened = debateTurns(db(), id).filter((t) => t.status === 'open').length
    await submitAcrobotTurn(db(), deps(true), small, id, tokenOf(told[0]!), 'válasz', false)
    const gpt = debateTurns(db(), id).filter((t) => t.speaker === 'gpt')
    expect([gpt.map((t) => [t.kind, t.status]), directOpened, posts.some((p) => /napi 1 futást/.test(p.text))], 'DEB-CAP').toEqual([
      [['direct', 'answered'], ['turn', 'skipped']], 1, true,
    ])
  })
})

describe('GPT runs (the multi-model plan\'s PR 2)', () => {
  it('DEB-ATTEMPTS: a run the runner FAILED counts in the daily cap (an attempt, barracuda #137); the next one is skipped by the cap', async () => {
    const small = { ...cfg, gptDailyCap: 1 }
    const id = await start('vita os gpt: kérdés', true)
    const failing: DebateDeps = { ...deps(true), runGpt: async () => { gptCalls.push('x'); throw new Error('502') } }
    await handleOwnerMessage(db(), failing, small, THREAD, { id: 'a1', content: 'gpt: első' }, OWNER)
    await handleOwnerMessage(db(), deps(true), small, THREAD, { id: 'a2', content: 'gpt: második' }, OWNER)
    const gpt = debateTurns(db(), id).filter((t) => t.speaker === 'gpt').map((t) => t.status)
    expect([gpt, gptCalls.length, posts.some((p) => /napi 1 futást/.test(p.text))], 'DEB-ATTEMPTS').toEqual([['failed', 'skipped'], 1, true])
  })

  it('DEB-RUNNING-COUNTS: a run in progress already counts (its row is written before the call)', async () => {
    const small = { ...cfg, gptDailyCap: 1 }
    const id = await start('vita os gpt: kérdés', true)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow: DebateDeps = { ...deps(true), runGpt: async () => { await gate; return { text: 'lassú', final: false } } }
    const first = handleOwnerMessage(db(), slow, small, THREAD, { id: 'r1', content: 'gpt: első' }, OWNER)
    await new Promise((r) => setTimeout(r, 10))
    const during = debateTurns(db(), id).filter((t) => t.speaker === 'gpt').map((t) => t.status)
    await handleOwnerMessage(db(), deps(true), small, THREAD, { id: 'r2', content: 'gpt: második' }, OWNER)
    release()
    await first
    expect([during, gptCalls.length], 'DEB-RUNNING-COUNTS').toEqual([['running'], 0])
  })

  it('DEB-BLOCKED: a package the filters stopped spent nothing: it does not count, the thread says which piece', async () => {
    const small = { ...cfg, gptDailyCap: 1 }
    const id = await start('vita os gpt: kérdés', true)
    const blocking: DebateDeps = { ...deps(true), runGpt: async () => { throw new GptBlocked('GPT most nem kapja meg a beszélgetést: Balázs 1. üzenete titok-alakot tartalmaz (x).', 'secret') } }
    await handleOwnerMessage(db(), blocking, small, THREAD, { id: 'b1', content: 'gpt: első' }, OWNER)
    await handleOwnerMessage(db(), deps(true), small, THREAD, { id: 'b2', content: 'gpt: második' }, OWNER)
    const gpt = debateTurns(db(), id).filter((t) => t.speaker === 'gpt').map((t) => t.status)
    expect([gpt, posts.some((p) => p.text.includes('Balázs 1. üzenete titok-alakot')), posts.some((p) => p.text.includes('GPT válasz'))], 'DEB-BLOCKED').toEqual([['blocked', 'answered'], true, true])
  })

  it('DEB-FOREIGN-ERROR: an error that is not one of ours never puts its own text into the thread, even with a publicMessage field', async () => {
    const id = await start('vita os gpt: kérdés', true)
    const odd = Object.assign(new Error('belso'), { publicMessage: 'IDEGEN SZOVEG A SZALBA' })
    const d: DebateDeps = { ...deps(true), runGpt: async () => { throw odd } }
    await handleOwnerMessage(db(), d, cfg, THREAD, { id: 'f1', content: 'gpt: kérdés' }, OWNER)
    const gpt = debateTurns(db(), id).filter((t) => t.speaker === 'gpt').map((t) => [t.status, t.text])
    expect([posts.some((p) => p.text.includes('IDEGEN SZOVEG')), posts.some((p) => /futtató hibát adott/.test(p.text)), gpt], 'DEB-FOREIGN-ERROR').toEqual([false, true, [['failed', 'a futtató hibát adott']]])
  })

  it('DEB-DEFER: with GPT in the debate, the hand-in is answered once Acrobot\'s text is posted; GPT runs after, in the background', async () => {
    const id = await start('vita os gpt: kérdés', true)
    const queued: (() => Promise<void>)[] = []
    const d: DebateDeps = { ...deps(true), defer: (w) => { queued.push(w) } }
    const out = await submitAcrobotTurn(db(), d, cfg, id, tokenOf(told[0]!), 'Acrobot 1', false)
    const before = [out.status, out.status === 200 ? out.body.next : null, gptCalls.length, posts.some((p) => p.text.includes('Acrobot 1')), queued.length]
    await queued[0]!()
    const open = debateTurns(db(), id).filter((t) => t.status === 'open' && t.speaker === 'acrobot').map((t) => t.round)
    expect([before, gptCalls.length, open], 'DEB-DEFER').toEqual([[200, 'gpt', 0, true, 1], 1, [2]])
  })

  it('DEB-DEFER-NO-GPT: without GPT nothing is deferred (quick, inline), the answer says the real state', async () => {
    const id = await start()
    const queued: (() => Promise<void>)[] = []
    const out = await submitAcrobotTurn(db(), { ...deps(false), defer: (w) => { queued.push(w) } }, cfg, id, tokenOf(told[0]!), 'válasz', false)
    expect([out.status === 200 ? out.body.next : null, queued.length], 'DEB-DEFER-NO-GPT').toEqual(['var_balazsra', 0])
  })

  it('DEB-FINAL-ASK: GPT\'s round asks for the end mark by name', async () => {
    const id = await start('vita os gpt: kérdés', true)
    await submitAcrobotTurn(db(), deps(true), cfg, id, tokenOf(told[0]!), 'Acrobot 1', false)
    expect([gptCalls.length, gptCalls[0]!.includes(FINAL_MARK)], 'DEB-FINAL-ASK').toEqual([1, true])
  })
})

describe('steering and the clocks', () => {
  it('DEB-STOP: állj closes the open round; a hand-in after it is refused', async () => {
    const id = await start()
    const token = tokenOf(told[0]!)
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 's1', content: 'állj' }, OWNER)
    const late = await submitAcrobotTurn(db(), deps(false), cfg, id, token, 'késő', false)
    expect([getDebate(db(), id)!.status, debateTurns(db(), id)[0]!.status, late.status, /leállította/.test(told[told.length - 1]!)], 'DEB-STOP')
      .toEqual(['leallitva', 'expired', 409, true])
  })

  // barracuda #137: állj runs in the poller, the hand-in on the HTTP route; they interleave, and in
  // PR 2 the GPT run takes minutes, exactly when Balázs would stop it
  it('DEB-STOP-RACE: állj during GPT\'s run: its answer does not go out, no new round opens, the debate stays stopped', async () => {
    const id = await start('vita os gpt: kérdés', true)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow: DebateDeps = { ...deps(true), runGpt: async () => { await gate; return { text: 'késő GPT', final: false } } }
    const submitting = submitAcrobotTurn(db(), slow, cfg, id, tokenOf(told[0]!), 'Acrobot 1', false)
    await new Promise((r) => setTimeout(r, 10)) // the hand-in is now inside the GPT run
    await handleOwnerMessage(db(), slow, cfg, THREAD, { id: 'race-stop', content: 'állj' }, OWNER)
    const toldAfterStop = told.length
    release()
    const out = await submitting
    const turns = debateTurns(db(), id)
    expect([
      out.status, getDebate(db(), id)!.status,
      posts.some((p) => p.text.includes('késő GPT')),
      turns.filter((t) => t.status === 'open').length,
      turns.filter((t) => t.speaker === 'gpt').map((t) => [t.status, /leállítás után/.test(t.text ?? '')]),
      told.length - toldAfterStop,
    // 'late': the runner WAS called, so it is an attempt and counts in the daily cap (barracuda, #137)
    ], 'DEB-STOP-RACE').toEqual([200, 'leallitva', false, 0, [['late', true]], 0])
  })

  it('DEB-STOP-STAYS: a stopped or closed debate is not written back to running or waiting by a late phase end', async () => {
    const id = await start()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slowPost: DebateDeps = { ...deps(false), post: async (t, x) => { if (x.startsWith('[Acrobot]')) await gate; posts.push({ thread: t, text: x }); return 'p' } }
    const submitting = submitAcrobotTurn(db(), slowPost, cfg, id, tokenOf(told[0]!), 'válasz', false)
    await new Promise((r) => setTimeout(r, 10))
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'stay-close', content: 'zárd le' }, OWNER)
    release()
    await submitting
    expect([getDebate(db(), id)!.status, posts.some((p) => /Balázs döntésére vár/.test(p.text))], 'DEB-STOP-STAYS').toEqual(['lezarva', false])
  })

  it('DEB-IDLE: running with no open round and nothing written for a turn\'s time stops as megakadt', async () => {
    const id = await start()
    db().prepare(`UPDATE debate_turns SET status = 'expired' WHERE debate_id = ?`).run(id) // as if the round was never opened
    now += cfg.turnTimeoutSeconds + 1
    const stopped = await sweepDebates(db(), deps(false), cfg)
    expect([stopped, getDebate(db(), id)!.status, posts.some((p) => /nincs nyitott kör/.test(p.text))], 'DEB-IDLE').toEqual([[id], 'megakadt', true])
  })

  // acrobot 31095, 31100: a plain reply in a waiting debate started a phase (and a GPT run)
  it('DEB-OWNER-MESSAGE: a message is kept and moves nothing, in a phase or after it; only folytasd starts the next, with the message in it', async () => {
    const id = await start()
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'm1', content: 'Figyelj a határidőre.' }, OWNER)
    const during = [getDebate(db(), id)!.phase, debateTurns(db(), id).length]
    await submitAcrobotTurn(db(), deps(false), cfg, id, tokenOf(told[0]!), 'válasz', false)
    const toldBefore = told.length
    const reply = await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'm2', content: '1' }, OWNER)
    const second = await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'm3', content: 'Megvárjuk a felmérést.' }, OWNER)
    const waiting = getDebate(db(), id)!
    const waitingState = [reply, second, waiting.phase, waiting.status, told.length === toldBefore, debateTurns(db(), id).length]
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'm4', content: 'folytasd' }, OWNER)
    const after = getDebate(db(), id)!
    expect([during, waitingState, after.phase, after.status, told[told.length - 1]!.includes('Megvárjuk a felmérést.')], 'DEB-OWNER-MESSAGE').toEqual([
      [1, 1], ['noted', 'noted', 1, 'var_balazsra', true, 1], 2, 'fut', true,
    ])
  })

  it('DEB-OWNER-MESSAGE-STALLED: a message in a stalled debate does not restart it either', async () => {
    const id = await start()
    now += cfg.turnTimeoutSeconds + 1
    await sweepDebates(db(), deps(false), cfg)
    const r = await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 's-m', content: 'Mi történt?' }, OWNER)
    expect([r, getDebate(db(), id)!.status, getDebate(db(), id)!.phase], 'DEB-OWNER-MESSAGE-STALLED').toEqual(['noted', 'megakadt', 1])
  })

  it('DEB-TIMEOUT: an Acrobot round that never comes stops the debate as megakadt, said in the thread; folytasd restarts it', async () => {
    const id = await start()
    now += cfg.turnTimeoutSeconds + 1
    const stopped = await sweepDebates(db(), deps(false), cfg)
    const state = getDebate(db(), id)!.status
    await handleOwnerMessage(db(), deps(false), cfg, THREAD, { id: 'c1', content: 'folytasd' }, OWNER)
    expect([stopped, state, posts.some((p) => /megakadt/.test(p.text)), getDebate(db(), id)!.status, getDebate(db(), id)!.phase], 'DEB-TIMEOUT')
      .toEqual([[id], 'megakadt', true, 'fut', 2])
  })
})

describe('the thread', () => {
  it('DEB-POLL: only the owner\'s messages in an allowed thread count; a bot message (an approval request) is not a round', async () => {
    const queue: { id: string; content: string; author: { id: string; bot?: boolean } }[] = []
    const transport = {
      send: async (thread: string, text: string) => { posts.push({ thread, text }); return String(5000 + posts.length) },
      read: async (_t: string, after: string) => queue.filter((m) => BigInt(m.id) > BigInt(after)),
    }
    const d = deps(false)
    await pollDebates(db(), transport, d, cfg) // the first pass only sets the cursor
    const cursor = (db().prepare('SELECT after_id FROM debate_cursors WHERE thread_id = ?').get(THREAD) as { after_id: string }).after_id
    const next = (n: number) => (BigInt(cursor) + BigInt(n)).toString()
    queue.push(
      { id: next(1), content: 'vita os: idegen', author: { id: '999' } },
      { id: next(2), content: 'vita os: bot', author: { id: OWNER, bot: true } },
      { id: next(3), content: 'vita os: a gazdáé', author: { id: OWNER } },
      { id: next(4), content: 'Jóváhagyás kérés: igen ABC123', author: { id: '42', bot: true } },
    )
    await pollDebates(db(), transport, d, cfg)
    const debates = db().prepare('SELECT topic, status FROM debates').all()
    const turns = db().prepare('SELECT COUNT(*) AS n FROM debate_turns').get() as { n: number }
    expect([debates, turns.n], 'DEB-POLL').toEqual([[{ topic: 'a gazdáé', status: 'fut' }], 1])
  })

  it('DEB-OUTBOUND: no em or en dash, no ` -- `, links without an embed, every piece at most 2000 characters', () => {
    const long = Array.from({ length: 300 }, (_, i) => `sor ${i} https://example.com/${i} — x -- y`).join('\n')
    const pieces = outboundPieces('[GPT]', long)
    expect([
      pieces.length > 1, pieces.every((p) => p.length <= DISCORD_LIMIT), pieces[0]!.startsWith('[GPT] '),
      pieces.some((p) => /[—–]| -- /.test(p)), pieces.join('\n').includes('<https://example.com/7>'),
      pieces.join('\n').includes('<<https'),
    ], 'DEB-OUTBOUND').toEqual([true, true, true, false, true, false])
  })
})

describe('the route', () => {
  function ctxOf(path: string, method: string, auth: RouteContext['auth'], body?: unknown, surface?: string) {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
    const raw = body === undefined ? '' : JSON.stringify(body)
    const req: any = { headers: {}, on(e: string, h: (arg?: unknown) => void) { if (e === 'data' && raw) h(Buffer.from(raw)); if (e === 'end') h(); return req } }
    const url = new URL(`http://localhost:3420${path}`)
    return { ctx: { req, res, path: url.pathname, method, url, auth, surface } as unknown as RouteContext, out }
  }

  it('DEB-ROUTE: a round is handed in by the main agent\'s own token only, not on the AcrovelIQ host; the list and one debate read', async () => {
    const id = await start()
    const token = tokenOf(told[0]!)
    setDebateTransportForTest(() => ({ send: async (t: string, x: string) => { posts.push({ thread: t, text: x }); return 'p1' }, read: async () => [] }))
    try {
      const path = `/api/debates/${id}/turns/${token}`
      const send = async (auth: RouteContext['auth'], surface?: string) => {
        const { ctx, out } = ctxOf(path, 'POST', auth, { text: 'route válasz', final: false }, surface)
        await tryHandleDebates(ctx)
        return out
      }
      const other = await send({ kind: 'token', actor: 'nautilus', project: 'acropora' } as RouteContext['auth'])
      const shared = await send({ kind: 'token', actor: 'legacy' } as RouteContext['auth'])
      const surface = await send({ kind: 'token', actor: MAIN_AGENT_ID, project: 'acropora' } as RouteContext['auth'], 'acroveliq')
      const main = await send({ kind: 'token', actor: MAIN_AGENT_ID, project: 'acropora' } as RouteContext['auth'])
      const again = await send({ kind: 'token', actor: MAIN_AGENT_ID, project: 'acropora' } as RouteContext['auth'])
      const list = ctxOf('/api/debates?project=acropora-os', 'GET', null as unknown as RouteContext['auth'])
      await tryHandleDebates(list.ctx)
      const one = ctxOf(`/api/debates/${id}`, 'GET', null as unknown as RouteContext['auth'])
      await tryHandleDebates(one.ctx)
      expect([other.status, shared.status, surface.status, main.status, main.body.next, again.status,
        list.out.body.map((d: { id: string }) => d.id), one.out.body.turns[0].text], 'DEB-ROUTE').toEqual([
        403, 403, 403, 200, 'var_balazsra', 409, [id], 'route válasz',
      ])
    } finally {
      setDebateTransportForTest(null)
    }
  })
})
