// scripts/memoria-or.py, the memory guard (not an LLM, task flotta-memoria-or), run on a fake tree and a fake /proc:
// agent-pane.sh, daily-log.sh and curl are stand-ins. WHAT TURNS THIS RED: an agent stopped while its panel shows a
// turn, a running shell or a permission prompt; acrobot stopped at all; more than one stop per run; a stop with plenty
// of memory, or none under pressure (low MemAvailable, or a swap-in rate sustained over two runs, not one spike); a
// start before 10 continuous minutes above 2.5 GB, or of an agent it did not stop; a start that is fresh; the token on
// a command line; a dry run that calls the API or changes the list; a failed start of an agent somebody else started
// blocking the others.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'memoria-or.py')
const root = mkdtempSync(join(tmpdir(), 'memoria-or-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const IDLE = '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n'
const BUSY = '✻ Working… (12s · ↓ 300 tokens · esc to interrupt)\n'
const SHELL = '  1 shell still running\n  ⏵⏵ bypass permissions on\n'
// measured 2026-11-06 on a pane with a run_in_background shell
const BACKGROUND = '❯ \n  ⏵⏵ bypass permissions on · 1 shell · ← for agents\n'
const MODAL = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n'
const TOKEN = 'test-token-not-a-secret'

function tree(panes: Record<string, string>) {
  const dir = mkdtempSync(join(root, 'fa-'))
  for (const d of ['scripts', 'store/tokens', 'panes', 'proc']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'store/tokens/acrobot.token'), `${TOKEN}\n`)
  for (const [agent, pane] of Object.entries(panes)) writeFileSync(join(dir, 'panes', agent), pane)
  const put = (name: string, body: string) => {
    writeFileSync(join(dir, 'scripts', name), body)
    chmodSync(join(dir, 'scripts', name), 0o755)
  }
  put('agent-pane.sh', `#!/usr/bin/env bash\n[ -f '${dir}/panes/'"$1" ] || exit 1\ncat '${dir}/panes/'"$1"\n`)
  put('daily-log.sh', `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >> '${dir}/daily.txt'\n`)
  // the fake API: records the call (argv and the header read from stdin); a stop takes the agent's panel away, a start
  // brings back an idle one; FAKE_CODE overrides the answer
  put(
    'curl',
    `#!/usr/bin/env bash\nurl="\${@: -1}"\nhdr=$(cat)\nprintf '%s ## %s\\n' "$*" "$hdr" >> '${dir}/calls.txt'\n` +
      `agent=$(basename "$(dirname "$url")"); verb=$(basename "$url")\n` +
      `code="\${FAKE_CODE:-200}"\nif [ "$code" = 200 ]; then [ "$verb" = stop ] && rm -f '${dir}/panes/'"$agent"; [ "$verb" = start ] && printf '%s' '${IDLE}' > '${dir}/panes/'"$agent"; fi\n` +
      `printf '%s' "$code"\n`,
  )
  const run = (o: { availMb: number; now: number; pswpin?: number; dry?: boolean; code?: string }) => {
    writeFileSync(join(dir, 'proc/meminfo'), `MemTotal:        8000000 kB\nMemAvailable:    ${o.availMb * 1024} kB\n`)
    writeFileSync(join(dir, 'proc/vmstat'), `pgpgin 1\npswpin ${o.pswpin ?? 0}\npswpout 0\n`)
    return spawnSync('python3', [SCRIPT], {
      env: {
        ...process.env,
        MEMORIA_OR_ROOT: dir,
        MEMORIA_OR_MEMINFO: join(dir, 'proc/meminfo'),
        MEMORIA_OR_VMSTAT: join(dir, 'proc/vmstat'),
        MEMORIA_OR_NOW: String(o.now),
        MEMORIA_OR_CURL: join(dir, 'scripts', 'curl'),
        MEMORIA_OR_DRY_RUN: o.dry ? 'on' : '',
        FAKE_CODE: o.code ?? '200',
      },
      encoding: 'utf-8',
    })
  }
  const calls = () =>
    existsSync(join(dir, 'calls.txt')) ? readFileSync(join(dir, 'calls.txt'), 'utf-8').trim().split('\n') : []
  const verbs = () => calls().map((c) => c.split(' ## ')[0]!.split(' ').at(-1)!.replace('http://localhost:3420/api/agents/', ''))
  const daily = () => (existsSync(join(dir, 'daily.txt')) ? readFileSync(join(dir, 'daily.txt'), 'utf-8').trim().split('\n') : [])
  const stopped = () => JSON.parse(readFileSync(join(dir, 'store/memoria-or.state'), 'utf-8')).stopped
  const setPane = (agent: string, pane: string) => writeFileSync(join(dir, 'panes', agent), pane)
  return { run, calls, verbs, daily, stopped, setPane }
}

const T0 = 1_793_960_000

describe('memoria-or', () => {
  it('MEMORIA-OR-STOP: under pressure one idle agent per run, lowest priority first; never a busy, modal or running-shell one, never acrobot', () => {
    const t = tree({ acrobot: IDLE, korall: BUSY, polip: MODAL, picasso: SHELL, barracuda: IDLE, murena: IDLE, nautilus: BACKGROUND })
    const first = t.run({ availMb: 800, now: T0 })
    t.run({ availMb: 700, now: T0 + 60 })
    expect(
      { code: first.status, verbs: t.verbs(), stopped: t.stopped(), daily: t.daily().length },
      'MEMORIA-OR-STOP',
    ).toEqual({ code: 0, verbs: ['barracuda/stop', 'murena/stop'], stopped: ['barracuda', 'murena'], daily: 2 })
    // the token went in on stdin, never on the command line
    expect(t.calls().every((c) => !c.split(' ## ')[0]!.includes(TOKEN) && c.split(' ## ')[1] === `Authorization: Bearer ${TOKEN}`), 'MEMORIA-OR-TOKEN').toBe(true)
    // nothing idle left (acrobot never counts): a third run stops nobody
    t.run({ availMb: 600, now: T0 + 120 })
    expect(t.verbs().length, 'MEMORIA-OR-NOTHING-LEFT').toBe(2)
  })

  it('MEMORIA-OR-START: only after 10 continuous minutes above 2.5 GB, one per run, highest priority first, only its own, not fresh', () => {
    const t = tree({ korall: IDLE, polip: IDLE, picasso: IDLE })
    t.run({ availMb: 500, now: T0 })
    t.run({ availMb: 500, now: T0 + 60 })
    expect(t.stopped(), 'MEMORIA-OR-START-SETUP').toEqual(['korall', 'polip'])
    // a dip below 2.5 GB restarts the clock
    t.run({ availMb: 3000, now: T0 + 120 })
    t.run({ availMb: 2000, now: T0 + 400 })
    t.run({ availMb: 3000, now: T0 + 460 })
    t.run({ availMb: 3000, now: T0 + 460 + 599 })
    expect(t.verbs(), 'MEMORIA-OR-START-WAIT').toEqual(['korall/stop', 'polip/stop'])
    t.run({ availMb: 3000, now: T0 + 460 + 600 })
    // the clock starts again after a start: no second start in the next minute, nor before 10 more minutes
    t.run({ availMb: 3000, now: T0 + 460 + 660 })
    t.run({ availMb: 3000, now: T0 + 460 + 1199 })
    expect(t.verbs(), 'MEMORIA-OR-START-ONE-PER-TEN').toEqual(['korall/stop', 'polip/stop', 'polip/start'])
    t.run({ availMb: 3000, now: T0 + 460 + 1200 })
    t.run({ availMb: 3000, now: T0 + 460 + 1260 })
    expect({ verbs: t.verbs(), stopped: t.stopped() }, 'MEMORIA-OR-START').toEqual({
      verbs: ['korall/stop', 'polip/stop', 'polip/start', 'korall/start'],
      stopped: [],
    })
    // the start body is the plain one: the agent continues its conversation
    expect(t.calls().filter((c) => c.includes('/start')).every((c) => c.includes('--data {}')), 'MEMORIA-OR-NOT-FRESH').toBe(true)
  })

  it('MEMORIA-OR-SWAP: a swap-in rate over 2500 pages/s on two runs in a row is pressure; one spike is not', () => {
    const t = tree({ korall: IDLE })
    t.run({ availMb: 2000, now: T0, pswpin: 0 })
    t.run({ availMb: 2000, now: T0 + 60, pswpin: 60 * 3000 })
    t.run({ availMb: 2000, now: T0 + 120, pswpin: 60 * 3000 + 60 * 100 })
    expect(t.verbs(), 'MEMORIA-OR-SWAP-SPIKE').toEqual([])
    t.run({ availMb: 2000, now: T0 + 180, pswpin: 60 * 3100 + 60 * 3000 })
    t.run({ availMb: 2000, now: T0 + 240, pswpin: 60 * 3100 + 60 * 6000 })
    expect(t.verbs(), 'MEMORIA-OR-SWAP').toEqual(['korall/stop'])
  })

  it('MEMORIA-OR-DRY: a dry run calls no API and leaves the list as it was', () => {
    const t = tree({ korall: IDLE })
    const out = t.run({ availMb: 500, now: T0, dry: true })
    expect({ calls: t.calls(), stopped: t.stopped(), said: out.stdout.includes('DRY RUN, stop korall') }, 'MEMORIA-OR-DRY').toEqual({
      calls: [],
      stopped: [],
      said: true,
    })
  })

  it('MEMORIA-OR-STARTED-BY-OTHERS: a failed start of an agent that is running again takes it off the list, and the next one goes on', () => {
    const t = tree({ korall: IDLE, polip: IDLE })
    t.run({ availMb: 500, now: T0 })
    t.run({ availMb: 500, now: T0 + 60 })
    // somebody started polip by hand; the API refuses a second start
    t.setPane('polip', IDLE)
    t.run({ availMb: 3000, now: T0 + 120 })
    t.run({ availMb: 3000, now: T0 + 720, code: '409' })
    expect(t.stopped(), 'MEMORIA-OR-STARTED-BY-OTHERS').toEqual(['korall'])
    t.run({ availMb: 3000, now: T0 + 780 })
    expect({ verbs: t.verbs(), stopped: t.stopped() }, 'MEMORIA-OR-STARTED-BY-OTHERS-NEXT').toEqual({
      verbs: ['korall/stop', 'polip/stop', 'polip/start', 'korall/start'],
      stopped: [],
    })
  })

  it('MEMORIA-OR-START-FAILING: an API that keeps refusing the start of a stopped agent is said once, at the fifth try, and the agent stays listed', () => {
    const t = tree({ korall: IDLE })
    t.run({ availMb: 500, now: T0 })
    t.run({ availMb: 3000, now: T0 + 60 })
    for (let i = 0; i < 6; i++) t.run({ availMb: 3000, now: T0 + 660 + i * 60, code: '500' })
    expect(
      { starts: t.verbs().filter((v) => v.endsWith('/start')).length, stopped: t.stopped(), said: t.daily().filter((l) => l.includes('otodszor')).length },
      'MEMORIA-OR-START-FAILING',
    ).toEqual({ starts: 6, stopped: ['korall'], said: 1 })
  })
})
