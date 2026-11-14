import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Card fde4acc2 (task t-20261114-lemez-kapu): the PROD disk-cleanup preCheck. WHAT TURNS THIS RED: a gate that skips
// while a signal is over its threshold; a gate that wakes the prod cleanup every 6 hours for nothing (four model rounds
// a day at builder-prune 0 B, measured 2026-11-14); a failed ssh or an unparseable answer that reads as SKIP instead of
// failing open; a gate that reaches the stage host or can be put in front of the stage cleanup, which Balazs ordered
// UNCONDITIONAL on 2026-11-04 (msg 1567610781254811670: "nem kell megvarni amig felmegy 80%-ra").
const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts/precheck/lemez-kapu.sh')
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
function run(args: string[], world: World) {
  const dir = mkdtempSync(join(tmpdir(), 'lemez-kapu-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'df.txt'), ['Filesystem 1024-blocks Used Available Capacity Mounted on', ...world.disks].join('\n') + '\n')
  writeFileSync(join(dir, 'docker.txt'), world.docker.join('\n') + '\n')
  writeFileSync(
    join(dir, 'ssh'),
    `#!/bin/bash
echo "$@" >> "${dir}/ssh.log"
${world.unreachable ? 'exit 255' : ''}
case "$*" in
  *"system-df --format"*) cat "${dir}/docker.txt" ;;
  *" df -P"*) cat "${dir}/df.txt" ;;
  *) exit 99 ;;
esac
`,
  )
  chmodSync(join(dir, 'ssh'), 0o755)
  const r = spawnSync('bash', [SCRIPT, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf-8' })
  const logFile = join(dir, 'ssh.log')
  return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '', log: existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '' }
}

// the measured prod state of 2026-11-14 18:49: every cleanup round of the day freed 0 B
const PROD_NOW: World = {
  disks: ['/dev/sda1 78643200 28311552 47185920 38% /', '/dev/sdb 206569472 61865984 134217728 32% /var/lib/docker'],
  docker: ['Images|14.51GB|3.143GB (21%)', 'Containers|3.282GB|24.58kB (0%)', 'Local Volumes|1.883GB|0B (0%)', 'Build Cache|0B|0B'],
}
const withDocker = (w: World, docker: string[]): World => ({ ...w, docker })
const withDisk = (w: World, disks: string[]): World => ({ ...w, disks })

describe('lemez-kapu.sh eles', () => {
  it('the measured prod state SKIPS: cache 0 B, disk 38/32 percent; its 3.1 GB of reclaimable images is not a signal', () => {
    const r = run(['eles'], PROD_NOW)
    expect([r.code, r.out]).toEqual([0, 'SKIP'])
  })

  it('prod ignores the images however large: 15 GB of reclaimable images alone does not wake it', () => {
    const r = run(['eles'], withDocker(PROD_NOW, ['Images|30GB|15GB (50%)', 'Build Cache|0B|0B']))
    expect(r.out).toBe('SKIP')
  })

  it('wakes on the Build Cache (2 GB) with the measurement and the reason in the line', () => {
    const r = run(['eles'], withDocker(PROD_NOW, ['Images|14GB|3GB (21%)', 'Build Cache|23.7GB|23.7GB']))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^\[preCheck meres, eles\]/)
    expect(r.out).toMatch(/Build Cache visszanyerheto 23\.70 GB >= 2 GB/)
  })

  it('wakes on the disk (80 percent) by itself, whichever of the two disks is fuller', () => {
    const r = run(['eles'], withDisk(PROD_NOW, ['/dev/sda1 1 1 1 18% /', '/dev/sdb 1 1 1 86% /var/lib/docker']))
    expect(r.out).toMatch(/lemez 86% >= 80%/)
    expect(r.out).toMatch(/gyoker es Docker-lemez kozul a telebb: 18\/86/)
  })

  it('the thresholds are inclusive at the line and quiet just under it', () => {
    const under = run(['eles'], withDocker(withDisk(PROD_NOW, ['/dev/sda1 1 1 1 79% /']), ['Build Cache|1.99GB|1.99GB']))
    const atCache = run(['eles'], withDocker(withDisk(PROD_NOW, ['/dev/sda1 1 1 1 79% /']), ['Build Cache|2GB|2GB']))
    const atDisk = run(['eles'], withDocker(withDisk(PROD_NOW, ['/dev/sda1 1 1 1 80% /']), ['Build Cache|0B|0B']))
    expect([under.out, atCache.out.startsWith('[preCheck meres, eles]'), atDisk.out.startsWith('[preCheck meres, eles]')]).toEqual(['SKIP', true, true])
  })

  it('talks to the PROD host with exactly the two gate operations, df -P then system-df --format, and never the stage host', () => {
    const r = run(['eles'], PROD_NOW)
    const calls = r.log.trim().split('\n')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('fleet@162.55.216.28 df -P')
    expect(calls[1]).toContain('fleet@162.55.216.28 system-df --format')
    expect(r.log).not.toContain('100.88.199.87')
  })

  it('an unreachable host exits non-zero: the runner fails open and wakes the agent, it is never read as SKIP', () => {
    const r = run(['eles'], { ...PROD_NOW, unreachable: true })
    expect([r.code === 0, r.out]).toEqual([false, ''])
  })

  it('an answer it cannot parse (no Build Cache row, no disk row, a size it cannot read) fails open too', () => {
    const noCache = run(['eles'], withDocker(PROD_NOW, ['Images|1GB|0B (0%)']))
    const noDisk = run(['eles'], withDisk(PROD_NOW, []))
    const badSize = run(['eles'], withDocker(PROD_NOW, ['Build Cache|kb|many']))
    expect([noCache.code === 0, noDisk.code === 0, badSize.code === 0]).toEqual([false, false, false])
  })
})

describe('lemez-kapu.sh arguments: the stage cleanup stays unconditional', () => {
  it('`stage` is refused with exit 2 and NO ssh at all: a gate in front of the stage cleanup would override the owner (2026-11-04)', () => {
    const r = run(['stage'], PROD_NOW)
    expect([r.code, r.log]).toEqual([2, ''])
    expect(r.err).toMatch(/stage cleanup is unconditional/)
    expect(r.err).toContain('1567610781254811670')
  })

  it('no argument or an unknown host: usage, exit 2, and no ssh', () => {
    const none = run([], PROD_NOW)
    const other = run(['valami'], PROD_NOW)
    expect([none.code, none.log, other.code, other.log]).toEqual([2, '', 2, ''])
    expect(none.err).toMatch(/usage: lemez-kapu\.sh eles/)
  })

  it('the script header cites the owner decision with its message id and words, so nobody wires a stage preCheck from it', () => {
    const text = readFileSync(SCRIPT, 'utf-8')
    expect(text).toContain('1567610781254811670')
    expect(text).toContain('nem kell megvarni amig felmegy 80%-ra')
    expect(text).toMatch(/must? ?not|stays UNCONDITIONAL/i)
  })

  it('stage-gyorsitotar.sh (the old gate of the disabled schedule) is untouched and does not call lemez-kapu.sh', () => {
    const old = readFileSync(join(ROOT, 'scripts/precheck/stage-gyorsitotar.sh'), 'utf-8')
    expect(old).toContain('fleet@100.88.199.87')
    expect(old).not.toContain('lemez-kapu')
  })
})
