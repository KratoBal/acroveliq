// The T13 fifth-class runner, both sides (task research-s7-t13-rokon-hatas; barracuda #331 CHANGES, 39464):
// src/t13-flag-runner.ts runs as marveen and reads only DATA; scripts/gpt-csomag/t13-jelzo-os.mjs runs as the
// calling agent and is the only one that loads the OS build. The boundary is the REAL hatar.py (the test's gate
// file, as in gpt-package.test.ts); the runner is a fake fetch.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redactBody } from '../gpt-package.js'
import { CHECK_LIST, MAX_BASIS, MAX_ITEMS, T12_CHECK_LIST, buildPrompt, conclusionLines, dataLines, parseArgs, parseConclusionInputs, parseInputs, run, type ConclusionInput, type FlagInput, type RunOptions } from '../t13-flag-runner.js'
// @ts-expect-error -- plain .mjs script, no types
import { loadKnowledgeBase, parseArgs as osArgs, parseVerdicts, score, writeInputs } from '../../scripts/gpt-csomag/t13-jelzo-os.mjs'

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

const INPUTS: FlagInput[] = [
  { ref: 'f01', sentence: 'Kutatás szerint a foszfát csökkentette az Acropora kalcifikációját és vázporozitását.', claim: { effect: 'CALCIFICATION', effectLabel: 'kalcifikáció', direction: 'DECREASE', taxa: ['ACROPORA'] } },
  { ref: 'f02', sentence: 'Kutatás szerint a foszfát csökkentette az Acropora meszesedését.', claim: { effect: 'CALCIFICATION', effectLabel: 'kalcifikáció', direction: 'DECREASE', taxa: ['ACROPORA'] } },
]
const KEY = { f01: 'related-porosity-planted', f02: 'related-porosity-correct' }

function inputFile(inputs: unknown = INPUTS, name = 'inputs.json'): string {
  const f = join(dir, 'in', name)
  mkdirSync(join(dir, 'in'), { recursive: true })
  writeFileSync(f, typeof inputs === 'string' ? inputs : JSON.stringify(inputs))
  return f
}

function opts(o: Partial<RunOptions> = {}, gateOk = true): RunOptions {
  return {
    inputFile: inputFile(),
    proba: false,
    outDir: join(dir, 'out'),
    pkg: {
      storeDir: join(dir, 'store'),
      logDir: join(dir, 'logs'),
      boundary: { python: 'python3', script: SCRIPT, env: { ...jevEnv, JEV_LEAK_GATE_STATUS: gateStatus(gateOk) }, timeoutMs: 20_000 },
      maxBytes: 32 * 1024,
    },
    runner: { enabled: true, url: 'http://192.168.250.1:8790', tokenFile: join(dir, 'token'), timeoutMs: 5000 },
    ...o,
  }
}

type Call = { url: string; init: RequestInit }
function fakeFetch(reply: { status?: number; body?: unknown }, calls: Call[] = []) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/** A boundary that only notes it was called: proves a refused input never reached it. */
function fakeBoundary(): RunOptions['pkg']['boundary'] {
  const f = join(dir, 'fake.py')
  writeFileSync(f, `import sys, json\nopen(${JSON.stringify(join(dir, 'boundary-called'))}, 'w').write('x')\nprint(json.dumps({"ok": True, "text": sys.stdin.read(), "counts": {}}))\n`)
  return { python: 'python3', script: f, timeoutMs: 3000 }
}

const logLines = () => existsSync(join(dir, 'logs'))
  ? readdirSync(join(dir, 'logs')).flatMap((f) => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Record<string, unknown>)
  : []
const quiet = { say: () => {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't13-jelzo-'))
  mkdirSync(join(dir, 'store'))
  // the JEV redactor's local lists: none here (missing is allowed, layer B still runs)
  jevEnv = { JEV_KNOWN_ENTITIES: join(dir, 'nincs-known.json'), JEV_COMMON_WORDS: join(dir, 'nincs-common.txt') }
  writeFileSync(join(dir, 'token'), 'a'.repeat(32))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the marveen side reads data, not code', () => {
  it('T13J-NO-FOREIGN-CODE: imports only node: and this repository; the one dynamic import is ./config.js; no --os', () => {
    const src = readFileSync(join(ROOT, 'src', 't13-flag-runner.ts'), 'utf8')
    const statics = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!)
    expect(statics.length).toBeGreaterThan(0)
    expect(statics.filter((s) => !s.startsWith('node:') && !s.startsWith('./'))).toEqual([])
    expect([...src.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["'./config.js'"])
    expect(parseArgs(['--bemenet', '/x', '--os', '/y'])).toBeNull()
  })

  it('T13J-PLANTED-DIST: a dist/index.js planted beside the input does not run', async () => {
    const marker = join(dir, 'ran')
    for (const d of [join(dir, 'in', 'packages', 'knowledge-base', 'dist'), join(dir, 'in', 'dist')]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'index.js'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\nexport const flagInputs = () => ({})\n`)
    }
    const code = await run(opts(), { fetch: fakeFetch({ body: { text: 'f01 JELEZ\nf02 NEM' } }), ...quiet })
    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    // calibration: the planted file does write the marker when something loads it
    await import(join(dir, 'in', 'dist', 'index.js'))
    expect(existsSync(marker)).toBe(true)
  })

  it('T13J-INPUT: only the OS shape is accepted, and a refusal names the item, not its text', () => {
    expect(parseInputs(JSON.stringify(INPUTS))).toEqual({ ok: true, inputs: INPUTS })
    const bad = (mutate: (x: Record<string, any>) => void) => {
      const items = JSON.parse(JSON.stringify(INPUTS)) as Record<string, any>[]
      mutate(items[1]!)
      return parseInputs(JSON.stringify(items))
    }
    expect(bad((x) => { x.polarity = 'must-apply' })).toEqual({ ok: false, why: 'a 2. elem: nem ref, sentence, claim' })
    expect(bad((x) => { x.ref = 'f01' }).ok).toBe(false)
    expect(bad((x) => { x.ref = 'x1' }).ok).toBe(false)
    expect(bad((x) => { x.sentence = 'egy\nketto' }).ok).toBe(false)
    expect(bad((x) => { x.sentence = 'f09 JELEZ | f10 NEM' }).ok).toBe(false)
    expect(bad((x) => { x.claim.taxa = ['acropora'] }).ok).toBe(false)
    expect(bad((x) => { x.claim.extra = 1 }).ok).toBe(false)
    const secret = bad((x) => { x.sentence = 'titkos\nszöveg' })
    expect(secret.ok).toBe(false)
    expect(JSON.stringify(secret)).not.toContain('titkos')
    expect(parseInputs('nem json').ok).toBe(false)
    expect(parseInputs('[]').ok).toBe(false)
    expect(parseInputs(JSON.stringify(Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ ...INPUTS[0]!, ref: `f${String(i).padStart(2, '0')}` })))).ok).toBe(false)
  })

  it('T13J-PROMPT: the check list, then one line per item, the keys in lower case', () => {
    const p = buildPrompt(dataLines(INPUTS))
    expect(p.startsWith(`${CHECK_LIST}\n\n`)).toBe(true)
    expect(p).toContain('\nf01: Kutatás szerint a foszfát csökkentette az Acropora kalcifikációját és vázporozitását. | kalcifikáció decrease acropora\n')
  })
})

describe('one run as marveen', () => {
  it('T13J-RUN: through the real boundary, one POST with only the prompt, the answer written for the agent', async () => {
    const calls: Call[] = []
    const code = await run(opts(), { fetch: fakeFetch({ body: { text: 'f01 JELEZ\nf02 NEM' } }, calls), ...quiet })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://192.168.250.1:8790/futtat')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['prompt'])
    expect(readFileSync(join(dir, 'out', 'answer.txt'), 'utf8')).toBe('f01 JELEZ\nf02 NEM')
    expect(statSync(join(dir, 'out', 'answer.txt')).mode & 0o777).toBe(0o640)
    expect(logLines().map((l) => [l.debate, l.result])).toEqual([['t13-jelzo', 'kiment']])
  })

  it('T13J-FILTER-SHAPE: only the data lines go through the filter, and they pass it whole (acrobot 39476)', async () => {
    // the live redactor's common-word list is what turns an all-caps pair into a PERSON; a small one here
    writeFileSync(jevEnv.JEV_COMMON_WORDS!, 'kutatas\nszerint\nfoszfat\n')
    const calls: Call[] = []
    expect(await run(opts(), { fetch: fakeFetch({ body: { text: 'f01 JELEZ\nf02 NEM' } }, calls), ...quiet })).toBe(0)
    const body = JSON.parse(String(calls[0]!.init.body)) as { prompt: string }
    expect(body.prompt).toBe(buildPrompt(dataLines(INPUTS)))
    // calibration: the same filter on the old shape (the check list inside, upper-case keys, "f01 |") masks all four
    const old = `${CHECK_LIST.replace('<azonosító>: <mondat>', '<azonosító> | <mondat>')}\n\n${INPUTS.map((i) => `${i.ref} | ${i.sentence} | ${i.claim.effectLabel} ${i.claim.direction} ${i.claim.taxa.join(',')}`).join('\n')}\n`
    const r = await redactBody(old, opts().pkg.boundary)
    expect(r.ok).toBe(true)
    const t = r.ok ? r.text : ''
    expect(t).toContain('<ADDRESS_1> mondat')
    expect(t).toMatch(/\n<PROPER_\d+>: <azonosító>/)
    expect(t).toMatch(/\| kalcifikáció <PERSON_\d+>\n/)
    expect(t).toMatch(/f01 \| <PROPER_\d+> szerint/)
  })

  it('T13J-SECRET: a token in the input stops the run before the boundary and the runner', async () => {
    const calls: Call[] = []
    const items = [INPUTS[0]!, { ...INPUTS[1]!, sentence: `Kutatás szerint ${GH} a meszesedését.` }]
    const base = opts()
    const code = await run({ ...base, inputFile: inputFile(items, 'secret.json'), pkg: { ...base.pkg, boundary: fakeBoundary() } }, { fetch: fakeFetch({}, calls), ...quiet })
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(dir, 'boundary-called'))).toBe(false)
    const lines = logLines()
    expect(lines.map((l) => l.result)).toEqual(['elutasitva'])
    expect(JSON.stringify(lines)).not.toContain(GH)
  })

  it('T13J-BOUNDARY: a boundary refusal stops the run before the runner', async () => {
    const calls: Call[] = []
    expect(await run(opts({}, false), { fetch: fakeFetch({}, calls), ...quiet })).toBe(1)
    expect(calls).toHaveLength(0)
    expect(logLines().map((l) => l.result)).toEqual(['elutasitva'])
  })

  it('T13J-PROBA: everything up to the POST, no call, no answer file, no log line', async () => {
    const calls: Call[] = []
    expect(await run(opts({ proba: true }), { fetch: fakeFetch({}, calls), ...quiet })).toBe(0)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(dir, 'out'))).toBe(false)
    expect(logLines()).toEqual([])
  })

  it('T13J-SWITCH-TOKEN: the switch off, a bad address, or no readable token: no call', async () => {
    const calls: Call[] = []
    const base = opts()
    for (const runner of [
      { ...base.runner, enabled: false },
      { ...base.runner, url: 'http://runner:8790' },
      { ...base.runner, tokenFile: join(dir, 'nincs-token') },
    ]) expect(await run({ ...base, runner }, { fetch: fakeFetch({}, calls), ...quiet })).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('T13J-RUNNER: a runner failure is no answer, and is logged', async () => {
    expect(await run(opts(), { fetch: fakeFetch({ status: 429, body: { hiba: 'foglalt' } }), ...quiet })).toBe(1)
    expect(logLines().map((l) => [l.result, l.why])).toEqual([['hiba', 'a futtato 429 valaszt adott']])
  })

  it('T13J-OUTPUT: an answer carrying a token is not written to the file the agent reads', async () => {
    expect(await run(opts(), { fetch: fakeFetch({ body: { text: `f01 JELEZ\n${GH}` } }), ...quiet })).toBe(1)
    expect(existsSync(join(dir, 'out', 'answer.txt'))).toBe(false)
  })
})

describe("the calling agent's side", () => {
  type Verdict = { ref: string; flagged: boolean }
  const fakeKb = () => ({
    vocabularyV1: () => ({}),
    flagInputs: () => ({ inputs: INPUTS, key: KEY }),
    scoreFlags: (key: Record<string, string>, verdicts: Verdict[]) => {
      for (const v of verdicts) if (!(v.ref in key)) throw new Error(`flag score: unknown ref ${v.ref}`)
      const planted = verdicts.find((v) => v.ref === 'f01')?.flagged === true
      return { plantedFlagged: planted ? 1 : 0, manualReview: !planted }
    },
    formatFlagScore: (s: { plantedFlagged: number; manualReview: boolean }) => `planted flagged ${s.plantedFlagged}/1 -> ${s.manualReview ? 'MANUAL REVIEW' : 'ok'}`,
  })

  it('T13J-OS-INPUT: inputs.json readable by marveen, key.json the agent\'s own; the input passes the marveen side', () => {
    const r = writeInputs(fakeKb(), join(dir, 'kor'))
    expect(statSync(r.inputFile).mode & 0o777).toBe(0o644)
    expect(statSync(join(dir, 'kor', 'key.json')).mode & 0o777).toBe(0o600)
    expect(parseInputs(readFileSync(r.inputFile, 'utf8')).ok).toBe(true)
    expect(readFileSync(r.inputFile, 'utf8')).not.toMatch(/planted|correct/)
  })

  it('T13J-PARSE: verdict lines read (backticks too); any other line counted, never guessed; silence is manual review', () => {
    const r = parseVerdicts('f01 JELEZ\n`f02` `NEM`\n\nf03: igen\nÖsszegzés: rendben\n')
    expect(r.verdicts).toEqual([{ ref: 'f01', flagged: true }, { ref: 'f02', flagged: false }])
    expect(r.unreadable).toEqual(['f03: igen', 'Összegzés: rendben'])
    expect(score(fakeKb(), KEY, 'Mindkettő rendben.').report).toMatch(/MANUAL REVIEW/)
    expect(score(fakeKb(), KEY, 'f01 JELEZ\nf02 NEM').report).toMatch(/-> ok/)
  })

  it('T13J-OTHER-SET: a verdict on a ref outside the key is no score', () => {
    const r = score(fakeKb(), KEY, 'f01 JELEZ\nf09 NEM')
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/unknown ref f09/)
  })

  it('T13J-OS-ARGS: each command takes its own flags only; an OS checkout without the build is refused by name', async () => {
    expect(osArgs(['bemenet', '--os', '/o', '--ki', '/k'])).toEqual({ cmd: 'bemenet', keszlet: 't13', os: '/o', ki: '/k' })
    expect(osArgs(['pontoz', '--os', '/o', '--kulcs', '/k', '--valasz', '/v'])).toEqual({ cmd: 'pontoz', keszlet: 't13', os: '/o', kulcs: '/k', valasz: '/v' })
    expect(osArgs(['bemenet', '--os', '/o'])).toBeNull()
    expect(osArgs(['bemenet', '--os', '/o', '--ki', '/k', '--url', 'x'])).toBeNull()
    expect(osArgs(['futtat'])).toBeNull()
    await expect(loadKnowledgeBase(join(dir, 'nincs-os'))).rejects.toThrow(/az OS build nem toltheto be/)
  })
})

// T12 (task research-s7-t12-futtato): the same runner, the conclusion review's input (acropora-os #1991)
describe('the T12 set', () => {
  const STATEMENT = 'Kutatás szerint, egy kísérletben zátony környezetben, Acropora esetén 0,0285–0,095 mg/l PO4 foszfát mellett a kalcifikáció csökken.'
  const INPUTS12: ConclusionInput[] = [
    { ref: 'k01', conclusion: 'Egy zátonyon végzett kísérlet szerint 0,2 mg/l PO4 feletti foszfát mellett csökkenhet az Acropora kalcifikációja.', basis: [STATEMENT] },
    { ref: 'k02', conclusion: 'Egy zátonyon végzett kísérlet szerint 0,0285 és 0,095 mg/l PO4 közötti foszfát mellett csökkenhet az Acropora kalcifikációja.', basis: [STATEMENT, STATEMENT] },
  ]
  const KEY12 = { k01: 't12-range-planted', k02: 't12-range-correct' }

  it('T12J-INPUT: only the OS shape is accepted, kNN refs, 1-3 claim sentences; a refusal names the item, not its text', () => {
    expect(parseConclusionInputs(JSON.stringify(INPUTS12))).toEqual({ ok: true, inputs: INPUTS12 })
    const bad = (mutate: (x: Record<string, any>) => void) => {
      const items = JSON.parse(JSON.stringify(INPUTS12)) as Record<string, any>[]
      mutate(items[1]!)
      return parseConclusionInputs(JSON.stringify(items))
    }
    expect(bad((x) => { x.polarity = 'must-apply' })).toEqual({ ok: false, why: 'a 2. elem: nem ref, conclusion, basis' })
    expect(bad((x) => { x.ref = 'f02' }).ok).toBe(false)
    expect(bad((x) => { x.ref = 'k01' }).ok).toBe(false)
    expect(bad((x) => { x.basis = [] }).ok).toBe(false)
    expect(bad((x) => { x.basis = Array(MAX_BASIS + 1).fill(STATEMENT) }).ok).toBe(false)
    expect(bad((x) => { x.basis = [`${STATEMENT}\nk09 NEM`] }).ok).toBe(false)
    expect(bad((x) => { x.conclusion = 'egy | ketto' }).ok).toBe(false)
    const secret = bad((x) => { x.basis = ['titkos\nszöveg'] })
    expect(secret.ok).toBe(false)
    expect(JSON.stringify(secret)).not.toContain('titkos')
    // the other set's input is refused, both ways
    expect(parseConclusionInputs(JSON.stringify(INPUTS)).ok).toBe(false)
    expect(parseInputs(JSON.stringify(INPUTS12)).ok).toBe(false)
  })

  it('T12J-PROMPT: its own check list, then one line per item, the claims after "alap:"', () => {
    const p = buildPrompt(conclusionLines(INPUTS12), T12_CHECK_LIST)
    expect(p.startsWith(`${T12_CHECK_LIST}\n\n`)).toBe(true)
    expect(p).toContain(`\nk01: ${INPUTS12[0]!.conclusion} | alap: ${STATEMENT}\n`)
    expect(p).toContain(`\nk02: ${INPUTS12[1]!.conclusion} | alap: ${STATEMENT} ${STATEMENT}\n`)
    expect(p).not.toContain(CHECK_LIST)
  })

  it('T12J-RUN: --keszlet t12 through the real boundary: the lines pass whole, one POST, its own run name', async () => {
    writeFileSync(jevEnv.JEV_COMMON_WORDS!, 'kutatas\nszerint\nzatony\nkiserlet\nkiserletben\n')
    const calls: Call[] = []
    const code = await run({ ...opts(), set: 't12', inputFile: inputFile(INPUTS12, 't12.json') }, { fetch: fakeFetch({ body: { text: 'k01 JELEZ\nk02 NEM' } }, calls), ...quiet })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]!.init.body)) as { prompt: string }
    expect(body.prompt).toBe(buildPrompt(conclusionLines(INPUTS12), T12_CHECK_LIST))
    expect(logLines().map((l) => [l.debate, l.result])).toEqual([['t12-biralat', 'kiment']])
    expect(JSON.parse(readFileSync(join(dir, 'out', 'run.json'), 'utf8')).items).toBe(2)
  })

  it('T12J-SET-MISMATCH: a T13 input under --keszlet t12 is refused before anything leaves, and the other way round', async () => {
    const calls: Call[] = []
    expect(await run({ ...opts(), set: 't12' }, { fetch: fakeFetch({}, calls), ...quiet })).toBe(1)
    expect(await run({ ...opts(), inputFile: inputFile(INPUTS12, 't12.json') }, { fetch: fakeFetch({}, calls), ...quiet })).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('T12J-ARGS: --keszlet takes t13 or t12 only, t13 when absent', () => {
    expect(parseArgs(['--bemenet', '/x'])).toEqual({ inputFile: '/x', set: 't13', proba: false })
    expect(parseArgs(['--bemenet', '/x', '--keszlet', 't12', '--proba'])).toEqual({ inputFile: '/x', set: 't12', proba: true })
    expect(parseArgs(['--bemenet', '/x', '--keszlet', 't14'])).toBeNull()
    expect(parseArgs(['--bemenet', '/x', '--keszlet'])).toBeNull()
  })

  type Verdict = { ref: string; flagged: boolean }
  const fakeKb12 = () => ({
    vocabularyV1: () => ({}),
    conclusionInputs: () => ({ inputs: INPUTS12, key: KEY12 }),
    scoreConclusions: (key: Record<string, string>, verdicts: Verdict[]) => {
      for (const v of verdicts) if (!(v.ref in key)) throw new Error(`conclusion score: unknown ref ${v.ref}`)
      const got = verdicts.find((v) => v.ref === 'k01')?.flagged === true
      return { discrepancies: got ? [] : ['t12-range-planted'] }
    },
    formatConclusionScore: (s: { discrepancies: string[] }) => `T12: ${s.discrepancies.length ? `${s.discrepancies.join(', ')} -> EMBERI DONTES` : 'no discrepancy'}`,
  })

  it("T12J-OS-SIDE: the calling agent's side runs the set's own OS functions, and a T13 answer does not score here", async () => {
    expect(osArgs(['bemenet', '--os', '/o', '--ki', '/k', '--keszlet', 't12'])).toEqual({ cmd: 'bemenet', keszlet: 't12', os: '/o', ki: '/k' })
    expect(osArgs(['pontoz', '--os', '/o', '--kulcs', '/k', '--valasz', '/v', '--keszlet', 't14'])).toBeNull()
    const r = writeInputs(fakeKb12(), join(dir, 'kor12'), 't12')
    expect(parseConclusionInputs(readFileSync(r.inputFile, 'utf8')).ok).toBe(true)
    expect(score(fakeKb12(), KEY12, 'k01 JELEZ\nk02 NEM', 't12').report).toBe('T12: no discrepancy')
    expect(score(fakeKb12(), KEY12, 'k01 NEM\nk02 NEM', 't12').report).toMatch(/EMBERI DONTES/)
    expect(score(fakeKb12(), KEY12, 'f01 JELEZ', 't12').ok).toBe(false)
    // a build without the set's functions is refused by name
    const t13only = join(dir, 'os13', 'packages', 'knowledge-base', 'dist')
    mkdirSync(t13only, { recursive: true })
    writeFileSync(join(t13only, 'index.js'), 'export const vocabularyV1 = () => ({})\nexport const flagInputs = () => ({})\nexport const scoreFlags = () => ({})\nexport const formatFlagScore = () => ""\n')
    await expect(loadKnowledgeBase(join(dir, 'os13'), 't12')).rejects.toThrow(/nincs conclusionInputs/)
    await expect(loadKnowledgeBase(join(dir, 'os13'), 't13')).resolves.toBeDefined()
  })

  it('T12J-COLON: a verdict line mirroring the input\'s colon is read, for both sets (barracuda, #332 review)', () => {
    const r = parseVerdicts('k01: JELEZ\n`k02`: `NEM`\nf03: NEM\nk04 : JELEZ\n')
    expect(r.verdicts).toEqual([{ ref: 'k01', flagged: true }, { ref: 'k02', flagged: false }, { ref: 'f03', flagged: false }])
    expect(r.unreadable).toEqual(['k04 : JELEZ'])
  })
})
