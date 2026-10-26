import { execFile } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/*
  The deny-rule gate (scripts/hooks/deny-normalizing-gate.py, task tiltott-osszetett-parancs) is Python and its guard is
  scripts/hooks/tests/deny-normalizing-gate.test.py. The CI workflow lists the Python guards one by one and a workflow
  file is not this agent's to edit, so `npm test` runs it from here: the same file, the same exit code, and a floor under
  the number of checks so that a guard which quietly runs nothing turns red.
  WHAT TURNS THIS RED: any check of the Python file failing, or fewer than 14 checks running.
*/
describe('deny-normalizing-gate.py and its guard', () => {
  it('the Python guard passes, with all its checks', async () => {
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(
        'python3',
        ['-B', join(process.cwd(), 'scripts', 'hooks', 'tests', 'deny-normalizing-gate.test.py')],
        { timeout: 120_000, maxBuffer: 10_000_000 },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, text: stdout + stderr }),
      )
    })
    expect(out.text).toMatch(/\nOK\s*$/)
    const ran = Number(/Ran (\d+) tests?/.exec(out.text)?.[1] ?? 0)
    expect(ran).toBeGreaterThanOrEqual(14)
    expect(out.code).toBe(0)
  }, 150_000)
})
