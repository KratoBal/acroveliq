// The GPT debate package and its filters (src/gpt-package.ts, scripts/gpt-csomag/hatar.py; task
// t-20261014-gpt-futtato-kontener, the multi-model plan's PR 2). WHAT TURNS THIS RED:
//   - anything but this debate's owner messages and the controller's answered turns goes out;
//   - a secret shape or a fleet token value (in a message, the topic or the ask) is sent, or the
//     thread is told its content instead of which piece it was;
//   - a name, an e-mail or a phone number leaves unredacted; the leak gate red, the redactor
//     failing, silent or slow still lets the package out (a fall back to the raw text);
//   - the size limit drops the newest instead of the oldest, or drops without saying so;
//   - the log holds the package's text;
//   - GPT's answer with a secret in it is allowed out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getDb, initDatabase } from '../db.js'
import { getDebate, type Debate } from '../debates.js'
import { GptBlocked, PARTICIPANT_NAMES, buildPackage, debatePieces, envSecretValues, maskInternalIpv4, outputAllowed, secretIn, type PackageOptions } from '../gpt-package.js'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'gpt-csomag', 'hatar.py')
// broken on purpose so the repository's own secret gate does not see a token in this file
const GH = ['gh', 'p_', 'A'.repeat(36)].join('')

let dir: string
let jevEnv: Record<string, string>

function gateStatus(ok = true): string {
  const r = spawnSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'jev'))}); import leak_gate, redact; print(leak_gate.code_hash(), redact.REDACTION_VERSION)`], {
    env: { PATH: '/usr/bin:/bin', ...jevEnv }, encoding: 'utf8',
  })
  const [hash, version] = r.stdout.trim().split(' ')
  const f = join(dir, 'gate.json')
  writeFileSync(f, JSON.stringify({ redaction_version: version, code_hash: ok ? hash : '0'.repeat(64), leaks: 0 }))
  return f
}

function opts(o: Partial<PackageOptions> = {}, boundaryEnv: Record<string, string> = {}): PackageOptions {
  return {
    storeDir: join(dir, 'store'),
    logDir: join(dir, 'logs'),
    boundary: { python: 'python3', script: SCRIPT, env: { ...jevEnv, JEV_LEAK_GATE_STATUS: gateStatus(), ...boundaryEnv }, timeoutMs: 20_000 },
    maxBytes: 32 * 1024,
    ...o,
  }
}

function debate(id = 'v1', topic = 'Hogyan legyen a számlázás?'): Debate {
  getDb().prepare(`INSERT INTO debates (id, project, thread_id, topic, start_message_id, status, gpt_invited, phase, phase_started_at, created_by, created_at, updated_at)
                   VALUES (?, 'os', 't', ?, ?, 'fut', 1, 1, 100, 'o', 100, 100)`).run(id, topic, `s-${id}`)
  return getDebate(getDb(), id)!
}
const owner = (d: string, id: string, text: string, at: number) =>
  getDb().prepare('INSERT INTO debate_owner_messages (message_id, debate_id, text, at) VALUES (?, ?, ?, ?)').run(id, d, text, at)
const turn = (d: string, speaker: string, status: string, text: string | null, at: number, round = 1, kind = 'turn') =>
  getDb().prepare(`INSERT INTO debate_turns (debate_id, phase, round, speaker, kind, status, text, created_at, answered_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d, round, speaker, kind, status, text, at, at)
const logLines = () => readdirSync(join(dir, 'logs')).flatMap((f) => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Record<string, unknown>)
/** A boundary that only notes it was called: proves a blocked package never reached it. */
function fakeBoundary(body: string): PackageOptions['boundary'] {
  const f = join(dir, 'fake.py')
  writeFileSync(f, `import sys, json\nopen(${JSON.stringify(join(dir, 'boundary-called'))}, 'w').write('x')\n${body}\n`)
  return { python: 'python3', script: f, timeoutMs: 3000 }
}

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'gpt-csomag-'))
  mkdirSync(join(dir, 'store'))
  // the JEV redactor's local lists: none here (missing is allowed, layer B still runs)
  jevEnv = { JEV_KNOWN_ENTITIES: join(dir, 'nincs-known.json'), JEV_COMMON_WORDS: join(dir, 'nincs-common.txt') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('what goes out', () => {
  it('PKG-SOURCE: only this debate, only the owner and the answered turns, in time order', () => {
    const d = debate()
    debate('masik')
    owner('v1', 'm1', 'első kérdés', 110)
    turn('v1', 'acrobot', 'answered', 'Acrobot válasza', 120)
    turn('v1', 'gpt', 'answered', 'GPT válasza', 130)
    owner('v1', 'm2', 'második', 140)
    for (const s of ['open', 'skipped', 'blocked', 'running', 'failed', 'late', 'expired']) turn('v1', 'gpt', s, `nem mehet ki (${s})`, 150)
    owner('masik', 'x1', 'más vita', 115)
    turn('masik', 'acrobot', 'answered', 'más vita válasza', 125)
    expect(debatePieces(getDb(), d).map((p) => [p.who, p.label, p.text])).toEqual([
      ['gazda', 'Balázs 1. üzenete', 'első kérdés'],
      ['acrobot', 'Acrobot 1. körös válasza', 'Acrobot válasza'],
      ['gpt', 'GPT 1. körös válasza', 'GPT válasza'],
      ['gazda', 'Balázs 2. üzenete', 'második'],
    ])
  })
})

describe('filter 1: secrets', () => {
  it('PKG-SECRET: a secret shape in a message blocks it before the boundary is called; the thread is told which message, not its content', async () => {
    const d = debate()
    owner('v1', 'm1', 'rendben', 110)
    owner('v1', 'm2', `itt a kulcs: ${GH}`, 120)
    const err = await buildPackage(getDb(), d, 'kérdés', opts({ boundary: fakeBoundary('print(json.dumps({"ok": True, "text": "x"}))') })).catch((e) => e)
    expect([err instanceof GptBlocked, (err as GptBlocked).publicMessage.includes('Balázs 2. üzenete titok-alakot tartalmaz'), (err as GptBlocked).publicMessage.includes(GH), existsSync(join(dir, 'boundary-called'))]).toEqual([true, true, false, false])
    expect(logLines().map((l) => [l.result, JSON.stringify(l).includes(GH)])).toEqual([['titok', false]])
  })

  it('PKG-KNOWN-VALUE: a fleet token VALUE (not a known shape) in an answer, the topic or the ask blocks too', async () => {
    const value = 'q7Rk2LmZ8vT4xW1nB6yH3cJ9sD0fG5pA'
    writeFileSync(join(dir, 'store', '.dashboard-token'), `${value}\n`)
    mkdirSync(join(dir, 'store', 'tokens'))
    writeFileSync(join(dir, 'store', 'tokens', 'acrobot.token'), 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2')
    expect([secretIn(`ez ${value} az`, [value]), secretIn('semmi', [value])]).toEqual(['a flotta egyik tokenje', null])
    const cases: [string, () => void, string][] = [
      ['answer', () => turn('v1', 'acrobot', 'answered', `a token: ${value}`, 120), 'Acrobot 1. körös válasza'],
      ['agent token', () => owner('v1', 'm9', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2', 120), 'Balázs 1. üzenete'],
      ['ask', () => {}, 'A GPT-nek szóló kérés'],
    ]
    for (const [name, add, label] of cases) {
      initDatabase(':memory:')
      const d = debate()
      add()
      const err = await buildPackage(getDb(), d, name === 'ask' ? `nézd: ${value}` : 'kérdés', opts({ boundary: fakeBoundary('print(json.dumps({"ok": True, "text": "x"}))') })).catch((e) => e)
      expect([name, err instanceof GptBlocked, (err as GptBlocked).publicMessage.includes(label), (err as GptBlocked).publicMessage.includes(value)]).toEqual([name, true, true, false])
    }
  })

  it('PKG-OUTPUT: GPT\'s answer with a secret shape or a fleet token is not allowed out; a plain answer is', () => {
    writeFileSync(join(dir, 'store', '.gpt-futtato-token'), 'Mm3Nn4Bb5Vv6Cc7Xx8Zz9Ll0Kk1')
    const s = { storeDir: join(dir, 'store') }
    expect([outputAllowed('Szerintem így jobb.', s), outputAllowed(`kulcs ${GH}`, s), outputAllowed('Mm3Nn4Bb5Vv6Cc7Xx8Zz9Ll0Kk1', s)]).toEqual([true, false, false])
  })

  it('PKG-ENV-VALUES: the VALUES of the dashboard .env secret-named settings are compared too; other settings and short values are not (barracuda, #149)', async () => {
    const env = join(dir, 'dot.env')
    writeFileSync(env, ['DISCORD_BOT_TOKEN="Dq1Wr2Te3Yu4Io5Pa6Sd7Fg8"', 'export OPENAI_API_KEY=Kk9Jj8Hh7Gg6Ff5Dd4Ss3', 'SCHEDULER_TZ=Europe/Budapest/Hosszu_Ertek', 'SHORT_SECRET=rovid', '# KOMMENT_TOKEN=Zz1Xx2Cc3Vv4Bb5Nn6Mm7'].join('\n'))
    expect(envSecretValues(env)).toEqual(['Dq1Wr2Te3Yu4Io5Pa6Sd7Fg8', 'Kk9Jj8Hh7Gg6Ff5Dd4Ss3'])
    const d = debate()
    owner('v1', 'm1', 'a bot tokenje: Dq1Wr2Te3Yu4Io5Pa6Sd7Fg8', 110)
    const err = await buildPackage(getDb(), d, 'kérdés', opts({ envFile: env, boundary: fakeBoundary('print(json.dumps({"ok": True, "text": "x"}))') })).catch((e) => e)
    expect([err instanceof GptBlocked, existsSync(join(dir, 'boundary-called')), outputAllowed('ez Kk9Jj8Hh7Gg6Ff5Dd4Ss3', { storeDir: join(dir, 'store'), envFile: env })]).toEqual([true, false, false])
  })

  it('PKG-INTERNAL-IP: an internal IPv4 the redactor left (at a sentence end, with a port) leaves only as a stable placeholder; a public one stays', async () => {
    expect(maskInternalIpv4('A 10.0.2.4. És 10.0.2.4:8790, 192.168.250.1; 100.117.177.56. Publikus: 162.55.216.28. Nem cím: 110.0.2.45, v10.0.2.4.5')).toEqual({
      // a doubtful shape (a version-like v10.0.2.4.5) is masked too: the safe direction
      text: 'A <BELSO_IP_1>. És <BELSO_IP_2>, <BELSO_IP_3>; <BELSO_IP_4>. Publikus: 162.55.216.28. Nem cím: 110.0.2.45, v<BELSO_IP_1>.5', count: 4,
    })
    const d = debate()
    owner('v1', 'm1', 'A gép címe 10.0.2.4.', 110)
    const pkg = await buildPackage(getDb(), d, 'kérdés', opts())
    expect([pkg.prompt.includes('10.0.2.4'), /<BELSO_IP_1>|<ID_\d+>/.test(pkg.prompt)]).toEqual([false, true])
  })

  it('PKG-LATE-SECRET: a secret in what the boundary returns (the last look) blocks too', async () => {
    const d = debate()
    owner('v1', 'm1', 'szia', 110)
    const err = await buildPackage(getDb(), d, 'kérdés', opts({ boundary: fakeBoundary(`print(json.dumps({"ok": True, "text": "x ${GH}", "counts": {}}))`) })).catch((e) => e)
    expect([err instanceof GptBlocked, String((err as GptBlocked).reason)]).toEqual([true, expect.stringContaining('secret after redaction')])
  })
})

describe('filter 2: personal data (the JEV boundary, full mode)', () => {
  it('PKG-REDACT: a name, an e-mail and a phone number do not leave; placeholders do; the log has the hash and size, never the text', async () => {
    const d = debate()
    owner('v1', 'm1', 'Kovács Péter telefonja +36 30 123 4567, e-mail kovacs.peter@pelda.hu, ő kérdezte. A 10.0.2.4 címen fut.', 110)
    turn('v1', 'acrobot', 'answered', 'Megnéztem, Kovács Péter ügye a szerviz menübe tartozik.', 120)
    const pkg = await buildPackage(getDb(), d, 'Mit javasolsz?', opts())
    // the FULL mode: a technical id is masked too (the keeping mode is narrowed to another task, PD-006)
    for (const leak of ['Kovács', 'Péter', '4567', 'kovacs.peter', 'pelda.hu', '10.0.2.4']) expect([leak, pkg.prompt.includes(leak)]).toEqual([leak, false])
    expect([/<PERSON_1>/.test(pkg.prompt), /<PHONE_1>/.test(pkg.prompt), /<EMAIL_1>/.test(pkg.prompt), pkg.prompt.includes('Mit javasolsz?')]).toEqual([true, true, true, true])
    const log = logLines()
    expect(log.map((l) => [l.result, typeof l.sha256, l.bytes === Buffer.byteLength(pkg.prompt)])).toEqual([['kiment', 'string', true]])
    expect(JSON.stringify(log).includes('Kovács') || JSON.stringify(log).includes('szerviz')).toBe(false)
  })

  // acrobot 31072: in the first live debate GPT called the owner <PERSON_1>
  it('PKG-PARTICIPANTS: the participants keep their names, inflected and unaccented too; every other person masks, a namesake whole', async () => {
    const d = debate()
    owner('v1', 'm1', 'Balázsnak írtam, Balazs is látta, Acrobottal egyeztettem, a GPT-nek is. Kovács Péter is ott volt, és Kovács Balázs, meg Balázs Nagy.', 110)
    // a namesake in a list (comma) and across a line break (barracuda, #181 review)
    owner('v1', 'm2', 'Névsor: Szabó, Balázs; Tóth\nBalázs.', 115)
    turn('v1', 'acrobot', 'answered', 'Balázzsal megbeszéltem.', 120)
    const pkg = await buildPackage(getDb(), d, 'Mit javasolsz?', opts())
    const kept = ['[gazda] Balázs, a döntéshozó', '[acrobot] Acrobot', 'Balázsnak írtam', 'Balazs is látta', 'Acrobottal', 'GPT-nek', 'Balázzsal megbeszéltem']
    const gone = ['Kovács', 'Péter', 'Nagy', 'Szabó', 'Tóth']
    expect([
      kept.filter((k) => !pkg.prompt.includes(k)),
      gone.filter((g) => pkg.prompt.includes(g)),
      // the namesake (Kovács Balázs, Balázs Nagy) is not half-shown
      /<PERSON_\d+>[ \t,]*\n?[ \t]*Balázs|Balázs[ \t,]*\n?[ \t]*<PERSON_\d+>/.test(pkg.prompt),
      /Kivetel[a-z]{12}/.test(pkg.prompt),
    ], 'PKG-PARTICIPANTS').toEqual([[], [], false, false])
  })

  // barracuda, #181 review; acrobot 31140: hatar.py now shapes what the redactor sees
  it('PKG-GATE-KEEPING: the leak gate hashes hatar.py and runs its suite through the keeping path with the same names', () => {
    const jev = JSON.stringify(join(ROOT, 'scripts', 'jev'))
    const code = `import sys, json, os, shutil, tempfile; sys.path.insert(0, ${jev})
import leak_gate, hatar
names = list(hatar.PARTICIPANTS)
listed = '../gpt-csomag/hatar.py' in leak_gate.CODE_FILES
before = leak_gate.code_hash()
# a hatar.py with one byte more must give another hash (a copy, the real file untouched)
tmp = tempfile.mkdtemp()
jevcopy = os.path.join(tmp, 'jev'); gptcopy = os.path.join(tmp, 'gpt-csomag')
shutil.copytree(leak_gate._HERE, jevcopy); shutil.copytree(os.path.dirname(hatar.__file__), gptcopy)
open(os.path.join(gptcopy, 'hatar.py'), 'a').write('\\n')
leak_gate._HERE = jevcopy
after = leak_gate.code_hash()
leak_gate._HERE = os.path.dirname(os.path.abspath(leak_gate.__file__))
# the keeping path is what the third run measures. Without the common-words list (this test's
# environment) full mode itself leaks two sentence-initial surnames; the keeping path must leak
# exactly what full mode leaks, and one that keeps the raw text leaks more
_, full_leaks, _, _, _ = leak_gate.run()
_, ok_leaks, _, _, _ = leak_gate.run(keep_names=hatar.PARTICIPANTS)
hatar.redact_keeping = lambda t, k: ({"text": t}, {})
_, bad_leaks, _, _, _ = leak_gate.run(keep_names=hatar.PARTICIPANTS)
same = sorted((c, x) for c, x, _ in ok_leaks) == sorted((c, x) for c, x, _ in full_leaks)
print(json.dumps([names, listed, before != after, same, len(bad_leaks) > len(full_leaks)]))`
    const r = spawnSync('python3', ['-I', '-B', '-c', code], { env: { PATH: '/usr/bin:/bin', ...jevEnv }, encoding: 'utf8' })
    expect(JSON.parse(r.stdout || 'null'), r.stderr).toEqual([[...PARTICIPANT_NAMES], true, true, true, true])
  })

  it('PKG-GATE-MAIN: the gate is red when only the keeping path leaks, and a green status names the participants run', () => {
    const status = join(dir, 'gate-main.json')
    const code = `import sys, json, os; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'jev'))})
import leak_gate
real = leak_gate.run
def fake(verbose=False, path=leak_gate.SUITE, keep_kinds=(), keep_names=()):
    suite = leak_gate.load_suite(path)
    leaks = [("x", "y", "z")] if (keep_names and LEAK) else []
    return suite, leaks, [], 1, 1
leak_gate.run = fake
LEAK = True
red = leak_gate.main()
red_file = os.path.exists(os.environ["JEV_LEAK_GATE_STATUS"])
LEAK = False
green = leak_gate.main()
st = json.load(open(os.environ["JEV_LEAK_GATE_STATUS"]))
print(json.dumps([red, red_file, green, st.get("participants", {}).get("names"), st.get("participants", {}).get("leaks")]))`
    const r = spawnSync('python3', ['-I', '-B', '-c', code], { env: { PATH: '/usr/bin:/bin', ...jevEnv, JEV_LEAK_GATE_STATUS: status }, encoding: 'utf8' })
    expect(JSON.parse(r.stdout.trim().split('\n').pop() || 'null'), r.stderr).toEqual([1, false, 0, [...PARTICIPANT_NAMES], 0])
  })

  it('PKG-KEEP-SHAPE: the boundary refuses a keep list that is not a few single capitalised words', () => {
    const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'gpt-csomag'))})
import hatar
hatar.gate_green = lambda: True
print(json.dumps([hatar.decide("Kovács Péter írt.", k)["ok"] for k in (["Kovács Péter"], ["kovacs"], ["A1b"], ["Kovács@x"], ["A", "Bb", "Cc", "Dd", "Ee", "Ff"], "Balázs", ["Balázs"])]))`
    const r = spawnSync('python3', ['-I', '-c', code], { env: { PATH: '/usr/bin:/bin', ...jevEnv }, encoding: 'utf8' })
    expect(JSON.parse(r.stdout), 'PKG-KEEP-SHAPE').toEqual([false, false, false, false, false, false, true])
  })

  it('PKG-GATE-RED: the leak gate not green for this redactor code: blocked, never the raw text', async () => {
    const d = debate()
    owner('v1', 'm1', 'Kovács Péter kérdezte.', 110)
    const o = opts()
    o.boundary.env = { ...o.boundary.env, JEV_LEAK_GATE_STATUS: gateStatus(false) }
    const err = await buildPackage(getDb(), d, 'kérdés', o).catch((e) => e)
    expect([err instanceof GptBlocked, String((err as GptBlocked).reason)]).toEqual([true, expect.stringContaining('szivargas-kapu')])
  })

  it('PKG-GUARD: when the redaction leaves a personal shape behind, the boundary\'s runtime guard refuses (a redactor bug does not leak)', () => {
    // the real boundary module, with its redact() made to leave an e-mail in: decide() must refuse
    const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'gpt-csomag'))})
import hatar
hatar.redact.redact = lambda t: {"text": "irj ide: kovacs@pelda.hu", "version": hatar.redact.REDACTION_VERSION, "counts": {}}
print(json.dumps(hatar.decide("x")))`
    const r = spawnSync('python3', ['-I', '-c', code], { env: { PATH: '/usr/bin:/bin', ...jevEnv, JEV_LEAK_GATE_STATUS: gateStatus() }, encoding: 'utf8' })
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, why: expect.stringContaining('maradt: EMAIL') })
  })

  it('PKG-BOUNDARY-FAIL: the boundary failing, answering garbage, refusing, or silent past its time: blocked every time', async () => {
    for (const body of ['sys.exit(3)', 'print("nem json")', 'print(json.dumps({"ok": False, "why": "x"}))', 'print(json.dumps({"ok": True, "text": ""}))', 'import time; time.sleep(10)']) {
      initDatabase(':memory:')
      const d = debate()
      owner('v1', 'm1', 'szia', 110)
      const err = await buildPackage(getDb(), d, 'kérdés', opts({ boundary: fakeBoundary(body) })).catch((e) => e)
      expect([body, err instanceof GptBlocked]).toEqual([body, true])
    }
    const err = await buildPackage(getDb(), debate('v2'), 'kérdés', opts({ boundary: { python: join(dir, 'nincs-python'), script: SCRIPT, timeoutMs: 3000 } })).catch((e) => e)
    expect(err instanceof GptBlocked).toBe(true)
  })
})

describe('filter 3: size', () => {
  it('PKG-SIZE: the OLDEST messages are left out, the package says it, and the thread is told; header and ask alone too long: blocked', async () => {
    const d = debate()
    for (let i = 1; i <= 8; i++) owner('v1', `m${i}`, `${i}. üzenet ${'x'.repeat(300)}`, 100 + i)
    const keep = Buffer.byteLength('x'.repeat(300)) * 3 + 900
    const pkg = await buildPackage(getDb(), d, 'kérdés', opts({ maxBytes: keep, boundary: fakeBoundary('t = json.loads(sys.stdin.read())["text"]\nprint(json.dumps({"ok": True, "text": t, "counts": {}}))') }))
    const kept = [...pkg.prompt.matchAll(/(\d)\. üzenet/g)].map((m) => Number(m[1]))
    expect([kept[kept.length - 1], kept[0]! > 1, pkg.prompt.includes(`a régebbi ${kept[0]! - 1} üzenet a méretkorlát miatt kimaradt`), pkg.notice]).toEqual([8, true, true, `A GPT-nek küldött csomagból a régebbi ${kept[0]! - 1} üzenet a méretkorlát miatt kimaradt.`])
    const err = await buildPackage(getDb(), d, 'k'.repeat(2000), opts({ maxBytes: 500 })).catch((e) => e)
    expect([err instanceof GptBlocked, String((err as GptBlocked).reason)]).toEqual([true, 'size'])
  })
})
