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
import { GptBlocked, buildPackage, debatePieces, outputAllowed, secretIn, type PackageOptions } from '../gpt-package.js'

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
    expect([outputAllowed('Szerintem így jobb.', join(dir, 'store')), outputAllowed(`kulcs ${GH}`, join(dir, 'store')), outputAllowed('Mm3Nn4Bb5Vv6Cc7Xx8Zz9Ll0Kk1', join(dir, 'store'))]).toEqual([true, false, false])
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
