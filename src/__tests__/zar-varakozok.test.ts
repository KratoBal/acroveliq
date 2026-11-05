// scripts/zar-varakozok.py, the fleet-lock waiter watch of tetlen-or.sh (acrobot 43759), on real flock processes.
// WHAT TURNS THIS RED: a process waiting on the lock longer than the threshold not named; a wait under a holder that is
// its own ancestor (it never lets go) not called a deadlock, or a plain wait called one; a young wait named; the
// agent not read from the process owner.
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'zar-varakozok.py')
const root = mkdtempSync(join(tmpdir(), 'zar-varakozok-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const me = userInfo().username
const agent = me.startsWith('agent-') ? me.slice('agent-'.length) : me === 'marveen' ? 'acrobot' : me

describe('zar-varakozok', () => {
  it('ZAR-VARAKOZOK: names the waiter, calls a wait under its own ancestor a deadlock, leaves a young wait out', async () => {
    const lock = join(root, 'nehez.lock')
    writeFileSync(lock, '')
    // a holder whose child waits on the same lock (the murena shape), and an outside waiter
    const deadlock = spawn('timeout', ['6', 'flock', lock, 'bash', '-c', `flock '${lock}' true`], { stdio: 'ignore' })
    await sleep(300)
    // started directly: its pid is the waiter's (under `timeout` the waiter would be timeout's child)
    const plain = spawn('flock', [lock, 'true'], { stdio: 'ignore' })
    await sleep(1200)
    const read = (perc: string) =>
      spawnSync('python3', [SCRIPT, '--zar', lock, '--perc', perc], { encoding: 'utf-8' })
        .stdout.trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [who, pid, , holder, kind] = line.split(' ')
          return { who, pid: Number(pid), holder: Number(holder), kind }
        })
        .sort((a, b) => a.kind.localeCompare(b.kind))
    const now = read('0')
    const young = read('5')
    deadlock.kill()
    plain.kill()
    expect(
      {
        kinds: now.map((w) => w.kind),
        agents: [...new Set(now.map((w) => w.who))],
        plainIsTheOutsider: now.find((w) => w.kind === 'var')?.pid === plain.pid,
        sameHolder: now.length === 2 && now[0]!.holder === now[1]!.holder,
        young,
      },
      'ZAR-VARAKOZOK',
    ).toEqual({ kinds: ['holtpont', 'var'], agents: [agent], plainIsTheOutsider: true, sameHolder: true, young: [] })
  })

  it('ZAR-VARAKOZOK-NOLOCK: no lock file, no line and no error', () => {
    const r = spawnSync('python3', [SCRIPT, '--zar', join(root, 'nincs.lock'), '--perc', '0'], { encoding: 'utf-8' })
    expect({ code: r.status, out: r.stdout }, 'ZAR-VARAKOZOK-NOLOCK').toEqual({ code: 0, out: '' })
  })
})
