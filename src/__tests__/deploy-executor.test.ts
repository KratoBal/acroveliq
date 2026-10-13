import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalLine } from '../deploy-executor/canonical.js'
import { parseExecutorConfig, type ExecutorConfig } from '../deploy-executor/config.js'
import { DeployExecutor, Refusal } from '../deploy-executor/executor.js'
import { RequestStore } from '../deploy-executor/store.js'
import {
  coolifyRest,
  discordRest,
  githubRest,
  type CoolifyClient,
  type CoolifyDeployment,
  type DiscordReader,
  type GitHubReader,
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
        { commit: 'b'.repeat(40), status: 'failed', pullRequestId: 0 },
        { commit: 'c'.repeat(40), status: 'finished', pullRequestId: 7 },
        { commit: running[app] ?? null, status: 'finished', pullRequestId: 0 },
      ]
    },
  }
  return c
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
    expect(ex.recover()).toEqual({ interrupted: [rec.r], following: [] })
    expect(ex.status(rec.r)).toMatchObject({ status: 'used', outcome: 'interrupted' })
    await refusedWith(ex.execute({ r: rec.r, requestMessageId: msg.id }), 'already used')
  })

  it('a deployment queued before a restart is followed again after it', async () => {
    const { rec, msg } = await approvedRequest()
    const out = await ex.execute({ r: rec.r, requestMessageId: msg.id })
    makeExecutor()
    expect(ex.recover()).toEqual({ interrupted: [], following: [rec.r] })
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

  it('a Coolify answer without a deployment uuid (queue skipped) is not a deployment', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'skipped' }), { status: 200 })) as unknown as typeof fetch
    const cl = coolifyRest({ 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', token: SECRET } }, fetchImpl)
    expect(await cl.rollback('prod-gep', 'prodapi0001', MAIN[1]!)).toEqual({ deploymentUuid: null })
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
