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
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  HOST_PORTS, SYSTEM_EXACT, networkTargets, globalIpv6, checkIpv6, checkIds, checkCaps, classifyReadable, judgeNetwork, judgeSandboxRun, codexSandboxChecks,
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
    expect(classifyReadable(['/usr/bin/node', '/etc/passwd', '/tmp/kanari-proba.txt'])).toEqual({ outside: [], marked: [] })
  })

  it("F2-DOCKERENV: Docker's own /.dockerenv is allowed by EXACT path only (the first live run's false hit)", () => {
    expect(SYSTEM_EXACT).toEqual(['/.dockerenv'])
    expect(classifyReadable(['/.dockerenv']).outside).toEqual([])
    expect(classifyReadable(['/.dockerenv.bak', '/.dockerenvx/a', '/.dockerinit']).outside).toEqual(['/.dockerenv.bak', '/.dockerenvx/a', '/.dockerinit'])
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
    expect([r.V2, r['V2-IRAS'], r.V3]).toEqual(['OK', 'OK', 'NEM_MERHETO'])
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
      const r = spawnSync(process.execPath, [join(__dirname, '..', '..', 'gpt-runner', 'proba.mjs')], {
        env: { ...process.env, PROBA_CSAK_HELYI: '1', PROBA_GYOKER: dir }, encoding: 'utf8', timeout: 60_000,
      })
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
  // the fake keeps "<chain>|<rule>" lines in a file: -N (fails if it exists), -F, -A, -I, -C, -D, -S
  const FAKE = `#!/bin/bash
S="$FAKE_STATE"; touch "$S"
op="$1"; chain="$2"; shift 2
case "$op" in
  -N) grep -qx "N|$chain" "$S" && exit 1; echo "N|$chain" >> "$S" ;;
  -F) grep -vx "R|$chain|.*" "$S" > "$S.t" || true; grep -v "^R|$chain|" "$S" > "$S.t" || true; mv "$S.t" "$S" ;;
  -A) echo "R|$chain|$*" >> "$S" ;;
  -I) shift; { grep -v "^R|$chain|" "$S" || true; echo "R|$chain|$*"; grep "^R|$chain|" "$S" || true; } > "$S.t"; mv "$S.t" "$S" ;;
  -C) grep -qxF "R|$chain|$*" "$S" ;;
  -D) grep -vxF "R|$chain|$*" "$S" > "$S.t" || true; mv "$S.t" "$S" ;;
  -S) grep "^R|$chain|" "$S" | cut -d'|' -f3- ;;
esac
`
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-fw-'))
    writeFileSync(join(dir, 'iptables'), FAKE, { mode: 0o755 })
    return dir
  }
  const fw = (dir: string) => spawnSync('bash', [join(__dirname, '..', '..', 'gpt-runner', 'host', 'tuzfal.sh')], {
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_STATE: join(dir, 'state'), IPTABLES: join(dir, 'iptables') }, encoding: 'utf8', timeout: 20_000,
  })
  const rules = (dir: string) => readFileSync(join(dir, 'state'), 'utf8').split('\n').filter((l) => l.startsWith('R|'))

  it('FW-RULES: the host is closed to the bridge (INPUT), the private ranges too (DOCKER-USER), outward untouched', () => {
    const dir = setup()
    try {
      const r = fw(dir)
      expect([r.status, r.stderr]).toEqual([0, ''])
      expect(rules(dir).sort()).toEqual([
        'R|DOCKER-USER|-i gptki0 -j GPTF-PRIVAT',
        'R|GPTF-GEP|-j DROP',
        'R|GPTF-PRIVAT|-d 10.0.0.0/8 -j DROP',
        'R|GPTF-PRIVAT|-d 100.64.0.0/10 -j DROP',
        'R|GPTF-PRIVAT|-d 169.254.0.0/16 -j DROP',
        'R|GPTF-PRIVAT|-d 172.16.0.0/12 -j DROP',
        'R|GPTF-PRIVAT|-d 192.168.0.0/16 -j DROP',
        'R|INPUT|-i gptki0 -j GPTF-GEP',
      ])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('FW-IDEMPOTENT: a second and a third run (boot, docker restart) leave exactly the same rules', () => {
    const dir = setup()
    try {
      // per chain, in order (iptables keeps the order WITHIN a chain; the chains are independent)
      const byChain = (rs: string[]) => [...rs].sort((a, b) => a.split('|')[1]!.localeCompare(b.split('|')[1]!))
      fw(dir)
      const first = byChain(rules(dir))
      fw(dir); fw(dir)
      expect(byChain(rules(dir))).toEqual(first)
      expect(first.length).toBe(8)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('FW-JUMP-FIRST: the jumps go to the TOP of INPUT and DOCKER-USER, before rules already there', () => {
    const dir = setup()
    try {
      writeFileSync(join(dir, 'state'), 'R|INPUT|-i eth0 -j ACCEPT\nR|DOCKER-USER|-j RETURN\n')
      fw(dir)
      const r = rules(dir)
      expect([r.filter((l) => l.startsWith('R|INPUT|'))[0], r.filter((l) => l.startsWith('R|DOCKER-USER|'))[0]]).toEqual(['R|INPUT|-i gptki0 -j GPTF-GEP', 'R|DOCKER-USER|-i gptki0 -j GPTF-PRIVAT'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('FW-UNIT: the unit runs the script at boot and after every docker (re)start', () => {
    const unit = R('host/gpt-futtato-tuzfal.service')
    expect([/^After=docker\.service$/m.test(unit), /^PartOf=docker\.service$/m.test(unit), /^WantedBy=.*docker\.service.*multi-user\.target/m.test(unit), /^ExecStart=\/opt\/gpt-futtato\/tuzfal\.sh$/m.test(unit), /^RemainAfterExit=yes$/m.test(unit)]).toEqual([true, true, true, true, true])
  })

  it('FW-INSTALL: the installer measures persistence (rules removed, unit restores them) and never restarts docker', () => {
    const inst = R('host/telepit-tuzfal.sh')
    expect(inst).toMatch(/iptables -D INPUT -i "\$BRIDGE" -j GPTF-GEP[\s\S]*systemctl restart gpt-futtato-tuzfal\.service[\s\S]*grep -F GPTF-GEP \|\| \{ echo "STOP/)
    expect(inst).toMatch(/systemctl enable --now gpt-futtato-tuzfal\.service/)
    expect(/systemctl (restart|stop) docker/.test(inst)).toBe(false)
    expect(inst).toMatch(/\^PROBA N1 NEM_MERHETO[\s\S]*STOP/)
    // barracuda, #140 review: no silent stop; the backend, the FORWARD wiring and ufw/firewalld said
    expect(inst).toMatch(/^trap '.*STOP.*\$LINENO.*' ERR$/m)
    expect(inst).toMatch(/iptables -V/)
    expect(inst).toMatch(/iptables -S FORWARD \| grep -F -- '-j DOCKER-USER' \|\| echo "FIGYELEM/)
    expect(inst).toMatch(/for fw in ufw firewalld/)
  })
})
