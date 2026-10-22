import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  The scripts that used to fall back to the shared dashboard token silently (P0-1, task p01-csendes-visszaeso-hivok,
  PR 4 of 4): fleet-doctor.py, fleet-state.py, task-last-run.sh, pr-beolvaszt.sh's candidate finder, and the new
  `fleet-api.sh agents`. (heartbeat-metrics.sh has its own test file.)
  What turns these red: any of them presenting the shared token when the own one is missing; a missing token read as
  a measured ZERO (the doctor's queue column, the state page's schedules); a script that carries on after the
  resolver's error; the own token not presented when it exists.
*/

const REPO = process.cwd()
const MAIN = 'proba-fo'
let server: Server
let port = 0
let seen: { auth: string; path: string }[] = []
let root = ''
let agentsRunning = true

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), path: req.url ?? '' })
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      const url = req.url ?? ''
      if (url.startsWith('/api/messages')) {
        res.end(JSON.stringify([{ status: 'pending', to_agent: 'al-agens', id: 1 }, { status: 'pending', to_agent: 'al-agens', id: 2 }, { status: 'done', to_agent: 'al-agens', id: 3 }]))
      } else if (url.startsWith('/api/agents')) {
        res.end(JSON.stringify([{ name: 'al-agens', running: agentsRunning, model: 'proba-modell' }, { name: 'masik', running: false }]))
      } else if (url.startsWith('/api/schedules')) {
        res.end('[]')
      } else {
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
  agentsRunning = true
})

/** A fake install with the resolvers and the scripts under test copied in. */
function install(ownToken: string | null) {
  root = mkdtempSync(join(tmpdir(), 'scripts-own-token-'))
  for (const d of ['scripts/lib', 'store/tokens', 'agents/al-agens']) mkdirSync(join(root, d), { recursive: true })
  for (const f of ['lib/dashboard-token.sh', 'lib/dashboard_token.py', 'fleet-doctor.py', 'fleet-state.py', 'task-last-run.sh', 'fleet-api.sh', 'pr-beolvaszt.sh', 'local-now.sh'])
    copyFileSync(join(REPO, 'scripts', f), join(root, 'scripts', f))
  writeFileSync(join(root, 'agents', 'al-agens', 'agent-config.json'), JSON.stringify({ runAsUser: 'nincs-ilyen-felhasznalo' }))
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${MAIN}\nWEB_PORT=${port}\n`)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'KOZOS-TOKEN-NEM-HASZNALT\n')
  if (ownToken !== null) writeFileSync(join(root, 'store', 'tokens', `${MAIN}.token`), ownToken)
}

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}, input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      env: {
        ...process.env,
        FLEET_ROOT: root,
        FLEET_DASH: `http://127.0.0.1:${port}`,
        MARVEEN_WEB_PORT: String(port),
        CLAW_DIR: root,
        ...extraEnv,
      },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
    if (input !== undefined) p.stdin.write(input)
    p.stdin.end()
  })
}

const done = () => rmSync(root, { recursive: true, force: true })

describe('fleet-doctor.py', () => {
  it('own token: the queue is counted from the dashboard (2 pending for al-agens)', async () => {
    install('own-token\n')
    const r = await run('python3', ['-B', join(root, 'scripts', 'fleet-doctor.py')])
    expect(seen.every((q) => q.auth === 'Bearer own-token')).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(r.out).toContain('2 message(s) queued')
    expect(r.out).not.toContain('UNKNOWN')
    done()
  })

  it('NO own token: no request, and the queue is UNKNOWN (not zero), and the exit says attention', async () => {
    install(null)
    const r = await run('python3', ['-B', join(root, 'scripts', 'fleet-doctor.py')])
    expect(seen, 'the shared token must not be presented').toHaveLength(0)
    expect(r.out).toContain('message queue UNKNOWN (not zero)')
    expect(r.out).toMatch(/own dashboard token/)
    expect(r.out).not.toContain('KOZOS-TOKEN')
    expect(r.out).toMatch(/al-agens\s.*\s\?\n/)
    expect(r.code).toBe(1)
    done()
  })
})

// fleet-doctor.py: "is it running" (task fleet-doctor-running, acrobot 35256). Measured 2026-10-22: the real launcher line is
// /etc/fleet-pane/conf/claude/<version>/claude, which the old substring "/bin/claude" never matched, so the doctor said
// "not running" for all six agents while the dashboard said running; and /proc is hidepid=invisible, so a process of
// another user may simply not be there to see. A fake `ps` stands in for both shapes.
describe('fleet-doctor.py: the running state', () => {
  const TMUX = '   2273 /usr/bin/tmux new-session -d -s agent-al-agens -x 200 -y 24 /usr/bin/env -i HOME=/home/x /etc/fleet-pane/conf/claude/2.1.301/claude --continue'
  const BROKER = '   2274 /etc/fleet-pane/conf/claude/2.1.301/claude --continue --dangerously-skip-permissions --model m --name al-agens'
  const NPM = '   2360 npm exec @modelcontextprotocol/server-github'
  const OLD = '   2275 /usr/local/bin/claude --dangerously-skip-permissions --name al-agens'

  function withPs(lines: string[]) {
    const bin = join(root, 'fakebin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'ps'), `#!/bin/bash\ncat <<'EOF'\n${lines.join('\n')}\nEOF\n`)
    chmodSync(join(bin, 'ps'), 0o755)
    return { PATH: `${bin}:${process.env.PATH}` }
  }
  const doctor = (env: Record<string, string>) => run('python3', ['-B', join(root, 'scripts', 'fleet-doctor.py')], env)
  const rowOf = (out: string) => out.split('\n').find((l) => l.startsWith('al-agens')) ?? ''

  const detect = (lines: string[]) =>
    run(
      'python3',
      ['-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(root, 'scripts'))}); import importlib.util as u; s=u.spec_from_file_location('d', ${JSON.stringify(join(root, 'scripts', 'fleet-doctor.py'))}); m=u.module_from_spec(s); s.loader.exec_module(m); print(repr(m.claude_process('x')))`],
      withPs(lines),
    )

  it('the process match is the executable basename: the broker path matches, the tmux wrapper and npm do not', async () => {
    install('own-token\n')
    expect((await detect([TMUX, BROKER, NPM])).out.trim()).toContain('/etc/fleet-pane/conf/claude/2.1.301/claude --continue --dangerously-skip-permissions')
    expect((await detect([TMUX, NPM])).out.trim()).toBe('None')
    expect((await detect([OLD])).out.trim()).toContain('/usr/local/bin/claude')
    done()
  })

  it('the dashboard says running and the process is not visible: NOT "not running"; an info line says the checks were skipped', async () => {
    install('own-token\n')
    const r = await doctor(withPs([]))
    expect(rowOf(r.out)).not.toBe('')
    expect(r.out).not.toContain('not running')
    expect(r.out).toContain('the process is not visible from here')
    expect(r.out).toContain('skipped, not passed')
    done()
  })

  it('the dashboard says running and the broker process IS visible: no conflict, the launch flag is checked', async () => {
    install('own-token\n')
    const r = await doctor(withPs([TMUX, BROKER]))
    expect(r.out).not.toContain('not running')
    expect(r.out).not.toContain('is not visible')
    expect(r.out).not.toContain('EXISTS although')
    done()
  })

  it('the dashboard says NOT running: it is reported as such, with the source', async () => {
    install('own-token\n')
    agentsRunning = false
    const r = await doctor(withPs([]))
    expect(r.out).toContain('not running (the dashboard says so)')
    done()
  })

  it('the dashboard says not running but a claude process EXISTS: a conflict is reported', async () => {
    install('own-token\n')
    agentsRunning = false
    const r = await doctor(withPs([BROKER]))
    expect(r.out).toContain('EXISTS although the dashboard says not running')
    done()
  })

  it('no dashboard answer (no own token) and the process is not visible: UNKNOWN, never "not running"', async () => {
    install(null)
    const r = await doctor(withPs([]))
    expect(r.out).toContain("running state UNKNOWN (not 'not running')")
    expect(r.out).not.toContain('not running\n')
    expect(rowOf(r.out)).toMatch(/\?\s+\?\s+\?/)
    done()
  })

  it('no dashboard answer but the process is visible: running, from the process line', async () => {
    install(null)
    const r = await doctor(withPs([TMUX, BROKER]))
    expect(r.out).not.toContain('running state UNKNOWN')
    expect(r.out).not.toContain('not running')
    done()
  })
})

describe('fleet-state.py', () => {
  it('own token: the schedules are read with it', async () => {
    install('own-token\n')
    const r = await run('python3', ['-B', join(root, 'scripts', 'fleet-state.py')])
    expect(seen.some((q) => q.path === '/api/schedules')).toBe(true)
    expect(seen.every((q) => q.auth === 'Bearer own-token')).toBe(true)
    expect(r.out).not.toContain('Nem tudom megmondani')
    done()
  })

  it('NO own token: no request, and the page says it CANNOT SAY (not "there is no schedule")', async () => {
    install(null)
    const r = await run('python3', ['-B', join(root, 'scripts', 'fleet-state.py')])
    expect(seen).toHaveLength(0)
    // BOTH schedule sections (the auto-update question and the schedule table) say it, each on its own
    expect((r.out.match(/Nem tudom megmondani/g) ?? []).length).toBe(2)
    expect(r.out).toMatch(/own dashboard token/)
    expect(r.out).not.toContain('KOZOS-TOKEN')
    done()
  })
})

describe('task-last-run.sh', () => {
  it('own token: the request carries it', async () => {
    install('own-token\n')
    await run('bash', [join(root, 'scripts', 'task-last-run.sh'), 'pr-figyeles'])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((q) => q.auth === 'Bearer own-token')).toBe(true)
    done()
  })

  it('NO own token: it stops with FAIL, no request, NOT the shared token (the :- default used to take it)', async () => {
    install(null)
    const r = await run('bash', [join(root, 'scripts', 'task-last-run.sh'), 'pr-figyeles'])
    expect(r.code).toBe(1)
    expect(seen).toHaveLength(0)
    expect(r.err).toContain('nincs hasznalhato sajat token')
    done()
  })
})

describe('fleet-api.sh agents', () => {
  it('lists the agents with the OWN token: name, running, model', async () => {
    install('own-token\n')
    const r = await run('bash', [join(root, 'scripts', 'fleet-api.sh'), 'agents'])
    expect(r.code).toBe(0)
    expect(r.out.trim().split('\n')).toEqual(['al-agens\trunning\tproba-modell', 'masik\tstopped\t-'])
    expect(seen).toEqual([{ auth: 'Bearer own-token', path: '/api/agents' }])
    done()
  })

  it('a dashboard answer that is not JSON gives one FAIL line, not a traceback', async () => {
    install('own-token\n')
    const r = await run('bash', [join(root, 'scripts', 'fleet-api.sh'), 'agents'], { MARVEEN_WEB_PORT: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out + r.err).not.toContain('Traceback')
    expect(r.out).toMatch(/^FAIL/m)
    done()
  })

  it('no own token: no request (the helper stops, never the shared token)', async () => {
    install(null)
    const r = await run('bash', [join(root, 'scripts', 'fleet-api.sh'), 'agents'])
    expect(seen).toHaveLength(0)
    expect(r.out + r.err).not.toContain('al-agens')
    done()
  })
})

describe('pr-beolvaszt.sh candidate finder (_jeloltek_kiir)', () => {
  // the function lives inside a heredoc python program of the script; it is cut out of the script text and run with a
  // stubbed subprocess, so no curl, no GitHub and no real install is touched
  const probe = `
import json, os, sys, time, types
src = open(os.path.join(os.environ['PR_BEOLVASZT_ROOT'], 'scripts', 'pr-beolvaszt.sh')).read()
start = src.index('def _jeloltek_kiir(')
end = src.index('\\n_t2, _c2 = api(', start)
calls = []
def run(args, input=None, capture_output=None, text=None):
    calls.append({'args': args, 'input': input})
    return types.SimpleNamespace(stdout='[]')
subprocess = types.SimpleNamespace(run=run)
g = {}
exec(src[start:end], {'json': json, 'os': os, 'sys': sys, 'time': time, 'subprocess': subprocess}, g)
g['_jeloltek_kiir']('abcdef1234567890', 0)
print('CALLS=' + json.dumps(calls))
`
  it('own token: curl gets the OWN token on stdin, on the configured port', async () => {
    install('own-token\n')
    const r = await run('python3', ['-B', '-c', probe], { PR_BEOLVASZT_ROOT: root })
    const calls = JSON.parse(r.out.split('CALLS=')[1]!.trim())
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe('Authorization: Bearer own-token\n')
    expect(calls[0].args.join(' ')).toContain(`localhost:${port}/api/messages`)
    done()
  })

  it('NO own token: curl is NOT called (the shared token is not presented), and the finder says why', async () => {
    install(null)
    const r = await run('python3', ['-B', '-c', probe], { PR_BEOLVASZT_ROOT: root })
    expect(JSON.parse(r.out.split('CALLS=')[1]!.trim())).toEqual([])
    expect(r.out).toContain('a jelolt-kereso nem ert el az uzenetsorhoz')
    expect(r.out).toMatch(/own dashboard token/)
    expect(r.out).not.toContain('KOZOS-TOKEN')
    done()
  })
})
