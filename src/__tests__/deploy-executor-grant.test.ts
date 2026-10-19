import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GRANT_APPROVAL_CATEGORY, grantCanonicalLine, GrantLineError } from '../deploy-executor/canonical.js'
import { parseExecutorConfig, type ExecutorConfig } from '../deploy-executor/config.js'
import { DeployExecutor, Refusal } from '../deploy-executor/executor.js'
import { opsFromText, parseGateOutput, PlanError, planDigest, planText, sortOps, type PlanOp } from '../deploy-executor/grant-plan.js'
import { RequestStore } from '../deploy-executor/store.js'
import {
  gateSsh,
  gateSshArgs,
  type CoolifyClient,
  type DiscordReader,
  type GateClient,
  type GateRun,
  type GitHubReader,
} from '../deploy-executor/transports.js'
import type { ChannelMessage } from '../deploy-executor/verify-approval.js'
import { buildDiscordApprovalText, descriptionMaxFor, snowflakeAt } from '../web/approval-discord-core.js'

/*
  THE GRANT BUTTON (task parancssor-a-fleet-ro-grant; design sheet v1, barracuda APPROVE and its four conditions).
  What turns these red: a grant applied without the owner's own "igen <code>" on the request message; a plan other
  than the approved one being applied (compared in ALL 64 digits, not the 16 on the line); the R spent before the
  second plan run agrees, or not spent before `alkalmaz`; an applied plan that still shows changes reported as
  verified; a gate output that is not exactly a plan being read as one; a name with a comma, a semicolon, a space or
  a quote reaching the compact text (two readings); an approval text that is cut instead of refused; a Coolify R and a
  grant R mixing; an ssh call built from anything but the allowlist and a checked commit.
*/

const BOT = '1500000000000000001'
const OWNER = '1460000000000000001'
const CHANNEL = '1540270627926183997'
const MAIN = Array.from({ length: 6 }, (_, i) => `${String(i + 1).repeat(8)}${'a'.repeat(32)}`)
const SIDE = 'f'.repeat(40)
const LIST_SHA = 'ab'.repeat(32)
const CODE = 'K7QZ'

const PLAN_LINES = [
  'GRANT SELECT (id) ON "BankTransaction" TO fleet_ro',
  'GRANT SELECT ("documentNumber") ON "BankTransaction" TO fleet_ro',
  'GRANT SELECT (migration_name) ON _prisma_migrations TO fleet_ro',
  'REVOKE SELECT (email) ON "Supplier" FROM fleet_ro',
]

function configRaw(stateDir: string) {
  return {
    stateDir,
    discord: {
      channelId: CHANNEL,
      requestBotUserId: BOT,
      deciderUserIds: [OWNER],
      yes: 'igen',
      no: 'nem',
      tokenFile: '/run/secrets/discord',
    },
    github: { tokenFile: '/run/secrets/github' },
    coolifyHosts: { 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', coolifyTokenFile: '/run/secrets/coolify-prod' } },
    apps: [
      {
        env: 'prod',
        name: 'acropora-api',
        coolifyHost: 'prod-gep',
        coolifyUuid: 'prodapi0001',
        repo: 'KratoBal/acropora-os',
        branch: 'main',
        actions: ['deploy'],
        approvalMinutes: 30,
      },
    ],
    gate: {
      host: '172.18.0.1',
      port: 22,
      user: 'fleet',
      keyFile: '/run/secrets/gate-key',
      knownHostsFile: '/run/secrets/gate-known-hosts',
    },
    grants: [
      {
        env: 'prod',
        name: 'fleet-ro',
        repo: 'KratoBal/acroveliq',
        branch: 'main',
        gateKey: 'iwm34jaqp9xmwb72qkrqkwhy',
        database: 'acropora',
        approvalMinutes: 30,
      },
    ],
  }
}

function fakeGitHub(): GitHubReader {
  return {
    async compare(_repo, base, head) {
      const resolve = (ref: string) => (ref === 'main' ? MAIN[MAIN.length - 1]! : ref)
      const [b, h] = [resolve(base), resolve(head)]
      const known = (s: string) => MAIN.includes(s) || s === SIDE
      if (!known(b) || !known(h)) return null
      if (b === SIDE || h === SIDE) return { status: b === h ? 'identical' : ('diverged' as const), baseSha: b }
      const [ib, ih] = [MAIN.indexOf(b), MAIN.indexOf(h)]
      return { status: ib === ih ? 'identical' : ib < ih ? ('ahead' as const) : ('behind' as const), baseSha: b }
    },
  }
}

function fakeCoolify() {
  const rollbacks: string[] = []
  const lists: string[] = []
  return {
    rollbacks,
    lists,
    async rollback(_h: string, _a: string, commit: string) {
      rollbacks.push(commit)
      return { deploymentUuid: 'dep1' }
    },
    async getDeployment() {
      return null
    },
    async listAppDeployments(_h: string, app: string) {
      lists.push(app)
      return []
    },
  }
}

function fakeDiscord(): DiscordReader & { messages: ChannelMessage[] } {
  const messages: ChannelMessage[] = []
  return {
    messages,
    async getMessage(_c, id) {
      return messages.find((m) => m.id === id) ?? null
    },
    async listAfter(_c, after) {
      return messages.filter((m) => BigInt(m.id) > BigInt(after))
    },
  }
}

/** A gate that answers as scripts/host/fleet-gate.sh does: a head line and the psql notices. */
function fakeGate() {
  const g = {
    calls: [] as { mode: string; key: string; db: string; commit: string }[],
    plan: [...PLAN_LINES],
    applied: false,
    /** what a `terv` after a successful `alkalmaz` shows */
    after: 'empty' as 'empty' | 'same' | 'garbage' | 'throw',
    code: { terv: 0, alkalmaz: 0 } as Record<string, number>,
    throwOn: null as null | 'terv' | 'alkalmaz',
    /** replaces the whole output of a `terv` (an unreadable one) */
    rawTerv: null as null | string,
    head: (mode: string, commit: string) =>
      `fleet-ro-grant ${mode}: commit ${commit}, lista sha256 ${LIST_SHA}, ma 2026-10-13 (Europe/Budapest)`,
    async run(mode: 'terv' | 'alkalmaz', key: string, db: string, commit: string): Promise<GateRun> {
      g.calls.push({ mode, key, db, commit })
      if (g.throwOn === mode) throw new Error('gate call did not run')
      if (g.code[mode] !== 0) return { code: g.code[mode]!, output: "fleet-gate: 'fleet-ro-grant': a lista nem tolthato le" }
      if (mode === 'terv' && g.applied) {
        if (g.after === 'throw') throw new Error('gate call timed out')
        if (g.after === 'garbage') return { code: 0, output: 'psql: error: connection refused' }
        if (g.after === 'empty') return { code: 0, output: g.head('terv', commit) }
      }
      if (mode === 'terv' && g.rawTerv !== null) return { code: 0, output: g.rawTerv }
      const out = [g.head(mode, commit), ...g.plan.map((l) => `NOTICE:  ${l}`)].join('\n')
      if (mode === 'alkalmaz') g.applied = true
      return { code: 0, output: out }
    },
  }
  return g
}

let dir: string
let config: ExecutorConfig
let clock: number
let dc: ReturnType<typeof fakeDiscord>
let gate: ReturnType<typeof fakeGate>
let cool: ReturnType<typeof fakeCoolify>
let store: RequestStore
let ex: DeployExecutor

function makeExecutor(withGate = true) {
  store = new RequestStore(config.stateDir)
  ex = new DeployExecutor({
    config,
    store,
    discord: dc,
    github: fakeGitHub(),
    coolify: cool as unknown as CoolifyClient,
    gate: withGate ? (gate as unknown as GateClient) : undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    pickInt: (() => {
      let i = 0
      return (n: number) => i++ % n
    })(),
    followEveryMs: 10_000,
    followForMs: 60_000,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-executor-grant-'))
  config = parseExecutorConfig(configRaw(join(dir, 'state')))
  clock = Date.parse('2026-10-13T10:00:00Z')
  dc = fakeDiscord()
  gate = fakeGate()
  cool = fakeCoolify()
  makeExecutor()
})
afterEach(async () => {
  await Promise.all(ex.following)
  rmSync(dir, { recursive: true, force: true })
})

const tick = (ms = 1000) => (clock += ms)
const grantReq = (over: Record<string, unknown> = {}) =>
  ex.request({ env: 'prod', app: 'fleet-ro', action: 'fleet-ro-grant', sha: MAIN[4], requester: 'acrobot', ...over })

function postRequest(rec: { canonicalLine: string; expiresAt: number }, opts: { category?: string; text?: string } = {}): ChannelMessage {
  const m: ChannelMessage = {
    id: snowflakeAt(tick()),
    channel_id: CHANNEL,
    content:
      opts.text ??
      buildDiscordApprovalText(
        {
          agent_id: 'acrobot',
          category: opts.category ?? GRANT_APPROVAL_CATEGORY,
          action_description: rec.canonicalLine,
          timeout_at: rec.expiresAt - 60,
        },
        CODE,
        { yes: 'igen', no: 'nem', requireReply: true },
      ),
    author: { id: BOT, bot: true },
    edited_timestamp: null,
  }
  dc.messages.push(m)
  return m
}

function reply(to: ChannelMessage, content = `igen ${CODE}`) {
  dc.messages.push({
    id: snowflakeAt(tick()),
    channel_id: CHANNEL,
    content,
    author: { id: OWNER },
    message_reference: { message_id: to.id },
    edited_timestamp: null,
  })
}

async function approvedGrant(over: Record<string, unknown> = {}) {
  const rec = await grantReq(over)
  tick(5000)
  const msg = postRequest(rec)
  tick(5000)
  reply(msg)
  tick(5000)
  return { rec, msg }
}

async function refusedWith(p: Promise<unknown>, part: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Refusal)
  expect((err as Refusal).reason).toContain(part)
}

const callModes = () => gate.calls.map((c) => c.mode)

describe('reading the gate output', () => {
  const COMMIT = MAIN[4]!
  const head = (mode = 'terv', commit = COMMIT) =>
    `fleet-ro-grant ${mode}: commit ${commit}, lista sha256 ${LIST_SHA}, ma 2026-10-13 (Europe/Budapest)`
  const parse = (lines: string[], mode: 'terv' | 'alkalmaz' = 'terv') => parseGateOutput(lines.join('\n'), { mode, commit: COMMIT })

  it('reads the head and the ops, with or without the notice prefix, quoted and bare names', () => {
    const plan = parse([
      head(),
      'GRANT SELECT (id) ON "BankTransaction" TO fleet_ro',
      'NOTICE:  GRANT SELECT ("documentNumber") ON "BankTransaction" TO fleet_ro',
      'psql:<stdin>:12: NOTICE:  REVOKE SELECT (email) ON "Supplier" FROM fleet_ro',
      '',
    ])
    expect(plan.ops).toEqual([
      { sign: '+', table: 'BankTransaction', column: 'documentNumber' },
      { sign: '+', table: 'BankTransaction', column: 'id' },
      { sign: '-', table: 'Supplier', column: 'email' },
    ])
    expect([plan.commit, plan.listSha256, plan.today]).toEqual([COMMIT, LIST_SHA, '2026-10-13'])
    expect(plan.planSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['a line that is neither head nor op', [head(), 'BEGIN']],
    ['no head line', ['GRANT SELECT (id) ON "A" TO fleet_ro']],
    ['two head lines', [head(), head()]],
    ['the head of another mode', [head('alkalmaz')]],
    ['the head of another commit', [head('terv', MAIN[3])]],
    ['a GRANT that says FROM', [head(), 'GRANT SELECT (id) ON "A" FROM fleet_ro']],
    ['a REVOKE that says TO', [head(), 'REVOKE SELECT (id) ON "A" TO fleet_ro']],
    ['another grantee', [head(), 'GRANT SELECT (id) ON "A" TO acropora']],
    ['another privilege', [head(), 'GRANT UPDATE (id) ON "A" TO fleet_ro']],
    ['a quoted name with a comma', [head(), 'GRANT SELECT ("a,b") ON "A" TO fleet_ro']],
    ['a quoted name with a semicolon', [head(), 'GRANT SELECT (id) ON "A;B" TO fleet_ro']],
    ['a quoted name with a space', [head(), 'GRANT SELECT ("a b") ON "A" TO fleet_ro']],
    ['a quote inside a quoted name', [head(), 'GRANT SELECT ("a""b") ON "A" TO fleet_ro']],
    ['a name with a hyphen', [head(), 'GRANT SELECT ("a-b") ON "A" TO fleet_ro']],
    ['a column twice', [head(), 'GRANT SELECT (id) ON "A" TO fleet_ro', 'NOTICE:  GRANT SELECT (id) ON "A" TO fleet_ro']],
    ['one column granted and revoked', [head(), 'GRANT SELECT (id) ON "A" TO fleet_ro', 'REVOKE SELECT (id) ON "A" FROM fleet_ro']],
    ['two columns in one op', [head(), 'GRANT SELECT (id, name) ON "A" TO fleet_ro']],
    ['an error from psql', [head(), 'ERROR:  permission denied for table A']],
  ])('refuses %s', (_n, lines) => {
    expect(() => parse(lines)).toThrow(PlanError)
  })

  it('an empty plan is a plan: the head alone, no ops', () => {
    expect(parse([head()]).ops).toEqual([])
  })

  it('the digest is of the commit, the list and every op: any change moves it, the order of the lines does not', () => {
    const a = parse([head(), 'GRANT SELECT (id) ON "A" TO fleet_ro', 'GRANT SELECT (name) ON "B" TO fleet_ro'])
    const reordered = parse([head(), 'GRANT SELECT (name) ON "B" TO fleet_ro', 'GRANT SELECT (id) ON "A" TO fleet_ro'])
    const other = parse([head(), 'GRANT SELECT (id) ON "A" TO fleet_ro', 'GRANT SELECT (nam) ON "B" TO fleet_ro'])
    const revoke = parse([head(), 'GRANT SELECT (id) ON "A" TO fleet_ro', 'REVOKE SELECT (name) ON "B" FROM fleet_ro'])
    expect(reordered.planSha256).toBe(a.planSha256)
    expect(new Set([a.planSha256, other.planSha256, revoke.planSha256]).size).toBe(3)
    const ops = a.ops
    expect(planDigest(COMMIT, LIST_SHA, ops)).toBe(a.planSha256)
    expect(planDigest(MAIN[3]!, LIST_SHA, ops)).not.toBe(a.planSha256)
    expect(planDigest(COMMIT, 'cd'.repeat(32), ops)).not.toBe(a.planSha256)
  })
})

describe('the compact approval text', () => {
  const ops = (lines: string[]) =>
    parseGateOutput(
      [`fleet-ro-grant terv: commit ${MAIN[4]}, lista sha256 ${LIST_SHA}, ma 2026-10-13 (Europe/Budapest)`, ...lines].join('\n'),
      { mode: 'terv', commit: MAIN[4]! },
    ).ops

  it('has one fixed shape: grants then revokes, tables and columns sorted, an underscore shown as a dot', () => {
    expect(planText(ops(PLAN_LINES))).toBe(
      'a nevekben a pont az alahuzas jele / GRANT SELECT TO fleet-ro: +BankTransaction documentNumber,id; +.prisma.migrations migration.name / REVOKE SELECT FROM fleet-ro: -Supplier email',
    )
  })

  it('names every op once and none else: the text read back is the plan', () => {
    const plan = ops(PLAN_LINES)
    expect(sortOps(opsFromText(planText(plan)))).toEqual(sortOps(plan))
    // the same plan in another order gives the same text
    expect(planText(ops([...PLAN_LINES].reverse()))).toBe(planText(plan))
  })

  it("survives #33's neutraliser unchanged (no underscore, star, tilde, bar, bracket, hash or backtick in it)", () => {
    const line = grantCanonicalLine({
      id: 'ABCD2345',
      env: 'prod',
      app: 'fleet-ro',
      sha: MAIN[4]!,
      listSha256: LIST_SHA,
      planSha256: 'cd'.repeat(32),
      planText: planText(ops(PLAN_LINES)),
    })
    expect(line).not.toMatch(/[`>#*_~|]/)
    expect(line).toContain(`/ ${MAIN[4]} / lista abababababababab / terv cdcdcdcdcdcdcdcd / `)
  })

  it("fits today's whole list: the first application of docs/fleet-gate.md, 16 tables and 67 columns, well under the category limit", () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'fleet-gate.md'), 'utf8')
    const block = /```fleet-ro-grant\n([\s\S]*?)```/.exec(doc)![1]!
    const all: PlanOp[] = []
    for (const row of block.split('\n')) {
      if (!row.trim() || row.startsWith('#')) continue
      const [table, cols] = row.split(' ')
      for (const column of cols!.split(',')) all.push({ sign: '+', table: table!, column })
    }
    // the control: the reading of the list found what the document has
    expect(all.length).toBeGreaterThan(60)
    const line = grantCanonicalLine({
      id: 'ABCD2345',
      env: 'prod',
      app: 'fleet-ro',
      sha: MAIN[4]!,
      listSha256: LIST_SHA,
      planSha256: 'cd'.repeat(32),
      planText: planText(all),
    })
    expect(line.length).toBeLessThan(descriptionMaxFor(GRANT_APPROVAL_CATEGORY) - 200)
    // and the full GRANT SELECT ... TO fleet_ro form would not have fitted: why the text is compact
    const verbose = all.map((o) => `GRANT SELECT (${o.column}) ON ${o.table} TO fleet_ro`).join('; ')
    expect(verbose.length).toBeGreaterThan(descriptionMaxFor(GRANT_APPROVAL_CATEGORY) - 200)
  })

  it('a plan too long for the category is refused, never cut', () => {
    const huge: PlanOp[] = Array.from({ length: 400 }, (_, i) => ({ sign: '+' as const, table: `Table${i}`, column: `column${i}` }))
    expect(() =>
      grantCanonicalLine({
        id: 'ABCD2345',
        env: 'prod',
        app: 'fleet-ro',
        sha: MAIN[4]!,
        listSha256: LIST_SHA,
        planSha256: 'cd'.repeat(32),
        planText: planText(huge),
      }),
    ).toThrow(GrantLineError)
  })
})

describe('asking for a grant', () => {
  it('records the plan, builds the line, and uses the grant category', async () => {
    const rec = await grantReq()
    expect(rec.action).toBe('fleet-ro-grant')
    expect(rec.sha).toBe(MAIN[4])
    expect(rec.canonicalLine).toMatch(
      /^VEGREHAJTO R=[A-Z0-9]{8} \/ prod \/ fleet-ro \/ fleet-ro-grant \/ [0-9a-f]{40} \/ lista [0-9a-f]{16} \/ terv [0-9a-f]{16} \/ /,
    )
    expect(rec.canonicalLine).toContain('GRANT SELECT TO fleet-ro: +BankTransaction documentNumber,id; +.prisma.migrations migration.name')
    expect(rec.canonicalLine).toContain('REVOKE SELECT FROM fleet-ro: -Supplier email')
    const stored = store.get(rec.r)!
    expect(stored.category).toBe(GRANT_APPROVAL_CATEGORY)
    expect(stored.grant!.planSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.grant!.ops).toEqual([
      '+ BankTransaction documentNumber',
      '+ BankTransaction id',
      '+ _prisma_migrations migration_name',
      '- Supplier email',
    ])
    // the line shows the first 16 digits of the digest the record keeps in full
    expect(rec.canonicalLine).toContain(`terv ${stored.grant!.planSha256.slice(0, 16)}`)
    expect(gate.calls).toEqual([{ mode: 'terv', key: 'iwm34jaqp9xmwb72qkrqkwhy', db: 'acropora', commit: MAIN[4] }])
  })

  it('runs only `terv` (a read-only plan) and never `alkalmaz`', async () => {
    await grantReq()
    expect(callModes()).toEqual(['terv'])
  })

  it('refuses a target off the allowlist, a commit off the branch, and an unconfigured door', async () => {
    await refusedWith(grantReq({ app: 'masik' }), 'not on the allowlist')
    await refusedWith(grantReq({ env: 'stage' }), 'not on the allowlist')
    await refusedWith(grantReq({ sha: SIDE }), 'not part of the branch')
    makeExecutor(false)
    await refusedWith(grantReq(), 'not configured')
    expect(gate.calls).toEqual([])
  })

  it('an empty plan has nothing to approve', async () => {
    gate.plan = []
    await refusedWith(grantReq(), 'plan is empty')
  })

  it('a gate refusal and an output that is not a plan are refusals, and the audit keeps one visible line of it', async () => {
    gate.code.terv = 2
    await refusedWith(grantReq(), 'the gate refused the terv (exit 2)')
    gate.code.terv = 0
    gate.rawTerv = 'psql: error: connection to server failed'
    await refusedWith(grantReq(), 'could not be read as a plan')
    const audit = readFileSync(join(config.stateDir, 'audit.log'), 'utf8')
    expect(audit).toContain('plan_unreadable')
    expect(audit).toContain('connection to server failed')
  })

  it('a plan that does not fit the approval text: refused with the reason, nothing recorded', async () => {
    gate.plan = Array.from({ length: 400 }, (_, i) => `GRANT SELECT (column${i}) ON "Table${i}" TO fleet_ro`)
    await refusedWith(grantReq(), 'terv-nem-fer-a-gombra')
    expect(store.ids()).toEqual([])
  })

  it('a transport failure is not a refusal: it surfaces as an error (the door answers 502)', async () => {
    gate.throwOn = 'terv'
    const err = await grantReq().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(Refusal)
  })
})

describe('applying the approved grant', () => {
  const exec = (rec: { r: string }, msg: ChannelMessage) => ex.execute({ r: rec.r, requestMessageId: msg.id })

  it('the whole order: plan at request, plan again, the R spent, `alkalmaz`, plan once more; verified when that one is empty', async () => {
    const { rec, msg } = await approvedGrant()
    const out = await exec(rec, msg)
    expect([out.status, out.outcome]).toEqual(['used', 'finished_verified'])
    expect(callModes()).toEqual(['terv', 'terv', 'alkalmaz', 'terv'])
    // the same key, database and commit every time, from the record and the allowlist
    expect(new Set(gate.calls.map((c) => `${c.key} ${c.db} ${c.commit}`))).toEqual(
      new Set([`iwm34jaqp9xmwb72qkrqkwhy acropora ${MAIN[4]}`]),
    )
    expect(cool.rollbacks).toEqual([])
  })

  it("`alkalmaz` does not run without the owner's answer", async () => {
    const rec = await grantReq()
    tick(5000)
    const msg = postRequest(rec)
    await refusedWith(exec(rec, msg), 'no decision')
    expect(callModes()).toEqual(['terv'])
    expect(store.get(rec.r)!.status).toBe('open')
  })

  it("an approval text with another category is not the R's text (the category is part of what the owner read)", async () => {
    const rec = await grantReq()
    tick(5000)
    const msg = postRequest(rec, { category: 'coolify_deploy' })
    tick(5000)
    reply(msg)
    await refusedWith(exec(rec, msg), 'text differs')
    expect(callModes()).toEqual(['terv'])
  })

  it('a plan that moved since the approval is refused, the R stays unused, and `alkalmaz` never runs', async () => {
    const { rec, msg } = await approvedGrant()
    gate.plan = [...PLAN_LINES, 'GRANT SELECT (extra) ON "BankTransaction" TO fleet_ro']
    await refusedWith(exec(rec, msg), 'plan changed since the approval')
    expect(callModes()).toEqual(['terv', 'terv'])
    expect(store.get(rec.r)!.status).toBe('open')
  })

  it('compares ALL 64 digits of the record: a plan whose first 16 digits match but the rest do not is refused', async () => {
    const { rec, msg } = await approvedGrant()
    const stored = store.get(rec.r)!
    const real = stored.grant!.planSha256
    // the record keeps a digest that agrees with the line (and the live plan) for 16 digits and differs after
    stored.grant!.planSha256 = `${real.slice(0, 16)}${real.slice(16).replace(/./g, (c) => (c === '0' ? '1' : '0'))}`
    expect(stored.grant!.planSha256.slice(0, 16)).toBe(real.slice(0, 16))
    expect(stored.grant!.planSha256).not.toBe(real)
    store.put(stored)
    await refusedWith(exec(rec, msg), 'plan changed since the approval')
    expect(callModes()).toEqual(['terv', 'terv'])
    expect(store.get(rec.r)!.status).toBe('open')
  })

  it('the R is spent before `alkalmaz`, and a second execution is refused', async () => {
    const { rec, msg } = await approvedGrant()
    let statusAtApply = ''
    const run = gate.run.bind(gate)
    gate.run = async (mode, key, db, commit) => {
      if (mode === 'alkalmaz') statusAtApply = `${store.get(rec.r)!.status}/${store.get(rec.r)!.outcome}`
      return run(mode, key, db, commit)
    }
    await exec(rec, msg)
    expect(statusAtApply).toBe('used/calling')
    await refusedWith(exec(rec, msg), 'already used')
    expect(callModes().filter((m) => m === 'alkalmaz')).toHaveLength(1)
  })

  it('`alkalmaz` failing (exit code or no answer) spends the R and says so', async () => {
    const a = await approvedGrant()
    gate.code.alkalmaz = 1
    expect((await exec(a.rec, a.msg)).outcome).toBe('alkalmaz_hiba')
    expect(store.get(a.rec.r)!.status).toBe('used')
    gate.code.alkalmaz = 0
    const b = await approvedGrant()
    gate.throwOn = 'alkalmaz'
    expect((await exec(b.rec, b.msg)).outcome).toBe('alkalmaz_hiba')
    expect(callModes().filter((m) => m === 'alkalmaz')).toHaveLength(2)
  })

  it('an applied plan that still shows changes is not verified; one that cannot be read is not verified either', async () => {
    const a = await approvedGrant()
    gate.after = 'same'
    expect((await exec(a.rec, a.msg)).outcome).toBe('terv_nem_ures')
    gate.applied = false
    gate.after = 'garbage'
    const b = await approvedGrant()
    expect((await exec(b.rec, b.msg)).outcome).toBe('utomeres_nem_olvashato')
    gate.applied = false
    gate.after = 'throw'
    const c = await approvedGrant()
    expect((await exec(c.rec, c.msg)).outcome).toBe('utomeres_nem_olvashato')
  })

  it('the allowlist is read again: an entry gone since the request refuses, and so does a changed key or database', async () => {
    const { rec, msg } = await approvedGrant()
    const raw = configRaw(config.stateDir)
    raw.grants[0]!.database = 'masik'
    config = parseExecutorConfig(raw)
    makeExecutor()
    await refusedWith(exec(rec, msg), 'no longer on the allowlist')
    expect(callModes()).toEqual(['terv'])
  })

  it('a grant R never reaches Coolify, and a deploy R never reaches the gate', async () => {
    const grant = await approvedGrant()
    await exec(grant.rec, grant.msg)
    expect(cool.rollbacks).toEqual([])
    gate.calls.length = 0
    const deploy = await ex.request({ env: 'prod', app: 'acropora-api', action: 'deploy', sha: MAIN[4], requester: 'acrobot' })
    expect(gate.calls).toEqual([])
    expect(store.get(deploy.r)!.grant).toBeUndefined()
    expect(store.get(deploy.r)!.category).toBeUndefined()
    // a deploy request cannot name a grant target, and a grant request cannot name a Coolify app
    await refusedWith(
      ex.request({ env: 'prod', app: 'fleet-ro', action: 'deploy', sha: MAIN[4], requester: 'acrobot' }),
      'not on the allowlist',
    )
    await refusedWith(grantReq({ app: 'acropora-api' }), 'not on the allowlist')
  })

  it('a grant R left `calling` after a restart is `interrupted`, with no Coolify call', async () => {
    const { rec } = await approvedGrant()
    const stored = store.get(rec.r)!
    stored.status = 'used'
    stored.outcome = 'calling'
    stored.usedAt = Math.floor(clock / 1000)
    store.put(stored)
    makeExecutor()
    const out = await ex.recover()
    expect(out.interrupted).toEqual([rec.r])
    expect(store.get(rec.r)!.outcome).toBe('interrupted')
    // no Coolify deployment list was read for it: a grant R has no application to look in
    expect(cool.lists).toEqual([])
    expect(cool.rollbacks).toEqual([])
  })
})

describe('the settings of the grant door', () => {
  const clone = () => JSON.parse(JSON.stringify(configRaw('/var/lib/vegrehajto'))) as Record<string, any>

  it('parse with both keys; the old file without them still parses, with the door off', () => {
    const c = parseExecutorConfig(clone())
    expect([c.gate!.host, c.gate!.user, c.grants[0]!.gateKey]).toEqual(['172.18.0.1', 'fleet', 'iwm34jaqp9xmwb72qkrqkwhy'])
    const old = clone()
    delete old['gate']
    delete old['grants']
    const o = parseExecutorConfig(old)
    expect([o.gate, o.grants]).toEqual([null, []])
  })

  const bad: [string, (c: Record<string, any>) => void][] = [
    [
      'grants without gate',
      (c) => {
        delete c['gate']
      },
    ],
    [
      'gate without grants',
      (c) => {
        delete c['grants']
      },
    ],
    [
      'no grants',
      (c) => {
        c['grants'] = []
      },
    ],
    [
      'a host that starts with a hyphen (an ssh option)',
      (c) => {
        c['gate'].host = '-oProxyCommand=x'
      },
    ],
    [
      'a host with a space',
      (c) => {
        c['gate'].host = 'a b'
      },
    ],
    [
      'a user with a slash',
      (c) => {
        c['gate'].user = 'fleet/x'
      },
    ],
    [
      'a port of zero',
      (c) => {
        c['gate'].port = 0
      },
    ],
    [
      'a port as a string',
      (c) => {
        c['gate'].port = '22'
      },
    ],
    [
      'a relative key file',
      (c) => {
        c['gate'].keyFile = 'gate-key'
      },
    ],
    [
      'a known hosts file with ..',
      (c) => {
        c['gate'].knownHostsFile = '/run/../etc/known_hosts'
      },
    ],
    [
      'an unknown key in the gate',
      (c) => {
        c['gate'].extra = 1
      },
    ],
    [
      'a gate key with a space',
      (c) => {
        c['grants'][0].gateKey = 'iwm34 jaqp9'
      },
    ],
    [
      'a database with a quote',
      (c) => {
        c['grants'][0].database = "acropora'"
      },
    ],
    [
      'a duplicate env/name',
      (c) => {
        c['grants'].push({ ...c['grants'][0] })
      },
    ],
    [
      'an approval window over the limit',
      (c) => {
        c['grants'][0].approvalMinutes = 61
      },
    ],
  ]
  it.each(bad)('refuses %s', (_n, change) => {
    const c = clone()
    change(c)
    expect(() => parseExecutorConfig(c)).toThrow(/executor config/)
  })

  it('the example in the repository parses (the shape an installer copies)', () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), 'deploy-executor', 'config.example.json'), 'utf8'))
    const parsed = parseExecutorConfig(example)
    expect([parsed.gate !== null, parsed.grants.length]).toEqual([true, 1])
  })
})

describe('the ssh call', () => {
  const gateCfg = {
    host: '172.18.0.1',
    port: 22,
    user: 'fleet',
    keyFile: '/run/secrets/gate-key',
    knownHostsFile: '/run/secrets/gate-known-hosts',
  }

  it('is built from the allowlist and a checked commit, in a fixed shape, the destination after `--`', () => {
    const args = gateSshArgs(gateCfg, 'terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!)
    expect(args.slice(-3)).toEqual(['--', 'fleet@172.18.0.1', `fleet-ro-grant iwm34jaqp9xmwb72qkrqkwhy acropora ${MAIN[4]} terv`])
    const joined = args.join(' ')
    for (const wanted of [
      '-F /dev/null',
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UserKnownHostsFile=/run/secrets/gate-known-hosts',
      'GlobalKnownHostsFile=/dev/null',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'ForwardAgent=no',
      'RequestTTY=no',
      '-i /run/secrets/gate-key',
      '-p 22',
    ]) {
      expect(joined, wanted).toContain(wanted)
    }
    expect(gateSshArgs(gateCfg, 'alkalmaz', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!).at(-1)).toMatch(/ alkalmaz$/)
  })

  it.each([
    ['another mode', ['szukit' as never, 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!]],
    ['a short commit', ['terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!.slice(0, 12)]],
    ['an upper-case commit', ['terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!.toUpperCase()]],
    ['a commit with a shell word', ['terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', `${MAIN[4]!.slice(0, 30)}; rm -rf /`]],
    ['a key with a space', ['terv', 'iwm34 jaqp9xmwb72', 'acropora', MAIN[4]!]],
    ['a database with a semicolon', ['terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'a;b', MAIN[4]!]],
  ] as [string, ['terv' | 'alkalmaz', string, string, string]][])('refuses %s before any process', (_n, [mode, key, db, commit]) => {
    expect(() => gateSshArgs(gateCfg, mode, key, db, commit)).toThrow()
  })

  it("runs ssh with an argument list and a clean environment; an exit code is the gate's answer, both streams are read", async () => {
    const fake = join(dir, 'ssh')
    writeFileSync(
      fake,
      '#!/bin/sh\necho "args:$#"\necho "env:${SSH_AUTH_SOCK:-none}:${HOME}" >&2\necho "last:$(for a; do :; done; echo "$a")" >&2\nexit 3\n',
    )
    chmodSync(fake, 0o755)
    process.env['SSH_AUTH_SOCK'] = '/tmp/should-not-pass'
    try {
      const run = await gateSsh(gateCfg, fake).run('terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!)
      expect(run.code).toBe(3)
      expect(run.output).toContain('env:none:/nonexistent')
      expect(run.output).toContain(`last:fleet-ro-grant iwm34jaqp9xmwb72qkrqkwhy acropora ${MAIN[4]} terv`)
    } finally {
      delete process.env['SSH_AUTH_SOCK']
    }
  })

  it('a missing ssh is no answer: it rejects, it does not look like a refusal of the gate', async () => {
    await expect(gateSsh(gateCfg, join(dir, 'nincs-ssh')).run('terv', 'iwm34jaqp9xmwb72qkrqkwhy', 'acropora', MAIN[4]!)).rejects.toThrow(
      'did not run',
    )
    expect(existsSync(join(dir, 'nincs-ssh'))).toBe(false)
  })

  it('the transport module starts a process only with execFile and an argument array: no shell', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'deploy-executor', 'transports.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    expect(code).toMatch(/import \{ execFile \} from 'node:child_process'/)
    expect(code).not.toMatch(/\b(spawn|spawnSync|execSync|execFileSync|fork)\(|\bexec\(|shell:\s*true/)
    expect(code.match(/execFile\(/g)).toHaveLength(1)
  })
})

describe('the install files of the grant door', () => {
  const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')
  const noComments = (text: string) =>
    text
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')

  it('the grant category has its own limit, the others keep theirs', () => {
    expect([descriptionMaxFor('fleet_ro_grant'), descriptionMaxFor('coolify_deploy'), descriptionMaxFor('root_telepites')]).toEqual([
      1500, 500, 1500,
    ])
  })

  it('the compose file gives the gate key and the pinned host key to the executor only, as file secrets under titkok', () => {
    const compose = noComments(read('deploy-executor', 'compose.yaml'))
    expect(compose).toMatch(/^ {2}gate-key:\n {4}file: \/opt\/vegrehajto\/titkok\/gate-key$/m)
    expect(compose).toMatch(/^ {2}gate-known-hosts:\n {4}file: \/opt\/vegrehajto\/titkok\/gate-known-hosts$/m)
    const executor = /^ {2}vegrehajto:\n([\s\S]*?)(?=^\S)/m.exec(compose)![1]!
    expect(executor).toMatch(/^ {6}- gate-key$/m)
    expect(executor).toMatch(/^ {6}- gate-known-hosts$/m)
    const ts = /^ {2}ts:\n([\s\S]*?)(?=^ {2}vegrehajto:)/m.exec(compose)![1]!
    expect(ts).not.toMatch(/gate-/)
    // the hardening did not move
    for (const must of [/^ {4}read_only: true$/m, /^ {4}cap_drop:\n {6}- ALL$/m, /^ {4}user: "10001:10001"$/m])
      expect(executor).toMatch(must)
  })

  it("the image gets ssh from Debian's repository without recommends, prints its version, and the uid gets an account", () => {
    const docker = noComments(read('deploy-executor', 'Dockerfile'))
    expect(docker).toMatch(/apt-get install -y --no-install-recommends openssh-client/)
    expect(docker).toMatch(/&& ssh -V/)
    expect(docker).toMatch(/groupadd -g 10001 vegrehajto/)
    expect(docker).toMatch(/useradd -u 10001 -g 10001 -M -d \/nonexistent -s \/usr\/sbin\/nologin vegrehajto/)
    // the user is switched only AFTER the packages went in
    expect(docker.indexOf('openssh-client')).toBeLessThan(docker.indexOf('USER 10001:10001'))
  })

  it("the install sheet names the key line with `restrict`, `from=` and the gate's executor role, and the thief's reach", () => {
    const readme = read('deploy-executor', 'README.md')
    expect(readme).toContain('restrict,from="<the executor\'s source address>",command="/usr/local/sbin/fleet-gate vegrehajto"')
    expect(readme).toContain("For that key's thief the\nowner's approval step falls away")
    expect(readme).toContain('/etc/ssh/ssh_host_ed25519_key.pub')
    expect(readme).toContain('ssh -V')
    expect(read('docs', 'fleet-gate.md')).toContain(
      'restrict,from="<a végrehajtó forráscíme>",command="/usr/local/sbin/fleet-gate vegrehajto"',
    )
  })
})
