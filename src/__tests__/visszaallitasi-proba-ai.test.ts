// scripts/visszaallitasi-proba-ai.py (card f7d08f28): the AI branch of the weekly restore probe. WHAT TURNS THIS RED: a restored
// dump whose newest message is older than what the live database held at the dump's time passing; the old host gate (no newest=)
// failing the probe instead of saying "not measured"; a quiet AI (no live message before the dump) failing; the counts' rules lost.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'visszaallitasi-proba-ai.py')
const NAME = 'acropora-ai-2026-11-23_04-30-01.dump'
const check = (got: string, live: string) => {
  const r = spawnSync('python3', [SCRIPT, got, live, NAME], { encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}
const counts = 'conversations=10 messages=200 answer_ratings=3'

describe('visszaallitasi-proba-ai.py: the restored AI dump is whole and as fresh as live was at its time', () => {
  it('fresh: the restored newest reaches the live newest at the dump time: exit 0', () => {
    expect(check(`${counts} newest=1795400000`, `${counts} newest=1795399990`).code).toBe(0)
  })

  it('stale content: the restored newest is a day behind what live held at the dump time: FAIL', () => {
    const r = check(`${counts} newest=1795313600`, `${counts} newest=1795400000`)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/FAIL\[ai\]: a visszatoltott mentes legfrissebb uzenete/)
  })

  it('the host gate not yet reinstalled (no newest= from restore-probe): said as not measured, no FAIL', () => {
    const r = check(counts, `${counts} newest=1795400000`)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/frissesseg: NEM MERT/)
  })

  it('a quiet AI: no live message before the dump time: nothing to compare, no FAIL', () => {
    expect(check(`${counts} newest=none`, `${counts} newest=none`).code).toBe(0)
  })

  it('the counts as before: above live, or zero messages, is a FAIL; a restored "none" against a live message too', () => {
    expect(check('conversations=10 messages=300 answer_ratings=3 newest=1', `${counts} newest=1`).code).toBe(1)
    expect(check('conversations=10 messages=0 answer_ratings=0 newest=none', `${counts} newest=none`).code).toBe(1)
    expect(check(`${counts} newest=none`, `${counts} newest=1795400000`).code).toBe(1)
  })
})
