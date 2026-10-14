// The GPT runner's isolation probe (task t-20261014-gpt-futtato-kontener).
//
// Balázs, 2026-10-14 16:38 UTC: the runner gets its own container, and the isolation is shown by
// REAL negative tests on the installed version, not by reading the configuration. This script is
// the container's whole job until the GPT side is activated (condition 6): it runs once, writes
// one line per check to stdout (so `docker logs gpt-futtato` shows it), and exits; nothing else
// runs, there is no login and no credential.
//
// Every check has a control that can turn it the other way, so a green line is not just a
// probe that could not have failed (plan v2, barracuda): a negative network test counts only if
// the same probe reaches the outside; the file walk counts only if it finds its own canary.
//
// Line format:  PROBA <id> <OK|FAIL|NEM_MERHETO> <detail>
// Last line:    OSSZESITES ok=<n> fail=<n> nem_merheto=<n>     exit code 1 when fail > 0
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, lstatSync, readFileSync, writeFileSync, rmSync, accessSync, constants } from 'node:fs'
import net from 'node:net'
import dns from 'node:dns/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The uids and gids the fleet uses (marveen 1000, the agents 1001-1006) and root. */
export const FLEET_IDS = [0, 1000, 1001, 1002, 1003, 1004, 1005, 1006]
/** The ONE id the runner may have (compose `user:`). An allowlist, not a denylist: a new agent's
 *  uid (1007) or a mistyped `user:` line must not pass (barracuda, #138 review). */
export const RUNNER_ID = 10002
/** Ports that must NOT answer from the runner: the dashboard, its second port, the usual
 *  databases, Coolify, the deploy executor. 22/80/443 on the gateway are public anyway. */
export const CLOSED_PORTS = [3420, 3425, 5432, 6379, 8000, 8080, 8787]
/** On the HOST (the gateway and the host's own addresses) the public ones must be closed too:
 *  the first live run (2026-10-14 17:50 UTC) reached 10.0.5.1:8000, the host itself; from the
 *  runner the host is not "the internet", and ssh and Traefik are the host's services. */
export const HOST_PORTS = [...CLOSED_PORTS, 22, 80, 443]
export const PINNED_CODEX = process.env.PROBA_CODEX_VERSION || '0.159.3'
/** Where a stranger may legitimately find readable files in this image. */
export const SYSTEM_PREFIXES = ['/usr/', '/lib/', '/lib32/', '/lib64/', '/libx32/', '/bin/', '/sbin/', '/etc/', '/proc/', '/sys/', '/dev/', '/run/', '/var/', '/app/', '/opt/yarn-', '/home/node/', '/tmp/']
/** Single files allowed by EXACT path, not as a prefix: Docker's own empty marker (the first live
 *  run's only F2 hit). A prefix here would let /.dockerenv-anything through. */
export const SYSTEM_EXACT = ['/.dockerenv']
/** Names that mean fleet data reached the container. */
export const FLEET_MARKERS = /marveen|acropora|agents\/|store\/|\.env(\.|$)|token|secret|auth\.json|id_(rsa|ed25519)/i

/** The ids of the Groups/Uid/Gid lines of /proc/self/status. */
export function idsFromStatus(status) {
  // [ \t]*, not \s*: an empty Groups line (no supplementary group) must not run on into the next
  const line = (name) => (status.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm')) || [, ''])[1].trim().split(/\s+/).filter(Boolean).map(Number)
  return { uid: line('Uid'), gid: line('Gid'), groups: line('Groups') }
}

/** G0: the process runs as no fleet uid and in no fleet group. */
export function checkIds(ids) {
  const all = [...ids.uid, ...ids.gid, ...ids.groups]
  const hit = all.filter((n) => FLEET_IDS.includes(n))
  if (hit.length) return ['FAIL', `flotta-azonosito a folyamaton: ${[...new Set(hit)].join(',')}`]
  const other = [...new Set(all.filter((n) => n !== RUNNER_ID))]
  if (other.length || !ids.uid.length || !ids.gid.length) return ['FAIL', `az elvart ${RUNNER_ID}:${RUNNER_ID} helyett: ${other.join(',') || 'hianyzo Uid/Gid sor'}`]
  return ['OK', `uid es gid ${RUNNER_ID}, kiegeszito csoport: ${ids.groups.filter((n) => n !== RUNNER_ID).join(',') || 'nincs'}`]
}

/** CAP: no effective/permitted/bounding capability, and no_new_privs set. */
export function checkCaps(status) {
  const hex = (name) => (status.match(new RegExp(`^${name}:\\s*([0-9a-f]+)`, 'm')) || [, null])[1]
  const nnp = (status.match(/^NoNewPrivs:\s*(\d)/m) || [, null])[1]
  const bad = ['CapEff', 'CapPrm', 'CapBnd'].filter((k) => hex(k) == null || /[1-9a-f]/.test(hex(k)))
  if (bad.length || nnp !== '1') return ['FAIL', `kepesseg: ${bad.map((k) => `${k}=${hex(k)}`).join(' ') || 'nulla'}; NoNewPrivs=${nnp}`]
  return ['OK', 'CapEff, CapPrm, CapBnd nulla; NoNewPrivs=1']
}

/** F2: readable regular files outside the system prefixes, or with a fleet marker anywhere. */
export function classifyReadable(paths) {
  const outside = paths.filter((p) => !SYSTEM_EXACT.includes(p) && !SYSTEM_PREFIXES.some((pre) => p.startsWith(pre)))
  const marked = paths.filter((p) => FLEET_MARKERS.test(p) && !p.startsWith('/proc/') && !p.startsWith('/sys/') && !p.startsWith('/usr/') && !p.startsWith('/app/'))
  return { outside, marked }
}

/** N1: the negative network tests count only when the control reached the outside. */
export function judgeNetwork(results, control) {
  const answered = results.filter((r) => r.open)
  if (answered.length) return ['FAIL', `valaszolt: ${answered.map((r) => `${r.host}:${r.port}`).join(', ')}`]
  if (!control.open) return ['NEM_MERHETO', `a kontroll (${control.host}:${control.port}) sem ert ki, igy a negativ probak nem bizonyitanak`]
  return ['OK', `${results.length} probalt cim:port egyike sem valaszolt; a kontroll (${control.host}:${control.port}) kiert`]
}

/** N1's targets: every host-side address (gateway, the host's own) and every fleet address,
 *  each with HOST_PORTS; the same address only once. */
export function networkTargets(gateway, hostAddrs, fleetAddrs) {
  const hosts = [...new Set([...(gateway ? [gateway] : []), ...hostAddrs, ...fleetAddrs])]
  return hosts.flatMap((host) => HOST_PORTS.map((port) => ({ host, port })))
}

export function summarize(lines) {
  const n = (s) => lines.filter((l) => l[1] === s).length
  return { ok: n('OK'), fail: n('FAIL'), nem: n('NEM_MERHETO') }
}

// ---------------------------------------------------------------- live side (inside the container)

function tcpOpen(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (open) => { s.destroy(); resolve({ host, port, open }) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

function gatewayIp() {
  try {
    for (const l of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = l.trim().split(/\s+/)
      if (f[1] === '00000000' && f[2]) return f[2].match(/../g).reverse().map((h) => parseInt(h, 16)).join('.')
    }
  } catch { /* no route table */ }
  return null
}

function walkReadable(root, out, skip) {
  let entries
  try { entries = readdirSync(root) } catch { return }
  for (const e of entries) {
    const p = join(root, e)
    if (skip.some((s) => p === s || p.startsWith(s + '/'))) continue
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walkReadable(p, out, skip)
    else if (st.isFile()) { try { accessSync(p, constants.R_OK); out.push(p) } catch { /* not readable */ } }
  }
}

function run(cmd, args) {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` } }
}

export async function main() {
  const lines = []
  const say = (id, verdict, detail) => { lines.push([id, verdict, detail]); console.log(`PROBA ${id} ${verdict} ${detail}`) }
  const status = readFileSync('/proc/self/status', 'utf8')

  say('G0', ...checkIds(idsFromStatus(status)))
  say('CAP', ...checkCaps(status))

  // read-only root: writes outside /tmp must fail; the control is a write into /tmp
  const roTargets = ['/app/proba-iras', '/etc/proba-iras', '/proba-iras']
  const written = roTargets.filter((p) => { try { writeFileSync(p, 'x'); rmSync(p); return true } catch { return false } })
  let tmpOk = false
  try { writeFileSync('/tmp/proba-iras', 'x'); rmSync('/tmp/proba-iras'); tmpOk = true } catch { /* tmpfs missing */ }
  say('RO', written.length ? 'FAIL' : tmpOk ? 'OK' : 'NEM_MERHETO', written.length ? `irhato: ${written.join(', ')}` : tmpOk ? 'a gyoker csak olvashato, a /tmp irhato (kontroll)' : 'a /tmp sem irhato, a kontroll nem fut')

  // F1: the fleet's paths do not exist here at all
  const fleetPaths = ['/home/marveen', '/opt/marveen-docker', '/opt/vegrehajto', '/var/run/docker.sock', '/run/supervisor.sock']
  const present = fleetPaths.filter((p) => existsSync(p))
  say('F1', present.length ? 'FAIL' : 'OK', present.length ? `letezik: ${present.join(', ')}` : `${fleetPaths.length} flotta-utvonal egyike sem letezik`)

  // F2: every readable file, no name filter; the canary in /tmp proves the walk can find one
  // PROBA_GYOKER: a test walks a temp tree instead of the whole file system
  const root = process.env.PROBA_GYOKER || '/'
  const canary = join(root === '/' ? '/tmp' : root, 'kanari-proba.txt')
  writeFileSync(canary, 'kanari', { mode: 0o644 })
  const found = []
  walkReadable(root, found, ['/proc', '/sys', '/dev'])
  rmSync(canary, { force: true })
  const { outside, marked } = classifyReadable(found)
  if (!found.includes(canary)) say('F2', 'NEM_MERHETO', 'a bejaras a sajat kanarijat sem talalta meg')
  else if (outside.length || marked.length) say('F2', 'FAIL', `rendszeren kivul ${outside.length}, flotta-jelzesu ${marked.length}: ${[...outside, ...marked].slice(0, 8).join(', ')}`)
  else say('F2', 'OK', `${found.length} olvashato fajl, mind rendszer-utvonalon; a kanarit megtalalta`)

  // H1: no credential of any kind (Balázs: none until his separate approval)
  const secretEnv = Object.keys(process.env).filter((k) => /TOKEN|SECRET|KEY|PASS|AUTH/i.test(k))
  const secretFiles = ['/run/secrets', join(process.env.HOME || '/nonexistent', '.codex', 'auth.json')].filter((p) => existsSync(p) && (lstatSync(p).isFile() || readdirSync(p).length))
  say('H1', secretEnv.length || secretFiles.length ? 'FAIL' : 'OK', secretEnv.length || secretFiles.length ? `titok-nevu kornyezet: ${secretEnv.join(',') || '-'}; fajl: ${secretFiles.join(',') || '-'}` : 'nincs titok-nevu kornyezeti valtozo, /run/secrets es auth.json nincs')

  // V1: no way to drive the fleet: no sudo, no control sockets (F1 covers docker/supervisor)
  const sudo = run('sh', ['-c', 'command -v sudo || true']).out.trim()
  const tmux = readdirSync('/tmp').filter((e) => e.startsWith('tmux-'))
  say('V1', sudo || tmux.length ? 'FAIL' : 'OK', sudo || tmux.length ? `sudo: ${sudo || '-'}; tmux: ${tmux.join(',') || '-'}` : 'nincs sudo, nincs tmux-socket')

  // PROBA_CSAK_HELYI=1 (tests): no network and no Codex, only the local checks
  if (process.env.PROBA_CSAK_HELYI === '1') {
    say('N1', 'NEM_MERHETO', 'PROBA_CSAK_HELYI: a halozati proba kihagyva')
    const s = summarize(lines)
    console.log(`OSSZESITES ok=${s.ok} fail=${s.fail} nem_merheto=${s.nem}`)
    process.exitCode = s.fail > 0 ? 1 : 0
    return
  }

  // N1: the fleet's services do not answer; the control (the vendor's API) does
  const gw = gatewayIp()
  const fleetHosts = (process.env.PROBA_FLOTTA_CIMEK || '').split(',').map((s) => s.trim()).filter(Boolean)
  const names = (process.env.PROBA_FLOTTA_NEVEK || 'marveen,vegrehajto,host.docker.internal').split(',').map((s) => s.trim()).filter(Boolean)
  const resolved = []
  for (const n of names) { try { resolved.push(...(await dns.lookup(n, { all: true })).map((a) => a.address)) } catch { /* not resolvable: that is the point */ } }
  // the host's own addresses (public, tailnet), for the host-side firewall (PROBA_GEP_CIMEK)
  const hostAddrs = (process.env.PROBA_GEP_CIMEK || '').split(',').map((s) => s.trim()).filter(Boolean)
  const tries = await Promise.all(networkTargets(gw, hostAddrs, [...fleetHosts, ...resolved]).map((t) => tcpOpen(t.host, t.port)))
  const control = await tcpOpen('api.openai.com', 443, 5000)
  say('N1', ...judgeNetwork(tries, control))
  say('N1-CIMEK', 'OK', `atjaro ${gw || '-'}; gep-cimek ${hostAddrs.join(',') || '- (PROBA_GEP_CIMEK ures)'}; portok ${HOST_PORTS.join(',')}; flotta-cimek ${fleetHosts.join(',') || '- (PROBA_FLOTTA_CIMEK ures)'}; nevfeloldas: ${resolved.join(',') || 'egyik nev sem oldodott fel'}`)
  if (!fleetHosts.length) say('N1-FLOTTA', 'NEM_MERHETO', 'a flotta konteneranak cimei nincsenek megadva (PROBA_FLOTTA_CIMEK), csak az atjarot es a neveket probaltam')

  // VER: the installed Codex is the pinned one
  const ver = run('codex', ['--version'])
  say('VER', ver.code === 0 && ver.out.includes(PINNED_CODEX) ? 'OK' : 'FAIL', `codex --version: ${ver.out.trim().split('\n')[0] || `kilepes ${ver.code}`}; rogzitett: ${PINNED_CODEX}`)

  await codexSandboxChecks(say, run)

  const s = summarize(lines)
  console.log(`OSSZESITES ok=${s.ok} fail=${s.fail} nem_merheto=${s.nem}`)
  process.exitCode = s.fail > 0 ? 1 : 0
}

/** The inner command for V2: prints a marker first, so a sandbox that never started the command
 *  (no output marker) is told apart from one that ran it and blocked the network. */
export const NET_PROBE = ['node', '-e', "process.stdout.write('BELUL\\n');const s=require('net').connect(443,'api.openai.com');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3));setTimeout(()=>process.exit(4),5000)"]
export const WRITE_PROBE = ['sh', '-c', 'echo BELUL; echo x > "$HOME/proba-homokozo-iras" && echo IRT']

/** The vendor documents the CLI surface as `codex sandbox` with the backend picked by the OS
 *  (bubblewrap + seccomp on Linux), not the exact arguments; both forms are tried and the help
 *  text is logged, so the run itself says which form the installed version takes. */
export const SANDBOX_FORMS = [['sandbox', '--'], ['sandbox', 'linux', '--']]

/** One network attempt inside the sandbox -> 'usage' (the form is wrong), 'never-started' (no
 *  marker: the sandbox did not run the command), 'allowed' (the inner connect exited 0) or
 *  'blocked' (it ran and could not connect). */
export function judgeSandboxRun(r) {
  if (!r.out.includes('BELUL')) return /usage:|unexpected argument|unrecognized|invalid value/i.test(r.out) ? 'usage' : 'never-started'
  return r.code === 0 ? 'allowed' : 'blocked'
}

/** V2 and V3: Codex's own sandbox, measured on the installed version (Balázs, condition 4). */
export async function codexSandboxChecks(say, run) {
  const help = run('codex', ['sandbox', '--help'])
  for (const l of help.out.split('\n').filter(Boolean).slice(0, 40)) console.log(`PROBA-NAPLO codex-sandbox-help ${l}`)
  const outside = run(NET_PROBE[0], NET_PROBE.slice(1))
  let measured = false
  for (const form of SANDBOX_FORMS) {
    const net = run('codex', [...form, ...NET_PROBE])
    const v = judgeSandboxRun(net)
    console.log(`PROBA-NAPLO codex ${form.join(' ')} <halozat> kilepes=${net.code} itelet=${v} kimenet=${net.out.replace(/\s+/g, ' ').slice(0, 300)}`)
    if (v === 'usage') continue
    measured = true
    if (v === 'never-started') say('V2', 'NEM_MERHETO', `a homokozo nem inditotta el a parancsot ebben a kontenerben (\`codex ${form.join(' ')}\`); kimenet: ${net.out.replace(/\s+/g, ' ').slice(0, 200)}`)
    else if (outside.code !== 0) say('V2', 'NEM_MERHETO', `a homokozon kivul sem ert ki (kontroll kilepes ${outside.code}), a tiltas nem bizonyit`)
    else say('V2', v === 'blocked' ? 'OK' : 'FAIL', v === 'blocked' ? `a homokozoban a halozat tiltva (kilepes ${net.code}), kivul kiert (kontroll)` : 'a homokozoban a parancs kiert a halozatra')
    const wr = run('codex', [...form, ...WRITE_PROBE])
    console.log(`PROBA-NAPLO codex ${form.join(' ')} <iras> kilepes=${wr.code} kimenet=${wr.out.replace(/\s+/g, ' ').slice(0, 300)}`)
    if (!wr.out.includes('BELUL')) say('V2-IRAS', 'NEM_MERHETO', 'a homokozo nem inditotta el az irasi probat')
    else say('V2-IRAS', wr.out.includes('IRT') ? 'FAIL' : 'OK', wr.out.includes('IRT') ? 'a homokozobol irhato a home' : 'a homokozobol a home nem irhato (alapertelmezett mod)')
    break
  }
  if (!measured) say('V2', 'NEM_MERHETO', 'egyik homokozo-parancsforma sem ismert ezen a verzion; a sugot a PROBA-NAPLO sorok tartalmazzak')
  const execHelp = run('codex', ['exec', '--help'])
  for (const l of execHelp.out.split('\n').filter(Boolean).slice(0, 60)) console.log(`PROBA-NAPLO codex-exec-help ${l}`)
  say('V3', 'NEM_MERHETO', 'a parancsfuttato eszkoz kikapcsolasa csak belepett modellel merheto (a belepes nincs engedelyezve); a codex exec kapcsoloi a PROBA-NAPLO sorokban')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
