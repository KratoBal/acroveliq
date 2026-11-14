import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Card fde4acc2 (task t-20261114-lemez-kapu): the disk-cleanup preCheck. WHAT TURNS THIS RED: a gate that skips while a
// signal is over its threshold (the stage disk filling with IMAGES slept through a Build-Cache-only gate; the numbers
// below are the measured ones of 2026-11-14 18:49); a gate that wakes the PROD cleanup every 6 hours for nothing
// (four model rounds a day at builder-prune 0 B); a failed ssh that reads as SKIP instead of failing open.
const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts/precheck/lemez-kapu.sh')
const WRAPPER = join(ROOT, 'scripts/precheck/stage-gyorsitotar.sh')
const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface World {
  /** `df -P` rows after the header: "<fs> <size> <used> <avail> <pct>% <mount>" */
  disks: string[]
  /** `system-df --format` rows: "<Type>|<Size>|<Reclaimable>" */
  docker: string[]
  /** true: the ssh stub fails like an unreachable host */
  unreachable?: boolean
}

/** A fake `ssh` first on PATH: it records the host and answers the two gate operations from the world. */
function run(args: string[], world: World, script = SCRIPT) {
  const dir = mkdtempSync(join(tmpdir(), 'lemez-kapu-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'df.txt'), ['Filesystem 1024-blocks Used Available Capacity Mounted on', ...world.disks].join('\n') + '\n')
  writeFileSync(join(dir, 'docker.txt'), world.docker.join('\n') + '\n')
  writeFileSync(
    join(dir, 'ssh'),
    `#!/bin/bash
echo "$@" >> "${dir}/ssh.log"
${world.unreachable ? 'exit 255' : ''}
for a in "$@"; do last="$a"; prev2="$prev"; prev="$a"; done
case "$*" in
  *"system-df --format"*) cat "${dir}/docker.txt" ;;
  *" df -P"*) cat "${dir}/df.txt" ;;
  *) exit 99 ;;
esac
`,
  )
  chmodSync(join(dir, 'ssh'), 0o755)
  const r = spawnSync('bash', [script, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf-8' })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '', log: readFileSync(join(dir, 'ssh.log'), 'utf-8') }
}

// the measured states of 2026-11-14 18:49
const STAGE_NOW: World = {
  disks: ['/dev/sda1 78643200 13631488 62914560 18% /', '/dev/sdb 206569472 79691776 117440512 41% /var/lib/docker'],
  docker: ['Images|34.99GB|19.71GB (56%)', 'Containers|26.12MB|24.58kB (0%)', 'Local Volumes|2.654GB|682.4MB (25%)', 'Build Cache|45.06GB|40.57GB'],
}
const PROD_NOW: World = {
  disks: ['/dev/sda1 78643200 28311552 47185920 38% /', '/dev/sdb 206569472 61865984 134217728 32% /var/lib/docker'],
  docker: ['Images|14.51GB|3.143GB (21%)', 'Containers|3.282GB|24.58kB (0%)', 'Local Volumes|1.883GB|0B (0%)', 'Build Cache|0B|0B'],
}
const withDocker = (w: World, docker: string[]): World => ({ ...w, docker })
const withDisk = (w: World, disks: string[]): World => ({ ...w, disks })
const QUIET_STAGE_DOCKER = ['Images|10.00GB|1.50GB (15%)', 'Containers|26.12MB|24.58kB (0%)', 'Local Volumes|2.654GB|682.4MB (25%)', 'Build Cache|0.90GB|0.30GB']

describe('lemez-kapu.sh stage', () => {
  it('SKIP when every signal is under its threshold', () => {
    const r = run(['stage'], withDocker(STAGE_NOW, QUIET_STAGE_DOCKER))
    expect([r.code, r.out]).toEqual([0, 'SKIP'])
  })

  it('the measured stage state of 2026-11-14 wakes it: Build Cache 40.57 GB and Images 19.71 GB reclaimable', () => {
    const r = run(['stage'], STAGE_NOW)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^\[preCheck meres, stage\]/)
    expect(r.out).toMatch(/Build Cache visszanyerheto 40\.57 GB >= 2 GB/)
    expect(r.out).toMatch(/Kepek visszanyerheto 19\.71 GB >= 10 GB/)
  })

  it('IMAGES alone wake it: a disk filling with images (cache quiet, disk 41 percent) was the case the old gate slept through', () => {
    const r = run(['stage'], withDocker(STAGE_NOW, ['Images|34.99GB|19.71GB (56%)', 'Build Cache|0.90GB|0.30GB']))
    expect(r.out).toMatch(/Kepek visszanyerheto 19\.71 GB >= 10 GB/)
    expect(r.out).not.toMatch(/Build Cache visszanyerheto [\d.]+ GB >=/)
  })

  it('the disk at 80 percent wakes it by itself, whichever of the two disks is fuller', () => {
    const r = run(['stage'], withDisk(withDocker(STAGE_NOW, QUIET_STAGE_DOCKER), ['/dev/sda1 1 1 1 18% /', '/dev/sdb 1 1 1 83% /var/lib/docker']))
    expect(r.out).toMatch(/lemez 83% >= 80%/)
    expect(r.out).toMatch(/gyoker es Docker-lemez kozul a telebb: 18\/83/)
  })

  it('the thresholds are inclusive at the line and quiet just under it', () => {
    const under = run(['stage'], withDocker(withDisk(STAGE_NOW, ['/dev/sda1 1 1 1 79% /']), ['Images|9GB|9.99GB (50%)', 'Build Cache|1.99GB|1.99GB']))
    const at = run(['stage'], withDocker(withDisk(STAGE_NOW, ['/dev/sda1 1 1 1 79% /']), ['Images|9GB|10GB (50%)', 'Build Cache|1.99GB|1.99GB']))
    expect([under.out, at.out.startsWith('[preCheck meres, stage]')]).toEqual(['SKIP', true])
  })

  it('talks to the STAGE host with exactly the two gate operations, df -P then system-df --format', () => {
    const r = run(['stage'], STAGE_NOW)
    const calls = r.log.trim().split('\n')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('fleet@100.88.199.87 df -P')
    expect(calls[1]).toContain('fleet@100.88.199.87 system-df --format')
  })

  it('an unreachable host exits non-zero: the runner fails open and wakes the agent, it is never read as SKIP', () => {
    const r = run(['stage'], { ...STAGE_NOW, unreachable: true })
    expect([r.code === 0, r.out]).toEqual([false, ''])
  })

  it('an answer it cannot parse (no Build Cache row, or no Images row on stage) fails open too', () => {
    const noCache = run(['stage'], withDocker(STAGE_NOW, ['Images|1GB|0B (0%)']))
    const noImages = run(['stage'], withDocker(STAGE_NOW, ['Build Cache|0B|0B']))
    expect([noCache.code === 0, noImages.code === 0]).toEqual([false, false])
  })
})

describe('lemez-kapu.sh eles', () => {
  it('the measured prod state of 2026-11-14 SKIPS: cache 0 B, disk 38/32 percent; its 3.1 GB of reclaimable images is NOT a signal', () => {
    const r = run(['eles'], PROD_NOW)
    expect([r.code, r.out]).toEqual([0, 'SKIP'])
  })

  it('prod ignores the images however large: 15 GB of reclaimable images alone does not wake it', () => {
    const r = run(['eles'], withDocker(PROD_NOW, ['Images|30GB|15GB (50%)', 'Build Cache|0B|0B']))
    expect(r.out).toBe('SKIP')
  })

  it('prod wakes on its Build Cache (2 GB) and on its disk (80 percent)', () => {
    const cache = run(['eles'], withDocker(PROD_NOW, ['Images|14GB|3GB (21%)', 'Build Cache|23.7GB|23.7GB']))
    const disk = run(['eles'], withDisk(PROD_NOW, ['/dev/sdb 1 1 1 86% /var/lib/docker']))
    expect([cache.out, disk.out].map((o) => /^\[preCheck meres, eles\]/.test(o))).toEqual([true, true])
    expect(cache.out).toMatch(/Build Cache visszanyerheto 23\.70 GB/)
    expect(disk.out).toMatch(/lemez 86% >= 80%/)
  })

  it('talks to the PROD host, never the stage host', () => {
    const r = run(['eles'], PROD_NOW)
    expect(r.log).toContain('fleet@162.55.216.28')
    expect(r.log).not.toContain('100.88.199.87')
  })
})

describe('lemez-kapu.sh arguments and the old name', () => {
  it('no argument or an unknown host: usage, exit 2, and no ssh at all', () => {
    const none = spawnSync('bash', [SCRIPT], { encoding: 'utf-8' })
    const other = spawnSync('bash', [SCRIPT, 'valami'], { encoding: 'utf-8' })
    expect([none.status, other.status]).toEqual([2, 2])
    expect(none.stderr).toMatch(/usage: lemez-kapu\.sh stage\|eles/)
  })

  it('stage-gyorsitotar.sh (the name the disabled schedule still holds) answers exactly like lemez-kapu.sh stage', () => {
    const a = run([], STAGE_NOW, WRAPPER)
    const b = run(['stage'], STAGE_NOW)
    expect([a.code, a.out]).toEqual([b.code, b.out])
    expect(a.out).toMatch(/^\[preCheck meres, stage\]/)
  })
})
