import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { reviewRefGuard } from '../task-usage.js'

/*
  CARD f1e388e5 (barracuda, review of #78). review-ellenoriz.sh is the reviewer profile's ONLY
  verdict path, and until this card its ref was "<VERDICT> pr-<packet> fej <sha7>": no
  owner/repo#N, so in naplo mode every verdict was would_reject and in kenyszerit mode a 409.
  This test takes the refs the script ACTUALLY wrote in its own guard test (not a hand-written
  copy of its shape) and puts each through the Task Core guard. What turns it red: the script
  dropping the repo#N again, or the guard no longer accepting the shape the script writes.
*/

const REPO_ROOT = process.cwd()

describe('review-ellenoriz.sh refs pass the Task Core review-ref guard', () => {
  it('every verdict ref the script wrote names its PR as owner/repo#N', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-refs-'))
    try {
      const out = join(dir, 'refs')
      const r = await new Promise<{ code: number; text: string }>((resolve) =>
        execFile('bash', [join(REPO_ROOT, 'scripts', '__tests__', 'review-scripts.test.sh')], { env: { ...process.env, REVIEW_REFS_OUT: out } },
          (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, text: stdout + stderr })),
      )
      expect(r.text).toContain('all pass')
      expect(r.code).toBe(0)
      const refs = readFileSync(out, 'utf-8').split('\n').filter(Boolean)
      // the three repos' packet prefixes, each at least once, and a document packet
      for (const repo of ['KratoBal/marveen#', 'KratoBal/acropora-os#', 'KratoBal/acropora-commerce#', 'KratoBal/acropora-ai-agent#', ' doc-'])
        expect(refs.some((ref) => ref.includes(repo))).toBe(true)
      // a PR ref passes the code rule; a document ref (task review-docs-verdict) passes on a
      // docs or ops task only, and is still refused on a code task: it names a file, not a PR
      for (const ref of refs) {
        if (ref.includes(' doc-')) {
          for (const profile of ['docs', 'ops']) expect([ref, profile, reviewRefGuard('verdict', ref, null, profile)]).toEqual([ref, profile, null])
          expect(reviewRefGuard('verdict', ref, null, 'code_fleet'), ref).not.toBeNull()
        } else expect([ref, reviewRefGuard('verdict', ref, null, 'code_fleet')]).toEqual([ref, null])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // it runs the whole review-scripts.test.sh (2.7 s alone, with a local GitHub stub since E3 (b));
    // under the parallel suite that went past vitest's 5 s default on 2026-10-16
  }, 60_000)
})
