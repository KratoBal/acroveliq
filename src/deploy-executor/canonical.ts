// The one line the owner approves (SB1 plan 3.1 step 2, three-changes 2).
// The executor builds it from its own record, it goes out as the whole
// description of the #33 request, and at execution the executor rebuilds the
// whole Discord message from it and compares letter for letter.
import { descriptionMaxFor, neutralDescription } from '../web/approval-discord-core.js'
import type { Relation } from './store.js'

export const APPROVAL_CATEGORY = 'coolify_deploy'

export function relationSuffix(rel: Relation): string {
  switch (rel.kind) {
    case 'forward':
    case 'same':
      return ''
    // the approved commit is older than the running one: say so (barracuda, CHANGES 2)
    case 'back':
      return ` / VISSZALEPES ${rel.runningSha.slice(0, 8)}`
    // neither contains the other: not a step forward either
    case 'diverged':
      return ` / ELAGAZAS ${rel.runningSha.slice(0, 8)}`
    case 'unmeasured':
      return ' / VISZONY NEM MERT'
  }
}

export const GRANT_APPROVAL_CATEGORY = 'fleet_ro_grant'

/**
 * The line of a grant R: the same head as a deploy's, then the commit, the first 16 digits of the list's and the plan's
 * sha256 (for the eye; the execution compares all 64 digits from the record), then the plan text itself. The owner sees
 * the table and column names. A line longer than the category allows is refused, not cut: a cut line would approve
 * what the owner did not read.
 */
export function grantCanonicalLine(r: { id: string; env: string; app: string; sha: string; listSha256: string; planSha256: string; planText: string }): string {
  const line = `VEGREHAJTO R=${r.id} / ${r.env} / ${r.app} / fleet-ro-grant / ${r.sha} / lista ${r.listSha256.slice(0, 16)} / terv ${r.planSha256.slice(0, 16)} / ${r.planText}`
  if (neutralDescription(line, descriptionMaxFor(GRANT_APPROVAL_CATEGORY)) !== `> ${line}`) throw new GrantLineError(line.length)
  return line
}

/** The grant line does not fit the approval text, or the neutraliser would change it. */
export class GrantLineError extends Error {
  constructor(readonly length: number) {
    super(`grant line of ${length} characters does not fit the approval text`)
  }
}

export function canonicalLine(r: { id: string; env: string; app: string; action: string; sha: string; relation: Relation }): string {
  const line = `VEGREHAJTO R=${r.id} / ${r.env} / ${r.app} / ${r.action} / ${r.sha}${relationSuffix(r.relation)}`
  // #33 neutralises the description (markdown characters to spaces, a length
  // cap): a line it would change could never match letter for letter later
  if (neutralDescription(line) !== `> ${line}`) throw new Error('canonical line is not neutral')
  return line
}

/** Two relations are the same claim: same kind, same running commit. */
export function sameRelation(a: Relation, b: Relation): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'unmeasured' || b.kind === 'unmeasured') return true
  return a.runningSha === b.runningSha
}
