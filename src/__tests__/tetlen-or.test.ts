// scripts/tetlen-or.sh, the idle watchdog (not an LLM), run on a fake tree: agent-pane.sh, agent-msg.sh and
// zar-varakozok.py are stand-ins. WHAT TURNS THIS RED (acrobot 43759): a process waiting on the fleet lock past the
// threshold not reported because the panel shows nothing idle (murena, 2026-11-05: "shell still running", two hours on
// its own parent's lock); a deadlock not called one; a report repeated within the hour for the same state.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'tetlen-or.sh')
const root = mkdtempSync(join(tmpdir(), 'tetlen-or-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function tree(waiters: string) {
  const dir = mkdtempSync(join(root, 'fa-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'store'))
  const sent = join(dir, 'sent.txt')
  const put = (name: string, body: string) => {
    writeFileSync(join(dir, 'scripts', name), body)
    chmodSync(join(dir, 'scripts', name), 0o755)
  }
  // a panel with a turn in flight: nobody idle by the panel's measure
  put('agent-pane.sh', '#!/usr/bin/env bash\necho "esc to interrupt"\n')
  put('agent-msg.sh', `#!/usr/bin/env bash\nprintf '%s\\n' "$3" >> '${sent}'\n`)
  put('zar-varakozok.py', `#!/usr/bin/env python3\nprint(${JSON.stringify(waiters)}, end="")\n`)
  const run = () =>
    spawnSync('bash', [SCRIPT, '20'], { env: { ...process.env, TETLEN_OR_ROOT: dir, TETLEN_OR_HOUR: '20' }, encoding: 'utf-8' })
  const messages = () => (existsSync(sent) ? readFileSync(sent, 'utf-8').trim().split('\n') : [])
  return { run, messages }
}

describe('tetlen-or', () => {
  it('TETLEN-OR-ZAR: a deadlocked wait on the fleet lock is reported while the panel looks busy, once an hour', () => {
    const t = tree('murena 4242 35 4200 holtpont\n')
    t.run()
    t.run()
    const quiet = tree('')
    quiet.run()
    const sent = t.messages()
    expect(
      {
        count: sent.length,
        names: sent[0]?.includes('A flotta-zaron var: murena(35p, pid 4242, HOLTPONT'),
        idle: sent[0]?.includes('Tetlenul all'),
        quiet: quiet.messages(),
      },
      'TETLEN-OR-ZAR',
    ).toEqual({ count: 1, names: true, idle: false, quiet: [] })
  })
})
