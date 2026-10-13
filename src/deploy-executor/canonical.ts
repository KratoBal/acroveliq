// The one line the owner approves (SB1 plan 3.1 step 2, three-changes 2).
// The executor builds it from its own record, it goes out as the whole
// description of the #33 request, and at execution the executor rebuilds the
// whole Discord message from it and compares letter for letter.
import { neutralDescription } from '../web/approval-discord-core.js'
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
