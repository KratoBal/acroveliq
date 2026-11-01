// The fleet-side runner of the T13 fifth class (scripts/gpt-csomag/t13-jelzo.mjs; task
// research-s7-t13-rokon-hatas, acrobot 39453/39459). The OS build is replaced by a small stand-in
// with the same four functions; the boundary is the REAL hatar.py (with the test's gate file, as in
// gpt-package.test.ts); the runner is a fake fetch.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { CHECK_LIST, buildPrompt, loadKnowledgeBase, parseArgs, parseVerdicts, run, runnerEndpoint } from '../../scripts/gpt-csomag/t13-jelzo.mjs'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'gpt-csomag', 'hatar.py')

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

type Verdict = { ref: string; flagged: boolean }
const INPUTS = [
  { ref: 'f01', sentence: 'Kutatás szerint a foszfát csökkentette az Acropora kalcifikációját és vázporozitását.', claim: { effect: 'CALCIFICATION', effectLabel: 'kalcifikáció', direction: 'DECREASE', taxa: ['ACROPORA'] } },
  { ref: 'f02', sentence: 'Kutatás szerint a foszfát csökkentette az Acropora meszesedését.', claim: { effect: 'CALCIFICATION', effectLabel: 'kalcifikáció', direction: 'DECREASE', taxa: ['ACROPORA'] } },
]
const KEY = { f01: 'related-porosity-planted', f02: 'related-porosity-correct' }

/** The OS build's four functions; scoreFlags records what it was handed. */
function fakeKb(seen: { verdicts?: Verdict[] } = {}) {
  return {
    vocabularyV1: () => ({}),
    flagInputs: () => ({ inputs: INPUTS, key: KEY }),
    scoreFlags: (key: Record<string, string>, verdicts: Verdict[]) => {
      for (const v of verdicts) if (!(v.ref in key)) throw new Error(`flag score: unknown ref ${v.ref}`)
      seen.verdicts = verdicts
      const planted = verdicts.find((v) => v.ref === 'f01')?.flagged === true
      return { plantedFlagged: planted ? 1 : 0, plantedTotal: 1, manualReview: !planted }
    },
    formatFlagScore: (s: { plantedFlagged: number; manualReview: boolean }) =>
      `T13 RELATED_EFFECT: planted flagged ${s.plantedFlagged}/1 -> ${s.manualReview ? 'MANUAL REVIEW' : 'every planted case flagged'}`,
  }
}

function opts(o: Record<string, unknown> = {}, gateOk = true) {
  return {
    os: join(dir, 'nincs-os'),
    url: 'http://192.168.250.1:8790',
    proba: false,
    tokenFile: join(dir, 'token'),
    logDir: join(dir, 'logs'),
    outDir: join(dir, 'out'),
    timeoutMs: 5000,
    boundary: { python: 'python3', script: SCRIPT, env: { ...jevEnv, JEV_LEAK_GATE_STATUS: gateStatus(gateOk) }, timeoutMs: 20_000 },
    ...o,
  }
}

function fakeFetch(reply: { status?: number; body?: unknown }, calls: { url: string; init: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const logLines = () => existsSync(join(dir, 'logs'))
  ? readdirSync(join(dir, 'logs')).flatMap((f) => readFileSync(join(dir, 'logs', f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Record<string, unknown>)
  : []
const quiet = { say: () => {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't13-jelzo-'))
  // the JEV redactor's local lists: none here (missing is allowed, layer B still runs)
  jevEnv = { JEV_KNOWN_ENTITIES: join(dir, 'nincs-known.json'), JEV_COMMON_WORDS: join(dir, 'nincs-common.txt') }
  writeFileSync(join(dir, 'token'), 'a'.repeat(32))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the prompt and the answer', () => {
  it('T13J-PROMPT: the check list, then one line per item; the model sees no case id', () => {
    const p: string = buildPrompt(INPUTS)
    expect(p.startsWith(CHECK_LIST)).toBe(true)
    expect(p).toContain('f01 | Kutatás szerint a foszfát csökkentette az Acropora kalcifikációját és vázporozitását. | kalcifikáció DECREASE ACROPORA')
    expect(p.trim().split('\n').filter((l: string) => /^f\d{2} \| /.test(l))).toHaveLength(2)
    expect(p).not.toMatch(/planted|correct|related-/)
  })

  it('T13J-PARSE: verdict lines read (backticks too); any other line is counted, never guessed', () => {
    const r = parseVerdicts('f01 JELEZ\n`f02` `NEM`\n\nf03: igen\nÖsszegzés: rendben\n')
    expect(r.verdicts).toEqual([{ ref: 'f01', flagged: true }, { ref: 'f02', flagged: false }])
    expect(r.unreadable).toEqual(['f03: igen', 'Összegzés: rendben'])
  })

  it('T13J-ARGS: --os is required; an unknown flag or a missing value is wrong usage', () => {
    expect(parseArgs(['--os', '/x', '--url', 'http://1.2.3.4:8790', '--proba'])).toEqual({ os: '/x', url: 'http://1.2.3.4:8790', proba: true })
    expect(parseArgs(['--url', 'http://1.2.3.4:8790'])).toBeNull()
    expect(parseArgs(['--os'])).toBeNull()
    expect(parseArgs(['--os', '/x', '--force'])).toBeNull()
    expect(runnerEndpoint('http://192.168.250.1:8790')).toBe('http://192.168.250.1:8790/futtat')
    expect(runnerEndpoint('http://runner:8790')).toBeNull()
  })

  it('T13J-BUILD: an OS checkout without the fifth class is refused by name', async () => {
    await expect(loadKnowledgeBase(join(dir, 'nincs-os'))).rejects.toThrow(/az OS build nem toltheto be/)
  })
})

describe('one run', () => {
  it('T13J-RUN: through the real boundary, one POST with only the prompt, the answer scored by the OS', async () => {
    const seen: { verdicts?: Verdict[] } = {}
    const calls: { url: string; init: RequestInit }[] = []
    const r = await run(opts(), { kb: fakeKb(seen), fetch: fakeFetch({ body: { text: 'f01 JELEZ\nf02 NEM' } }, calls), ...quiet })
    expect(r.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://192.168.250.1:8790/futtat')
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['prompt'])
    expect(String(body.prompt)).toContain('f02 |')
    expect(seen.verdicts).toEqual([{ ref: 'f01', flagged: true }, { ref: 'f02', flagged: false }])
    expect(r.report).toMatch(/every planted case flagged/)
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')) as Record<string, unknown>
    expect(result.answer).toBe('f01 JELEZ\nf02 NEM')
    expect(logLines().map((l) => [l.debate, l.result])).toEqual([['t13-jelzo', 'kiment']])
  })

  it('T13J-SILENCE: an unreadable answer flags nothing, and the planted item goes to manual review', async () => {
    const r = await run(opts(), { kb: fakeKb(), fetch: fakeFetch({ body: { text: 'Mindkettő rendben van.' } }), ...quiet })
    expect(r.code).toBe(0)
    expect(r.report).toMatch(/MANUAL REVIEW/)
  })

  it('T13J-PROBA: everything up to the POST, and no call to the runner', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await run(opts({ proba: true }), { kb: fakeKb(), fetch: fakeFetch({}, calls), ...quiet })
    expect(r.code).toBe(0)
    expect(calls).toHaveLength(0)
    expect((r.result as { items: number }).items).toBe(2)
    expect(logLines()).toEqual([])
  })

  it('T13J-BOUNDARY: a boundary refusal stops the run before the runner, and is logged without content', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await run(opts({}, false), { kb: fakeKb(), fetch: fakeFetch({}, calls), ...quiet })
    expect(r.code).toBe(1)
    expect(calls).toHaveLength(0)
    const lines = logLines()
    expect(lines.map((l) => l.result)).toEqual(['elutasitva'])
    expect(JSON.stringify(lines)).not.toContain('vázporozitását')
  })

  it('T13J-TOKEN: no readable token, no call', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await run(opts({ tokenFile: join(dir, 'nincs-token') }), { kb: fakeKb(), fetch: fakeFetch({}, calls), ...quiet })
    expect(r.code).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('T13J-RUNNER: a runner failure is no score, and is logged', async () => {
    const r = await run(opts(), { kb: fakeKb(), fetch: fakeFetch({ status: 429, body: { hiba: 'foglalt' } }), ...quiet })
    expect(r.code).toBe(1)
    expect(logLines().map((l) => [l.result, l.why])).toEqual([['hiba', 'a futtato 429 valaszt adott']])
  })

  it('T13J-OTHER-SET: a verdict on a ref outside the key is no score, and the answer is kept for the record', async () => {
    const r = await run(opts(), { kb: fakeKb(), fetch: fakeFetch({ body: { text: 'f01 JELEZ\nf09 NEM' } }), ...quiet })
    expect(r.code).toBe(1)
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')) as Record<string, unknown>
    expect(result.error).toMatch(/unknown ref f09/)
  })
})
