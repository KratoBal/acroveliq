import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseExecutorConfig } from '../deploy-executor/config.js'
import { DeployExecutor } from '../deploy-executor/executor.js'
import { createExecutorServer } from '../deploy-executor/http.js'
import { RequestStore } from '../deploy-executor/store.js'
import type { CoolifyClient, CoolifyDeployment, DiscordReader, GateClient, GitHubReader } from '../deploy-executor/transports.js'
import type { ChannelMessage } from '../deploy-executor/verify-approval.js'
import { buildDiscordApprovalText, snowflakeAt } from '../web/approval-discord-core.js'

/*
  THE FLEET'S SIDE OF THE DEPLOY EXECUTOR (P0-3). scripts/vegrehajto.sh against
  the REAL executor (fake Discord, GitHub and Coolify behind it) and a fake
  dashboard. The executor accepts an approval only if the Discord message is
  letter for letter what #33 builds from the R, so the script's job is the
  shape. What turns these red: the approval going up without an expiry inside
  the R's window (the dashboard's default is 1440 minutes, and the executor
  refuses a later displayed expiry); a description other than the canonical
  line; an execution sent for a pending, rejected or Discord-less approval, or
  for another R's approval; a short sha spending an R; a refusal reported as
  anything but the executor's own reason.
*/

const CHANNEL = '1540270627926183997'
const BOT = '1500000000000000001'
const OWNER = '1460000000000000001'
const SHA = `${'1'.repeat(8)}${'a'.repeat(32)}`
const CODE = 'K7QZ'
// routes/approvals.ts DEFAULT_TIMEOUT_MINUTES; not imported, the module opens the database
const DASHBOARD_DEFAULT_MINUTES = 1440

interface Row {
  id: string
  agent_id: string
  category: string
  action_description: string
  timeout_at: number
  status: string
  discord_message_id: string | null
}

let dir: string
let script: string
let execBase: string
let dashPort: number
let servers: Server[]
let rows: Map<string, Row>
let messages: ChannelMessage[]
let executions: number
let rollbacks: string[]
/** the gate calls that reached the fake gate: `<mode>` in order */
let gateModes: string[]
let gateApplied: boolean
/** what the dashboard does to the body; a test may make it misbehave */
let dashboard: { recordAs?: string; ignoreTimeout?: boolean }

const listen = async (s: Server) => {
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res))
  servers.push(s)
  return (s.address() as AddressInfo).port
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vegrehajto-kliens-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  script = join(dir, 'scripts', 'vegrehajto.sh')
  copyFileSync(join(process.cwd(), 'scripts', 'vegrehajto.sh'), script)
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token')
  servers = []
  rows = new Map()
  messages = []
  executions = 0
  rollbacks = []
  gateModes = []
  gateApplied = false
  dashboard = {}

  const config = parseExecutorConfig({
    stateDir: join(dir, 'state'),
    discord: { channelId: CHANNEL, requestBotUserId: BOT, deciderUserIds: [OWNER], yes: 'igen', no: 'nem', tokenFile: '/run/secrets/d' },
    github: { tokenFile: '/run/secrets/g' },
    coolifyHosts: { 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', coolifyTokenFile: '/run/secrets/c' } },
    apps: [{ env: 'prod', name: 'acropora-api', coolifyHost: 'prod-gep', coolifyUuid: 'prodapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30 }],
    gate: { host: '172.18.0.1', port: 22, user: 'fleet', keyFile: '/run/secrets/gate-key', knownHostsFile: '/run/secrets/gate-known-hosts' },
    grants: [{ env: 'prod', name: 'fleet-ro', repo: 'KratoBal/acroveliq', branch: 'main', gateKey: 'iwm34jaqp9xmwb72qkrqkwhy', database: 'acropora', approvalMinutes: 30 }],
  })
  // the gate as scripts/host/fleet-gate.sh answers: a head line, then the changes as notices; empty once applied
  const gate: GateClient = {
    async run(mode, _key, _db, commit) {
      gateModes.push(mode)
      const head = `fleet-ro-grant ${mode}: commit ${commit}, lista sha256 ${'ab'.repeat(32)}, ma 2026-10-13 (Europe/Budapest)`
      const changes = gateApplied && mode === 'terv' ? [] : ['GRANT SELECT (id) ON "BankTransaction" TO fleet_ro', 'GRANT SELECT (migration_name) ON _prisma_migrations TO fleet_ro']
      if (mode === 'alkalmaz') gateApplied = true
      return { code: 0, output: [head, ...changes.map((l) => `NOTICE:  ${l}`)].join('\n') }
    },
  }
  const github: GitHubReader = {
    async compare(_repo, b) {
      return { status: 'ahead', baseSha: b }
    },
  }
  const deployments = new Map<string, CoolifyDeployment>()
  const coolify: CoolifyClient = {
    async rollback(_h, _a, commit) {
      rollbacks.push(commit)
      const uuid = `dep${rollbacks.length}`
      deployments.set(uuid, { commit, status: 'finished', pullRequestId: 0 })
      return { deploymentUuid: uuid }
    },
    async getDeployment(_h, uuid) {
      return deployments.get(uuid) ?? null
    },
    async listAppDeployments() {
      return []
    },
  }
  const discord: DiscordReader = {
    async getMessage(_c, id) {
      return messages.find((m) => m.id === id) ?? null
    },
    async listAfter(_c, after) {
      return messages.filter((m) => BigInt(m.id) > BigInt(after))
    },
  }
  const ex = new DeployExecutor({ config, store: new RequestStore(config.stateDir), discord, github, coolify, gate, followEveryMs: 1, followForMs: 1 })
  const inner = createExecutorServer(ex, () => {})
  // count the executions that reach the executor: a refused one must not be sent at all
  const execSrv = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/executions') executions++
    inner.emit('request', req, res)
  })
  execBase = `http://127.0.0.1:${await listen(execSrv)}`

  const dash = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'no' })
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/approvals') {
        const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        const now = Math.floor(Date.now() / 1000)
        const secs = typeof b.timeout_seconds === 'number' && !dashboard.ignoreTimeout ? b.timeout_seconds : DASHBOARD_DEFAULT_MINUTES * 60
        const row: Row = {
          id: `apr-${rows.size + 1}`,
          agent_id: dashboard.recordAs ?? String(b.agent_id),
          category: String(b.category),
          action_description: String(b.action_description).trim(),
          timeout_at: now + secs,
          status: 'pending',
          discord_message_id: null,
        }
        rows.set(row.id, row)
        return send(201, row)
      }
      const m = /^\/api\/approvals\/([\w-]+)$/.exec(req.url ?? '')
      if (req.method === 'GET' && m) return rows.has(m[1]!) ? send(200, rows.get(m[1]!)) : send(404, { error: 'not found' })
      send(404, { error: 'not found' })
    })
  })
  dashPort = await listen(dash)
})

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))))
  rmSync(dir, { recursive: true, force: true })
})

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(dashPort), VEGREHAJTO_URL: execBase } }, (err, stdout) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

/** What #33 does once the row exists and Discord is on: post the request, then the owner answers. */
function ownerAnswers(row: Row, answer = `igen ${CODE}`): void {
  const t = Date.now()
  const request: ChannelMessage = {
    id: snowflakeAt(t),
    channel_id: CHANNEL,
    content: buildDiscordApprovalText(row, CODE, { yes: 'igen', no: 'nem', requireReply: true }),
    author: { id: BOT, bot: true },
    edited_timestamp: null,
  }
  messages.push(request, {
    id: snowflakeAt(t + 1000),
    channel_id: CHANNEL,
    content: answer,
    author: { id: OWNER },
    message_reference: { message_id: request.id },
    edited_timestamp: null,
  })
  row.discord_message_id = request.id
  row.status = answer.startsWith('igen') ? 'approved' : 'rejected'
}

const ask = () => run(['kerj', 'acrobot', 'prod', 'acropora-api', SHA])
const idsOf = (out: string) => {
  const m = /^R=([A-Z0-9]+) approval=([\w-]+) lejar=(\d+)$/m.exec(out)
  if (!m) throw new Error(`no R line in: ${out}`)
  return { r: m[1]!, apr: m[2]!, expires: Number(m[3]) }
}

describe('vegrehajto.sh', () => {
  it('kerj puts the canonical line up as the whole description, expiring inside the R window', async () => {
    const { code, out } = await ask()
    expect(code).toBe(0)
    const { r, apr, expires } = idsOf(out)
    const row = rows.get(apr)!
    expect(row.category).toBe('coolify_deploy')
    expect(row.action_description).toBe(`VEGREHAJTO R=${r} / prod / acropora-api / deploy / ${SHA} / VISZONY NEM MERT`)
    expect(row.timeout_at).toBeLessThanOrEqual(expires)
    expect(row.timeout_at).toBeGreaterThan(expires - 5 * 60)
  })

  it('the whole path: an approved request reaches Coolify as a rollback to the approved sha', async () => {
    const { r, apr } = idsOf((await ask()).out)
    ownerAnswers(rows.get(apr)!)
    const done = await run(['vegrehajt', r, apr])
    expect(done.code).toBe(0)
    expect(done.out).toContain(`R=${r} status=used outcome=queued deployment=dep1`)
    expect(rollbacks).toEqual([SHA])
    const state = await run(['allapot', r])
    expect(state.code).toBe(0)
    expect(state.out).toContain(`R=${r} status=used`)
  })

  it('an approval with the dashboard default expiry is caught at kerj; the executor would refuse it later', async () => {
    dashboard.ignoreTimeout = true
    const asked = await ask()
    expect(asked.code).toBe(1)
    expect(asked.out).toContain('kesobbi, mint az R-e')
    // the control: the same row, answered and sent on, is refused by the executor itself
    const [, apr, r] = /approval=([\w-]+) R=([A-Z0-9]+)$/m.exec(asked.out)!
    ownerAnswers(rows.get(apr)!)
    const sent = await run(['vegrehajt', r, apr])
    expect(sent.code).toBe(5)
    expect(sent.out).toMatch(/^MEGTAGADVA \(vegrehajtas\): /)
    expect(rollbacks).toEqual([])
  })

  it('the dashboard recording another requester stops kerj: the Discord message would name the wrong one', async () => {
    dashboard.recordAs = 'murena'
    const asked = await ask()
    expect(asked.code).toBe(1)
    expect(asked.out).toContain('murena-kent rogzitette')
  })

  it.each([
    ['pending', undefined, 3, 'meg nincs dontes'],
    ['rejected', `nem ${CODE}`, 4, 'status=rejected'],
  ])('a %s approval sends no execution', async (_n, answer, exit, text) => {
    const { r, apr } = idsOf((await ask()).out)
    if (answer) ownerAnswers(rows.get(apr)!, answer)
    const res = await run(['vegrehajt', r, apr])
    expect(res.code).toBe(exit)
    expect(res.out).toContain(text)
    expect(executions).toBe(0)
  })

  it('an approval decided off Discord sends no execution', async () => {
    const { r, apr } = idsOf((await ask()).out)
    rows.get(apr)!.status = 'approved'
    const res = await run(['vegrehajt', r, apr])
    expect(res.code).toBe(1)
    expect(res.out).toContain('nincs Discord-uzenete')
    expect(executions).toBe(0)
  })

  it("another R's approval is not sent for this R", async () => {
    const first = idsOf((await ask()).out)
    const second = idsOf((await ask()).out)
    ownerAnswers(rows.get(first.apr)!)
    const res = await run(['vegrehajt', second.r, first.apr])
    expect(res.code).toBe(1)
    expect(res.out).toContain('nem ezt az R-t irja le')
    expect(executions).toBe(0)
  })

  it('a short sha spends no R; an executor refusal is reported with its own reason', async () => {
    const short = await run(['kerj', 'acrobot', 'prod', 'acropora-api', SHA.slice(0, 8)])
    expect(short.code).toBe(1)
    expect(short.out).toContain('40 jegyu')
    const off = await run(['kerj', 'acrobot', 'prod', 'acropora-commerce-medusa', SHA])
    expect(off.code).toBe(5)
    expect(off.out).toBe('MEGTAGADVA (R kerese): application is not on the allowlist for this environment\n')
    expect(rows.size).toBe(0)
  })

  it('a wrong argument count is usage, exit 2', async () => {
    expect((await run(['kerj', 'acrobot', 'prod', 'acropora-api'])).code).toBe(2)
    expect((await run(['vegrehajt', 'ABCDEFGH'])).code).toBe(2)
    expect((await run([])).code).toBe(2)
  })
})

describe('vegrehajto.sh fleet-ro-kerj (the grant button)', () => {
  const askGrant = () => run(['fleet-ro-kerj', 'acrobot', 'prod', 'fleet-ro', SHA])

  it('puts the plan up as the whole description, in the grant category, expiring inside the R window', async () => {
    const { code, out } = await askGrant()
    expect(code).toBe(0)
    const { r, apr, expires } = idsOf(out)
    const row = rows.get(apr)!
    expect(row.category).toBe('fleet_ro_grant')
    expect(row.action_description).toMatch(new RegExp(`^VEGREHAJTO R=${r} / prod / fleet-ro / fleet-ro-grant / ${SHA} / lista [0-9a-f]{16} / terv [0-9a-f]{16} / `))
    // the owner reads the table and column names, with an underscore shown as a dot
    expect(row.action_description).toContain('GRANT SELECT TO fleet-ro: +BankTransaction id; +.prisma.migrations migration.name')
    expect(row.timeout_at).toBeLessThanOrEqual(expires)
    expect(gateModes).toEqual(['terv'])
  })

  it('the whole path: an approved grant reaches the gate once as `alkalmaz` and is verified by an empty plan afterwards', async () => {
    const { r, apr } = idsOf((await askGrant()).out)
    ownerAnswers(rows.get(apr)!)
    const done = await run(['vegrehajt', r, apr])
    expect(done.code).toBe(0)
    expect(done.out).toContain('outcome=finished_verified')
    expect(done.out).toContain('terv_utana=ures')
    const status = await run(['allapot', r])
    expect(status.out).toContain('terv_utana=ures')
    expect(gateModes).toEqual(['terv', 'terv', 'alkalmaz', 'terv'])
    expect(rollbacks).toEqual([])
  })

  it('does not apply without an answer: no `alkalmaz`', async () => {
    const { r, apr } = idsOf((await askGrant()).out)
    const done = await run(['vegrehajt', r, apr])
    expect(done.code).toBe(3)
    expect(gateModes).toEqual(['terv'])
  })

  it('a grant approval filed under another category is refused before the executor is asked', async () => {
    const { r, apr } = idsOf((await askGrant()).out)
    const row = rows.get(apr)!
    ownerAnswers(row)
    row.category = 'coolify_deploy'
    const done = await run(['vegrehajt', r, apr])
    expect(done.code).toBe(1)
    expect(done.out).toContain('fleet_ro_grant')
    expect(executions).toBe(0)
    expect(gateModes).toEqual(['terv'])
  })

  it('a deploy approval keeps its own category (the old path is unchanged)', async () => {
    const { r, apr } = idsOf((await ask()).out)
    const row = rows.get(apr)!
    ownerAnswers(row)
    row.category = 'fleet_ro_grant'
    const done = await run(['vegrehajt', r, apr])
    expect(done.code).toBe(1)
    expect(done.out).toContain('coolify_deploy')
    expect(executions).toBe(0)
  })
})
