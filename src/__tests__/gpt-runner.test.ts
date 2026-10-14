// The GPT runner container (gpt-runner/; task t-20261014-gpt-futtato-kontener).
//
// WHAT TURNS THIS RED:
//   - a check of the probe calls a fleet uid/group, a capability, a readable fleet file, an
//     answering internal port, or a sandbox that let the network through anything but FAIL;
//   - a negative network test or a sandbox result without its control is called OK instead of
//     NEM_MERHETO (a probe that could not have failed is not a proof);
//   - "the sandbox never started the command" is called OK (blocked) instead of NEM_MERHETO;
//   - the compose file loses a limit, gains a bind mount, a secret, a host port, the docker
//     socket, a fleet path, a second network, root, or a restart policy (the GPT side is off);
//   - the base image is no longer forced to a digest, or the Codex version drifts between
//     package.json, the lockfile and the probe;
//   - the probe, run here in the fleet's own container, does not come out red.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rootCertificates, createServer as createTlsServer } from 'node:tls'
import {
  HOST_PORTS, SYSTEM_EXACT, networkTargets, globalIpv6, checkIpv6, checkHome, RUNNER_HOME,
  SYSTEM_CA, TLS_HOSTS, judgeTls, tlsSystemCa,
  AUTH_FILE, checkTestOverrides, checkAuthFile, safeExecArgs, v3Checks, V3_TEST_ARGS, V3_CONTROL_ARGS, V3_CANARIES, toolUses, V3_PROMPT, checkIds, checkCaps, classifyReadable, judgeNetwork, judgeSandboxRun, codexSandboxChecks,
  idsFromStatus, summarize, PINNED_CODEX, FLEET_IDS,
} from '../../gpt-runner/proba.mjs'

const R = (p: string) => readFileSync(join(__dirname, '..', '..', 'gpt-runner', p), 'utf8')
const STATUS = (o: Partial<Record<string, string>>) =>
  ['Uid:\t10002\t10002\t10002\t10002', 'Gid:\t10002\t10002\t10002\t10002', 'Groups:\t', 'NoNewPrivs:\t1', 'CapPrm:\t0000000000000000', 'CapEff:\t0000000000000000', 'CapBnd:\t0000000000000000']
    .map((l) => { const k = l.split(':')[0]; return o[k] != null ? `${k}:\t${o[k]}` : l }).join('\n')

describe('gpt-runner probe: the pure checks', () => {
  it('G0: the runner uid is clean; a fleet uid, gid or supplementary group is FAIL', () => {
    expect(checkIds(idsFromStatus(STATUS({})))[0]).toBe('OK')
    // an empty Groups line (the container's real case) reads as no group, not as the next line
    expect(idsFromStatus(STATUS({})).groups).toEqual([])
    expect([
      checkIds(idsFromStatus(STATUS({ Uid: '1004\t1004\t1004\t1004' })))[0],
      checkIds(idsFromStatus(STATUS({ Gid: '1001\t1001\t1001\t1001' })))[0],
      checkIds(idsFromStatus(STATUS({ Groups: '10002 1015 1001' })))[0],
      checkIds(idsFromStatus(STATUS({ Uid: '0\t0\t0\t0' })))[0],
      // an allowlist, not a denylist: a new agent's uid, a mistyped user line, an extra group
      checkIds(idsFromStatus(STATUS({ Uid: '1007\t1007\t1007\t1007' })))[0],
      checkIds(idsFromStatus(STATUS({ Gid: '10003\t10003\t10003\t10003' })))[0],
      checkIds(idsFromStatus(STATUS({ Groups: '10002 10010' })))[0],
      checkIds({ uid: [], gid: [], groups: [] })[0],
    ]).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL'])
    expect(FLEET_IDS).toEqual(expect.arrayContaining([0, 1000, 1001, 1004, 1006]))
  })

  it('CAP: any effective, permitted or bounding capability, or no_new_privs off, is FAIL', () => {
    expect(checkCaps(STATUS({}))[0]).toBe('OK')
    expect([
      checkCaps(STATUS({ CapEff: '0000000000000400' }))[0],
      checkCaps(STATUS({ CapPrm: '00000000a80425fb' }))[0],
      checkCaps(STATUS({ CapBnd: '000001ffffffffff' }))[0],
      checkCaps(STATUS({ NoNewPrivs: '0' }))[0],
      checkCaps('Uid:\t1\n')[0],
    ]).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL'])
  })

  it('F2: a readable file off the system paths, or with a fleet marker, is reported', () => {
    const r = classifyReadable(['/usr/lib/x.so', '/app/proba.mjs', '/tmp/kanari-proba.txt', '/home/marveen/marveen/store/x', '/opt/acropora-commerce-stage/backend/apps/backend/.env', '/etc/ssl/certs/a.pem'])
    expect(r.outside).toEqual(['/home/marveen/marveen/store/x', '/opt/acropora-commerce-stage/backend/apps/backend/.env'])
    expect(r.marked).toEqual(expect.arrayContaining(['/home/marveen/marveen/store/x', '/opt/acropora-commerce-stage/backend/apps/backend/.env']))
    expect(classifyReadable(['/usr/bin/node', '/etc/passwd', '/tmp/kanari-proba.txt'])).toEqual({ outside: [], marked: [], own: [] })
  })

  it("F2-DOCKERENV: Docker's own /.dockerenv is allowed by EXACT path only (the first live run's false hit)", () => {
    expect(SYSTEM_EXACT).toEqual(['/.dockerenv'])
    expect(classifyReadable(['/.dockerenv']).outside).toEqual([])
    expect(classifyReadable(['/.dockerenv.bak', '/.dockerenvx/a', '/.dockerinit']).outside).toEqual(['/.dockerenv.bak', '/.dockerenvx/a', '/.dockerinit'])
  })

  it("F2-OWN-HOME: the runner's own home is counted apart, not FAIL; a fleet-marked file there still is", () => {
    const lock = '/home/gpt/.codex/tmp/arg0/codex-arg0NEeGcj/.lock'
    const r = classifyReadable([lock, '/usr/bin/node'], '/home/gpt')
    expect([r.outside, r.marked, r.own]).toEqual([[], [], [lock]])
    // the login file by its EXACT path is the one allowed credential (H1-AUTH checks its mode);
    // any other credential-looking name in the home, or a copy of it, is still fleet-marked
    expect(classifyReadable(['/home/gpt/.codex/auth.json'], '/home/gpt').marked).toEqual([])
    expect(classifyReadable(['/home/gpt/auth.json', '/home/gpt/.codex/auth.json.bak', '/home/gpt/token.txt'], '/home/gpt').marked).toEqual(['/home/gpt/auth.json', '/home/gpt/.codex/auth.json.bak', '/home/gpt/token.txt'])
    // a prefix trap: /home/gptx is NOT the home; no home given: the home is outside as before
    expect(classifyReadable(['/home/gptx/a'], '/home/gpt').outside).toEqual(['/home/gptx/a'])
    expect(classifyReadable([lock], null).outside).toEqual([lock])
    expect(classifyReadable(['/etc/x'], '/').own).toEqual([])
  })

  it('HOME: exactly the runner home; a wider or another HOME is FAIL', () => {
    expect(RUNNER_HOME).toBe('/home/gpt')
    expect([checkHome('/home/gpt')[0], checkHome('/home')[0], checkHome('/')[0], checkHome('/home/gpt/')[0], checkHome(undefined)[0]]).toEqual(['OK', 'FAIL', 'FAIL', 'FAIL', 'FAIL'])
  })

  it('N1-HOST-PORTS: on the host the public ports are tested too (the first live run reached 10.0.5.1:8000)', () => {
    expect(HOST_PORTS).toEqual(expect.arrayContaining([3420, 3425, 8000, 22, 80, 443]))
    // every address gets every port, the gateway, the host's own and the fleet's; no address twice
    const t = networkTargets('10.0.5.1', ['203.0.113.7', '10.0.5.1'], ['10.0.2.4'])
    const key = (x: { host: string; port: number }) => `${x.host}:${x.port}`
    expect(t.length).toBe(3 * HOST_PORTS.length)
    expect(['10.0.5.1:8000', '10.0.5.1:22', '203.0.113.7:443', '10.0.2.4:3420', '10.0.2.4:80'].every((k) => t.map(key).includes(k))).toBe(true)
    expect(networkTargets(null, [], []).length).toBe(0)
  })

  it('N1: an answering port is FAIL; all closed counts as OK only when the control answered', () => {
    const closed = [{ host: '10.0.2.4', port: 3420, open: false }]
    expect(judgeNetwork(closed, { host: 'api.openai.com', port: 443, open: true })[0]).toBe('OK')
    expect(judgeNetwork(closed, { host: 'api.openai.com', port: 443, open: false })[0]).toBe('NEM_MERHETO')
    expect(judgeNetwork([...closed, { host: '172.17.0.1', port: 3425, open: true }], { host: 'api.openai.com', port: 443, open: true })).toEqual(['FAIL', 'valaszolt: 172.17.0.1:3425'])
  })

  it('IPV6: a global IPv6 address is reported (the host rules are IPv4 only); link-local and lo are not', () => {
    const lo = '00000000000000000000000000000001 01 80 10 80       lo'
    const ll = 'fe800000000000000000000000000002 1a 40 20 80     eth0'
    const glob = '20010db8000000000000000000000005 1a 40 00 00     eth0'
    expect([globalIpv6(''), globalIpv6([lo, ll].join('\n')), globalIpv6([lo, ll, glob].join('\n'))]).toEqual([[], [], ['eth0:20010db8000000000000000000000005']])
    expect([checkIpv6([lo, ll].join('\n'))[0], checkIpv6([lo, glob].join('\n'))[0]]).toEqual(['OK', 'FAIL'])
  })

  it('summarize counts each verdict; NEM_MERHETO is never OK', () => {
    expect(summarize([['a', 'OK', ''], ['b', 'NEM_MERHETO', ''], ['c', 'FAIL', ''], ['d', 'OK', '']])).toEqual({ ok: 2, fail: 1, nem: 1 })
  })
})

describe('gpt-runner probe: the Codex sandbox (V2) against a fake codex', () => {
  type Run = { code: number; out: string }
  const go = async (sandbox: (args: string[]) => Run, outsideCode = 0) => {
    const said: Array<[string, string]> = []
    const run = (cmd: string, args: string[]): Run => {
      if (cmd === 'node') return { code: outsideCode, out: 'BELUL\n' }
      if (args[0] === 'sandbox' && args[1] === '--help') return { code: 0, out: 'Usage: codex sandbox ...' }
      if (args[0] === 'exec') return { code: 0, out: 'Usage: codex exec ...' }
      return sandbox(args)
    }
    const log = console.log
    console.log = () => {}
    try { await codexSandboxChecks((id: string, v: string) => said.push([id, v]), run) } finally { console.log = log }
    return Object.fromEntries(said)
  }
  const isNet = (a: string[]) => a.includes('node')

  it('V2-BLOCKED: the command ran (marker) and could not connect, while outside it could: OK', async () => {
    const r = await go((a) => (isNet(a) ? { code: 3, out: 'BELUL\n' } : { code: 1, out: 'BELUL\nsh: cannot create' }))
    expect([r.V2, r['V2-IRAS'], r.V3]).toEqual(['OK', 'OK', undefined])
  })

  it('V2-ALLOWED: the command reached the network from inside the sandbox: FAIL; a write that worked: FAIL', async () => {
    const r = await go(() => ({ code: 0, out: 'BELUL\nIRT\n' }))
    expect([r.V2, r['V2-IRAS']]).toEqual(['FAIL', 'FAIL'])
  })

  it('V2-NEVER-STARTED: no marker (bwrap could not make a namespace) is NEM_MERHETO, never OK', async () => {
    const r = await go(() => ({ code: 1, out: 'bwrap: No permissions to create new namespace' }))
    expect([r.V2, r['V2-IRAS']]).toEqual(['NEM_MERHETO', 'NEM_MERHETO'])
  })

  it('V2-NO-CONTROL: blocked inside but also blocked outside proves nothing: NEM_MERHETO', async () => {
    const r = await go((a) => (isNet(a) ? { code: 3, out: 'BELUL\n' } : { code: 1, out: 'BELUL\n' }), 3)
    expect(r.V2).toBe('NEM_MERHETO')
  })

  it('V2-FORMS: an unknown first form falls through to the second; both unknown is NEM_MERHETO', async () => {
    const r = await go((a) => (a[1] === '--' ? { code: 2, out: 'error: unexpected argument' } : isNet(a) ? { code: 3, out: 'BELUL\n' } : { code: 1, out: 'BELUL\n' }))
    expect(r.V2).toBe('OK')
    const none = await go(() => ({ code: 2, out: "error: unrecognized subcommand 'sandbox'" }))
    expect(none.V2).toBe('NEM_MERHETO')
    expect(judgeSandboxRun({ code: 2, out: 'Usage: codex sandbox' })).toBe('usage')
  })
})

describe('gpt-runner container definition', () => {
  const compose = R('compose.yaml')
  const dockerfile = R('Dockerfile')

  it('COMPOSE-LIMITS: not root, no capability, no new privileges, read-only root, resource limits, no restart', () => {
    expect(compose).toMatch(/user: "10002:10002"/)
    expect(compose).toMatch(/cap_drop:\n\s+- ALL\n/)
    expect(compose).toMatch(/- no-new-privileges:true/)
    expect(compose).toMatch(/read_only: true/)
    expect(compose).toMatch(/pids_limit: \d+/)
    expect(compose).toMatch(/mem_limit: \d+m/)
    expect(compose).toMatch(/cpus: [\d.]+/)
    expect(compose).toMatch(/restart: "no"/)
  })

  it('COMPOSE-NOTHING-OF-THE-FLEET: no bind mount, secret, host port, docker socket, fleet path, privileged mode; one outward network', () => {
    const code = compose.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    for (const bad of [/type: bind/, /^\s*secrets:/m, /^\s*ports:/m, /docker\.sock/, /marveen-docker/, /\/home\/marveen/, /privileged/, /network_mode/, /external: true/, /cap_add/]) {
      expect([bad.source, bad.test(code)]).toEqual([bad.source, false])
    }
    const nets = code.split(/^networks:/m)[1]!.split(/^volumes:/m)[0]!
    expect(nets.match(/^ {2}\w[\w-]*:/gm)).toEqual(['  ki:'])
    // a fixed bridge name: the host firewall (host/tuzfal.sh) is written for it
    expect(nets).toMatch(/com\.docker\.network\.bridge\.name: gptki0/)
    expect(code).toMatch(/PROBA_GEP_CIMEK: \$\{GPT_FUTTATO_GEP_CIMEK:-\}/)
  })

  it('PINS: the base image must be a digest; one Codex version in package.json, the lockfile and the probe', () => {
    expect(dockerfile).toMatch(/\*@sha256:\?{64}\)/)
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/)
    expect(dockerfile).toMatch(/^USER 10002:10002$/m)
    const pkg = JSON.parse(R('package.json'))
    const lock = JSON.parse(R('package-lock.json'))
    expect([pkg.dependencies['@openai/codex'], lock.packages['node_modules/@openai/codex'].version, PINNED_CODEX]).toEqual(['0.159.3', '0.159.3', '0.159.3'])
    expect(lock.packages['node_modules/@openai/codex-linux-x64'].integrity).toMatch(/^sha512-/)
  })
})

describe('gpt-runner probe: a live run here, in the fleet container, must come out red', () => {
  it('PROBE-HERE: the fleet uid and the fleet paths are found; the canary is found; exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-probe-'))
    try {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'plain.txt'), 'x')
      // the runner's own home, with one file in it: F2 must count it apart (the main path reads HOME)
      mkdirSync(join(dir, 'home', '.codex'), { recursive: true })
      writeFileSync(join(dir, 'home', '.codex', '.lock'), '')
      const r = spawnSync(process.execPath, [join(__dirname, '..', '..', 'gpt-runner', 'proba.mjs')], {
        env: { ...process.env, PROBA_CSAK_HELYI: '1', PROBA_GYOKER: dir, HOME: join(dir, 'home'), PROBA_ELVART_HOME: join(dir, 'home') }, encoding: 'utf8', timeout: 60_000,
      })
      expect(r.stdout).toContain(`sajat home (${join(dir, 'home')}): 1 fajl`)
      expect(r.stdout).toMatch(/^PROBA HOME OK /m)
      // the test sets PROBA_* overrides: the probe itself must call that out
      expect(r.stdout).toMatch(/^PROBA TESZT-VALTOZO FAIL teszt-feluliras beallitva: PROBA_ELVART_HOME, PROBA_GYOKER, PROBA_CSAK_HELYI$/m)
      // another HOME than the expected one: FAIL, and no own-home category for it
      const wide = spawnSync(process.execPath, [join(__dirname, '..', '..', 'gpt-runner', 'proba.mjs')], {
        env: { ...process.env, PROBA_CSAK_HELYI: '1', PROBA_GYOKER: dir, HOME: dir, PROBA_ELVART_HOME: join(dir, 'home') }, encoding: 'utf8', timeout: 60_000,
      })
      expect([/^PROBA HOME FAIL /m.test(wide.stdout), wide.stdout.includes(`sajat home (${dir}): 0 fajl`)]).toEqual([true, true])
      const line = (id: string) => (r.stdout.match(new RegExp(`^PROBA ${id} (\\S+)`, 'm')) || [])[1]
      const expectedG0 = checkIds(idsFromStatus(readFileSync('/proc/self/status', 'utf8')))[0]
      expect([line('G0'), line('F2'), line('N1'), /OSSZESITES ok=\d+ fail=[1-9]/.test(r.stdout)]).toEqual([expectedG0, 'OK', 'NEM_MERHETO', true])
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gpt-runner host firewall (host/tuzfal.sh) against a stateful fake iptables', () => {
  // the fake keeps "R|<chain>|<rule>" lines in order; -S prints like iptables ("-A <chain> <rule>"),
  // -D removes ONE instance, -I puts at the top; every call is logged (to see that a correct
  // chain is never flushed)
  const FAKE = `#!/bin/bash
S="$FAKE_STATE"; touch "$S"
w=""; if [ "$1" = "-w" ]; then w="W "; shift 2; fi
echo "$w$*" >> "$S.calls"
op="$1"; chain="$2"; shift 2
case "$op" in
  -N) grep -qx "N|$chain" "$S" && exit 1; echo "N|$chain" >> "$S" ;;
  -F) grep -v "^R|$chain|" "$S" > "$S.t" || true; mv "$S.t" "$S" ;;
  -A) echo "R|$chain|$*" >> "$S" ;;
  -I) shift; { grep -v "^R|" "$S" || true; echo "R|$chain|$*"; grep "^R|" "$S" || true; } > "$S.t"; mv "$S.t" "$S" ;;
  -C) grep -qxF "R|$chain|$*" "$S" ;;
  -D) if [[ "$*" =~ ^[0-9]+$ ]]; then
        awk -v c="R|$chain|" -v n="$1" 'index($0, c) == 1 { i++; if (i == n) next } { print }' "$S" > "$S.t"
      else
        awk -v want="R|$chain|$*" '!done && $0 == want { done = 1; next } { print }' "$S" > "$S.t"
      fi; mv "$S.t" "$S" ;;
  -S) echo "-P $chain ACCEPT"; grep "^R|$chain|" "$S" | cut -d'|' -f3- | sed "s/^/-A $chain /" ;;
esac
`
  const setup = (state = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-fw-'))
    writeFileSync(join(dir, 'iptables'), FAKE, { mode: 0o755 })
    writeFileSync(join(dir, 'state'), state)
    return dir
  }
  const fw = (dir: string) => spawnSync('bash', [join(__dirname, '..', '..', 'gpt-runner', 'host', 'tuzfal.sh')], {
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_STATE: join(dir, 'state'), IPTABLES: join(dir, 'iptables') }, encoding: 'utf8', timeout: 20_000,
  })
  const rules = (dir: string) => readFileSync(join(dir, 'state'), 'utf8').split('\n').filter((l) => l.startsWith('R|'))
  const chain = (dir: string, c: string) => rules(dir).filter((l) => l.startsWith(`R|${c}|`)).map((l) => l.split('|')[2])
  const calls = (dir: string) => { try { return readFileSync(join(dir, 'state.calls'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const PRIVATE = ['-d 10.0.0.0/8 -j DROP', '-d 172.16.0.0/12 -j DROP', '-d 192.168.0.0/16 -j DROP', '-d 100.64.0.0/10 -j DROP', '-d 169.254.0.0/16 -j DROP']
  const run = (state: string, fn: (dir: string) => void) => { const dir = setup(state); try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }

  it('FW-RULES: the host is closed to the bridge (INPUT), the private ranges too (DOCKER-USER), outward untouched', () => run('', (dir) => {
    const r = fw(dir)
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect([chain(dir, 'INPUT'), chain(dir, 'DOCKER-USER'), chain(dir, 'GPTF-GEP'), chain(dir, 'GPTF-PRIVAT')]).toEqual([
      ['-i gptki0 -j GPTF-GEP'], ['-i gptki0 -j GPTF-PRIVAT'], ['-j DROP'], PRIVATE,
    ])
  }))

  it('FW-QUIET: the second and third run (the per-minute timer) change nothing, print nothing, flush nothing', () => run('', (dir) => {
    fw(dir)
    const first = rules(dir)
    const before = calls(dir).length
    const second = fw(dir)
    fw(dir)
    expect([rules(dir), second.stdout, calls(dir).slice(before).filter((c) => /^(W )?-(F|A|I|D) /.test(c))]).toEqual([first, '', []])
  }))

  it('FW-UFW-REORDER: a rule put above our jump (a ufw reload) is undone: ours first again, once, one journal line', () => run(
    'R|INPUT|-j ufw-before-input\nR|INPUT|-i gptki0 -j GPTF-GEP\nR|DOCKER-USER|-j RETURN\n', (dir) => {
      const r = fw(dir)
      expect(chain(dir, 'INPUT')).toEqual(['-i gptki0 -j GPTF-GEP', '-j ufw-before-input'])
      expect(chain(dir, 'DOCKER-USER')).toEqual(['-i gptki0 -j GPTF-PRIVAT', '-j RETURN'])
      expect(r.stdout).toMatch(/^VISSZATETTE: INPUT elejere: -i gptki0 -j GPTF-GEP$/m)
    }))

  it('FW-DUPLICATE: two copies of our jump become one, at the top', () => run(
    'R|INPUT|-i gptki0 -j GPTF-GEP\nR|INPUT|-i eth0 -j ACCEPT\nR|INPUT|-i gptki0 -j GPTF-GEP\n', (dir) => {
      fw(dir)
      expect(chain(dir, 'INPUT')).toEqual(['-i gptki0 -j GPTF-GEP', '-i eth0 -j ACCEPT'])
    }))

  it('FW-CHAIN-DRIFT: a chain that lost a rule is refilled and said; a correct chain is not flushed', () => run(
    `N|GPTF-GEP\nR|GPTF-GEP|-j DROP\nN|GPTF-PRIVAT\n${PRIVATE.slice(0, 3).map((x) => `R|GPTF-PRIVAT|${x}`).join('\n')}\n`, (dir) => {
      const r = fw(dir)
      expect(chain(dir, 'GPTF-PRIVAT')).toEqual(PRIVATE)
      expect(r.stdout).toMatch(/^VISSZATETTE: a GPTF-PRIVAT lanc tartalma$/m)
      expect(calls(dir).filter((c) => /^(W )?-F /.test(c))).toEqual([])
    }))

  it('FW-NEVER-OPEN: a chain with an extra rule and a missing one: the missing is ADDED before the extra is removed', () => run(
    `N|GPTF-PRIVAT\nR|GPTF-PRIVAT|-d 8.8.8.8/32 -j DROP\n${PRIVATE.slice(1).map((x) => `R|GPTF-PRIVAT|${x}`).join('\n')}\n`, (dir) => {
      fw(dir)
      const c = calls(dir)
      const lastAdd = c.map((x, i) => (/^W -A GPTF-PRIVAT /.test(x) ? i : -1)).filter((i) => i >= 0).pop()!
      const firstDel = c.findIndex((x) => /^W -D GPTF-PRIVAT /.test(x))
      expect([chain(dir, 'GPTF-PRIVAT').sort(), lastAdd < firstDel]).toEqual([[...PRIVATE].sort(), true])
    }))

  it('FW-JUMP-NEVER-MISSING: when our jump is not first, the new copy goes in BEFORE the old one is removed', () => run(
    'R|INPUT|-j ufw-before-input\nR|INPUT|-i gptki0 -j GPTF-GEP\n', (dir) => {
      fw(dir)
      const c = calls(dir)
      expect(c.findIndex((x) => /^W -I INPUT 1 -i gptki0 -j GPTF-GEP$/.test(x)) < c.findIndex((x) => /^W -D INPUT /.test(x))).toBe(true)
      expect(chain(dir, 'INPUT')).toEqual(['-i gptki0 -j GPTF-GEP', '-j ufw-before-input'])
    }))

  it('FW-LOCK-WAIT: every iptables call of the script waits for the xtables lock (-w)', () => run('', (dir) => {
    fw(dir)
    fw(dir)
    expect(calls(dir).filter((c) => !c.startsWith('W ')).length).toBe(0)
    expect(calls(dir).length).toBeGreaterThan(10)
  }))

  it('FW-UNIT: the unit runs the script at boot and after every docker (re)start', () => {
    const unit = R('host/gpt-futtato-tuzfal.service')
    expect([/^After=docker\.service$/m.test(unit), /^PartOf=docker\.service$/m.test(unit), /^WantedBy=.*docker\.service.*multi-user\.target/m.test(unit), /^ExecStart=\/opt\/gpt-futtato\/tuzfal\.sh$/m.test(unit), /^RemainAfterExit=yes$/m.test(unit)]).toEqual([true, true, true, true, true])
  })

  it('FW-TIMER: a per-minute timer runs the same script through a plain oneshot (no RemainAfterExit)', () => {
    const timer = R('host/gpt-futtato-tuzfal-ellenor.timer')
    const svc = R('host/gpt-futtato-tuzfal-ellenor.service')
    expect([/^OnUnitActiveSec=1min$/m.test(timer), /^OnBootSec=/m.test(timer), /^Unit=gpt-futtato-tuzfal-ellenor\.service$/m.test(timer), /^WantedBy=timers\.target$/m.test(timer)]).toEqual([true, true, true, true])
    expect([/^Type=oneshot$/m.test(svc), /RemainAfterExit/.test(svc), /^ExecStart=\/opt\/gpt-futtato\/tuzfal\.sh$/m.test(svc)]).toEqual([true, false, true])
  })

  it('FW-INSTALL: persistence and the timer are measured on the host, docker is never restarted', () => {
    const inst = R('host/telepit-tuzfal.sh')
    expect(inst).toMatch(/iptables -w 5 -D INPUT -i "\$BRIDGE" -j GPTF-GEP[\s\S]*systemctl restart gpt-futtato-tuzfal\.service[\s\S]*grep -F GPTF-GEP \|\| \{ echo "STOP/)
    expect(inst).toMatch(/systemctl enable --now gpt-futtato-tuzfal\.service/)
    expect(inst).toMatch(/systemctl enable --now gpt-futtato-tuzfal-ellenor\.timer/)
    // the one timer round: a rule above ours, the DOCKER-USER jump removed, wait, check, clean up
    expect(inst).toMatch(/iptables -w 5 -I INPUT 1 -m comment --comment gptf-ufw-proba\niptables -w 5 -D DOCKER-USER -i "\$BRIDGE" -j GPTF-PRIVAT[\s\S]*sleep 5[\s\S]*"-A INPUT -i \$BRIDGE -j GPTF-GEP"[\s\S]*iptables -w 5 -D INPUT -m comment --comment gptf-ufw-proba[\s\S]*STOP: a timer/)
    // every write of the installer waits for the lock too; the save before the real reload
    expect(inst.match(/\biptables -(?!w 5 |V\b)\w/g)).toBeNull()
    expect(inst).toMatch(/ufw-elo-mentett\.sh[\s\S]*STOP reload nelkul[\s\S]*iptables-save > \/opt\/gpt-futtato\/iptables-elotte\.rules[\s\S]*chmod 600[\s\S]*\n {2}ufw reload\n/)
    expect(/systemctl (restart|stop) docker/.test(inst)).toBe(false)
    // a REAL ufw reload, with what it may change outside ufw printed, and the timer measured after it
    expect(inst).toMatch(/ufw_before=\$\(ufw status verbose\)[\s\S]*rules_before=\$\(other_rules\)[\s\S]*\nufw reload\n|\n {2}ufw reload\n/)
    expect(inst).toMatch(/ {2}ufw reload\n[\s\S]*"-A INPUT -i \$BRIDGE -j GPTF-GEP"[\s\S]*STOP: a ufw reload utan[\s\S]*rules_diff=\$\(diff <\(echo "\$rules_before"\) <\(other_rules\)/)
    expect(inst).toMatch(/\^PROBA N1 NEM_MERHETO[\s\S]*STOP/)
    expect(inst).toMatch(/^trap '.*STOP.*\$LINENO.*' ERR$/m)
    expect(inst).toMatch(/iptables -V/)
    expect(inst).toMatch(/iptables -w 5 -S FORWARD \| grep -F -- '-j DOCKER-USER' \|\| echo "FIGYELEM/)
    // ufw by its own status (the host: service running, firewall off; acrobot 30839)
    expect(inst).toMatch(/ufw_aktiv\(\) \{ command -v ufw >\/dev\/null && ufw status 2>\/dev\/null \| grep -q '\^Status: active'; \}/)
    expect(inst).toMatch(/\nif ufw_aktiv; then\n {2}echo "== valodi ufw reload"/)
    expect(/systemctl is-active --quiet "?ufw/.test(inst)).toBe(false)
  })
})

describe('gpt-runner host: ufw rules that live only in the running state (ufw-elo-mentett.sh)', () => {
  const helper = join(__dirname, '..', '..', 'gpt-runner', 'host', 'ufw-elo-mentett.sh')
  const go = (running: string | null, saved: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-ufw-'))
    try {
      // a fake iptables whose -S prints the given running rules (or fails, when null)
      writeFileSync(join(dir, 'iptables'), running == null ? '#!/bin/bash\nexit 4\n' : `#!/bin/bash\n[ "$1" = -w ] && shift 2\n[ "$1" = -S ] && cat <<'X'\n-P INPUT DROP\n${running}\nX\n`, { mode: 0o755 })
      if (saved != null) writeFileSync(join(dir, 'user.rules'), `*filter\n:ufw-user-input - [0:0]\n${saved}\nCOMMIT\n`)
      const r = spawnSync('bash', [helper, join(dir, 'iptables'), join(dir, 'user.rules')], { encoding: 'utf8', timeout: 20_000 })
      return { code: r.status, out: r.stdout.trim() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('UFW-SAME: the running rules are the saved ones (spelled the iptables -S way): exit 0, nothing printed', () => {
    expect(go('-A ufw-user-input -p tcp -m tcp --dport 22 -j ACCEPT\n-A ufw-user-input -s 10.0.0.0/8 -j DROP', '-A ufw-user-input -p tcp --dport 22 -j ACCEPT\n-A ufw-user-input -s 10.0.0.0/8 -j DROP')).toEqual({ code: 0, out: '' })
  })

  it('UFW-ONLY-LIVE: a rule only in the running state is printed and exits 1 (the installer stops before the reload)', () => {
    expect(go('-A ufw-user-input -p tcp -m tcp --dport 22 -j ACCEPT\n-A ufw-user-input -p tcp -m tcp --dport 8443 -j ACCEPT', '-A ufw-user-input -p tcp --dport 22 -j ACCEPT')).toEqual({ code: 1, out: '-A ufw-user-input -p tcp --dport 8443 -j ACCEPT' })
  })

  it('UFW-CANNOT-TELL: a failing iptables -S or an unreadable saved file is exit 2, never "nothing"', () => {
    expect([go(null, '-A ufw-user-input -j DROP').code, go('-A ufw-user-input -j DROP', null).code]).toEqual([2, 2])
  })

  it('UFW-WIRED: the installer stops on 1 and on 2, before the reload', () => {
    const inst = R('host/telepit-tuzfal.sh')
    expect(inst).toMatch(/ufw-elo-mentett\.sh" "\$ipt" "\$saved_file"\) \|\| rc=\$\?\n\s+if \[ "\$rc" = 2 \]; then echo "STOP reload nelkul[\s\S]*if \[ -n "\$only_live_all" \]; then[\s\S]*exit 1[\s\S]*\n {2}ufw reload\n/)
  })
})

describe('gpt-runner probe after the login: H1-AUTH, test overrides, V3', () => {
  it('H1-AUTH: no login file is OK; the file is OK only at 600 and owned by the runner', () => {
    expect(AUTH_FILE).toBe('/home/gpt/.codex/auth.json')
    expect([
      checkAuthFile(null)[0],
      checkAuthFile({ mode: 0o100600, uid: 10002 })[0],
      checkAuthFile({ mode: 0o100644, uid: 10002 })[0],
      checkAuthFile({ mode: 0o100600, uid: 0 })[0],
      checkAuthFile({ mode: 0o100640, uid: 1000 })[0],
    ]).toEqual(['OK', 'OK', 'FAIL', 'FAIL', 'FAIL'])
  })

  it('TESZT-VALTOZO: any test-only override set in the container is FAIL; the real inputs are not', () => {
    expect(checkTestOverrides({ PROBA_FLOTTA_CIMEK: '10.0.2.4', PROBA_GEP_CIMEK: '1.2.3.4' })[0]).toBe('OK')
    expect(['PROBA_ELVART_HOME', 'PROBA_GYOKER', 'PROBA_CSAK_HELYI', 'PROBA_CODEX_VERSION'].map((k) => checkTestOverrides({ [k]: 'x' })[0])).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL'])
    expect(checkTestOverrides({ PROBA_GYOKER: '' })[0]).toBe('OK')
  })

  it('V3-ARGS: both runs are read-only with approval never; the test run switches both shell tools off, the control turns shell_tool on', () => {
    expect([safeExecArgs(V3_TEST_ARGS), safeExecArgs(V3_CONTROL_ARGS)]).toEqual([null, null])
    expect(V3_TEST_ARGS).toEqual(expect.arrayContaining(['-s', 'read-only', 'approval_policy="never"', 'features.shell_tool=false', 'features.unified_exec=false', '--json']))
    expect(V3_CONTROL_ARGS).toEqual(expect.arrayContaining(['-s', 'read-only', 'features.shell_tool=true']))
    expect(V3_CANARIES).toEqual(['/tmp/kanari-v3', '/home/gpt/kanari-v3'])
    // anything wider is refused before any call
    // an ALLOWLIST (barracuda, #145): the common part, feature pairs, the fixed prompt; nothing else
    const common = V3_TEST_ARGS.slice(0, V3_TEST_ARGS.indexOf('-c', 9))
    for (const extra of [['--full-auto'], ['--add-dir', '/'], ['-c', 'features.apply_patch=true'], ['-c', 'sandbox_mode="danger-full-access"'], ['--sandbox', 'danger-full-access'], ['-c']]) {
      const args = [...common, ...extra, V3_PROMPT]
      expect([extra.join(' '), safeExecArgs(args) != null]).toEqual([extra.join(' '), true])
    }
    expect(safeExecArgs([...V3_TEST_ARGS.slice(0, -1), 'touch /etc/x'])).toMatch(/prompt/)
    for (const bad of [['-s', 'read-only', '--sandbox', 'danger-full-access'], ['-s', 'read-only', '--sandbox', 'workspace-write'], ['-s', 'danger-full-access'], ['-s', 'workspace-write'], ['--dangerously-bypass-approvals-and-sandbox', '-s', 'read-only'], ['--yolo', '-s', 'read-only'], ['-c', 'sandbox_mode="danger-full-access"', '-s', 'read-only'], ['exec']]) {
      expect([bad.join(' '), safeExecArgs(bad) != null]).toEqual([bad.join(' '), true])
    }
  })

  type R = { code: number; out: string }
  const v3 = (onRun: (args: string[], fs: Set<string>) => R, loggedIn = true) => {
    const fs = new Set<string>()
    const said: Record<string, string> = {}
    const calls: string[][] = []
    const log = console.log
    console.log = () => {}
    try {
      v3Checks((id, v) => { said[id] = v }, (_c, args) => { calls.push(args); return onRun(args, fs) }, { exists: (p) => fs.has(p), remove: (p) => fs.delete(p), loggedIn })
    } finally { console.log = log }
    return { said, calls, fs }
  }
  const isControl = (a: string[]) => a.includes('features.shell_tool=true')
  const EXEC = '{"type":"item.started","item":{"type":"command_execution","command":"touch ..."}}'

  it('TOOL-USES: only the answer and the reasoning in the frames are clean; every other item, an unknown event, an error is reported', () => {
    const ev = (o: object) => JSON.stringify(o)
    const clean = [ev({ type: 'thread.started', thread_id: 't' }), ev({ type: 'turn.started' }), ev({ type: 'item.completed', item: { type: 'reasoning' } }), ev({ type: 'item.completed', item: { type: 'agent_message', text: 'nem futtatok parancsot' } }), ev({ type: 'turn.completed' }), 'Reading prompt from stdin...']
    expect(toolUses(clean.join('\n'))).toEqual({ tools: [], unknown: [], errors: [], items: 2 })
    for (const tool of ['command_execution', 'file_change', 'web_search', 'mcp_tool_call', 'todo_list', 'a_future_tool']) {
      expect([tool, toolUses(ev({ type: 'item.started', item: { type: tool } })).tools]).toEqual([tool, [tool]])
    }
    expect(toolUses(ev({ id: '0', msg: { type: 'exec_command_begin' } })).unknown).toEqual(['kulcsok:id+msg'])
    expect(toolUses(ev({ type: 'exec_command_begin' })).unknown).toEqual(['exec_command_begin'])
    // an item event without its item's type is unknown (fail-closed), not silently nothing
    expect([toolUses(ev({ type: 'item.started', item: {} })).unknown, toolUses(ev({ type: 'item.completed' })).unknown, toolUses(ev({ type: 'item.updated', item: { type: 7 } })).unknown]).toEqual([['item.started:tipus-nelkul'], ['item.completed:tipus-nelkul'], ['item.updated:tipus-nelkul']])
    expect(toolUses([ev({ type: 'error', message: 'x' }), ev({ type: 'turn.failed' })].join('\n')).errors).toEqual(['error', 'turn.failed'])
  })

  it('V3-OK: off, no execution and no canary; the control shows an attempt', () => {
    const r = v3((a) => (isControl(a) ? { code: 0, out: EXEC } : { code: 0, out: '{"type":"item.completed","item":{"type":"agent_message"}}' }))
    expect([r.said.V3, r.said['V3-KONTROLL-IRAS'], r.calls.length, r.fs.size]).toEqual(['OK', undefined, 2, 0])
  })

  it('V3-EXECUTED: an execution event, or a canary, in the run with the tools off is FAIL', () => {
    expect(v3(() => ({ code: 0, out: EXEC })).said.V3).toBe('FAIL')
    expect(v3((a, fs) => { if (!isControl(a)) fs.add('/home/gpt/kanari-v3'); return { code: 0, out: isControl(a) ? EXEC : '' } }).said.V3).toBe('FAIL')
  })

  it('V3-ANY-TOOL: a file change, a web search, or an unknown event in the test run is FAIL (not only a command)', () => {
    const ctl = (a: string[]) => isControl(a)
    for (const out of [
      '{"type":"item.started","item":{"type":"file_change","changes":[{"path":"/home/gpt/kanari-v3"}]}}',
      '{"type":"item.completed","item":{"type":"web_search","query":"x"}}',
      '{"type":"exec_command_begin"}',
    ]) {
      expect([out.slice(0, 40), v3((a) => (ctl(a) ? { code: 0, out: EXEC } : { code: 0, out })).said.V3]).toEqual([out.slice(0, 40), 'FAIL'])
    }
  })

  it('V3-NO-ANSWER: an error, or no item at all, in the test run proves nothing: NEM_MERHETO', () => {
    expect(v3((a) => (isControl(a) ? { code: 0, out: EXEC } : { code: 1, out: '{"type":"error","message":"401"}' })).said.V3).toBe('NEM_MERHETO')
    expect(v3((a) => (isControl(a) ? { code: 0, out: EXEC } : { code: 0, out: '{"type":"thread.started"}\n{"type":"turn.completed"}' })).said.V3).toBe('NEM_MERHETO')
  })

  it('V3-BLIND: no attempt even in the control: NEM_MERHETO, never OK', () => {
    expect(v3(() => ({ code: 0, out: '{"type":"item.completed","item":{"type":"agent_message"}}' })).said.V3).toBe('NEM_MERHETO')
  })

  it('V3-CONTROL-WROTE: a canary from the read-only control run is its own FAIL', () => {
    const r = v3((a, fs) => { if (isControl(a)) fs.add('/tmp/kanari-v3'); return { code: 0, out: isControl(a) ? EXEC : '{"type":"item.completed","item":{"type":"agent_message"}}' } })
    expect([r.said.V3, r.said['V3-KONTROLL-IRAS'], r.fs.size]).toEqual(['OK', 'FAIL', 0])
  })

  it('V3-NO-LOGIN: no model call without a login', () => {
    const r = v3(() => { throw new Error('called') }, false)
    expect([r.said.V3, r.calls.length]).toEqual(['NEM_MERHETO', 0])
  })
})

describe('gpt-runner host: the login step and the measure after it, against a fake docker', () => {
  const HOST = join(__dirname, '..', '..', 'gpt-runner', 'host')
  // the fake docker answers by what it is asked: the login, the stat line, or a probe run
  const DOCKER = `#!/bin/bash
args="$*"
case "$args" in
  *"login --device-auth"*) printf '%s\\n' "$LOGIN_OUT"; exit "$LOGIN_RC" ;;
  *'stat -c "%a %u" /home/gpt/.codex/auth.json'*) printf '%s\\n' "$PERM" ;;
  *"stat -c"*) printf '%s\\n' "$PERM 1234 bajt /home/gpt/.codex/auth.json" "--- a kotet fajljai:" "/home/gpt/.codex/auth.json" ;;
  "compose up --no-color") printf '%b' "$PROBE_OUT" ;;
  logs*) : ;;
esac
`
  const runHost = (script: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-host-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), DOCKER, { mode: 0o755 })
    try {
      const r = spawnSync('bash', [join(HOST, script)], { env: { PATH: `${bin}:/usr/bin:/bin`, GPT_FUTTATO_DIR: dir, ...env }, encoding: 'utf8', timeout: 20_000 })
      const left = readdirSync(dir).filter((f) => f.startsWith('belepes.'))
      return { code: r.status, out: r.stdout + r.stderr, left }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('LOGIN-NOT-ENABLED: the account-setting error is named as that, the one-time-code log is removed', () => {
    const r = runHost('belepes.sh', { LOGIN_OUT: 'Device code login is not enabled; falling back to browser login.', LOGIN_RC: '1', PERM: '' })
    expect([r.code, /nincs engedelyezve a ChatGPT-fiokban/.test(r.out), /halozati/.test(r.out), r.left]).toEqual([1, true, false, []])
  })

  it('LOGIN-NETWORK: the 2026-10-14 20:13 error (a request that could not be sent) is a network or certificate error, not the account', () => {
    const r = runHost('belepes.sh', { LOGIN_OUT: 'Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)', LOGIN_RC: '1', PERM: '' })
    expect([r.code, /halozati vagy tanusitvany-hiba/.test(r.out), /fiokban NINCS teendo/.test(r.out), /nincs engedelyezve/.test(r.out)]).toEqual([1, true, true, false])
  })

  it('LOGIN-OTHER: any other failure points at the error above, no guessed cause', () => {
    const r = runHost('belepes.sh', { LOGIN_OUT: 'Error logging in with device code: something new', LOGIN_RC: '1', PERM: '' })
    expect([r.code, /a hiba fent lathato/.test(r.out), /nincs engedelyezve|halozati/.test(r.out)]).toEqual([1, true, false])
  })

  it('LOGIN-OK: only the place, the mode, the owner and the file NAMES are printed; 600 10002 is required', () => {
    const ok = runHost('belepes.sh', { LOGIN_OUT: 'Successfully logged in', LOGIN_RC: '0', PERM: '600 10002' })
    expect([ok.code, /rendben: \/home\/gpt\/\.codex\/auth\.json, 600, uid 10002/.test(ok.out), /--- a kotet fajljai:/.test(ok.out), ok.left]).toEqual([0, true, true, []])
    const wide = runHost('belepes.sh', { LOGIN_OUT: 'Successfully logged in', LOGIN_RC: '0', PERM: '644 10002' })
    expect([wide.code, /STOP: az auth\.json joga vagy tulajdonosa nem 600 es 10002/.test(wide.out)]).toEqual([1, true])
  })

  it('LOGIN-NEVER-PRINTS-THE-VALUE: the script never reads the file content (no cat, no jq, no base64 of it)', () => {
    const s = R('host/belepes.sh')
    expect(/(cat|jq|base64|head|tail|less|more|xxd|od)\b[^\n]*auth\.json/.test(s)).toBe(false)
    expect(s).toMatch(/login --device-auth/)
  })

  it('AFTER-OK: V3 OK, H1-AUTH OK and no FAIL: activation is Balázs\'s decision', () => {
    const r = runHost('utana-meres.sh', { PROBE_OUT: 'PROBA H1-AUTH OK x\\nPROBA V3 OK y\\nPROBA N1 OK z\\nOSSZESITES ok=3 fail=0 nem_merheto=0\\n' })
    expect([r.code, /V3=OK H1-AUTH=OK FAIL-sorok=0/.test(r.out), /aktivalasa Balazs dontese/.test(r.out)]).toEqual([0, true, true])
  })

  it('AFTER-NOT-PROVEN: V3 NEM_MERHETO, a FAIL line, or a missing V3 line keeps the GPT side off', () => {
    for (const out of [
      'PROBA H1-AUTH OK x\\nPROBA V3 NEM_MERHETO y\\nOSSZESITES ok=1 fail=0 nem_merheto=1\\n',
      'PROBA H1-AUTH OK x\\nPROBA V3 OK y\\nPROBA F2 FAIL z\\nOSSZESITES ok=2 fail=1 nem_merheto=0\\n',
      'PROBA H1-AUTH OK x\\nOSSZESITES ok=1 fail=0 nem_merheto=0\\n',
    ]) {
      const r = runHost('utana-meres.sh', { PROBE_OUT: out })
      expect([out.slice(0, 40), r.code, /KIKAPCSOLVA MARAD/.test(r.out)]).toEqual([out.slice(0, 40), 0, true])
    }
  })
})

// any CA bundle that is NOT the self-signed test cert: the system one here, or Node's own list
const SYSTEM_CA_FALLBACK = () => {
  for (const p of ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt']) { try { readFileSync(p); return p } catch { /* next */ } }
  const p = join(mkdtempSync(join(tmpdir(), 'gpt-ca-')), 'node.pem')
  writeFileSync(p, rootCertificates.join('\n'))
  return p
}

describe('gpt-runner TLS with the system CA store (the login failed on it, 2026-10-14 20:13 UTC)', () => {
  it('TLS-JUDGE: every host must handshake with the system CA; one failure is FAIL and named', () => {
    expect(TLS_HOSTS).toEqual(['api.openai.com', 'auth.openai.com'])
    expect(SYSTEM_CA).toBe('/etc/ssl/certs/ca-certificates.crt')
    expect(judgeTls([{ host: 'api.openai.com', ok: true, why: 'rendben' }, { host: 'auth.openai.com', ok: true, why: 'rendben' }])[0]).toBe('OK')
    expect(judgeTls([{ host: 'api.openai.com', ok: true, why: 'rendben' }, { host: 'auth.openai.com', ok: false, why: 'nincs rendszer-CA' }])).toEqual(['FAIL', 'TLS a rendszer-CA-val nem sikerult: auth.openai.com (nincs rendszer-CA)'])
  })

  it('TLS-FAILS-CLOSED: no CA file, or a peer that does not speak TLS, is not ok (no Node default store behind it)', async () => {
    const missing = await tlsSystemCa('127.0.0.1', 9, '/nonexistent/ca.crt')
    expect([missing.ok, missing.why]).toEqual([false, 'nincs rendszer-CA (/nonexistent/ca.crt)'])
    const net = await import('node:net')
    const server = net.createServer((s) => s.end('not tls\n'))
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
    try {
      const port = (server.address() as { port: number }).port
      const dir = mkdtempSync(join(tmpdir(), 'gpt-ca-'))
      writeFileSync(join(dir, 'ca.crt'), '')
      const r = await tlsSystemCa('127.0.0.1', port, join(dir, 'ca.crt'), 3000)
      rmSync(dir, { recursive: true, force: true })
      expect(r.ok).toBe(false)
    } finally { server.close() }
  })

  it('TLS-USES-THE-GIVEN-CA: a self-signed server passes ONLY with its own cert as the CA file (Node store would refuse it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-tls-'))
    try {
      const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { encoding: 'utf8', timeout: 30_000 })
      expect(gen.status).toBe(0)
      const server = createTlsServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (s) => s.end())
      await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
      try {
        const port = (server.address() as { port: number }).port
        const withOwn = await tlsSystemCa('localhost', port, join(dir, 'c.pem'), 5000)
        writeFileSync(join(dir, 'other.pem'), readFileSync(SYSTEM_CA_FALLBACK()))
        const withOther = await tlsSystemCa('localhost', port, join(dir, 'other.pem'), 5000)
        expect([withOwn.ok, withOther.ok]).toEqual([true, false])
      } finally { server.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('TLS-IMAGE: the image installs the system CA store, without recommends, and cleans the apt lists', () => {
    expect(R('Dockerfile')).toMatch(/apt-get install -y --no-install-recommends ca-certificates[\s\S]*rm -rf \/var\/lib\/apt\/lists\/\*/)
  })

  it('TLS-IS-THE-CONTROL: the N1 control is the system-CA TLS result, not a bare TCP connect', () => {
    const src = R('proba.mjs')
    expect(src).toMatch(/const tlsResults = await Promise\.all\(TLS_HOSTS\.map\(\(h\) => tlsSystemCa\(h\)\)\)\n {2}say\('TLS', \.\.\.judgeTls\(tlsResults\)\)\n {2}const control = \{ host: 'api\.openai\.com', port: 443, open: tlsResults\[0\]\.ok \}/)
    expect(/tcpOpen\('api\.openai\.com'/.test(src)).toBe(false)
  })
})
