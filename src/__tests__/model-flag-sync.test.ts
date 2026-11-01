// The stage OS round trip of the second model's flags (task research-s4-jelzes-modul; acropora-os #1994):
// pull the waiting items, shape them into the runner's input, run the runner, write the flags back. The OS and
// the runner are one fake fetch, routed by URL; the boundary is a fake that echoes (the real hatar.py is the
// runner's own test, t13-flag-runner.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MODEL_LABEL,
  countByReason,
  SOURCE,
  flagsFrom,
  parseArgs,
  parsePending,
  shape,
  stageApi,
  sync,
  type PendingClaim,
  type PendingConclusion,
  type SyncOptions,
} from '../model-flag-sync.js'
import { MAX_ITEMS } from '../t13-flag-runner.js'

const ROOT = join(__dirname, '..', '..')
const API = 'https://api-staging.acropora.hu'
const PASSWORD = 'smoke-jelszo-ne-lassa-senki'
const OS_TOKEN = 'os-token-ne-lassa-senki'
const H = (c: string) => c.repeat(64)

const claim = (id: string, passages: string[], hash = H('a')): PendingClaim => ({
  targetId: id,
  targetHash: hash,
  passages,
  claim: { effect: 'CALCIFICATION', effectLabel: 'kalcifikáció', direction: 'DECREASE', taxa: ['ACROPORA'] },
})
const P1 = 'Calcification of Acropora decreased by 18 % at 2 µM phosphate.'
const P2 = 'Skeletal density did not change in the same colonies.'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-flag-sync-'))
  mkdirSync(join(dir, 'store'))
  writeFileSync(join(dir, 'password'), `${PASSWORD}\n`)
  writeFileSync(join(dir, 'runner-token'), 'r'.repeat(32))
  // a boundary that passes the data through unchanged
  writeFileSync(join(dir, 'fake.py'), 'import sys, json\nprint(json.dumps({"ok": True, "text": sys.stdin.read(), "counts": {}}))\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function opts(o: Partial<SyncOptions> = {}): SyncOptions {
  return {
    set: 't13',
    limit: 40,
    proba: false,
    api: API,
    email: 'flotta-smoke@acropora.hu',
    passwordFile: join(dir, 'password'),
    outDir: join(dir, 'out'),
    runId: 'os-jelzes-t13-20261101T113000',
    pkg: { storeDir: join(dir, 'store'), logDir: join(dir, 'logs'), boundary: { python: 'python3', script: join(dir, 'fake.py'), timeoutMs: 5000 }, maxBytes: 32 * 1024 },
    runner: { enabled: true, url: 'http://192.168.250.1:8790', tokenFile: join(dir, 'runner-token'), timeoutMs: 5000 },
    ...o,
  }
}

type Call = { url: string; body: unknown; auth: string | null }
/** The OS and the runner, by URL. */
function world(w: { pending: unknown; answer?: string; write?: { status?: number; body?: unknown } }, calls: Call[]) {
  return (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, body, auth: headers.authorization ?? null })
    const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (url === `${API}/auth/mobile/login/password`) return reply(200, { token: OS_TOKEN })
    if (url.startsWith(`${API}/knowledge-base/model-flags/pending?`)) return reply(200, w.pending)
    if (url === `${API}/knowledge-base/model-flags`) return reply(w.write?.status ?? 200, w.write?.body ?? { runId: 'x', written: 1, alreadyWritten: 0, rejected: [] })
    if (url.startsWith('http://192.168.250.1:8790')) return reply(200, { text: w.answer ?? '' })
    return reply(404, { message: 'nincs' })
  }) as unknown as typeof fetch
}
const pendingOf = (items: (PendingClaim | PendingConclusion)[], targetType = 'CLAIM') => ({
  targetType,
  items: items.map((i) => ({ targetType, ...i })),
  total: items.length,
  notOffered: [] as unknown[],
})

describe('the module reads data, not code', () => {
  it('MFS-NO-FOREIGN-CODE: imports only node: and this repository; the one dynamic import is ./config.js', () => {
    const src = readFileSync(join(ROOT, 'src', 'model-flag-sync.ts'), 'utf8')
    const statics = [...src.matchAll(/^import [\s\S]*? from '([^']+)'/gm)].map((m) => m[1]!)
    expect(statics.length).toBeGreaterThan(0)
    expect(statics.filter((s) => !s.startsWith('node:') && !s.startsWith('./'))).toEqual([])
    expect([...src.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["'./config.js'"])
  })

  it('MFS-STAGE-ONLY: the stage host over https, nothing else, and a refused address reads no password', async () => {
    expect(stageApi(API)).toBe(API)
    expect(stageApi(`${API}/`)).toBe(API)
    for (const bad of ['https://api.acropora.hu', 'http://api-staging.acropora.hu', 'https://api-staging.acropora.hu.evil.example', 'https://x.api-staging.acropora.hu', 'https://api-staging.acropora.hu:8443', 'https://api-staging.acropora.hu/v2', 'https://u:p@api-staging.acropora.hu', 'nem url'])
      expect(stageApi(bad), bad).toBeNull()
    const calls: Call[] = []
    const said: string[] = []
    const code = await sync(opts({ api: 'https://api.acropora.hu', passwordFile: join(dir, 'nincs') }), { fetch: world({ pending: {} }, calls), say: (s) => said.push(s) })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(said.join()).toContain('nem a teszt OS')
  })

  it('MFS-ARGS: the set is required; the limit is 1-50', () => {
    expect(parseArgs(['--keszlet', 't12'])).toEqual({ set: 't12', limit: 40, proba: false })
    expect(parseArgs(['--keszlet', 't13', '--limit', '5', '--proba'])).toEqual({ set: 't13', limit: 5, proba: true })
    for (const bad of [[], ['--keszlet', 'x'], ['--keszlet', 't13', '--limit', '0'], ['--keszlet', 't13', '--limit', '51'], ['--keszlet', 't13', '--os', '/y']])
      expect(parseArgs(bad), bad.join(' ')).toBeNull()
  })
})

describe('the OS answer and the runner input', () => {
  it('MFS-PENDING: the OS shape is checked; another set or a bad hash is refused', () => {
    expect(parsePending(pendingOf([claim('c1', [P1])]), 't13').ok).toBe(true)
    expect(parsePending(pendingOf([claim('c1', [P1])]), 't12').ok).toBe(false)
    expect(parsePending(pendingOf([claim('c1', [P1], 'ABC')]), 't13').ok).toBe(false)
    expect(parsePending(pendingOf([claim('c 1', [P1])]), 't13').ok).toBe(false)
    expect(parsePending(null, 't13').ok).toBe(false)
    // the OS's reasons are kept per item and counted, not reduced to a number
    const body = { ...pendingOf([]), notOffered: [{ targetId: 'c9', reason: 'NO_TAXON' }, { targetId: 'c8', reason: 'NO_EFFECT' }, { targetId: 'c7', reason: 'NO_TAXON' }] }
    const p = parsePending(body, 't13')
    expect(p.ok && countByReason(p.notOffered)).toEqual({ NO_EFFECT: 1, NO_TAXON: 2 })
    expect(parsePending({ ...body, notOffered: [{ targetId: 'c9', reason: 'nem kulcs' }] }, 't13').ok).toBe(false)
  })

  it('MFS-SHAPE-CLAIM: one line per passage, refs only; an item the runner would refuse is skipped by name', () => {
    const s = shape('t13', [claim('c1', [P1, P2]), claim('c2', ['x'.repeat(501)]), claim('c3', ['a | b']), claim('c4', [P1])])
    expect(s.inputs.map((i) => i.ref)).toEqual(['f01', 'f02', 'f03'])
    expect(s.key).toEqual({ f01: { targetId: 'c1', targetHash: H('a') }, f02: { targetId: 'c1', targetHash: H('a') }, f03: { targetId: 'c4', targetHash: H('a') } })
    expect(s.skipped).toEqual([
      { targetId: 'c2', why: 'kivonat 501 karakter, a futtato legfeljebb 500-at visz' },
      { targetId: 'c3', why: 'a 1. elem: a mondat ures, tul hosszu, vagy sortorest, | vagy ` jelet visel' },
    ])
    expect(JSON.stringify(s.inputs)).not.toMatch(/c1|c4|aaaa/)
  })

  it('MFS-SHAPE-LIMIT: the runner takes at most MAX_ITEMS lines; the rest waits for the next run, whole', () => {
    const many = Array.from({ length: MAX_ITEMS }, (_, i) => claim(`c${i}`, [P1, P2]))
    const s = shape('t13', many)
    expect(s.inputs.length).toBe(MAX_ITEMS)
    expect(new Set(Object.values(s.key).map((k) => k.targetId)).size).toBe(MAX_ITEMS / 2)
    expect(s.deferred).toBe(MAX_ITEMS / 2)
  })

  it('MFS-SHAPE-ORDER: the first item that does not fit ends the input; a shorter one after it waits too (barracuda, #335)', () => {
    const items = [...Array.from({ length: MAX_ITEMS - 1 }, (_, i) => claim(`c${i}`, [P1])), claim('long', [P1, P2]), claim('short', [P1])]
    const s = shape('t13', items)
    expect(s.inputs.length).toBe(MAX_ITEMS - 1)
    expect(Object.values(s.key).some((k) => k.targetId === 'short')).toBe(false)
    expect(s.deferred).toBe(2)
  })

  it('MFS-SHAPE-CONCLUSION: one line each; a fourth basis claim is skipped with its reason', () => {
    const k = (id: string, n: number): PendingConclusion => ({ targetId: id, targetHash: H('b'), conclusion: 'Következtetés.', basis: Array.from({ length: n }, (_, i) => `Állítás ${i}.`) })
    const s = shape('t12', [k('k1', 2), k('k2', 4)])
    expect(s.inputs).toEqual([{ ref: 'k01', conclusion: 'Következtetés.', basis: ['Állítás 0.', 'Állítás 1.'] }])
    expect(s.skipped).toEqual([{ targetId: 'k2', why: '4 alap-allitas, a futtato legfeljebb 3-at visz' }])
  })
})

describe('the verdicts', () => {
  const key = { f01: { targetId: 'c1', targetHash: H('a') }, f02: { targetId: 'c1', targetHash: H('a') }, f03: { targetId: 'c2', targetHash: H('c') }, f04: { targetId: 'c3', targetHash: H('d') } }

  it('MFS-VERDICT: one JELEZ flags the claim; all NEM is not flagged; a missing verdict is no flag at all', () => {
    const r = flagsFrom('f01 NEM\nf02: JELEZ\n`f03` NEM\nmagyarazat\n', key)
    expect(r).toEqual({
      ok: true,
      flags: [{ targetId: 'c1', targetHash: H('a'), flagged: true }, { targetId: 'c2', targetHash: H('c'), flagged: false }],
      unanswered: ['c3'],
      unreadable: 1,
    })
    const half = flagsFrom('f01 NEM\nf03 NEM\nf04 NEM', key)
    expect(half.ok && half.unanswered).toEqual(['c1'])
  })

  it('MFS-VERDICT-OTHER: an unknown ref or two verdicts on one ref is an answer of another input', () => {
    expect(flagsFrom('f01 NEM\nf09 JELEZ', key).ok).toBe(false)
    expect(flagsFrom('f01 NEM\nf01 JELEZ', key).ok).toBe(false)
  })
})

describe('the round trip', () => {
  it('MFS-SYNC: pulls, runs, writes back with the run id, the prompt digest and each item hash; no secret in the output', async () => {
    const calls: Call[] = []
    const said: string[] = []
    const code = await sync(opts(), {
      fetch: world({ pending: pendingOf([claim('c1', [P1, P2], H('a')), claim('c2', [P1], H('c'))]), answer: 'f01 NEM\nf02 JELEZ\nf03 NEM' }, calls),
      say: (s) => said.push(s),
    })
    expect(code).toBe(0)
    expect(calls.map((c) => c.url.replace(/\?.*/, ''))).toEqual([`${API}/auth/mobile/login/password`, `${API}/knowledge-base/model-flags/pending`, 'http://192.168.250.1:8790/futtat', `${API}/knowledge-base/model-flags`])
    expect(calls[0]!.body).toEqual({ email: 'flotta-smoke@acropora.hu', password: PASSWORD })
    expect(calls[1]!.url).toContain('targetType=CLAIM')
    expect(calls[1]!.auth).toBe(`Bearer ${OS_TOKEN}`)
    // the model sees refs, the passages and the claim's fields: no id, no hash
    const prompt = (calls[2]!.body as { prompt: string }).prompt
    expect(prompt).toContain(`f01: ${P1}`)
    expect(prompt).not.toMatch(/c1|c2|aaaaaaaa|cccccccc/)
    const run = JSON.parse(readFileSync(join(dir, 'out', 'run.json'), 'utf8')) as { prompt_sha256: string }
    expect(calls[3]!.body).toEqual({
      source: SOURCE,
      runId: 'os-jelzes-t13-20261101T113000',
      model: MODEL_LABEL,
      promptSha256: run.prompt_sha256,
      flags: [
        { targetType: 'CLAIM', targetId: 'c1', targetHash: H('a'), flagged: true },
        { targetType: 'CLAIM', targetId: 'c2', targetHash: H('c'), flagged: false },
      ],
    })
    const summary = JSON.parse(readFileSync(join(dir, 'out', 'sync.json'), 'utf8')) as { flags: unknown }
    expect(summary.flags).toEqual([{ targetId: 'c1', flagged: true }, { targetId: 'c2', flagged: false }])
    const out = said.join('\n') + readFileSync(join(dir, 'out', 'sync.json'), 'utf8') + readFileSync(join(dir, 'out', 'inputs.json'), 'utf8')
    expect(out).not.toContain(PASSWORD)
    expect(out).not.toContain(OS_TOKEN)
  })

  it('MFS-PROBA: up to the runner, nothing sent to it and nothing written', async () => {
    const calls: Call[] = []
    const code = await sync(opts({ proba: true }), { fetch: world({ pending: pendingOf([claim('c1', [P1])]) }, calls), say: () => {} })
    expect(code).toBe(0)
    expect(calls.map((c) => c.url.replace(/\?.*/, ''))).toEqual([`${API}/auth/mobile/login/password`, `${API}/knowledge-base/model-flags/pending`])
  })

  it('MFS-NO-WRITE: an answer of another input, or none, writes nothing', async () => {
    for (const answer of ['f07 JELEZ', 'nem ertem a feladatot']) {
      const calls: Call[] = []
      const code = await sync(opts({ outDir: join(dir, `out-${answer.length}`) }), { fetch: world({ pending: pendingOf([claim('c1', [P1])]), answer }, calls), say: () => {} })
      expect(code, answer).toBe(1)
      expect(calls.some((c) => c.url === `${API}/knowledge-base/model-flags`), answer).toBe(false)
    }
  })

  it('MFS-REFUSED: the OS refusing items is reported, not a failure; refusing the write is one', async () => {
    const said: string[] = []
    const ok = await sync(opts(), {
      fetch: world({ pending: pendingOf([claim('c1', [P1])]), answer: 'f01 NEM', write: { body: { runId: 'x', written: 0, alreadyWritten: 0, rejected: [{ targetType: 'CLAIM', targetId: 'c1', reason: 'STALE_HASH' }] } } }, []),
      say: (s) => said.push(s),
    })
    expect(ok).toBe(0)
    expect(said.at(-1)).toContain('1 elutasitva')
    expect(JSON.parse(readFileSync(join(dir, 'out', 'sync.json'), 'utf8')).rejected).toEqual([{ targetType: 'CLAIM', targetId: 'c1', reason: 'STALE_HASH' }])
    const bad = await sync(opts({ outDir: join(dir, 'out2') }), { fetch: world({ pending: pendingOf([claim('c1', [P1])]), answer: 'f01 NEM', write: { status: 403, body: { message: 'Nincs jogosultság.' } } }, []), say: () => {} })
    expect(bad).toBe(1)
  })

  it('MFS-EMPTY: nothing waiting is a clean run that calls no runner', async () => {
    const calls: Call[] = []
    const code = await sync(opts(), { fetch: world({ pending: pendingOf([]) }, calls), say: () => {} })
    expect(code).toBe(0)
    expect(calls.length).toBe(2)
    expect(existsSync(join(dir, 'out', 'inputs.json'))).toBe(false)
  })
})
