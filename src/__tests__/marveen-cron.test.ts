// scripts/crontab/marveen.cron, the crontab lines that must survive a container recreate. WHAT TURNS THIS RED: the
// idle and fleet-lock watchdog (tetlen-or.sh) missing from it again (acrobot 43759: lost since the 2026-10-13 recreate,
// because it lived only in the live crontab), or pointing at a script that is not in the repo.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CRON = join(process.cwd(), 'scripts', 'crontab', 'marveen.cron')

describe('marveen.cron', () => {
  it('MARVEEN-CRON-TETLEN-OR: the idle watchdog runs every ten minutes between 08 and 24, and its script exists', () => {
    const lines = readFileSync(CRON, 'utf-8').split('\n').filter((l) => l.includes('tetlen-or.sh'))
    const live = lines.filter((l) => !l.startsWith('#'))
    expect(
      { live, script: existsSync(join(process.cwd(), 'scripts', 'tetlen-or.sh')) },
      'MARVEEN-CRON-TETLEN-OR',
    ).toEqual({
      live: ['*/10 8-23 * * * /home/marveen/marveen/scripts/tetlen-or.sh 20 >>/home/marveen/marveen/store/tetlen-or.log 2>&1'],
      script: true,
    })
  })
})
