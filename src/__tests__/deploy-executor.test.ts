import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalLine } from '../deploy-executor/canonical.js'
import { parseExecutorConfig, type ExecutorConfig } from '../deploy-executor/config.js'
import {
  DeployExecutor,
  EXECUTIONS_PER_MINUTE,
  MAX_OPEN_REQUESTS,
  PRUNE_AFTER_DAYS,
  RateLimited,
  Refusal,
  REQUESTS_PER_MINUTE,
} from '../deploy-executor/executor.js'
import { RequestStore } from '../deploy-executor/store.js'
import {
  coolifyRest,
  discordRest,
  githubRest,
  healthHttp,
  type CoolifyClient,
  type CoolifyDeployment,
  type DiscordReader,
  type GitHubReader,
  type HealthProbe,
} from '../deploy-executor/transports.js'
import { findDisplayedExpiry, type ChannelMessage } from '../deploy-executor/verify-approval.js'
import * as discordModule from '../web/approval-discord.js'
import {
  buildDiscordApprovalText,
  formatApprovalExpiry,
  matchDecisions,
  neutralDescription,
  snowflakeAt,
} from '../web/approval-discord-core.js'

/*
  THE SEPARATE DEPLOY EXECUTOR (SB1). What turns these red: a deployment
  without the owner's own Discord "igen <code>" on the request message; a
  request message that says anything other than what the executor recorded
  (another description, a fifth line, an edit, another author, a later
  expiry); a reply from someone else, a "nem" first, an edited reply, a
  non-reply; an R used twice (also across a restart, also by two calls at
  once); an application, environment or action off the allowlist; a commit
  that is not a full sha on the branch; a step back not written into the
  approved line; a running version that changed after the approval; a deploy
  of anything but the approved commit; a failed Coolify call that leaves the R
  reusable; a deployment that built another commit reported as verified; a
  token or anything Coolify sent besides commit and status leaving the
  executor.
*/

const BOT = '1500000000000000001'
const OWNER = '1460000000000000001'
const OTHER = '1460000000000000002'
const CHANNEL = '1540270627926183997'

// a linear main branch, oldest first, and one commit that is not on it
const MAIN = Array.from({ length: 6 }, (_, i) => `${String(i + 1).repeat(8)}${'a'.repeat(32)}`)
const SIDE = 'f'.repeat(40)
const SECRET = 'cl-SECRET-token-value-0123456789'

function configRaw(stateDir: string) {
  return {
    stateDir,
    discord: { channelId: CHANNEL, requestBotUserId: BOT, deciderUserIds: [OWNER], yes: 'igen', no: 'nem', tokenFile: '/run/secrets/discord' },
    github: { tokenFile: '/run/secrets/github' },
    coolifyHosts: {
      'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', coolifyTokenFile: '/run/secrets/coolify-prod' },
      'ai-gep': { coolifyApiUrl: 'http://100.64.0.1:8000/api/v1', coolifyTokenFile: '/run/secrets/coolify-ai' },
    },
    apps: [
      { env: 'prod', name: 'acropora-api', coolifyHost: 'prod-gep', coolifyUuid: 'prodapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30 },
      { env: 'stage', name: 'acropora-stage-api', coolifyHost: 'ai-gep', coolifyUuid: 'stageapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30 },
      // a production app on the AI machine's Coolify (three-changes 3)
      { env: 'prod', name: 'acropora-ai-api', coolifyHost: 'ai-gep', coolifyUuid: 'aiapi00001', repo: 'KratoBal/acropora-ai', branch: 'main', actions: ['deploy'], approvalMinutes: 30 },
    ],
  }
}

function fakeGitHub(): GitHubReader & { main: string[]; calls: number } {
  const g = {
    main: [...MAIN],
    calls: 0,
    async compare(_repo: string, base: string, head: string) {
      g.calls++
      const resolve = (ref: string) => (ref === 'main' ? g.main[g.main.length - 1]! : ref)
      const [b, h] = [resolve(base), resolve(head)]
      const known = (s: string) => g.main.includes(s) || s === SIDE
      if (!known(b) || !known(h)) return null
      if (b === SIDE || h === SIDE) return { status: b === h ? 'identical' : ('diverged' as const), baseSha: b }
      const [ib, ih] = [g.main.indexOf(b), g.main.indexOf(h)]
      return { status: ib === ih ? 'identical' : ib < ih ? ('ahead' as const) : ('behind' as const), baseSha: b }
    },
  }
  return g as GitHubReader & { main: string[]; calls: number }
}

function fakeCoolify() {
  const running: Record<string, string> = { prodapi0001: MAIN[2]!, stageapi0001: MAIN[2]!, aiapi00001: MAIN[2]! }
  const rollbacks: { host: string; app: string; commit: string }[] = []
  const deployments = new Map<string, CoolifyDeployment & { logs?: string }>()
  const c = {
    running,
    rollbacks,
    deployments,
    failList: false,
    /** what Coolify lists before the fixed history, newest first */
    extra: [] as CoolifyDeployment[],
    rollbackResult: 'queue' as 'queue' | 'skip' | 'throw',
    async rollback(host: string, app: string, commit: string) {
      rollbacks.push({ host, app, commit })
      if (c.rollbackResult === 'throw') throw new Error('Coolify API 500')
      if (c.rollbackResult === 'skip') return { deploymentUuid: null }
      const uuid = `dep${rollbacks.length}`
      // what a real record may carry besides commit and status
      deployments.set(uuid, { commit, status: 'in_progress', pullRequestId: 0, logs: `DATABASE_URL=${SECRET}` })
      return { deploymentUuid: uuid }
    },
    async getDeployment(_env: string, uuid: string) {
      return deployments.get(uuid) ?? null
    },
    async listAppDeployments(_env: string, app: string) {
      if (c.failList) throw new Error('Coolify API 403')
      return [
        ...c.extra,
        { commit: 'b'.repeat(40), status: 'failed', pullRequestId: 0 },
        { commit: 'c'.repeat(40), status: 'finished', pullRequestId: 7 },
        { commit: running[app] ?? null, status: 'finished', pullRequestId: 0 },
      ]
    },
  }
  return c
}

/** The public health address: each look pops the next scripted answer, the last one repeats; a function answer may throw. */
function fakeHealth(script: (number | null | 'throw')[] = [200]) {
  const h = {
    calls: [] as string[],
    script,
    async status(url: string) {
      h.calls.push(url)
      const next = h.script.length > 1 ? h.script.shift()! : h.script[0]!
      if (next === 'throw') throw new Error('probe broke')
      return next
    },
  }
  return h
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

let dir: string
let config: ExecutorConfig
let clock: number
let gh: ReturnType<typeof fakeGitHub>
let cool: ReturnType<typeof fakeCoolify>
let dc: ReturnType<typeof fakeDiscord>
let health: ReturnType<typeof fakeHealth>
let store: RequestStore
let ex: DeployExecutor

function makeExecutor() {
  store = new RequestStore(config.stateDir)
  ex = new DeployExecutor({
    config,
    store,
    discord: dc,
    github: gh,
    coolify: cool as unknown as CoolifyClient,
    health: health as HealthProbe,
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
  dir = mkdtempSync(join(tmpdir(), 'deploy-executor-'))
  config = parseExecutorConfig(configRaw(join(dir, 'state')))
  clock = Date.parse('2026-10-13T10:00:00Z')
  gh = fakeGitHub()
  cool = fakeCoolify()
  dc = fakeDiscord()
  health = fakeHealth()
  makeExecutor()
})
afterEach(async () => {
  await Promise.all(ex.following)
  rmSync(dir, { recursive: true, force: true })
})

const CODE = 'K7QZ'
const tick = (ms = 1000) => (clock += ms)

/** What the dashboard (#33) posts for a request whose description is the canonical line. */
function postRequest(
  rec: { canonicalLine: string; expiresAt: number },
  opts: { text?: string; author?: string; atMs?: number; timeoutAt?: number; requester?: string; edited?: boolean } = {},
): ChannelMessage {
  const text =
    opts.text ??
    buildDiscordApprovalText(
      {
        agent_id: opts.requester ?? 'acrobot',
        category: 'coolify_deploy',
        action_description: rec.canonicalLine,
        timeout_at: opts.timeoutAt ?? rec.expiresAt - 60,
      },
      CODE,
      { yes: 'igen', no: 'nem', requireReply: true },
    )
  const m: ChannelMessage = {
    id: snowflakeAt(opts.atMs ?? tick()),
    channel_id: CHANNEL,
    content: text,
    author: { id: opts.author ?? BOT, bot: true },
    edited_timestamp: opts.edited ? new Date(clock).toISOString() : null,
  }
  dc.messages.push(m)
  return m
}

function reply(to: ChannelMessage | null, content = `igen ${CODE}`, opts: { author?: string; edited?: boolean; atMs?: number } = {}) {
  const m: ChannelMessage = {
    id: snowflakeAt(opts.atMs ?? tick()),
    channel_id: CHANNEL,
    content,
    author: { id: opts.author ?? OWNER },
    message_reference: to ? { message_id: to.id } : null,
    edited_timestamp: opts.edited ? new Date(clock).toISOString() : null,
  }
  dc.messages.push(m)
  return m
}

const req = (over: Record<string, unknown> = {}) =>
  ex.request({ env: 'prod', app: 'acropora-api', action: 'deploy', sha: MAIN[4], requester: 'acrobot', ...over })

async function refusedWith(p: Promise<unknown>, part: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Refusal)
  expect((err as Refusal).reason).toContain(part)
}

async function approvedRequest(over: Record<string, unknown> = {}) {
  const rec = await req(over)
  tick(5000)
  const msg = postRequest(rec)
  tick(5000)
  reply(msg)
  tick(5000)
  return { rec, msg }
}

describe('the positive path', () => {
  it('deploys exactly the approved commit, once, and verifies what Coolify built', async () => {
    const rec = await req()
    expect(rec.canonicalLine).toBe(`VEGREHAJTO R=${rec.r} / prod / acropora-api / deploy / ${MAIN[4]}`)
    expect(rec.canonicalLine).not.toMatch(/[`>#*_~|]/)
    tick(5000)
    const msg = postRequest(rec)
    reply(msg)
    tick()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    expect(out.status).toBe('used')
    expect(out.outcome).toBe('queued')
    expect(cool.rollbacks).toEqual([{ host: 'prod-gep', app: 'prodapi0001', commit: MAIN[4] }])

    cool.deployments.get(out.deploymentUuid!)!.status = 'finished'
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe('finished_verified')
  })

  it('a stage deployment needs the same approval (plan 6/3)', async () => {
    const { rec, msg } = await approvedRequest({ env: 'stage', app: 'acropora-stage-api' })
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    expect(cool.rollbacks).toEqual([{ host: 'ai-gep', app: 'stageapi0001', commit: MAIN[4] }])
  })

  it('the AI API is approved as prod and deployed on the AI machine (three-changes 3)', async () => {
    const { rec, msg } = await approvedRequest({ app: 'acropora-ai-api' })
    expect(rec.canonicalLine).toBe(`VEGREHAJTO R=${rec.r} / prod / acropora-ai-api / deploy / ${MAIN[4]}`)
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    expect(cool.rollbacks).toEqual([{ host: 'ai-gep', app: 'aiapi00001', commit: MAIN[4] }])
  })
})

describe('the allowlist and the commit, at request time', () => {
  it.each([
    [{ app: 'acropora-commerce-medusa' }, 'not on the allowlist'],
    [{ env: 'stage', app: 'acropora-api' }, 'not on the allowlist'],
    [{ action: 'restart' }, 'action is not allowed'],
    [{ sha: MAIN[4]!.slice(0, 12) }, 'full 40-character'],
    [{ sha: MAIN[4]!.toUpperCase() }, 'full 40-character'],
    [{ sha: SIDE }, 'not part of the branch'],
    [{ sha: '9'.repeat(40) }, 'not found on GitHub'],
    [{ requester: 'Acrobot; rm' }, 'requester'],
  ])('refuses %j and records no R', async (over, part) => {
    await refusedWith(req(over), part)
    expect(existsSync(join(dir, 'state', 'audit.log'))).toBe(false)
  })

  it('a commit older than the running one is said in the line (barracuda CHANGES 2)', async () => {
    const rec = await req({ sha: MAIN[1] })
    expect(rec.canonicalLine).toBe(`VEGREHAJTO R=${rec.r} / prod / acropora-api / deploy / ${MAIN[1]} / VISSZALEPES ${MAIN[2]!.slice(0, 8)}`)
  })

  it('an unmeasurable relation is said, not hidden', async () => {
    cool.failList = true
    expect((await req()).canonicalLine).toMatch(/ \/ VISZONY NEM MERT$/)
  })

  it('a running version off the branch is said as a fork', async () => {
    cool.running['prodapi0001'] = SIDE
    expect((await req()).canonicalLine).toMatch(new RegExp(` / ELAGAZAS ${SIDE.slice(0, 8)}$`))
  })

  it('every canonical line survives #33 neutralising unchanged', () => {
    for (const relation of [
      { kind: 'forward', runningSha: MAIN[0]! },
      { kind: 'back', runningSha: MAIN[0]! },
      { kind: 'diverged', runningSha: SIDE },
      { kind: 'unmeasured' },
    ] as const) {
      const line = canonicalLine({ id: 'ABCD2345', env: 'prod', app: 'acropora-api', action: 'deploy', sha: MAIN[1]!, relation })
      expect(neutralDescription(line)).toBe(`> ${line}`)
    }
  })
})

describe('the approval read back from Discord: refusals leave the R unused and nothing deployed', () => {
  async function refusedExecute(arrange: (rec: Awaited<ReturnType<typeof req>>) => ChannelMessage | string, part: string) {
    const rec = await req()
    tick(5000)
    const target = arrange(rec)
    tick(5000)
    const id = typeof target === 'string' ? target : target.id
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: id }), part)
    expect(cool.rollbacks).toHaveLength(0)
    expect(ex.status(rec.r)!.status).toBe('open')
  }

  it('no answer at all (a row marked approved in the dashboard database is never read)', async () => {
    await refusedExecute((rec) => postRequest(rec), 'no decision')
  })

  it('the bot posted the real R with another description', async () => {
    await refusedExecute((rec) => {
      const m = postRequest({ ...rec, canonicalLine: `${rec.canonicalLine} es a commerce is` })
      reply(m)
      return m
    }, 'text differs')
  })

  it('a fifth line under the request', async () => {
    await refusedExecute((rec) => {
      const base = buildDiscordApprovalText(
        { agent_id: 'acrobot', category: 'coolify_deploy', action_description: rec.canonicalLine, timeout_at: rec.expiresAt - 60 },
        CODE,
        { yes: 'igen', no: 'nem', requireReply: true },
      )
      const m = postRequest(rec, { text: `${base}\nés még a webshop is` })
      reply(m)
      return m
    }, 'four lines')
  })

  it('the request names another requester than the R', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec, { requester: 'nautilus' })
      reply(m)
      return m
    }, 'text differs')
  })

  it('the request was posted by someone other than the request bot', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec, { author: OTHER })
      reply(m)
      return m
    }, 'not from the request bot')
  })

  it('the request message was edited (barracuda v2)', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec, { edited: true })
      reply(m)
      return m
    }, 'was edited')
  })

  it('the request message is older than the R', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec, { atMs: rec.expiresAt * 1000 - 31 * 60_000 })
      reply(m)
      return m
    }, 'older than the R')
  })

  it('the request shows a later expiry than the R', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec, { timeoutAt: rec.expiresAt + 60 })
      reply(m)
      return m
    }, 'expiry is not within the R window')
  })

  it('an "igen" from someone other than the owner', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec)
      reply(m, `igen ${CODE}`, { author: OTHER })
      return m
    }, 'no decision')
  })

  it('a "nem" first, an "igen" after it', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec)
      reply(m, `nem ${CODE}`)
      reply(m)
      return m
    }, 'rejected')
  })

  it('an "igen" that is not a reply to the request', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec)
      reply(null)
      return m
    }, 'no decision')
  })

  it('an edited owner reply', async () => {
    await refusedExecute((rec) => {
      const m = postRequest(rec)
      reply(m, `igen ${CODE}`, { edited: true })
      return m
    }, 'reply to the request was edited')
  })

  it('a message id that is not in the channel', async () => {
    await refusedExecute(() => snowflakeAt(clock), 'not found')
  })

  it('an answer that came after the shown expiry', async () => {
    const rec = await req()
    tick(5000)
    const m = postRequest(rec, { timeoutAt: Math.floor(clock / 1000) + 120 })
    clock += 180_000
    reply(m)
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: m.id }), 'no decision')
    expect(cool.rollbacks).toHaveLength(0)
  })

  it('an execution after the R expired', async () => {
    const { rec, msg } = await approvedRequest()
    clock = rec.expiresAt * 1000
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'expired')
    expect(cool.rollbacks).toHaveLength(0)
  })
})

describe('one-time use and the commit actually deployed', () => {
  it('the same approval cannot be used twice', async () => {
    const { rec, msg } = await approvedRequest()
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'already used')
    expect(cool.rollbacks).toHaveLength(1)
  })

  it('the R is on disk as used at the moment Coolify is called', async () => {
    const { rec, msg } = await approvedRequest()
    const original = cool.rollback
    let onDisk: string | undefined
    cool.rollback = async (host, app, commit) => {
      onDisk = (JSON.parse(readFileSync(join(config.stateDir, 'requests.json'), 'utf8')) as { requests: Record<string, { status: string }> }).requests[rec.r]!.status
      return original(host, app, commit)
    }
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    expect(onDisk).toBe('used')
  })

  it('nor after a restart: the used state is on disk before the Coolify call', async () => {
    const { rec, msg } = await approvedRequest()
    cool.rollbackResult = 'throw'
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    makeExecutor()
    cool.rollbackResult = 'queue'
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'already used')
    expect(cool.rollbacks).toHaveLength(1)
  })

  it('nor by two calls at once', async () => {
    const { rec, msg } = await approvedRequest()
    const results = await Promise.allSettled([
      ex.execute({ r: rec.r, requestMessageId: msg.id }),
      ex.execute({ r: rec.r, requestMessageId: msg.id }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(cool.rollbacks).toHaveLength(1)
  })

  it('a stop between spending the R and the Coolify answer reads back as interrupted, not as nothing (barracuda #48)', async () => {
    const { rec, msg } = await approvedRequest()
    cool.rollback = async () => new Promise<never>(() => {})
    void ex.execute({ r: rec.r, requestMessageId: msg.id })
    await new Promise((res) => setTimeout(res, 50))
    expect(ex.status(rec.r)).toMatchObject({ status: 'used', outcome: 'calling' })
    makeExecutor()
    expect(await ex.recover()).toEqual({ interrupted: [rec.r], recovered: [], following: [] })
    expect(ex.status(rec.r)).toMatchObject({ status: 'used', outcome: 'interrupted' })
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'already used')
  })

  describe('a lost answer read back from Coolify (barracuda, #50 review)', () => {
    async function lostCall() {
      const { rec, msg } = await approvedRequest()
      const usedAtMs = clock
      cool.rollback = async () => new Promise<never>(() => {})
      void ex.execute({ r: rec.r, requestMessageId: msg.id })
      await new Promise((res) => setTimeout(res, 50))
      makeExecutor()
      return { rec, usedAtMs }
    }
    const rollbackOf = (sha: string, uuid: string, atMs: number, over: Partial<CoolifyDeployment> = {}): CoolifyDeployment => ({
      commit: sha, status: 'finished', pullRequestId: 0, deploymentUuid: uuid, rollback: true, createdAtMs: atMs, ...over,
    })

    it('exactly one rollback of this sha after the R was spent is its deployment, and it is followed', async () => {
      const { rec, usedAtMs } = await lostCall()
      cool.extra = [rollbackOf(MAIN[4]!, 'lost1', usedAtMs + 2000)]
      cool.deployments.set('lost1', { commit: MAIN[4]!, status: 'finished', pullRequestId: 0 })
      expect(await ex.recover()).toEqual({ interrupted: [], recovered: [rec.r], following: [] })
      await Promise.all(ex.following)
      expect(ex.status(rec.r)).toMatchObject({ status: 'used', deploymentUuid: 'lost1', outcome: 'finished_verified' })
    })

    it.each([
      ['no rollback at all', () => [], 'no matching rollback'],
      ['a plain deploy of the sha, not a rollback', (t: number) => [rollbackOf(MAIN[4]!, 'u1', t + 2000, { rollback: false })], 'no matching rollback'],
      ['a rollback of another sha', (t: number) => [rollbackOf(MAIN[3]!, 'u1', t + 2000)], 'no matching rollback'],
      ['a rollback of the sha from before the R was spent', (t: number) => [rollbackOf(MAIN[4]!, 'u1', t - 120_000)], 'no matching rollback'],
      ['a rollback whose time Coolify did not give with a zone', (t: number) => [rollbackOf(MAIN[4]!, 'u1', t + 2000, { createdAtMs: null })], 'no matching rollback'],
      ['two rollbacks of the sha', (t: number) => [rollbackOf(MAIN[4]!, 'u1', t + 2000), rollbackOf(MAIN[4]!, 'u2', t + 3000)], 'more than one'],
    ])('%s stays interrupted', async (_name, list, why) => {
      const { rec, usedAtMs } = await lostCall()
      cool.extra = list(usedAtMs)
      expect(await ex.recover()).toEqual({ interrupted: [rec.r], recovered: [], following: [] })
      expect(readFileSync(join(config.stateDir, 'audit.log'), 'utf8')).toContain(why)
    })

    it('an unreadable list stays interrupted', async () => {
      const { rec } = await lostCall()
      cool.failList = true
      expect((await ex.recover()).interrupted).toEqual([rec.r])
    })

    it('a deployment another R already holds is not taken', async () => {
      const first = await approvedRequest()
      const out = await ex.execute({ r: first.rec.r, requestMessageId: first.msg.id })
      const { rec, usedAtMs } = await lostCall()
      cool.extra = [rollbackOf(MAIN[4]!, out.deploymentUuid!, usedAtMs + 2000)]
      const r = await ex.recover()
      expect(r.interrupted).toEqual([rec.r])
      expect(ex.status(rec.r)!.deploymentUuid).toBeNull()
    })
  })

  it('a deployment queued before a restart is followed again after it', async () => {
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    makeExecutor()
    expect(await ex.recover()).toEqual({ interrupted: [], recovered: [], following: [rec.r] })
    cool.deployments.get(out.deploymentUuid!)!.status = 'finished'
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe('finished_verified')
  })

  it('a commit merged after the approval does not change what is deployed', async () => {
    const { rec, msg } = await approvedRequest()
    gh.main.push(`${'9'.repeat(8)}${'b'.repeat(32)}`)
    await ex.execute({ r: rec.r, requestMessageId: msg.id })
    expect(cool.rollbacks.map((r) => r.commit)).toEqual([MAIN[4]])
  })

  it('a running version that changed after the approval refuses', async () => {
    const { rec, msg } = await approvedRequest()
    cool.running['prodapi0001'] = MAIN[3]!
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'running version changed')
    expect(cool.rollbacks).toHaveLength(0)
  })

  it('a commit taken off the branch after the approval refuses', async () => {
    const { rec, msg } = await approvedRequest()
    gh.main.splice(4)
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'not found on GitHub')
    expect(cool.rollbacks).toHaveLength(0)
  })

  it('a skipped or failed Coolify call spends the R and says not_queued', async () => {
    for (const result of ['skip', 'throw'] as const) {
      const { rec, msg } = await approvedRequest()
      cool.rollbackResult = result
      const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
      expect([out.status, out.outcome]).toEqual(['used', 'not_queued'])
    }
  })

  it.each([
    ['finished', 'x'.repeat(40), 'commit_mismatch'],
    ['failed', null, 'failed'],
    ['cancelled-by-user', null, 'failed'],
    ['in_progress', null, 'unverified_timeout'],
  ])('a deployment that ends %s (commit %s) is reported as %s', async (status, commit, outcome) => {
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    const d = cool.deployments.get(out.deploymentUuid!)!
    d.status = status
    if (commit) d.commit = commit
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe(outcome)
  })
})

const HEALTH_URL = 'https://shark.example/api/health'

describe('finished_verified means the public address is healthy too (nautilus, Cápárium #16: 503 for about 15 s after finished)', () => {
  async function deployFinished(): Promise<{ r: string; t0: number }> {
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    cool.deployments.get(out.deploymentUuid!)!.status = 'finished'
    return { r: rec.r, t0: clock }
  }
  const withHealthUrl = () => ((config.apps[0] as { healthUrl?: string }).healthUrl = HEALTH_URL)

  it('503 for a while, then 200: verified only after the 200, two seconds apart, and the 200 is recorded', async () => {
    withHealthUrl()
    health.script = [503, 503, 200]
    const { r } = await deployFinished()
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_verified')
    expect(health.calls).toEqual([HEALTH_URL, HEALTH_URL, HEALTH_URL])
    expect(store.get(r)!.observed).toEqual({ commit: MAIN[4], status: 'finished', health: 200 })
  })

  it('a 200 at once: one look and no extra wait', async () => {
    withHealthUrl()
    const { r, t0 } = await deployFinished()
    const before = clock
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_verified')
    expect(health.calls).toHaveLength(1)
    expect(clock - before).toBeLessThan(11_000)
    expect(t0).toBeLessThanOrEqual(before)
  })

  it.each([
    ['a 503 that never ends', [503], 503],
    ['no answer at all', [null], null],
    ['a redirect (not followed, not a 200)', [307], 307],
    ['a 500', [500], 500],
    ['a 204', [204], 204],
  ] as [string, (number | null)[], number | null][])('%s: finished_unhealthy after the 120 s window, the last status recorded', async (_n, script, last) => {
    withHealthUrl()
    health.script = script
    const { r, t0 } = await deployFinished()
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_unhealthy')
    expect(store.get(r)!.observed!.health).toBe(last)
    // 2 s apart for 120 s: 61 looks, and the clock moved by about the window (the follow's own 10 s step included)
    expect(health.calls.length).toBeGreaterThanOrEqual(60)
    expect(health.calls.length).toBeLessThanOrEqual(62)
    expect(clock - t0).toBeGreaterThanOrEqual(120_000)
  })

  it('a probe that throws counts as no answer: the next look is made, and a later 200 verifies', async () => {
    withHealthUrl()
    health.script = ['throw', 200]
    const { r } = await deployFinished()
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_verified')
    expect(health.calls).toHaveLength(2)
  })

  it('an app WITHOUT a healthUrl is not probed: verified as before', async () => {
    const { r } = await deployFinished()
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_verified')
    expect(health.calls).toEqual([])
    expect(store.get(r)!.observed).toEqual({ commit: MAIN[4], status: 'finished' })
  })

  it.each([
    ['a wrong commit', 'finished', 'x'.repeat(40), 'commit_mismatch'],
    ['a failed deployment', 'failed', null, 'failed'],
  ])('%s is not probed at all: only the right commit is worth waiting for', async (_n, status, commit, outcome) => {
    withHealthUrl()
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    const d = cool.deployments.get(out.deploymentUuid!)!
    d.status = status
    if (commit) d.commit = commit
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe(outcome)
    expect(health.calls).toEqual([])
  })

  it('a healthUrl with no probe wired in does not read as healthy (fail closed)', async () => {
    withHealthUrl()
    await Promise.all(ex.following)
    const bare = new DeployExecutor({
      config,
      store,
      discord: dc,
      github: gh,
      coolify: cool as unknown as CoolifyClient,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      followEveryMs: 10_000,
      followForMs: 60_000,
    })
    ex = bare
    const { r } = await deployFinished()
    await Promise.all(ex.following)
    expect(ex.status(r)!.outcome).toBe('finished_unhealthy')
    expect(store.get(r)!.observed!.health).toBeNull()
  })

  it('the health look is in the audit line, and nothing else from the probe', async () => {
    withHealthUrl()
    health.script = [503, 200]
    const { r } = await deployFinished()
    await Promise.all(ex.following)
    const audit = readFileSync(join(dir, 'state', 'audit.log'), 'utf8')
    const line = audit.split('\n').filter((l) => l.includes('finished_verified')).pop()!
    expect(line).toContain('"health":200')
    expect(r).toBeTruthy()
  })
})

describe('healthHttp: one look at the address, status only', () => {
  it('returns the status, asks without following a redirect, and never reads the body', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null
    let cancelled = false
    const probe = healthHttp((async (url: string, init?: RequestInit) => {
      seen = { url, init }
      return { status: 503, body: { cancel: async () => void (cancelled = true) } }
    }) as unknown as typeof fetch)
    expect(await probe.status(HEALTH_URL)).toBe(503)
    expect(seen!.url).toBe(HEALTH_URL)
    expect(seen!.init!.redirect).toBe('manual')
    expect(seen!.init!.signal).toBeDefined()
    expect(cancelled).toBe(true)
  })

  it('a refused connection or a timeout is null, not an exception', async () => {
    const probe = healthHttp((async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(await probe.status(HEALTH_URL)).toBeNull()
  })
})

describe('a flood is cut off before any outside call (barracuda, #49 review 3)', () => {
  it(`at most ${REQUESTS_PER_MINUTE} requests a minute, refused ones included, then 429-class refusals with no GitHub call`, async () => {
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await req({ sha: i % 2 ? MAIN[4] : SIDE }).catch(() => null)
    const before = gh.calls
    const err = await req().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimited)
    expect(gh.calls).toBe(before)
    clock += 61_000
    await expect(req()).resolves.toMatchObject({ status: 'open' })
  })

  it('a flood is refused at once, not queued behind the call in progress (barracuda, #51 review 1)', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const compare = gh.compare
    gh.compare = async (...a) => {
      await gate
      return compare(...a)
    }
    const calls = Array.from({ length: REQUESTS_PER_MINUTE + 4 }, () => req().then(() => 'ok', (e: unknown) => e))
    // the first call is held at GitHub; the four over the window must already be settled
    const settled = await Promise.race([Promise.all(calls.slice(REQUESTS_PER_MINUTE)), new Promise((res) => setTimeout(() => res('pending'), 200))])
    expect(Array.isArray(settled)).toBe(true)
    for (const e of settled as unknown[]) expect(e).toBeInstanceOf(RateLimited)
    release()
    expect((await Promise.all(calls.slice(0, REQUESTS_PER_MINUTE))).every((x) => x === 'ok')).toBe(true)
  })

  it(`at most ${MAX_OPEN_REQUESTS} open Rs; an expired one no longer counts`, async () => {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) {
      await req()
      clock += 11_000
    }
    await refusedWith(req(), 'too many open requests')
    clock += 31 * 60_000
    await expect(req()).resolves.toMatchObject({ status: 'open' })
  })

  it(`at most ${EXECUTIONS_PER_MINUTE} executions a minute, before any Discord read`, async () => {
    let reads = 0
    const get = dc.getMessage
    dc.getMessage = async (c, id) => {
      reads++
      return get(c, id)
    }
    // a real R and its request message, never answered: every execution reads Discord, then refuses
    const rec = await req()
    tick(5000)
    const msg = postRequest(rec)
    for (let i = 0; i < EXECUTIONS_PER_MINUTE; i++) await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'no decision')
    expect(reads).toBe(EXECUTIONS_PER_MINUTE)
    const err = await ex.execute({ r: rec.r, requestMessageId: msg.id }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimited)
    expect(reads).toBe(EXECUTIONS_PER_MINUTE)
  })
})

describe('the state file stays bounded (barracuda, #51 review 2)', () => {
  it(`finished Rs older than ${PRUNE_AFTER_DAYS} days leave it; a deployment still followed stays`, async () => {
    const done = await approvedRequest()
    const outDone = await ex.execute({ r: done.rec.r, requestMessageId: done.msg.id })
    cool.deployments.get(outDone.deploymentUuid!)!.status = 'finished'
    await Promise.all(ex.following)
    const expired = await req()
    tick(5000)
    const followed = await approvedRequest()
    await ex.execute({ r: followed.rec.r, requestMessageId: followed.msg.id })
    // the follow-up of `followed` gives up after a minute; make it look still queued
    await Promise.all(ex.following)
    const raw = store.get(followed.rec.r)!
    store.put({ ...raw, outcome: 'queued' })

    clock += (PRUNE_AFTER_DAYS + 1) * 86_400_000
    const gone = ex.prune()
    expect(gone.sort()).toEqual([done.rec.r, expired.r].sort())
    expect(ex.status(done.rec.r)).toBeNull()
    expect(ex.status(followed.rec.r)).toMatchObject({ outcome: 'queued' })
    expect(readFileSync(join(config.stateDir, 'audit.log'), 'utf8')).toContain('"event":"pruned"')
  })

  it('a young R is never pruned, open or used and finished', async () => {
    const open = await req()
    const used = await approvedRequest()
    const out = await ex.execute({ r: used.rec.r, requestMessageId: used.msg.id })
    // finished, so only its age can keep it
    cool.deployments.get(out.deploymentUuid!)!.status = 'finished'
    await Promise.all(ex.following)
    expect(ex.status(used.rec.r)!.outcome).toBe('finished_verified')
    clock += 29 * 86_400_000
    expect(ex.prune()).toEqual([])
    expect(ex.status(open.r)).not.toBeNull()
    expect(ex.status(used.rec.r)).not.toBeNull()
  })
})

describe('nothing secret leaves the executor', () => {
  it('neither the answer, the status nor the audit log carries what Coolify sent besides commit and status', async () => {
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    cool.deployments.get(out.deploymentUuid!)!.status = 'finished'
    await Promise.all(ex.following)
    const seen = [JSON.stringify(out), JSON.stringify(ex.status(rec.r)), readFileSync(join(dir, 'state', 'audit.log'), 'utf8'), readFileSync(join(dir, 'state', 'requests.json'), 'utf8')]
    for (const s of seen) expect(s).not.toContain(SECRET)
  })

  it('the REST transports put the token only in the header, and errors carry the status only', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ message: `bad token ${SECRET}` }), { status: 401 })
    }) as unknown as typeof fetch
    const cl = coolifyRest({ 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', token: SECRET } }, fetchImpl)
    const errs = await Promise.all([
      cl.rollback('prod-gep', 'prodapi0001', MAIN[1]!).catch((e: Error) => e.message),
      cl.listAppDeployments('prod-gep', 'prodapi0001', 20).catch((e: Error) => e.message),
      discordRest(SECRET, fetchImpl).listAfter(CHANNEL, '1').catch((e: Error) => e.message),
      githubRest(SECRET, fetchImpl).compare('KratoBal/acropora-os', MAIN[1]!, 'main').catch((e: Error) => e.message),
    ])
    expect(errs).toEqual(['Coolify API 401', 'Coolify API 401', 'Discord API 401', 'GitHub API 401'])
    for (const c of calls) expect(c.url).not.toContain(SECRET)
    expect(calls[0]!.url).toBe('https://prod.example/api/v1/applications/prodapi0001/rollback')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ commit: MAIN[1] })
    expect(calls[3]!.url).toBe(`https://api.github.com/repos/KratoBal/acropora-os/compare/${MAIN[1]}...main`)
  })

  it('a listed deployment keeps its uuid, rollback flag and a zoned time; a bare time is not guessed', async () => {
    const body = {
      count: 2,
      deployments: [
        { deployment_uuid: 'd1', commit: MAIN[1], status: 'finished', pull_request_id: 0, rollback: true, created_at: '2026-10-13T10:00:00.000000Z', logs: SECRET },
        { deployment_uuid: 'd2', commit: MAIN[1], status: 'finished', pull_request_id: 0, rollback: false, created_at: '2026-10-13 10:00:00' },
      ],
    }
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const list = await coolifyRest({ 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', token: SECRET } }, fetchImpl).listAppDeployments('prod-gep', 'prodapi0001', 20)
    expect(list).toEqual([
      { commit: MAIN[1], status: 'finished', pullRequestId: 0, deploymentUuid: 'd1', rollback: true, createdAtMs: Date.parse('2026-10-13T10:00:00Z') },
      { commit: MAIN[1], status: 'finished', pullRequestId: 0, deploymentUuid: 'd2', rollback: false, createdAtMs: null },
    ])
  })

  it('a Coolify answer without a deployment uuid (queue skipped) is not a deployment', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'skipped' }), { status: 200 })) as unknown as typeof fetch
    const cl = coolifyRest({ 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', token: SECRET } }, fetchImpl)
    expect(await cl.rollback('prod-gep', 'prodapi0001', MAIN[1]!)).toEqual({ deploymentUuid: null })
  })
})

describe('the health address in the settings', () => {
  it('an https address is kept as given on that app only; the others have none', () => {
    const c = configRaw('/var/lib/vegrehajto')
    Object.assign(c.apps[0]!, { healthUrl: HEALTH_URL })
    const parsed = parseExecutorConfig(c)
    expect(parsed.apps[0]!.healthUrl).toBe(HEALTH_URL)
    expect(parsed.apps.slice(1).map((a) => 'healthUrl' in a)).toEqual([false, false])
  })
})

describe('the state file and the settings fail closed', () => {
  it('a corrupt state file stops the executor instead of forgetting every used R', () => {
    writeFileSync(join(dir, 'state', 'requests.json'), '{"version":2}')
    expect(() => new RequestStore(join(dir, 'state'))).toThrow(/unknown shape/)
  })

  it.each([
    ['an unknown key', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { approvalMinute: 30 }), /unknown key/],
    ['the request bot as a decider', (c: ReturnType<typeof configRaw>) => c.discord.deciderUserIds.push(BOT), /request bot/],
    ['a long approval window', (c: ReturnType<typeof configRaw>) => (c.apps[0]!.approvalMinutes = 61), /approvalMinutes/],
    ['an action not implemented', (c: ReturnType<typeof configRaw>) => (c.apps[0]!.actions = ['deploy', 'restart']), /actions\[1\]/],
    ['a token inside the API URL', (c: ReturnType<typeof configRaw>) => (c.coolifyHosts['prod-gep'].coolifyApiUrl = 'https://u:p@prod.example/api/v1'), /credentials/],
    ['a relative secret path', (c: ReturnType<typeof configRaw>) => (c.github.tokenFile = 'secrets/github'), /absolute/],
    ['an app on an unknown Coolify', (c: ReturnType<typeof configRaw>) => (c.apps[0]!.coolifyHost = 'harmadik-gep'), /not in coolifyHosts/],
    ['one uuid under two names', (c: ReturnType<typeof configRaw>) => (c.apps[1]!.coolifyUuid = 'prodapi0001'), /duplicate coolifyUuid/],
    ['a health address over plain http', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 'http://shark.example/api/health' }), /healthUrl: must be https/],
    ['a health address with credentials', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 'https://u:p@shark.example/api/health' }), /healthUrl: no credentials/],
    ['a health address with a query', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 'https://shark.example/api/health?x=1' }), /healthUrl: no credentials, query/],
    ['a health address with a fragment', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 'https://shark.example/api/health#x' }), /healthUrl: no credentials, query/],
    ['a health address that is not a URL', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 'shark.example' }), /healthUrl: not a URL/],
    ['a health address that is not a string', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: 7 }), /healthUrl: must be a non-empty string/],
    ['an empty health address', (c: ReturnType<typeof configRaw>) => Object.assign(c.apps[0]!, { healthUrl: '' }), /healthUrl: must be a non-empty string/],
  ])('refuses %s', (_name, mutate, re) => {
    const c = configRaw('/var/lib/vegrehajto')
    mutate(c)
    expect(() => parseExecutorConfig(c)).toThrow(re)
  })
})

describe('the shared Discord code', () => {
  it('the dashboard and the executor judge with the very same functions', () => {
    expect(discordModule.matchDecisions).toBe(matchDecisions)
    expect(discordModule.buildDiscordApprovalText).toBe(buildDiscordApprovalText)
  })

  it('finds the shown expiry inside the window, and nothing outside it', () => {
    const t = Math.floor(Date.parse('2026-10-13T10:17:43Z') / 1000)
    expect(findDisplayedExpiry(formatApprovalExpiry(t), t - 1800, t + 5)).toBe(t)
    expect(findDisplayedExpiry(formatApprovalExpiry(t), t + 1, t + 1800)).toBeNull()
    expect(findDisplayedExpiry('nincs', t - 1800, t)).toBeNull()
  })
})
