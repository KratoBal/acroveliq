import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseExecutorConfig, type ExecutorConfig } from '../deploy-executor/config.js'
import { DeployExecutor, Refusal } from '../deploy-executor/executor.js'
import { RequestStore } from '../deploy-executor/store.js'
import {
  githubRest,
  RULE_MAX_PAGES,
  type CheckRunInfo,
  type CoolifyClient,
  type CoolifyDeployment,
  type DiscordReader,
  type GitHubReader,
  type GitHubRuleReader,
  type HealthProbe,
  type PullInfo,
  type ReviewInfo,
} from '../deploy-executor/transports.js'

/*
  THE RULE PATH (task vegrehajto-szabaly-jovahagyas; Balázs 2026-10-19, "1 mehet 2 mehet 3 mehet"). What turns these
  red: a deploy by rule without a merged PR whose merge commit is the deployed commit; an APPROVED review for another
  head than the merged one ("a hamis APPROVE"), by a login not configured, or followed by a CHANGES_REQUESTED; a red,
  unfinished or missing CI on the head, or a red one on the merge commit; to prod: a commit not verified on the stage
  counterpart, a frozen repository, a frozen file (also as a rename's old path); a grant, a step back, a GitHub read
  that failed, approved by rule; a refusal that spends the R or reaches Coolify; a decision missing from the audit log.
*/

const MAIN = Array.from({ length: 6 }, (_, i) => `${String(i + 1).repeat(8)}${'a'.repeat(32)}`)
const HEAD = 'e'.repeat(40) // the PR's head, merged as MAIN[4]
const OTHER_HEAD = 'd'.repeat(40)
const REVIEWER = 'acropora-fleet-review'
const S = MAIN[4]!

function configRaw(stateDir: string, rules: unknown = defaultRules()) {
  return {
    stateDir,
    discord: { channelId: '1540270627926183997', requestBotUserId: '1500000000000000001', deciderUserIds: ['1460000000000000001'], yes: 'igen', no: 'nem', tokenFile: '/run/secrets/discord' },
    github: { tokenFile: '/run/secrets/github' },
    coolifyHosts: { 'prod-gep': { coolifyApiUrl: 'https://prod.example/api/v1', coolifyTokenFile: '/run/secrets/coolify-prod' } },
    apps: [
      { env: 'prod', name: 'acropora-api', coolifyHost: 'prod-gep', coolifyUuid: 'prodapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30, stageApp: 'acropora-stage-api', requiredChecks: ['verify'] },
      { env: 'stage', name: 'acropora-stage-api', coolifyHost: 'prod-gep', coolifyUuid: 'stageapi0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30, requiredChecks: ['verify'] },
      { env: 'prod', name: 'nostage-api', coolifyHost: 'prod-gep', coolifyUuid: 'nostage0001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30, requiredChecks: ['verify'] },
      { env: 'prod', name: 'commerce-api', coolifyHost: 'prod-gep', coolifyUuid: 'commerce001', repo: 'KratoBal/acropora-commerce', branch: 'main', actions: ['deploy'], approvalMinutes: 30, stageApp: 'commerce-stage', requiredChecks: ['verify'] },
      { env: 'stage', name: 'commerce-stage', coolifyHost: 'prod-gep', coolifyUuid: 'commstage01', repo: 'KratoBal/acropora-commerce', branch: 'main', actions: ['deploy'], approvalMinutes: 30, requiredChecks: ['verify'] },
      { env: 'stage', name: 'nochecks-stage', coolifyHost: 'prod-gep', coolifyUuid: 'nochecks001', repo: 'KratoBal/acropora-os', branch: 'main', actions: ['deploy'], approvalMinutes: 30 },
    ],
    ...(rules === null ? {} : { rules }),
  }
}

function defaultRules() {
  return {
    reviewerLogins: [REVIEWER],
    frozenPaths: ['(^|/)unas', '(^|/)medusa', '(^|/)(storefront|webshop|kirakat)(/|$)', 'commerce'],
    frozenRepos: ['KratoBal/acropora-commerce'],
  }
}

function fakeGitHub(): GitHubReader & { main: string[] } {
  const g = {
    main: [...MAIN],
    async compare(_repo: string, base: string, head: string) {
      const resolve = (ref: string) => (ref === 'main' ? g.main[g.main.length - 1]! : ref)
      const [b, h] = [resolve(base), resolve(head)]
      if (!g.main.includes(b) || !g.main.includes(h)) return null
      const [ib, ih] = [g.main.indexOf(b), g.main.indexOf(h)]
      return { status: ib === ih ? 'identical' : ib < ih ? ('ahead' as const) : ('behind' as const), baseSha: b }
    },
  }
  return g as GitHubReader & { main: string[] }
}

/** GitHub as the rule path reads it: one merged PR (#77) from HEAD into main as S, approved and green by default. */
function fakeRules() {
  const r = {
    pullList: [{ number: 77, merged: true, mergeCommitSha: S, baseRef: 'main', headSha: HEAD }] as PullInfo[],
    reviewList: [{ login: REVIEWER, state: 'APPROVED', commitId: HEAD }] as ReviewInfo[],
    runs: {
      [HEAD]: [
        { name: 'verify', status: 'completed', conclusion: 'success' },
        { name: 'e2e', status: 'completed', conclusion: 'skipped' },
      ],
      [S]: [{ name: 'verify', status: 'completed', conclusion: 'success' }],
    } as Record<string, CheckRunInfo[]>,
    files: [{ path: 'apps/api/src/service/a.ts', previousPath: null }] as { path: string; previousPath: string | null }[],
    throwOn: null as null | 'pulls' | 'reviews' | 'runs' | 'files',
    calls: 0,
    async pullsForCommit(_repo: string, sha: string) {
      r.calls++
      if (r.throwOn === 'pulls') throw new Error('GitHub API 502')
      return r.pullList.filter((p) => p.mergeCommitSha === sha || p.headSha === sha)
    },
    async reviews() {
      r.calls++
      if (r.throwOn === 'reviews') throw new Error('GitHub API 502')
      return r.reviewList
    },
    async checkRuns(_repo: string, sha: string) {
      r.calls++
      if (r.throwOn === 'runs') throw new Error('GitHub API 502')
      return r.runs[sha] ?? []
    },
    async pullFiles() {
      r.calls++
      if (r.throwOn === 'files') throw new Error('GitHub list longer than the rule path reads')
      return r.files
    },
  }
  return r
}

function fakeCoolify() {
  const running: Record<string, string> = { prodapi0001: MAIN[2]!, stageapi0001: MAIN[2]!, nostage0001: MAIN[2]!, commerce001: MAIN[2]!, commstage01: MAIN[2]!, nochecks001: MAIN[2]! }
  const rollbacks: { app: string; commit: string }[] = []
  const deployments = new Map<string, CoolifyDeployment>()
  return {
    running,
    rollbacks,
    deployments,
    async rollback(_host: string, app: string, commit: string) {
      rollbacks.push({ app, commit })
      const uuid = `dep${rollbacks.length}`
      deployments.set(uuid, { commit, status: 'finished', pullRequestId: 0 })
      return { deploymentUuid: uuid }
    },
    async getDeployment(_h: string, uuid: string) {
      return deployments.get(uuid) ?? null
    },
    async listAppDeployments(_h: string, app: string) {
      return [{ commit: running[app] ?? null, status: 'finished', pullRequestId: 0 }]
    },
  }
}

const noDiscord: DiscordReader = {
  async getMessage() {
    throw new Error('the rule path must not read Discord')
  },
  async listAfter() {
    throw new Error('the rule path must not read Discord')
  },
}

let dir: string
let config: ExecutorConfig
let clock: number
let gh: ReturnType<typeof fakeGitHub>
let rules: ReturnType<typeof fakeRules>
let cool: ReturnType<typeof fakeCoolify>
let store: RequestStore
let ex: DeployExecutor

function make(raw = configRaw(join(dir, 'state')), withRules = true) {
  config = parseExecutorConfig(raw)
  store = new RequestStore(config.stateDir)
  ex = new DeployExecutor({
    config,
    store,
    discord: noDiscord,
    github: gh,
    ...(withRules ? { githubRules: rules as GitHubRuleReader } : {}),
    coolify: cool as unknown as CoolifyClient,
    health: { status: async () => 200 } as HealthProbe,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    followEveryMs: 1000,
    followForMs: 10_000,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-rules-'))
  clock = Date.parse('2026-10-19T20:00:00Z')
  gh = fakeGitHub()
  rules = fakeRules()
  cool = fakeCoolify()
  make()
})
afterEach(async () => {
  await Promise.all(ex.following)
  rmSync(dir, { recursive: true, force: true })
})

const audit = () =>
  readFileSync(join(config.stateDir, 'audit.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

async function byRule(env: string, app: string, sha = S) {
  const rec = await ex.request({ env, app, action: 'deploy', sha, requester: 'acrobot' })
  return { rec, out: ex.executeByRule({ r: rec.r }) }
}

/** A refusal: the reason names the condition, the R stays open and unused, Coolify is not called, the audit says why. */
async function refused(p: { rec: { r: string }; out: Promise<unknown> }, part: string) {
  const err = await p.out.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, `expected a refusal containing "${part}"`).toBeInstanceOf(Refusal)
  expect((err as Refusal).reason).toContain(part)
  expect(ex.status(p.rec.r)!.status).toBe('open')
  expect(cool.rollbacks).toEqual([])
  const line = audit().filter((l) => l.event === 'refused').pop()!
  expect(line).toMatchObject({ r: p.rec.r, by: 'rule' })
  expect(String(line.reason)).toContain(part)
}

describe('stage-auto: the commit, the PR, the review and the CI', () => {
  it('deploys exactly the merged commit, without a Discord read, and the audit names the rule and the evidence', async () => {
    const { rec, out } = await byRule('stage', 'acropora-stage-api')
    const done = await out
    expect(done.status).toBe('used')
    expect(cool.rollbacks).toEqual([{ app: 'stageapi0001', commit: S }])
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe('finished_verified')
    expect(audit().find((l) => l.event === 'approved')).toMatchObject({
      r: rec.r,
      by: 'rule',
      rule: 'stage-auto',
      pr: 77,
      head: HEAD,
      reviewer: REVIEWER,
      checksHead: 2,
      checksMerge: 1,
    })
  })

  it('a hamis APPROVE: the review approves another head than the merged one', async () => {
    rules.reviewList = [{ login: REVIEWER, state: 'APPROVED', commitId: OTHER_HEAD }]
    await refused(await byRule('stage', 'acropora-stage-api'), `is for ${OTHER_HEAD.slice(0, 8)}, not for the merged head ${HEAD.slice(0, 8)}`)
  })

  it('an APPROVED review by a login that is not configured does not count', async () => {
    rules.reviewList = [{ login: 'someone-else', state: 'APPROVED', commitId: HEAD }]
    await refused(await byRule('stage', 'acropora-stage-api'), `no review by ${REVIEWER}`)
  })

  it('a CHANGES_REQUESTED after the APPROVED decides; a COMMENTED after it does not', async () => {
    rules.reviewList = [
      { login: REVIEWER, state: 'APPROVED', commitId: HEAD },
      { login: REVIEWER, state: 'CHANGES_REQUESTED', commitId: HEAD },
    ]
    await refused(await byRule('stage', 'acropora-stage-api'), 'is CHANGES_REQUESTED')
    rules.reviewList = [
      { login: REVIEWER, state: 'APPROVED', commitId: HEAD },
      { login: REVIEWER, state: 'COMMENTED', commitId: HEAD },
    ]
    expect((await (await byRule('stage', 'acropora-stage-api')).out).status).toBe('used')
  })

  it('a dismissed approval is not an approval', async () => {
    rules.reviewList = [
      { login: REVIEWER, state: 'APPROVED', commitId: HEAD },
      { login: REVIEWER, state: 'DISMISSED', commitId: HEAD },
    ]
    await refused(await byRule('stage', 'acropora-stage-api'), 'is DISMISSED')
  })

  it('a piros CI on the head refuses, naming the check', async () => {
    rules.runs[HEAD] = [
      { name: 'verify', status: 'completed', conclusion: 'success' },
      { name: 'e2e', status: 'completed', conclusion: 'failure' },
    ]
    await refused(await byRule('stage', 'acropora-stage-api'), `CI on the head ${HEAD.slice(0, 8)}: e2e is failure`)
  })

  it('an unfinished or a missing CI on the head refuses', async () => {
    rules.runs[HEAD] = [{ name: 'verify', status: 'in_progress', conclusion: null }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'verify is in_progress')
    rules.runs[HEAD] = []
    await refused(await byRule('stage', 'acropora-stage-api'), 'the required check verify is missing')
  })

  it('the required run must be there by name and success: another green run, or a skipped or neutral one, is not enough (barracuda #267, 1a)', async () => {
    rules.runs[HEAD] = [{ name: 'scan', status: 'completed', conclusion: 'success' }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'the required check verify is missing')
    rules.runs[HEAD] = [{ name: 'verify', status: 'completed', conclusion: 'skipped' }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'the required check verify is skipped')
    rules.runs[HEAD] = [{ name: 'verify', status: 'completed', conclusion: 'neutral' }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'the required check verify is neutral')
  })

  it('an app that names no required run is not approved by rule', async () => {
    await refused(await byRule('stage', 'nochecks-stage'), 'nochecks-stage names no required check runs')
  })

  it('a PR that changes a workflow file is refused on stage too, naming the file; an old path under .github too (barracuda #267, 1b)', async () => {
    rules.files = [{ path: '.github/workflows/ci.yml', previousPath: null }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'changes the CI file .github/workflows/ci.yml')
    rules.files = [{ path: 'ci/old-workflow.yml', previousPath: '.github/workflows/ci.yml' }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'changes the CI file .github/workflows/ci.yml')
  })

  it('a red run on the merge commit refuses; no run there at all does not', async () => {
    rules.runs[S] = [{ name: 'verify', status: 'completed', conclusion: 'cancelled' }]
    await refused(await byRule('stage', 'acropora-stage-api'), `CI on the merge commit ${S.slice(0, 8)}: verify is cancelled`)
    rules.runs[S] = []
    expect((await (await byRule('stage', 'acropora-stage-api')).out).status).toBe('used')
  })

  it('a commit on main that no merged PR produced (a direct push, a PR head) refuses', async () => {
    rules.pullList = [{ number: 77, merged: false, mergeCommitSha: S, baseRef: 'main', headSha: HEAD }]
    await refused(await byRule('stage', 'acropora-stage-api'), `no merged pull request into main has ${S.slice(0, 8)}`)
    rules.pullList = [{ number: 78, merged: true, mergeCommitSha: S, baseRef: 'release', headSha: HEAD }]
    await refused(await byRule('stage', 'acropora-stage-api'), 'no merged pull request into main')
  })

  it('a GitHub read that fails approves nothing', async () => {
    for (const where of ['pulls', 'reviews', 'runs'] as const) {
      rules.throwOn = where
      await refused(await byRule('stage', 'acropora-stage-api'), 'a GitHub read of the rule path failed')
    }
  })
})

describe('what the rule never approves', () => {
  it('a step back to an older commit: only the owner reads that', async () => {
    cool.running.stageapi0001 = MAIN[5]!
    await refused(await byRule('stage', 'acropora-stage-api'), 'the running version is back of this commit')
  })

  it('without the rules section, or without the GitHub reads, nothing is approved by rule', async () => {
    make(configRaw(join(dir, 'state2'), null))
    await refused(await byRule('stage', 'acropora-stage-api'), 'the rule path is not configured')
    make(configRaw(join(dir, 'state3')), false)
    await refused(await byRule('stage', 'acropora-stage-api'), 'the rule path is not configured')
  })

  it('a grant R (a permission change) is never approved by rule', async () => {
    const rec = await ex.request({ env: 'stage', app: 'acropora-stage-api', action: 'deploy', sha: S, requester: 'acrobot' })
    const stored = store.get(rec.r)!
    store.put({ ...stored, grant: { gateKey: 'gatekey00001', database: 'acropora', listSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64), ops: ['+ T c'] } })
    await refused({ rec, out: ex.executeByRule({ r: rec.r }) }, 'a grant is never approved by rule')
  })

  it('a running version that moved after the request (someone deployed a newer one) refuses at execution', async () => {
    const rec = await ex.request({ env: 'stage', app: 'acropora-stage-api', action: 'deploy', sha: S, requester: 'acrobot' })
    cool.running.stageapi0001 = MAIN[3]!
    await refused({ rec, out: ex.executeByRule({ r: rec.r }) }, 'the running version changed since the approval')
  })

  it('the same R twice: the second is refused, Coolify called once', async () => {
    const { rec, out } = await byRule('stage', 'acropora-stage-api')
    await out
    await expect(ex.executeByRule({ r: rec.r })).rejects.toThrow('R was already used')
    expect(cool.rollbacks).toHaveLength(1)
  })
})

describe('prod-auto: verified on stage, nothing frozen', () => {
  async function verifiedOnStage(app = 'acropora-stage-api') {
    const { rec, out } = await byRule('stage', app)
    await out
    await Promise.all(ex.following)
    expect(ex.status(rec.r)!.outcome).toBe('finished_verified')
    cool.rollbacks.length = 0
  }

  it('after a finished_verified stage deployment of the same commit, prod is deployed and the evidence names it', async () => {
    await verifiedOnStage()
    const { rec, out } = await byRule('prod', 'acropora-api')
    expect((await out).status).toBe('used')
    expect(cool.rollbacks).toEqual([{ app: 'prodapi0001', commit: S }])
    expect(audit().filter((l) => l.event === 'approved').pop()).toMatchObject({ r: rec.r, rule: 'prod-auto', pr: 77, head: HEAD, filesChecked: 1 })
  })

  it('a commit not verified on stage refuses (ami a teszten átment)', async () => {
    await refused(await byRule('prod', 'acropora-api'), `${S.slice(0, 8)} is not verified on acropora-stage-api`)
  })

  it('a prod app without a stage counterpart refuses', async () => {
    await verifiedOnStage()
    await refused(await byRule('prod', 'nostage-api'), 'nostage-api names no stage app')
  })

  it('a commerce file to prod refuses and names the file; a rename out of a frozen path too', async () => {
    await verifiedOnStage()
    rules.files = [
      { path: 'apps/api/src/service/a.ts', previousPath: null },
      { path: 'apps/api/src/imports/unas/unas-order-sync.ts', previousPath: null },
    ]
    await refused(await byRule('prod', 'acropora-api'), 'changes the frozen file apps/api/src/imports/unas/unas-order-sync.ts')
    rules.files = [{ path: 'apps/api/src/shop/sync.ts', previousPath: 'apps/api/src/medusa/sync.ts' }]
    await refused(await byRule('prod', 'acropora-api'), 'changes the frozen file apps/api/src/medusa/sync.ts')
  })

  it('the same commerce file to STAGE is not refused: the freeze is about prod', async () => {
    rules.files = [{ path: 'apps/api/src/imports/unas/unas-order-sync.ts', previousPath: null }]
    expect((await (await byRule('stage', 'acropora-stage-api')).out).status).toBe('used')
  })

  it('a workflow file to prod is refused as well', async () => {
    await verifiedOnStage()
    rules.files = [{ path: '.github/workflows/test.yml', previousPath: null }]
    await refused(await byRule('prod', 'acropora-api'), 'changes the CI file .github/workflows/test.yml')
  })

  it('prod needs the required run on the merge commit too (the branch CI may lag a fresh merge)', async () => {
    await verifiedOnStage()
    rules.runs[S] = []
    await refused(await byRule('prod', 'acropora-api'), `CI on the merge commit ${S.slice(0, 8)}: the required check verify is missing`)
  })

  it('a frozen repository to prod refuses, whatever its files', async () => {
    await refused(await byRule('prod', 'commerce-api'), 'the repository KratoBal/acropora-commerce is frozen')
  })

  it('a file list that cannot be read whole refuses', async () => {
    await verifiedOnStage()
    rules.throwOn = 'files'
    await refused(await byRule('prod', 'acropora-api'), 'could not be read whole')
  })
})

describe('the settings of the rule path', () => {
  const base = () => configRaw('/srv/state') as unknown as Record<string, unknown> & { apps: Record<string, unknown>[]; rules: Record<string, unknown> }

  it('a stageApp must name a stage app of the same repository and branch, and only a prod app has one', () => {
    const wrongRepo = base()
    wrongRepo.apps[0]!.stageApp = 'commerce-stage'
    expect(() => parseExecutorConfig(wrongRepo)).toThrow(/another repository or branch/)
    const missing = base()
    missing.apps[0]!.stageApp = 'nincs-ilyen'
    expect(() => parseExecutorConfig(missing)).toThrow(/no stage app of that name/)
    const onStage = base()
    onStage.apps[1]!.stageApp = 'acropora-stage-api'
    expect(() => parseExecutorConfig(onStage)).toThrow(/only a prod app/)
  })

  it('the rules section is strict: no reviewer, a bad pattern, an unknown key refuse to start', () => {
    const empty = base()
    empty.rules.reviewerLogins = []
    expect(() => parseExecutorConfig(empty)).toThrow(/reviewerLogins/)
    const bad = base()
    bad.rules.frozenPaths = ['(unclosed']
    expect(() => parseExecutorConfig(bad)).toThrow(/not a regular expression/)
    const extra = base()
    extra.rules.allowAll = true
    expect(() => parseExecutorConfig(extra)).toThrow(/unknown key/)
  })

  it('an App bot login is refused as a reviewer: every agent acts as the fleet App (barracuda #267, 2)', () => {
    const bot = base()
    bot.rules.reviewerLogins = ['acroveliq-fleet[bot]']
    expect(() => parseExecutorConfig(bot)).toThrow(/reviewerLogins\[0\]/)
  })

  it('.github/ is always a CI path, and the configured ones come after it', () => {
    const c = parseExecutorConfig({ ...base(), rules: { ...defaultRules(), ciPaths: ['(^|/)scripts/ci/'] } })
    expect(c.rules!.ciPaths.map((r) => r.source)).toEqual(['^\\.github\\/', '(^|\\/)scripts\\/ci\\/'])
  })
})

describe('the example settings', () => {
  it('parse, with the rules section and a stage counterpart for every acropora-os prod app', () => {
    const example = parseExecutorConfig(JSON.parse(readFileSync(join(process.cwd(), 'deploy-executor', 'config.example.json'), 'utf8')))
    expect(example.rules?.frozenRepos).toEqual(['KratoBal/acropora-commerce'])
    const prodOs = example.apps.filter((a) => a.env === 'prod' && a.repo === 'KratoBal/acropora-os')
    expect(prodOs.length).toBeGreaterThan(0)
    expect(prodOs.every((a) => a.stageApp === 'acropora-stage-api')).toBe(true)
    expect(example.apps.filter((a) => a.repo === 'KratoBal/acropora-os').every((a) => (a.requiredChecks ?? []).includes('verify'))).toBe(true)
    // the freeze patterns catch the real commerce paths of acropora-os (measured 2026-10-19), and not a service path
    const frozen = (p: string) => example.rules!.frozenPaths.some((re) => re.test(p))
    for (const p of ['apps/api/src/integrations/medusa/x.ts', 'apps/api/src/imports/unas/x.ts', 'apps/api/src/orders/webshop-orders/x.ts', 'apps/web/src/components/webshop/x.tsx', 'packages/database/prisma/migrations/20261007220000_webshop_slug/migration.sql']) {
      expect(frozen(p), p).toBe(true)
    }
    expect(frozen('apps/api/src/maintenance/contract.ts')).toBe(false)
  })
})

describe('the GitHub reads of the rule path', () => {
  it('pages through a list, keeps the token in the header only, and refuses to judge a list it could not read whole', async () => {
    const urls: string[] = []
    let perPage = 100
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url)
      expect(init.headers.Authorization).toBe('Bearer TOKEN')
      expect(url).not.toContain('TOKEN')
      const page = Number(new URL(url).searchParams.get('page'))
      const items = Array.from({ length: page < 2 ? perPage : 7 }, (_, i) => ({ filename: `f${page}-${i}`, previous_filename: i === 0 ? 'old' : undefined }))
      return new Response(JSON.stringify(items), { status: 200 })
    }) as unknown as typeof fetch
    const g = githubRest('TOKEN', fetchImpl)
    const files = await g.pullFiles('KratoBal/acropora-os', 77)
    expect(files).toHaveLength(107)
    expect(files[0]).toEqual({ path: 'f1-0', previousPath: 'old' })
    expect(urls[0]).toBe('https://api.github.com/repos/KratoBal/acropora-os/pulls/77/files?per_page=100&page=1')

    // every page full: the 3000-file cap may have cut it, so it is not judged
    perPage = 100
    const full = (async (url: string) => new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ filename: url }))), { status: 200 })) as unknown as typeof fetch
    await expect(githubRest('TOKEN', full).pullFiles('KratoBal/acropora-os', 77)).rejects.toThrow('longer than the rule path reads')
    expect(RULE_MAX_PAGES).toBe(30)
  })
})
