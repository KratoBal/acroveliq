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
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rootCertificates, createServer as createTlsServer } from 'node:tls'
import {
  HOST_PORTS, SYSTEM_EXACT, PLUGIN_CACHE, checkPluginCache, SYSTEM_SKILLS, checkSystemSkills, RUN_COMMON, networkTargets, globalIpv6, checkIpv6, checkHome, RUNNER_HOME,
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

  it('F2-FULL-LIST: every flagged path is on its own log line, not just the first 8 of the summary (acrobot 30889: 35 hits, 8 seen)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-f2-'))
    try {
      mkdirSync(join(dir, 'home'))
      const names = Array.from({ length: 12 }, (_, i) => join(dir, `token-${String(i).padStart(2, '0')}.md`))
      for (const n of names) writeFileSync(n, 'x')
      const r = spawnSync(process.execPath, [join(__dirname, '..', '..', 'gpt-runner', 'proba.mjs')], {
        env: { ...process.env, PROBA_CSAK_HELYI: '1', PROBA_GYOKER: dir, HOME: join(dir, 'home'), PROBA_ELVART_HOME: join(dir, 'home') }, encoding: 'utf8', timeout: 60_000,
      })
      const listed = r.stdout.split('\n').filter((l) => l.startsWith('PROBA-NAPLO f2 flotta-jelzesu ')).map((l) => l.slice('PROBA-NAPLO f2 flotta-jelzesu '.length)).sort()
      expect([listed, /^PROBA F2 FAIL rendszeren kivul 0, flotta-jelzesu 12 \(mind a 12 a PROBA-NAPLO f2 sorokban\)/m.test(r.stdout)]).toEqual([names, true])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('PLUGIN: after the Codex runs no plugin cache may exist; without a login it is not measurable, never OK', () => {
    expect([checkPluginCache(true, true)[0], checkPluginCache(true, false)[0], checkPluginCache(false, true)[0], checkPluginCache(false, false)[0], PLUGIN_CACHE]).toEqual(['FAIL', 'FAIL', 'OK', 'NEM_MERHETO', '/home/gpt/.codex/plugins'])
  })

  it('FINISH-ONE-PATH: both paths end in finish() (PLUGIN, SKILLS, the summary); the host path passes whether Codex ran with a model', () => {
    const src = R('proba.mjs')
    const main = src.slice(src.indexOf('export async function main()'))
    expect([
      (src.match(/console\.log\(`OSSZESITES /g) ?? []).length,
      /\n {4}finish\(false\)\n {4}return\n {2}\}/.test(main),
      /\n {2}finish\(authStat != null\)\n\}/.test(main),
    ]).toEqual([1, true, true])
  })

  it('SKILLS: after the Codex runs no built-in skills folder may exist; without a login it is not measurable, never OK', () => {
    expect([checkSystemSkills(true, true)[0], checkSystemSkills(true, false)[0], checkSystemSkills(false, true)[0], checkSystemSkills(false, false)[0], SYSTEM_SKILLS]).toEqual(['FAIL', 'FAIL', 'OK', 'NEM_MERHETO', '/home/gpt/.codex/skills/.system'])
  })

  it('F2-STAYS-STRICT: the built-in skills\' agents/openai.yaml is still flagged by F2 (no exception: the install is off and the folder removed instead)', () => {
    const { marked } = classifyReadable(['/home/gpt/.codex/skills/.system/skill-installer/agents/openai.yaml'], '/home/gpt')
    expect(marked).toEqual(['/home/gpt/.codex/skills/.system/skill-installer/agents/openai.yaml'])
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
    expect(HOST_PORTS).toEqual(expect.arrayContaining([3420, 3425, 8000, 22, 80, 443, 8790]))
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
    for (const bad of [/type: bind/, /^\s*secrets:/m, /docker\.sock/, /marveen-docker/, /\/home\/marveen/, /privileged/, /network_mode/, /external: true/, /cap_add/]) {
      expect([bad.source, bad.test(code)]).toEqual([bad.source, false])
    }
    // the ONE published port: the service's, on ONE host address (never all of them), and only
    // in the service, which is in a profile (a plain `docker compose up` runs the probe only)
    const svc = code.split(/^ {2}gpt-szolga:/m)[1]!.split(/^networks:/m)[0]!
    const probe = code.split(/^ {2}gpt-futtato:/m)[1]!.split(/^ {2}gpt-szolga:/m)[0]!
    expect([(code.match(/^\s*ports:/gm) ?? []).length, /^\s*ports:/m.test(probe)]).toEqual([1, false])
    expect(svc.match(/^ {6}- "(.*)"$/m)?.[1]).toBe('${GPT_FUTTATO_KOZZETETT_CIM:?the host script sets it}:8790:8790')
    for (const want of [/profiles: \["szolga"\]/, /restart: "no"/, /user: "10002:10002"/, /read_only: true/, /- ALL/, /no-new-privileges:true/, /pids_limit: 128/, /mem_limit: 512m/, /ipv4_address: \$\{GPT_FUTTATO_SZOLGA_CIM:\?/, /SZOLGA_TOKEN_SHA256: \$\{GPT_FUTTATO_SZOLGA_TOKEN_SHA256:\?/]) {
      expect([want.source, want.test(svc)]).toEqual([want.source, true])
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
      // the plugin and the built-in skills lines run in every probe; without a login: not measurable
      expect([line('PLUGIN'), line('SKILLS')]).toEqual(['NEM_MERHETO', 'NEM_MERHETO'])
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
# -t nat: its chains are stored as nat:<chain>; -S prints the plain name, like iptables
tb=""; if [ "$1" = "-t" ]; then [ "$2" = filter ] || tb="$2:"; shift 2; fi
op="$1"; name="$2"; chain="$tb$2"; shift 2
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
  -S) echo "-P $name ACCEPT"; grep -F "R|$chain|" "$S" | grep "^R|$chain|" | cut -d'|' -f3- | sed "s/^/-A $name /" ;;
esac
`
  const setup = (state = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-fw-'))
    writeFileSync(join(dir, 'iptables'), FAKE, { mode: 0o755 })
    writeFileSync(join(dir, 'state'), state)
    return dir
  }
  const fw = (dir: string) => spawnSync('bash', [join(__dirname, '..', '..', 'gpt-runner', 'host', 'tuzfal.sh')], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`, FAKE_STATE: join(dir, 'state'), IPTABLES: join(dir, 'iptables'),
      GPT_FUTTATO_ENV: join(dir, 'env'), GPT_FUTTATO_ALLAPOT_DIR: join(dir, 'allapot'),
    },
    encoding: 'utf8', timeout: 20_000,
  })
  const rules = (dir: string) => readFileSync(join(dir, 'state'), 'utf8').split('\n').filter((l) => l.startsWith('R|'))
  const chain = (dir: string, c: string) => rules(dir).filter((l) => l.startsWith(`R|${c}|`)).map((l) => l.split('|')[2])
  const calls = (dir: string) => { try { return readFileSync(join(dir, 'state.calls'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'].map((r) => `-d ${r} -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP`)
  const BE_CLOSED = ['-m conntrack --ctstate INVALID -j DROP', '-m conntrack --ctstate NEW -j DROP']
  const run = (state: string, fn: (dir: string) => void) => { const dir = setup(state); try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }

  it('FW-RULES: the host is closed to the bridge (INPUT, OUTPUT), the private ranges too, and without a channel config nothing comes in', () => run('', (dir) => {
    const r = fw(dir)
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect([chain(dir, 'INPUT'), chain(dir, 'OUTPUT'), chain(dir, 'DOCKER-USER'), chain(dir, 'GPTF-TOVABB'), chain(dir, 'GPTF-GEP'), chain(dir, 'GPTF-GEPROL'), chain(dir, 'GPTF-PRIVAT'), chain(dir, 'GPTF-BE')]).toEqual([
      ['-i gptki0 -j GPTF-GEP'], ['-o gptki0 -j GPTF-GEPROL'], ['-j GPTF-TOVABB'], ['-i gptki0 -j GPTF-PRIVAT', '-o gptki0 -j GPTF-BE'], ['-j DROP'], ['-j DROP'], PRIVATE, BE_CLOSED,
    ])
    // nat: our jump first in POSTROUTING, the chain empty while the channel is closed
    expect([chain(dir, 'nat:POSTROUTING'), chain(dir, 'nat:GPTF-NAT'), chain(dir, 'POSTROUTING')]).toEqual([['-o gptki0 -j GPTF-NAT'], [], []])
    expect([chain(dir, 'raw:PREROUTING'), chain(dir, 'raw:GPTF-RAW')]).toEqual([['-i gptki0 -j GPTF-RAW'], []])
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
      expect(chain(dir, 'DOCKER-USER')).toEqual(['-j GPTF-TOVABB', '-j RETURN'])
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

  // a tiny evaluator of OUR rule shapes, so the tests check what a packet meets, not only the text
  type Pkt = { src: string; dst: string; proto: 'tcp' | 'udp'; dport: number; sport?: number; in?: string; out?: string; state: 'NEW' | 'ESTABLISHED' | 'RELATED' | 'INVALID' }
  const inCidr = (ip: string, cidr: string) => {
    const [base, bits = '32'] = cidr.split('/')
    const n = (a: string) => a.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0
    return ((n(ip) & mask) >>> 0) === ((n(base!) & mask) >>> 0)
  }
  const matches = (rule: string, p: Pkt) => {
    const tok = rule.split(' ')
    let ok = true
    for (let i = 0; i < tok.length; i++) {
      const neg = tok[i] === '!'
      if (neg) i++
      const k = tok[i]
      const v = tok[i + 1]
      let hit: boolean | null = null
      if (k === '-s') hit = inCidr(p.src, v!)
      else if (k === '-d') hit = inCidr(p.dst, v!)
      else if (k === '-p') hit = p.proto === v
      else if (k === '--dport') hit = p.dport === Number(v)
      else if (k === '--sport') hit = p.sport === Number(v)
      else if (k === '-i') hit = p.in === v
      else if (k === '-o') hit = p.out === v
      else if (k === '--ctstate') hit = v!.split(',').includes(p.state)
      else if (k === '-m') { i++; continue }
      else if (k === '-j') break
      else throw new Error(`unknown token in rule: ${rule}`)
      i++
      if (neg ? hit : !hit) ok = false
    }
    return ok
  }
  const verdict = (rules: string[], p: Pkt) => (rules.some((r) => r.endsWith('-j DROP') && matches(r, p)) ? 'DROP' : 'tovabb')
  const accepts = (rules: string[], p: Pkt) => rules.some((r) => r.endsWith('-j ACCEPT') && matches(r, p))
  const CHANNEL_ENV = 'GPT_FUTTATO_VEZERLO_CIM=10.0.2.4\nGPT_FUTTATO_SZOLGA_CIM=10.0.5.10\nGPT_FUTTATO_FLOTTA_KONTENER=marveen\n'
  // a fake docker: `inspect ... marveen` prints the fleet container's addresses from a file
  const fleetAt = (dir: string, ips: string | null) => {
    writeFileSync(join(dir, 'docker'), `#!/bin/bash\n[ "$1 $4" = "inspect marveen" ] || exit 9\n[ -f "${join(dir, 'ips')}" ] || exit 1\ncat "${join(dir, 'ips')}"\n`, { mode: 0o755 })
    if (ips == null) rmSync(join(dir, 'ips'), { force: true })
    else writeFileSync(join(dir, 'ips'), ips)
  }

  it('FW-CHANNEL: into the runner only the fleet address to the service port is new; replies pass; the runner still cannot start one to a private address', () => run('', (dir) => {
    writeFileSync(join(dir, 'env'), CHANNEL_ENV)
    fleetAt(dir, '10.0.2.4 192.168.250.2 ')
    expect(fw(dir).status).toBe(0)
    const be = chain(dir, 'GPTF-BE')
    const priv = chain(dir, 'GPTF-PRIVAT')
    const svc = { src: '10.0.2.4', dst: '10.0.5.10', proto: 'tcp', dport: 8790, state: 'NEW' } as Pkt
    expect([
      verdict(be, svc),
      verdict(be, { ...svc, src: '10.0.2.9' }),
      verdict(be, { ...svc, src: '10.0.5.1' }),
      verdict(be, { ...svc, dport: 22 }),
      verdict(be, { ...svc, dst: '10.0.5.11' }),
      verdict(be, { ...svc, proto: 'udp' }),
      verdict(be, { ...svc, state: 'INVALID' }),
      verdict(be, { src: '162.159.140.245', dst: '10.0.5.10', proto: 'tcp', dport: 51000, state: 'ESTABLISHED' }),
      verdict(priv, { src: '10.0.5.10', dst: '10.0.2.4', proto: 'tcp', dport: 3420, state: 'NEW' }),
      verdict(priv, { src: '10.0.5.10', dst: '10.0.2.4', proto: 'tcp', dport: 41000, state: 'ESTABLISHED' }),
      verdict(priv, { src: '10.0.5.10', dst: '162.159.140.245', proto: 'tcp', dport: 443, state: 'NEW' }),
    ]).toEqual(['tovabb', 'DROP', 'DROP', 'DROP', 'DROP', 'DROP', 'DROP', 'tovabb', 'DROP', 'tovabb', 'tovabb'])
    expect([chain(dir, 'OUTPUT'), chain(dir, 'GPTF-GEPROL')]).toEqual([['-o gptki0 -j GPTF-GEPROL'], ['-j DROP']])
  }))

  it('FW-ISOLATION-ACCEPT: past Docker\'s isolation goes EXACTLY the channel flow, both ways, and each ACCEPT is something our DROP chains pass anyway', () => run('', (dir) => {
    writeFileSync(join(dir, 'env'), CHANNEL_ENV)
    fleetAt(dir, '10.0.2.4 ')
    fw(dir)
    const tv = chain(dir, 'GPTF-TOVABB')
    const be = chain(dir, 'GPTF-BE')
    const priv = chain(dir, 'GPTF-PRIVAT')
    const there = { src: '10.0.2.4', dst: '10.0.5.10', proto: 'tcp', dport: 8790, sport: 41000, out: 'gptki0', state: 'NEW' } as Pkt
    const back = { src: '10.0.5.10', dst: '10.0.2.4', proto: 'tcp', dport: 41000, sport: 8790, in: 'gptki0', state: 'ESTABLISHED' } as Pkt
    const cases: [Pkt, boolean][] = [
      [there, true], [{ ...there, state: 'ESTABLISHED' }, true], [back, true],
      [{ ...there, src: '10.0.2.9' }, false], [{ ...there, dport: 22 }, false], [{ ...there, dst: '10.0.5.11' }, false], [{ ...there, proto: 'udp' }, false],
      [{ ...there, state: 'INVALID' }, false], [{ ...there, out: 'br-masik' }, false],
      [{ ...back, state: 'NEW' }, false], [{ ...back, sport: 22 }, false], [{ ...back, dst: '10.0.2.9' }, false], [{ ...back, in: 'br-masik' }, false],
    ]
    expect(cases.map(([p]) => accepts(tv, p))).toEqual(cases.map(([, want]) => want))
    // every accepted packet is one the DROP chain of its direction passes too: the ACCEPT never opens more
    for (const [p, want] of cases) if (want) expect(verdict(p.out === 'gptki0' ? be : priv, p)).toBe('tovabb')
  }))

  it('FW-NAT: while the channel is open, exactly its flow is kept from Docker\'s MASQUERADE (first in nat POSTROUTING); a docker rule above is moved below; closing empties it FIRST', () => run(
    'R|nat:POSTROUTING|-s 192.168.250.0/24 ! -o br-flotta -j MASQUERADE\n', (dir) => {
      writeFileSync(join(dir, 'env'), CHANNEL_ENV)
      fleetAt(dir, '10.0.2.4 ')
      fw(dir)
      const natRule = '-s 10.0.2.4/32 -d 10.0.5.10/32 -p tcp -m tcp --dport 8790 -j ACCEPT'
      const open = [chain(dir, 'nat:POSTROUTING'), chain(dir, 'nat:GPTF-NAT')]
      // the nat ACCEPT matches only the channel flow (the evaluator reads -j ACCEPT rules)
      const nat = chain(dir, 'nat:GPTF-NAT')
      const flow = { src: '10.0.2.4', dst: '10.0.5.10', proto: 'tcp', dport: 8790, state: 'NEW' } as Pkt
      expect([accepts(nat, flow), accepts(nat, { ...flow, src: '10.0.2.9' }), accepts(nat, { ...flow, dport: 22 }), accepts(nat, { ...flow, dst: '10.0.5.11' })]).toEqual([true, false, false, false])
      fleetAt(dir, '10.0.2.9 ')
      const closing = calls(dir).length
      fw(dir)
      const cc = calls(dir).slice(closing)
      const natDel = cc.findIndex((x) => x.startsWith('W -t nat -D GPTF-NAT '))
      const firstOther = cc.findIndex((x) => /^W -(A|D) GPTF-(TOVABB|BE) /.test(x))
      expect([open, chain(dir, 'nat:GPTF-NAT'), natDel >= 0 && natDel < firstOther]).toEqual([
        [['-o gptki0 -j GPTF-NAT', '-s 192.168.250.0/24 ! -o br-flotta -j MASQUERADE'], [natRule]], [], true,
      ])
    }))

  it('FW-RAW: the channel\'s REPLY passes Docker\'s raw direct-access guard, nothing else does; a NEW packet from the runner is still dropped by the filter; closing empties it FIRST', () => run(
    'R|raw:PREROUTING|-d 10.0.2.4/32 ! -i br-flotta -j DROP\n', (dir) => {
      writeFileSync(join(dir, 'env'), CHANNEL_ENV)
      fleetAt(dir, '10.0.2.4 ')
      fw(dir)
      const rawRule = '-s 10.0.5.10/32 -d 10.0.2.4/32 -p tcp -m tcp --sport 8790 -j ACCEPT'
      // a walk of raw PREROUTING as the kernel does it: our jump (into GPTF-RAW), then Docker's DROP
      const raw = (p: Pkt) => {
        for (const r of chain(dir, 'raw:PREROUTING')) {
          if (r.endsWith('-j GPTF-RAW')) { if (matches(r, p) && accepts(chain(dir, 'raw:GPTF-RAW'), p)) return 'ACCEPT'; continue }
          if (r.endsWith('-j DROP') && matches(r, p)) return 'DROP'
        }
        return 'tovabb'
      }
      const reply = { src: '10.0.5.10', dst: '10.0.2.4', proto: 'tcp', dport: 41000, sport: 8790, in: 'gptki0', state: 'ESTABLISHED' } as Pkt
      expect([
        chain(dir, 'raw:PREROUTING'), chain(dir, 'raw:GPTF-RAW'),
        raw(reply), raw({ ...reply, sport: 22 }), raw({ ...reply, src: '10.0.5.11' }), raw({ ...reply, in: 'br-masik' }), raw({ ...reply, proto: 'udp' }),
        // past raw, the filter still decides: a NEW packet from the runner (sport 8790) is dropped
        verdict(chain(dir, 'GPTF-PRIVAT'), { ...reply, state: 'NEW' }), verdict(chain(dir, 'GPTF-PRIVAT'), reply),
      ]).toEqual([
        ['-i gptki0 -j GPTF-RAW', '-d 10.0.2.4/32 ! -i br-flotta -j DROP'], [rawRule],
        'ACCEPT', 'DROP', 'DROP', 'DROP', 'DROP',
        'DROP', 'tovabb',
      ])
      fleetAt(dir, '10.0.2.9 ')
      const closing = calls(dir).length
      fw(dir)
      const cc = calls(dir).slice(closing)
      const rawDel = cc.findIndex((x) => x.startsWith('W -t raw -D GPTF-RAW '))
      const natDel = cc.findIndex((x) => x.startsWith('W -t nat -D GPTF-NAT '))
      expect([chain(dir, 'raw:GPTF-RAW'), rawDel >= 0 && rawDel < natDel]).toEqual([[], true])
    }))

  it('FW-ADDRESS-CLOSES: the fleet container without the fixed address (or unreadable) CLOSES the channel: GPTF-BE closed, no ACCEPT; back at the address it opens; the ACCEPTs leave first and come last', () => run('', (dir) => {
    writeFileSync(join(dir, 'env'), CHANNEL_ENV)
    const closedTv = ['-i gptki0 -j GPTF-PRIVAT', '-o gptki0 -j GPTF-BE']
    fleetAt(dir, '10.0.2.9 192.168.250.2 ')
    fw(dir)
    const a = [chain(dir, 'GPTF-BE'), chain(dir, 'GPTF-TOVABB')]
    fleetAt(dir, '10.0.2.4 ')
    const opening = calls(dir).length
    fw(dir)
    const openCalls = calls(dir).slice(opening)
    const b = chain(dir, 'GPTF-TOVABB').length
    fleetAt(dir, null)
    const closing = calls(dir).length
    fw(dir)
    const closeCalls = calls(dir).slice(closing)
    expect([a, b, chain(dir, 'GPTF-BE'), chain(dir, 'GPTF-TOVABB')]).toEqual([[BE_CLOSED, closedTv], 4, BE_CLOSED, closedTv])
    const idx = (cs: string[], re: RegExp) => cs.findIndex((x) => re.test(x))
    expect(idx(openCalls, /^W -A GPTF-BE ! -s /) < idx(openCalls, /^W -A GPTF-TOVABB .*-j ACCEPT$/)).toBe(true)
    const lastAcceptDel = closeCalls.map((x, i) => (/^W -D GPTF-TOVABB .*-j ACCEPT$/.test(x) ? i : -1)).filter((i) => i >= 0).pop()!
    expect(lastAcceptDel < idx(closeCalls, /^W -A GPTF-BE -m conntrack --ctstate NEW -j DROP$/)).toBe(true)
  }))

  it('FW-CHANNEL-MALFORMED: an address that is not a plain IPv4 (or a rule smuggled after it) keeps the channel closed', () => {
    for (const env of ['GPT_FUTTATO_VEZERLO_CIM=10.0.2.4 -j ACCEPT\nGPT_FUTTATO_SZOLGA_CIM=10.0.5.10\n', 'GPT_FUTTATO_VEZERLO_CIM=300.0.2.4\nGPT_FUTTATO_SZOLGA_CIM=10.0.5.10\n', 'GPT_FUTTATO_VEZERLO_CIM=10.0.2.4\n', 'GPT_FUTTATO_VEZERLO_CIM=0.0.0.0/0\nGPT_FUTTATO_SZOLGA_CIM=10.0.5.10\n']) {
      run('', (dir) => {
        writeFileSync(join(dir, 'env'), env)
        expect([fw(dir).status, chain(dir, 'GPTF-BE')]).toEqual([0, BE_CLOSED])
      })
    }
  })

  it('FW-MIGRATE: the first version (DOCKER-USER -i gptki0 -j GPTF-PRIVAT, plain private drops) moves over without an open moment', () => run(
    `R|DOCKER-USER|-i gptki0 -j GPTF-PRIVAT\nR|DOCKER-USER|-j RETURN\nN|GPTF-PRIVAT\n${['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'].map((r) => `R|GPTF-PRIVAT|-d ${r} -j DROP`).join('\n')}\n`, (dir) => {
      const r = fw(dir)
      const c = calls(dir)
      expect([chain(dir, 'DOCKER-USER'), chain(dir, 'GPTF-PRIVAT')]).toEqual([['-j GPTF-TOVABB', '-j RETURN'], PRIVATE])
      expect(c.findIndex((x) => x === 'W -I DOCKER-USER 1 -j GPTF-TOVABB') < c.findIndex((x) => x === 'W -D DOCKER-USER -i gptki0 -j GPTF-PRIVAT')).toBe(true)
      const lastNewPriv = c.map((x, i) => (/^W -A GPTF-PRIVAT /.test(x) ? i : -1)).filter((i) => i >= 0).pop()!
      expect(lastNewPriv < c.findIndex((x) => /^W -D GPTF-PRIVAT /.test(x))).toBe(true)
      expect(r.stdout).toMatch(/^ATTETTE: a DOCKER-USER regi ugrasa/m)
    }))

  it('FW-FLEET-ADDRESS: the fleet container without the fixed controller address is said once (channel closed), then said again when it is back', () => run('', (dir) => {
    writeFileSync(join(dir, 'env'), CHANNEL_ENV)
    fleetAt(dir, '10.0.2.9 192.168.250.2 ')
    const a = fw(dir).stdout
    const b = fw(dir).stdout
    fleetAt(dir, '10.0.2.4 192.168.250.2 ')
    const c = fw(dir).stdout
    expect(a).toMatch(/^CSATORNA: a flotta kontener \(marveen\) cimei: 10\.0\.2\.9 192\.168\.250\.2; a rogzitett vezerlo-cim \(10\.0\.2\.4\) nincs koztuk: a csatorna zarva marad$/m)
    // opening changes our chains (said by their own lines); the state line says why
    expect([b, /^CSATORNA: rendben$/m.test(c)]).toEqual(['', true])
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
    // the raw jump (the reply past Docker's guard) is in the persistence measurement too
    expect(inst).toMatch(/iptables -w 5 -t raw -D PREROUTING -i "\$BRIDGE" -j GPTF-RAW[\s\S]*systemctl restart gpt-futtato-tuzfal\.service[\s\S]*iptables -w 5 -t raw -S PREROUTING \| grep -F GPTF-RAW \|\| \{ echo "STOP: a raw PREROUTING ugras hianyzik"/)
    // the nat jump (the channel's no-masquerade chain) is in the persistence measurement too
    expect(inst).toMatch(/iptables -w 5 -t nat -D POSTROUTING -o "\$BRIDGE" -j GPTF-NAT[\s\S]*systemctl restart gpt-futtato-tuzfal\.service[\s\S]*iptables -w 5 -t nat -S POSTROUTING \| grep -F GPTF-NAT \|\| \{ echo "STOP: a nat POSTROUTING ugras hianyzik"/)
    expect(inst).toMatch(/systemctl enable --now gpt-futtato-tuzfal-ellenor\.timer/)
    // the one timer round: a rule above ours, the DOCKER-USER jump removed, wait, check, clean up
    expect(inst).toMatch(/iptables -w 5 -I INPUT 1 -m comment --comment gptf-ufw-proba\niptables -w 5 -D DOCKER-USER -j GPTF-TOVABB[\s\S]*sleep 5[\s\S]*"-A INPUT -i \$BRIDGE -j GPTF-GEP"[\s\S]*iptables -w 5 -D INPUT -m comment --comment gptf-ufw-proba[\s\S]*STOP: a timer/)
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
    expect(inst).toMatch(/ufw_aktiv\(\) \{ command -v ufw >\/dev\/null && grep -q '\^Status: active' <<< "\$\(ufw status 2>\/dev\/null \|\| true\)"; \}/)
    // F2's full list is printed by both host scripts that show the probe (acrobot 30889)
    expect([/grep -E "\^PROBA-NAPLO f2 " \/opt\/gpt-futtato\/proba-teljes\.log/.test(inst), /PROBA-NAPLO f2 /.test(R('host/utana-meres.sh'))]).toEqual([true, true])
    // no `cmd | grep -q` in the host scripts: under pipefail an early grep exit (SIGPIPE) is a false failure
    for (const f of ['host/telepit-tuzfal.sh', 'host/csatorna.sh', 'host/tuzfal.sh']) expect([f, /\|\s*grep -q/.test(R(f).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'))]).toEqual([f, false])
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
    const common = [...RUN_COMMON]
    // the control of the negatives below: the common part alone, with nothing extra, passes
    expect(safeExecArgs([...common, '-'])).toBeNull()
    // plugins and apps are off in BOTH runs (acrobot 30889), and turning one on is refused
    for (const a of [V3_TEST_ARGS, V3_CONTROL_ARGS]) expect(a).toEqual(expect.arrayContaining(['features.plugins=false', 'features.apps=false', 'skills.bundled.enabled=false']))
    expect([safeExecArgs([...common, '-c', 'features.plugins=true', '-']) != null, safeExecArgs([...common, '-c', 'skills.bundled.enabled=true', '-']) != null, safeExecArgs([...common.slice(0, -2), '-']) != null]).toEqual([true, true, true])
    for (const extra of [['--full-auto'], ['--add-dir', '/'], ['-c', 'features.apply_patch=true'], ['-c', 'sandbox_mode="danger-full-access"'], ['--sandbox', 'danger-full-access'], ['-c']]) {
      const args = [...common, ...extra, '-']
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
    const inputs: (string | undefined)[] = []
    const log = console.log
    console.log = () => {}
    try {
      v3Checks((id, v) => { said[id] = v }, (_c, args, input) => { calls.push(args); inputs.push(input); return onRun(args, fs) }, { exists: (p) => fs.has(p), remove: (p) => fs.delete(p), loggedIn })
    } finally { console.log = log }
    return { said, calls, fs, inputs }
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

  it('V3-STDIN: both runs take the fixed prompt on STDIN with the "-" sentinel, as the service does; no prompt text in the arguments', () => {
    const r = v3((a) => (isControl(a) ? { code: 0, out: EXEC } : { code: 0, out: '{"type":"item.completed","item":{"type":"agent_message"}}' }))
    expect([r.inputs, r.calls.map((a) => a[a.length - 1]), r.calls.some((a) => a.some((x) => x.includes('touch')))]).toEqual([[V3_PROMPT, V3_PROMPT], ['-', '-'], false])
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

describe('gpt-runner controller channel on the host (host/csatorna.sh) against fakes', () => {
  // fakes for docker, iptables and timeout; every call is logged. The scenario is set by files:
  // forras (what the service saw), nyitott (host:port pairs that connect), and the logs
  const SCRIPT = join(__dirname, '..', '..', 'gpt-runner', 'host', 'csatorna.sh')
  const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/
  const setup = (o: { forras?: string; nyitott?: string[]; allapot?: string } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-csat-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    mkdirSync(join(dir, 'opt', 'src', 'gpt-runner', 'host'), { recursive: true })
    mkdirSync(join(dir, 'store'))
    mkdirSync(join(dir, 'allapot'))
    writeFileSync(join(dir, 'store', '.dashboard-token'), 'x', { mode: 0o600 })
    writeFileSync(join(dir, 'opt', '.env'), 'GPT_FUTTATO_NODE_IMAGE=node@sha256:x\n', { mode: 0o600 })
    writeFileSync(join(dir, 'forras'), o.forras ?? '10.0.2.4')
    writeFileSync(join(dir, 'nyitott'), (o.nyitott ?? ['10.0.2.4:3420']).join('\n') + '\n')
    writeFileSync(join(dir, 'allapot', 'cim-allapot'), `${o.allapot ?? 'rendben'}\n`)
    writeFileSync(join(dir, 'opt', 'src', 'gpt-runner', 'host', 'telepit-tuzfal.sh'), `echo telepit >> "${dir}/calls"\nprintf 'PROBA N1 OK x\\nOSSZESITES ok=16 fail=0\\n' > "${dir}/opt/proba-teljes.log"\n`)
    const log = `echo "$(basename "$0") $*" >> "${dir}/calls"`
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
${log}
case "$1 $2" in
  "ps -q") echo c1 ;;
  "inspect -f") case "$4" in gpt-szolga) echo exited ;; c1) echo "/marveen|/opt/marveen-docker/data/marveen " ;; marveen) printf 'fleetnet 10.0.2.4 10.0.2.1\\nmasik 192.168.250.2 192.168.250.1\\n' ;; esac ;;
  "network inspect") case "$5" in fleetnet) echo 1 ;; masik) echo 3 ;; gpt-futtato-ki) echo "10.0.5.0/24 " ;; esac ;;
  "logs gpt-szolga") printf 'SZOLGA figyel 10.0.5.10:8790\\n'; [ -f "${dir}/nincs-forras" ] || printf 'FORRAS %s\\n' "$(cat "${dir}/forras")" ;;
  "exec marveen") cat "${dir}/forras"; echo ;;
  "run --rm") h="\${@: -2:1}"; p="\${@: -1}"; if grep -qxF "$h:$p" "${dir}/nyitott"; then echo NYITOTT; else echo "ZART (idotullepes)"; fi ;;
  "compose run") [ -f "${dir}/plugin-hiba" ] && exit 1; echo "elotte: 35 fajl" ;;
esac
exit 0
`, { mode: 0o755 })
    writeFileSync(join(bin, 'iptables'), `#!/bin/bash
${log}
case "$3 $4 $5 $6" in
  "-t nat -S POSTROUTING") if [ -f "${dir}/nat-masodik" ]; then printf -- '-P POSTROUTING ACCEPT\\n-A POSTROUTING -s 192.168.250.0/24 ! -o br-x -j MASQUERADE\\n-A POSTROUTING -o gptki0 -j GPTF-NAT\\n'; else printf -- '-P POSTROUTING ACCEPT\\n-A POSTROUTING -o gptki0 -j GPTF-NAT\\n-A POSTROUTING -s 192.168.250.0/24 ! -o br-x -j MASQUERADE\\n'; fi; exit 0 ;;
  "-t nat -S GPTF-NAT") printf -- '-N GPTF-NAT\\n'; [ -f "${dir}/nat-nincs" ] || printf -- '-A GPTF-NAT -s 10.0.2.4/32 -d 10.0.5.10/32 -p tcp -m tcp --dport 8790 -j ACCEPT\\n'; exit 0 ;;
  "-t raw -S PREROUTING") if [ -f "${dir}/raw-masodik" ]; then printf -- '-P PREROUTING ACCEPT\\n-A PREROUTING -d 10.0.2.4/32 ! -i br-x -j DROP\\n-A PREROUTING -i gptki0 -j GPTF-RAW\\n'; else printf -- '-P PREROUTING ACCEPT\\n-A PREROUTING -i gptki0 -j GPTF-RAW\\n-A PREROUTING -d 10.0.2.4/32 ! -i br-x -j DROP\\n'; fi; exit 0 ;;
  "-t raw -S GPTF-RAW") printf -- '-N GPTF-RAW\\n'; [ -f "${dir}/raw-nincs" ] || printf -- '-A GPTF-RAW -s 10.0.5.10/32 -d 10.0.2.4/32 -p tcp -m tcp --sport 8790 -j ACCEPT\\n'; exit 0 ;;
esac
case "$4" in
  GPTF-BE) printf -- '-N GPTF-BE\\n-A GPTF-BE -m conntrack --ctstate INVALID -j DROP\\n-A GPTF-BE ! -s 10.0.2.4/32 -m conntrack --ctstate NEW -j DROP\\n-A GPTF-BE ! -d 10.0.5.10/32 -m conntrack --ctstate NEW -j DROP\\n' ;;
  GPTF-TOVABB) printf -- '-N GPTF-TOVABB\\n-A GPTF-TOVABB -i gptki0 -j GPTF-PRIVAT\\n-A GPTF-TOVABB -o gptki0 -j GPTF-BE\\n'; [ -f "${dir}/accept-nincs" ] || printf -- '-A GPTF-TOVABB -s 10.0.2.4/32 -d 10.0.5.10/32 -o gptki0 -p tcp -m tcp --dport 8790 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT\\n-A GPTF-TOVABB -s 10.0.5.10/32 -d 10.0.2.4/32 -i gptki0 -p tcp -m tcp --sport 8790 -m conntrack --ctstate ESTABLISHED -j ACCEPT\\n' ;;
esac
`, { mode: 0o755 })
    writeFileSync(join(bin, 'timeout'), `#!/bin/bash
${log}
t="$4"; t="\${t#*/dev/tcp/}"; t="\${t%% *}"; hp="\${t%/*}:\${t##*/}"
grep -qxF "$hp" "${dir}/nyitott"
`, { mode: 0o755 })
    return dir
  }
  const go = (dir: string) => spawnSync('bash', [SCRIPT], {
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, GPT_FUTTATO_DIR: join(dir, 'opt'), GPT_FUTTATO_FLOTTA_STORE: join(dir, 'store'), GPT_FUTTATO_ALLAPOT_DIR: join(dir, 'allapot') },
    encoding: 'utf8', timeout: 30_000,
  })
  const calls = (dir: string) => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
  const run = (o: Parameters<typeof setup>[0], fn: (dir: string, r: ReturnType<typeof go>) => void) => {
    const dir = setup(o)
    try { fn(dir, go(dir)) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('CSAT-OK: the fleet address seen, the neighbour and the host closed with their controls open: done, and the service STOPPED at the end', () => run({}, (dir, r) => {
    expect([r.status, r.stdout]).toEqual([0, expect.stringContaining('== kesz: a csatorna mert, a szolgaltatas leallitva')])
    const c = calls(dir)
    // the last two: the stop, then its state said
    expect([c[c.length - 2], c[c.length - 1]]).toEqual(['docker compose --profile szolga stop gpt-szolga', 'docker inspect -f {{.State.Status}} gpt-szolga'])
    expect(r.stdout).toMatch(/^valasztott: fleetnet \(kontenerek: 1\); a vezerlo forrascime 10\.0\.2\.4, a kozzetett cim 10\.0\.2\.1:8790$/m)
    const env = readFileSync(join(dir, 'opt', '.env'), 'utf8')
    for (const l of ['GPT_FUTTATO_VEZERLO_CIM=10.0.2.4', 'GPT_FUTTATO_KOZZETETT_CIM=10.0.2.1', 'GPT_FUTTATO_SZOLGA_CIM=10.0.5.10', 'GPT_FUTTATO_KI_ALHALO=10.0.5.0/24', 'GPT_FUTTATO_KI_TARTOMANY=10.0.5.128/25', 'GPT_FUTTATO_FLOTTA_KONTENER=marveen']) expect(env.split('\n')).toContain(l)
    // never a network connect on the fleet container, never a docker restart
    expect(c.filter((x) => /network connect|docker restart|systemctl restart docker/.test(x))).toEqual([])
  }))

  it('CSAT-TOKEN: the token is made 0600 in the fleet store, the runner gets its SHA-256, and its value is never printed', () => run({}, (dir, r) => {
    const f = join(dir, 'store', '.gpt-futtato-token')
    const tok = readFileSync(f, 'utf8')
    const env = readFileSync(join(dir, 'opt', '.env'), 'utf8')
    expect([TOKEN_RE.test(tok), statSync(f).mode & 0o777, env.includes(`GPT_FUTTATO_SZOLGA_TOKEN_SHA256=${createHash('sha256').update(tok).digest('hex')}`), r.stdout.includes(tok), r.stderr.includes(tok), env.includes(tok)]).toEqual([true, 0o600, true, false, false, false])
  }))

  it('CSAT-SOURCE: the service saw a GATEWAY (a docker-proxy or a MASQUERADE in the way): STOP, the service is stopped, and its state is said', () => run({ forras: '10.0.5.128' }, (dir, r) => {
    expect([r.status, r.stdout]).toEqual([1, expect.stringContaining('STOP: a futtato nem a flotta kontener cimet (10.0.2.4) latta, hanem: 10.0.5.128')])
    const c = calls(dir)
    expect([c[c.length - 2], c[c.length - 1], /^a gpt-szolga allapota a leallitas utan: exited$/m.test(r.stdout)]).toEqual(['docker compose --profile szolga stop gpt-szolga', expect.stringMatching(/^docker inspect -f .* gpt-szolga$/), true])
  }))

  it('CSAT-RAW: our raw chain not first (Docker\'s guard above it), or its rule missing: STOP before the service starts', () => {
    for (const [file, msg] of [['raw-masodik', 'STOP: a raw PREROUTING elso szabalya nem a GPTF-RAW ugras'], ['raw-nincs', 'STOP: a GPTF-RAW-ban nincs meg a csatorna valaszanak szabalya']] as const) {
      const dir = setup({})
      writeFileSync(join(dir, file), '')
      try {
        const r = go(dir)
        expect([file, r.status, r.stdout.includes(msg), calls(dir).some((c) => c.includes('up -d gpt-szolga'))]).toEqual([file, 1, true, false])
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  it('CSAT-NO-FORRAS: the call never reached the service (no FORRAS line): the REAL step stops with its own message, not a pipeline failure', () => {
    const dir = setup({ forras: 'HIBA The operation was aborted due to timeout' })
    writeFileSync(join(dir, 'nincs-forras'), '')
    try {
      const r = go(dir)
      expect([r.status, r.stdout.includes('(a szolgaltatas naplojaban nincs FORRAS sor: a hivas nem ert el hozza)'), r.stdout.includes('STOP: a futtato nem a flotta kontener cimet (10.0.2.4) latta, hanem: HIBA'), r.stderr.includes('a csatorna-meres a(z)')]).toEqual([1, true, true, false])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CSAT-NAT: our no-masquerade chain is not first in nat POSTROUTING, or its rule is missing: STOP before the service starts', () => {
    for (const [file, msg] of [['nat-masodik', 'STOP: a nat POSTROUTING elso szabalya nem a GPTF-NAT ugras'], ['nat-nincs', 'STOP: a GPTF-NAT-ban nincs meg a csatorna (maszkolas nelkuli) szabalya']] as const) {
      const dir = setup({})
      writeFileSync(join(dir, file), '')
      try {
        const r = go(dir)
        expect([file, r.status, r.stdout.includes(msg), calls(dir).some((c) => c.includes('up -d gpt-szolga'))]).toEqual([file, 1, true, false])
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  it('CSAT-NEIGHBOUR: another container on the fleet network reaches the port: STOP', () => run({ nyitott: ['10.0.2.4:3420', '10.0.2.1:8790'] }, (_dir, r) => {
    expect([r.status, r.stdout]).toEqual([1, expect.stringContaining('STOP: egy masik kontener a flotta-halon eleri a futtato szolgaltatasat')])
  }))

  it('CSAT-BLIND: when the control does not connect either, a closed port proves nothing: STOP', () => run({ nyitott: [] }, (_dir, r) => {
    expect([r.status, r.stdout]).toEqual([1, expect.stringContaining('STOP: a kontroll sem ert el semmit a masik kontenerbol')])
  }))

  it('CSAT-PLUGIN-CACHE: the plugin cache is removed as the runner, BEFORE the probe; if it cannot be, STOP before the probe', () => {
    const ok = setup({})
    try {
      go(ok)
      const c = calls(ok)
      const del = c.findIndex((x) => x.startsWith('docker compose run --rm --no-deps --entrypoint sh gpt-futtato -c') && x.includes('rm -rf -- "$p"') && x.includes('for p in /home/gpt/.codex/plugins /home/gpt/.codex/skills/.system;'))
      expect([del >= 0, del < c.indexOf('telepit')]).toEqual([true, true])
    } finally { rmSync(ok, { recursive: true, force: true }) }
    const bad = setup({})
    writeFileSync(join(bad, 'plugin-hiba'), '')
    try {
      const r = go(bad)
      expect([r.status, r.stdout, calls(bad).includes('telepit')]).toEqual([1, expect.stringContaining('STOP: a plugin-gyorsitotar vagy a beepitett skillek nem torolhetok'), false])
    } finally { rmSync(bad, { recursive: true, force: true }) }
  })

  it('CSAT-NO-ACCEPT: the flow\'s ACCEPTs past Docker\'s isolation are missing: STOP before the service starts', () => {
    const dir = setup({})
    writeFileSync(join(dir, 'accept-nincs'), '')
    try {
      const r = go(dir)
      expect([r.status, r.stdout, calls(dir).some((c) => c.includes('up -d gpt-szolga'))]).toEqual([1, expect.stringContaining('STOP: a GPTF-TOVABB-ban nincs meg a csatorna oda-iranyu ACCEPT-je'), false])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CSAT-TIMER-ADDRESS: the timer says the fleet address does not match: STOP', () => run({ allapot: 'a flotta kontener (marveen) cimei: 10.0.2.9; ...' }, (_dir, r) => {
    expect([r.status, r.stdout]).toEqual([1, expect.stringContaining('STOP: a tuzfal szerint a flotta cime nem egyezik')])
  }))
})

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
