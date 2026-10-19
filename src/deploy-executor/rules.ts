// THE RULE PATH (task vegrehajto-szabaly-jovahagyas). Balázs, 2026-10-19 19:54 UTC, "1 mehet 2 mehet 3 mehet"
// (emlék 2406, 2407; CLAUDE.md "NINCS DISCORDOS ENGEDÉLYEZGETÉS"):
//
//   stage-auto  a deploy R to a stage app is approved when its commit S
//                 - is the merge commit of exactly one merged pull request into the app's branch (on the branch is
//                   measured by the executor itself, as on the Discord path);
//                 - that pull request's head H has a green CI: at least one check run, every one completed, none
//                   failed; and S itself has no failed or unfinished check run (the push run on the branch);
//                 - the LATEST decisive review of a configured reviewer login on that pull request is APPROVED,
//                   for exactly H. That review is what `fleet-approve approve` posts, and it posts it only for a
//                   verdict in its root record for that head (D4): the executor cannot read the record, it reads
//                   what only the record lets out.
//   prod-auto   the same, and
//                 - the app names its stage counterpart, and this executor deployed S there and saw
//                   `finished_verified` ("ami a teszten átment");
//                 - the repository is not frozen, and no file the pull request changes (old or new path) matches a
//                   frozen path. The commerce freeze stands on Balázs's word, not on this rule: such a deploy is
//                   refused here, naming the file, and goes to him.
//
// A grant (fleet_ro) is never approved by rule: it is a permission change, the owner's own (CLAUDE.md, the
// list that goes to him). Neither is a step back, a fork or an unmeasured running version: the Discord path
// writes those into the line the owner reads, and a rule has no one to read it.
//
// Every refusal names the one condition that failed; the evidence of an approval goes into the audit line.
import type { AppEntry, RuleConfig } from './config.js'
import type { RequestRecord } from './store.js'
import type { CheckRunInfo, GitHubRuleReader } from './transports.js'

export type RuleName = 'stage-auto' | 'prod-auto'

export interface RuleEvidence {
  rule: RuleName
  pr: number
  head: string
  reviewer: string
  /** the check runs on the head, all green, and how many runs the merge commit had */
  checksHead: number
  checksMerge: number
  /** prod: the stage R that verified this commit, and how many changed paths were matched against the freeze */
  stageR?: string
  filesChecked?: number
}

export type RuleVerdict = { ok: true; evidence: RuleEvidence } | { ok: false; reason: string; rule: RuleName | null }

/** The finished conclusions a check run may have and still count as green. */
const GREEN = new Set(['success', 'neutral', 'skipped'])

export async function judgeByRule(input: {
  rec: RequestRecord
  app: AppEntry
  rules: RuleConfig | null
  github: GitHubRuleReader | undefined
  /** the Rs this executor holds; prod looks here for the stage deployment of the same commit */
  records: readonly RequestRecord[]
}): Promise<RuleVerdict> {
  const { rec, app, rules, github, records } = input
  const rule: RuleName | null = rec.env === 'stage' ? 'stage-auto' : rec.env === 'prod' ? 'prod-auto' : null
  const no = (reason: string): RuleVerdict => ({ ok: false, reason, rule })
  if (!rules || !github) return no('the rule path is not configured')
  if (rec.grant) return no('a grant is never approved by rule: it goes to the owner')
  if (rule === null) return no(`no rule for the environment ${rec.env}`)
  if (rec.relation.kind !== 'forward' && rec.relation.kind !== 'same') {
    return no(`the running version is ${rec.relation.kind} of this commit: only the owner may approve that`)
  }
  if (rule === 'prod-auto' && rules.frozenRepos.includes(app.repo)) return no(`the repository ${app.repo} is frozen: prod needs the owner's word`)

  const sha = rec.sha
  const merged = (await github.pullsForCommit(app.repo, sha)).filter((p) => p.merged && p.mergeCommitSha === sha && p.baseRef === app.branch)
  if (merged.length === 0) return no(`no merged pull request into ${app.branch} has ${short(sha)} as its merge commit`)
  if (merged.length > 1) return no(`more than one pull request has ${short(sha)} as its merge commit`)
  const pr = merged[0]!
  const head = pr.headSha
  if (!/^[0-9a-f]{40}$/.test(head)) return no(`pull request #${pr.number} has no readable head`)

  // the latest decisive review of each configured reviewer; a COMMENTED or PENDING one decides nothing
  const decisive = (await github.reviews(app.repo, pr.number)).filter(
    (r) => rules.reviewerLogins.includes(r.login) && r.state !== 'COMMENTED' && r.state !== 'PENDING',
  )
  const latest = decisive[decisive.length - 1]
  if (!latest) return no(`no review by ${rules.reviewerLogins.join(', ')} on #${pr.number}`)
  if (latest.state !== 'APPROVED') return no(`the latest review on #${pr.number} by ${latest.login} is ${latest.state}`)
  if (latest.commitId !== head) {
    return no(`the approval on #${pr.number} is for ${short(latest.commitId)}, not for the merged head ${short(head)}`)
  }

  const headRuns = await github.checkRuns(app.repo, head)
  const headProblem = notGreen(headRuns, true)
  if (headProblem) return no(`CI on the head ${short(head)}: ${headProblem}`)
  const mergeRuns = await github.checkRuns(app.repo, sha)
  const mergeProblem = notGreen(mergeRuns, false)
  if (mergeProblem) return no(`CI on the merge commit ${short(sha)}: ${mergeProblem}`)

  const evidence: RuleEvidence = { rule, pr: pr.number, head, reviewer: latest.login, checksHead: headRuns.length, checksMerge: mergeRuns.length }
  if (rule === 'stage-auto') return { ok: true, evidence }

  if (!app.stageApp) return no(`${app.name} names no stage app: prod by rule needs a verified stage deployment`)
  const onStage = records.find((r) => r.env === 'stage' && r.app === app.stageApp && r.sha === sha && r.outcome === 'finished_verified')
  if (!onStage) return no(`${short(sha)} is not verified on ${app.stageApp} (no finished_verified stage deployment of it here)`)
  let files: { path: string; previousPath: string | null }[]
  try {
    files = await github.pullFiles(app.repo, pr.number)
  } catch {
    return no(`the file list of #${pr.number} could not be read whole`)
  }
  for (const f of files) {
    for (const path of [f.path, f.previousPath]) {
      if (path === null) continue
      const hit = rules.frozenPaths.find((re) => re.test(path))
      if (hit) return no(`#${pr.number} changes the frozen file ${path} (matches ${hit.source}): prod needs the owner's word`)
    }
  }
  return { ok: true, evidence: { ...evidence, stageR: onStage.id, filesChecked: files.length } }
}

/** Why a set of check runs is not green, or null. `required`: an empty set is not green either. */
function notGreen(runs: readonly CheckRunInfo[], required: boolean): string | null {
  if (runs.length === 0) return required ? 'no check run' : null
  const running = runs.find((r) => r.status !== 'completed')
  if (running) return `${running.name} is ${running.status}`
  const red = runs.find((r) => !GREEN.has(r.conclusion ?? ''))
  if (red) return `${red.name} is ${red.conclusion ?? 'without a conclusion'}`
  return null
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'nothing'
}
