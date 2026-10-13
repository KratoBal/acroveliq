import { describe, expect, it } from 'vitest'

import {
  changeFingerprint,
  githubProbe,
  handoffRequiredFields,
  validateHandoffRecord,
  verifyCodeState,
  type CodeStateProbe,
  type HandoffCodeState,
} from '../task-handoff.js'

/*
  THE LIVE COMMIT OF A MERGED CHANGE (koord-proba #57, acrobot msg 29913). The record of a
  fresh session wrote the live tree's head (a cherry-pick on tc-release) and handoff-read
  stopped with a mismatch although the change was the PR's. What turns these red: a
  `code.deployed` commit that carries the PR's change and sits on its branch still being a
  mismatch; one that carries ANOTHER change, sits off the branch, or cannot be measured
  passing; the fingerprint depending on line numbers or context lines, or not on the
  changed lines (handoff-read-kontextus: e81d9bd and 3288ec59, one context line apart).
  Measured on the real case before writing this: 2dc6145 (the #57 merge) and 0b6783d (its
  cherry-pick on tc-release) give the same fingerprint, and 0b6783d is 3 behind tc-release.
*/

const PR_HEAD = '1570fe4e989b72c7ae3df5db0eb771de604b14ed'
const MERGE = '2dc6145f058f446d80a256fa8f4e2afaf7be47bf'
const CP = '0b6783dc8c000000000000000000000000000000'
const OTHER = '88c5c1a000000000000000000000000000000000'

const merged = (extra: Partial<HandoffCodeState> = {}): HandoffCodeState => ({
  repo: 'KratoBal/marveen', branch: 'b45-runas-kovetes', head: PR_HEAD, pr: 57, merged: true, ...extra,
})

function probe(opts: { change?: Record<string, string | null | undefined>; on?: boolean | null | undefined } = {}): CodeStateProbe {
  const change = opts.change ?? { [MERGE]: 'X', [CP]: 'X', [OTHER]: 'Y' }
  return {
    async branchHead() { return null },
    async pullRequest() { return { state: 'closed', merged: true, headSha: PR_HEAD, mergeSha: MERGE } },
    async changeOf(_repo, sha) { return change[sha] },
    async onBranch() { return opts.on === undefined && !('on' in opts) ? true : opts.on },
  }
}

describe('code.deployed: the live commit of a merged PR', () => {
  it('a cherry-pick with the same change, on its branch: no mismatch', async () => {
    const c = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: CP } }), probe())
    expect(c).toMatchObject({ ok: true, mismatches: [] })
  })

  it('another change, off the branch, or not measurable: each is a mismatch (exit 3 at the reader)', async () => {
    const other = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: OTHER } }), probe())
    expect(other.mismatches.join(' ')).toMatch(/nem ugyanazt a változást hordozza/)
    const off = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: CP } }), probe({ on: false }))
    expect(off.mismatches.join(' ')).toMatch(/nincs rajta a tc-release ágon/)
    const blind = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: CP } }), probe({ change: { [MERGE]: 'X', [CP]: undefined } }))
    expect(blind.ok).toBe(false)
    const gone = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: CP } }), probe({ on: null }))
    expect(gone.ok).toBe(false)
  })

  it('the old shape (the live head written as code.head) is still a mismatch, and says where it belongs', async () => {
    const c = await verifyCodeState(merged({ head: OTHER }), probe())
    expect(c.ok).toBe(false)
    expect(c.mismatches[0]).toMatch(/code\.deployed mezőbe való/)
  })

  it('the validator: deployed only on a merged record, with a branch name and a sha', () => {
    const base = { task: { id: 't', goal: 'g', brief: 'b' }, status: 'done', decisions: [], prohibitions: [], files: [], next_step: 'x', open_questions: [] }
    expect(validateHandoffRecord({ ...base, code: merged({ deployed: { branch: 'tc-release', head: CP } }) }).ok).toBe(true)
    const bad = (code: unknown) => { const r = validateHandoffRecord({ ...base, code }); return r.ok ? [] : r.missing }
    expect(bad(merged({ merged: false, deployed: { branch: 'tc-release', head: CP } }))).toContain('code.deployed (only for a merged record: the live commit of a merged change)')
    expect(bad(merged({ deployed: { branch: 'a..b', head: 'zz' } }))).toEqual(['code.deployed.branch (a branch name, without ..)', 'code.deployed.head (a sha, at least 7 hex digits)'])
  })
})

describe('the change fingerprint', () => {
  const f = (patch: string, extra = {}) => [{ filename: 'a.ts', status: 'modified', patch, ...extra }]
  it('ignores the hunk line numbers, not the content', () => {
    const p1 = '@@ -10,3 +10,4 @@ fn\n a\n+b\n c'
    const p2 = '@@ -40,3 +41,4 @@ fn\n a\n+b\n c'
    expect(changeFingerprint(f(p1))).toBe(changeFingerprint(f(p2)))
    expect(changeFingerprint(f(p1))).not.toBe(changeFingerprint(f('@@ -10,3 +10,4 @@ fn\n a\n+X\n c')))
  })
  // handoff-read-kontextus: e81d9bd (tc-release) and 3288ec59 (main, #71) carry the same
  // added lines; main has an approval-discord import next to them, tc-release does not
  it('ignores the context lines: the same change next to other lines is the same', () => {
    const tc = "@@ -1,4 +1,5 @@\n import { a } from './a.js'\n+import { b } from './b.js'\n import { c } from './c.js'\n-import { d } from './d.js'\n+import { e } from './e.js'"
    const main = "@@ -3,4 +3,5 @@\n import { a } from './a.js'\n+import { b } from './b.js'\n import { discord } from './approval-discord.js'\n-import { d } from './d.js'\n+import { e } from './e.js'"
    expect(changeFingerprint(f(tc))).toBe(changeFingerprint(f(main)))
  })
  it('another added or removed line is still another change', () => {
    const base = '@@ -1,3 +1,3 @@\n a\n-old\n+new\n c'
    expect(changeFingerprint(f(base))).not.toBe(changeFingerprint(f('@@ -1,3 +1,3 @@\n a\n-old\n+NEW\n c')))
    expect(changeFingerprint(f(base))).not.toBe(changeFingerprint(f('@@ -1,3 +1,3 @@\n a\n-OLD\n+new\n c')))
    expect(changeFingerprint(f(base))).not.toBe(changeFingerprint(f('@@ -1,2 +1,3 @@\n a\n+new\n c')))
    // the same lines in another file: another change
    expect(changeFingerprint(f(base))).not.toBe(changeFingerprint(f(base, { filename: 'b.ts' })))
  })
  it('one hunk or two (the context decides where git splits) gives the same value', () => {
    const one = '@@ -1,7 +1,9 @@\n a\n+x\n b\n c\n d\n e\n+y\n f'
    const two = '@@ -1,3 +1,4 @@\n a\n+x\n b\n@@ -8,3 +9,4 @@\n e\n+y\n f'
    expect(changeFingerprint(f(one))).toBe(changeFingerprint(f(two)))
  })
  // barracuda, review of #79: a conflict resolution that pushes two blocks together
  it('two changes with context between them, and the same two changes touching: another change', () => {
    const apart = '@@ -1,5 +1,7 @@\n a\n+x\n b\n c\n d\n+y\n e'
    const touching = '@@ -1,2 +1,4 @@\n a\n+x\n+y\n b'
    expect(changeFingerprint(f(apart))).not.toBe(changeFingerprint(f(touching)))
  })
  it('the missing-newline marker counts after a changed line, not after a context line', () => {
    const changed = '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a'
    expect(changeFingerprint(f(changed))).not.toBe(changeFingerprint(f('@@ -1 +1 @@\n-a\n+a')))
    const ctxA = '@@ -1,2 +1,3 @@\n+x\n z\n\\ No newline at end of file'
    expect(changeFingerprint(f(ctxA))).toBe(changeFingerprint(f('@@ -1,2 +1,3 @@\n+x\n z\n w')))
  })
  it('a file without a patch (binary) stands by its blob', () => {
    expect(changeFingerprint([{ filename: 'p.png', status: 'added', sha: 'aaa' }])).not.toBe(changeFingerprint([{ filename: 'p.png', status: 'added', sha: 'bbb' }]))
  })
})

describe('the required fields, named up front', () => {
  it('names task, status and code.branch for a development record, and the four fields for a coordination one', () => {
    const dev = handoffRequiredFields(false).join(' | ')
    for (const s of ['task {id, goal, brief}', 'status (', 'code {repo, branch, head', 'next_step']) expect(dev).toContain(s)
    const co = handoffRequiredFields(true).join(' | ')
    for (const s of ["kind: 'coordination'", 'state {phase', 'next_steps [{what, who}]', 'open_questions [{from, what}]', 'quote']) expect(co).toContain(s)
  })
})

describe('the real probe: nothing measured is never "the same" (barracuda, review of #75)', () => {
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  it('an empty file list is not measurable', async () => {
    expect(await githubProbe('t', answer({ files: [], parents: [{}] })).changeOf!('o/r', 'abc1234')).toBeUndefined()
  })
  it('a merge commit (two parents) is not measurable: its list is the combined diff', async () => {
    const files = [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]
    expect(await githubProbe('t', answer({ files, parents: [{}, {}] })).changeOf!('o/r', 'abc1234')).toBeUndefined()
    expect(await githubProbe('t', answer({ files, parents: [{}] })).changeOf!('o/r', 'abc1234')).toBe(changeFingerprint(files))
  })
  it('so two empty commits make a mismatch, not agreement', async () => {
    const empty = githubProbe('t', (async (url: string) => {
      if (String(url).includes('/pulls/')) return new Response(JSON.stringify({ state: 'closed', merged: true, head: { sha: PR_HEAD }, merge_commit_sha: MERGE }), { status: 200 })
      if (String(url).includes('/compare/')) return new Response(JSON.stringify({ status: 'ahead' }), { status: 200 })
      return new Response(JSON.stringify({ files: [], parents: [{}] }), { status: 200 })
    }) as unknown as typeof fetch)
    const c = await verifyCodeState(merged({ deployed: { branch: 'tc-release', head: CP } }), empty)
    expect(c.ok).toBe(false)
    expect(c.mismatches.join(' ')).toMatch(/nem vethető össze/)
  })
})
