// The second model's flags on REAL items, pulled from and written back to the stage OS (task research-s4-jelzes-modul;
// plan v4, 7a 3., S4; acrobot 39518 path B, 39527).
//
// The OS holds the items waiting for a flag and the append-only flag table (acropora-os #1994); it calls nothing
// outward. This module, run as marveen by acrobot, does the round trip in one process:
//
//   1. logs in to the STAGE OS with the smoke account (its password file is marveen's, 0600) and GETs
//      /knowledge-base/model-flags/pending for one set (t13: CLAIM, t12: CONCLUSION);
//   2. shapes the items into the runner's own input (one line per claim passage; refs only, no id reaches the
//      model) and keeps the ref -> item key in memory;
//   3. runs the existing runner (t13-flag-runner.ts run()): the secret check, hatar.py on the data, one POST to the
//      GPT runner, the output filter. Nothing of that is repeated or bypassed here;
//   4. reads the verdicts, and POSTs the flags back to /knowledge-base/model-flags with the run's id, the prompt's
//      digest and each item's targetHash, so an item edited meanwhile is refused by the OS, not overwritten.
//
// Silence flags nothing (7a 3.): an item without a verdict gets no row and stays waiting. A claim with several
// passages is flagged when any of its lines is; it is "not flagged" only when every line says NEM.
//
// No module outside this repository is loaded (barracuda #331): the OS is reached over HTTP, as data.
//
//   node dist/model-flag-sync.js --keszlet t13|t12 [--limit N] [--proba]
//   exit 0: flags written (refusals are reported, not a failure) or, with --proba, everything up to the runner;
//   1: nothing written; 2: wrong usage.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MAX_BASIS,
  MAX_ITEMS,
  MAX_SENTENCE,
  parseConclusionInputs,
  parseInputs,
  run,
  type ConclusionInput,
  type FlagInput,
  type RunDeps,
  type RunOptions,
  type SetName,
} from './t13-flag-runner.js'

export const STAGE_OS_API_DEFAULT = 'https://api-staging.acropora.hu'
export const STAGE_OS_EMAIL_DEFAULT = 'flotta-smoke@acropora.hu'
/** The row's source on the OS surface: the runner, not the account that writes it. */
export const SOURCE = 'gpt-runner'
/** The runner's answer names no model; the label names the runner's kind (the GPT runner is a Codex run). */
export const MODEL_LABEL = 'codex'
export const DEFAULT_LIMIT = 40

const TARGET: Readonly<Record<SetName, 'CLAIM' | 'CONCLUSION'>> = { t13: 'CLAIM', t12: 'CONCLUSION' }

/** The stage OS's hosts, by name: a production address (or a look-alike) is refused before anything is read. */
export const STAGE_HOSTS: ReadonlySet<string> = new Set(['api-staging.acropora.hu'])

/** Only the stage OS, over https. */
export function stageApi(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && STAGE_HOSTS.has(u.hostname) && !u.port && u.pathname === '/' && !u.search && !u.username ? u.origin : null
  } catch {
    return null
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const ID = /^[A-Za-z0-9_-]{1,64}$/
const SHA256 = /^[0-9a-f]{64}$/

/** An item the OS cannot give to the model, with the OS's reason (e.g. NO_TAXON). */
export interface NotOffered { targetId: string; reason: string }
const REASON = /^[A-Z_]{1,40}$/

/** How many items per reason, in a fixed order: the run's summary line and sync.json. */
export function countByReason(list: readonly { reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { reason } of [...list].sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))) out[reason] = (out[reason] ?? 0) + 1
  return out
}

export interface PendingClaim {
  targetId: string
  targetHash: string
  passages: string[]
  claim: FlagInput['claim']
}
export interface PendingConclusion {
  targetId: string
  targetHash: string
  conclusion: string
  basis: string[]
}

/** The OS's pending answer, read as data: the shape is checked, nothing more is trusted. */
export function parsePending(body: unknown, set: SetName):
  | { ok: true; items: (PendingClaim | PendingConclusion)[]; total: number; notOffered: NotOffered[] }
  | { ok: false; why: string } {
  if (!isObject(body) || body.targetType !== TARGET[set] || !Array.isArray(body.items) || typeof body.total !== 'number' || !Array.isArray(body.notOffered))
    return { ok: false, why: 'az OS valasza nem a pending alak' }
  const items: (PendingClaim | PendingConclusion)[] = []
  for (const [i, it] of body.items.entries()) {
    const bad = { ok: false as const, why: `az OS ${i + 1}. tetele nem a vart alak` }
    if (!isObject(it) || it.targetType !== TARGET[set] || typeof it.targetId !== 'string' || !ID.test(it.targetId) || typeof it.targetHash !== 'string' || !SHA256.test(it.targetHash)) return bad
    if (set === 't13') {
      const c = it.claim
      if (!Array.isArray(it.passages) || !it.passages.every((p) => typeof p === 'string') || !isObject(c)) return bad
      if (typeof c.effect !== 'string' || typeof c.effectLabel !== 'string' || typeof c.direction !== 'string' || !Array.isArray(c.taxa) || !c.taxa.every((t) => typeof t === 'string')) return bad
      items.push({ targetId: it.targetId, targetHash: it.targetHash, passages: it.passages as string[], claim: { effect: c.effect, effectLabel: c.effectLabel, direction: c.direction, taxa: c.taxa as string[] } })
    } else {
      if (typeof it.conclusion !== 'string' || !Array.isArray(it.basis) || !it.basis.every((b) => typeof b === 'string')) return bad
      items.push({ targetId: it.targetId, targetHash: it.targetHash, conclusion: it.conclusion, basis: it.basis as string[] })
    }
  }
  const notOffered: NotOffered[] = []
  for (const n of body.notOffered) {
    if (!isObject(n) || typeof n.targetId !== 'string' || !ID.test(n.targetId) || typeof n.reason !== 'string' || !REASON.test(n.reason))
      return { ok: false, why: 'az OS nem-atadhato listaja nem a vart alak' }
    notOffered.push({ targetId: n.targetId, reason: n.reason })
  }
  return { ok: true, items, total: body.total, notOffered }
}

/** Which item a ref belongs to. A claim has one ref per passage. */
export interface KeyEntry { targetId: string; targetHash: string }

export interface Shaped {
  /** The runner's input file content. */
  inputs: (FlagInput | ConclusionInput)[]
  key: Readonly<Record<string, KeyEntry>>
  /** Items the runner would refuse (its own input rules), named, not sent. They stay waiting, for a human. */
  skipped: { targetId: string; why: string }[]
  /** Items left for the next run: the runner takes at most MAX_ITEMS lines. */
  deferred: number
}

const ref = (set: SetName, n: number) => `${set === 't13' ? 'f' : 'k'}${String(n).padStart(2, '0')}`

/**
 * The runner's input, item by item. Each item's lines are checked with the runner's own parser before they are
 * taken, so one item the runner would refuse (a passage over its length, a `|` in the text, a fourth basis claim)
 * is skipped by name instead of refusing the whole run.
 */
export function shape(set: SetName, items: readonly (PendingClaim | PendingConclusion)[]): Shaped {
  const inputs: (FlagInput | ConclusionInput)[] = []
  const key: Record<string, KeyEntry> = {}
  const skipped: Shaped['skipped'] = []
  let deferred = 0
  for (const [index, item] of items.entries()) {
    let lines: (FlagInput | ConclusionInput)[]
    let why: string | null = null
    if (set === 't13') {
      const c = item as PendingClaim
      lines = c.passages.map((sentence, i) => ({ ref: ref(set, i + 1), sentence, claim: c.claim }))
      const p = lines.length === 0 ? { ok: false as const, why: 'nincs kivonat' } : parseInputs(JSON.stringify(lines))
      const long = c.passages.find((x) => x.length > MAX_SENTENCE)
      if (!p.ok) why = long ? `kivonat ${long.length} karakter, a futtato legfeljebb ${MAX_SENTENCE}-at visz` : p.why
    } else {
      const c = item as PendingConclusion
      lines = [{ ref: ref(set, 1), conclusion: c.conclusion, basis: c.basis }]
      const p = parseConclusionInputs(JSON.stringify(lines))
      const long = [c.conclusion, ...c.basis].find((x) => x.length > MAX_SENTENCE)
      if (!p.ok)
        why = c.basis.length > MAX_BASIS
          ? `${c.basis.length} alap-allitas, a futtato legfeljebb ${MAX_BASIS}-at visz`
          : long ? `egy mondata ${long.length} karakter, a futtato legfeljebb ${MAX_SENTENCE}-at visz` : p.why
    }
    if (why !== null) { skipped.push({ targetId: item.targetId, why }); continue }
    // the first item that does not fit ends the run's input: the rest waits in the OS's order (barracuda, #335)
    if (inputs.length + lines.length > MAX_ITEMS) { deferred = items.length - index; break }
    for (const line of lines) {
      const r = ref(set, inputs.length + 1)
      inputs.push({ ...line, ref: r })
      key[r] = { targetId: item.targetId, targetHash: item.targetHash }
    }
  }
  return { inputs, key, skipped, deferred }
}

const VERDICT_LINE = /^\s*`?([fk]\d{2})`?:?\s+`?(JELEZ|NEM)`?\s*$/u

export interface Flag { targetId: string; targetHash: string; flagged: boolean }

/**
 * The flags the answer gives, per item. A verdict on a ref outside the key, or two on one ref, is an answer of
 * another input: nothing is written. An item with a JELEZ line is flagged; one whose every line is NEM is not; one
 * with a line unanswered and no JELEZ gets no flag (silence flags nothing) and stays waiting.
 */
export function flagsFrom(answer: string, key: Readonly<Record<string, KeyEntry>>):
  | { ok: true; flags: Flag[]; unanswered: string[]; unreadable: number }
  | { ok: false; why: string } {
  const verdicts = new Map<string, boolean>()
  let unreadable = 0
  for (const line of answer.split('\n')) {
    if (!line.trim()) continue
    const m = VERDICT_LINE.exec(line)
    if (!m) { unreadable++; continue }
    if (!(m[1]! in key)) return { ok: false, why: `a valasz ismeretlen azonositot nevez (${m[1]})` }
    if (verdicts.has(m[1]!)) return { ok: false, why: `a valasz ketszer itel ugyanarrol (${m[1]})` }
    verdicts.set(m[1]!, m[2] === 'JELEZ')
  }
  const byItem = new Map<string, { entry: KeyEntry; lines: (boolean | undefined)[] }>()
  for (const [r, entry] of Object.entries(key)) {
    const g = byItem.get(entry.targetId) ?? { entry, lines: [] }
    g.lines.push(verdicts.get(r))
    byItem.set(entry.targetId, g)
  }
  const flags: Flag[] = []
  const unanswered: string[] = []
  for (const { entry, lines } of byItem.values()) {
    if (lines.includes(true)) flags.push({ ...entry, flagged: true })
    else if (lines.every((l) => l === false)) flags.push({ ...entry, flagged: false })
    else unanswered.push(entry.targetId)
  }
  return { ok: true, flags, unanswered, unreadable }
}

export interface SyncOptions {
  set: SetName
  limit: number
  proba: boolean
  api: string
  email: string
  passwordFile: string
  /** The run's folder (inputs, the runner's answer, the summary). */
  outDir: string
  runId: string
  pkg: RunOptions['pkg']
  runner: RunOptions['runner']
}

/** The OS's own message on a failure: no token or password is in it. */
async function osCall(doFetch: typeof fetch, url: string, init: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok) {
      const msg = isObject(body) && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
      return { ok: false, why: `${res.status} ${msg}`.slice(0, 200) }
    }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, why: (e as Error).message.slice(0, 200) }
  }
}

/** One round trip; returns the exit code. */
export async function sync(o: SyncOptions, deps: RunDeps = {}): Promise<number> {
  const say = deps.say ?? ((s: string) => process.stdout.write(`${s}\n`))
  const doFetch = deps.fetch ?? fetch
  const api = stageApi(o.api)
  if (!api) { say(`NEM FUT: a cim nem a teszt OS (${o.api}).`); return 2 }

  let password: string
  try { password = readFileSync(o.passwordFile, 'utf8').trim() } catch { say('NEM FUT: a smoke-fiok jelszofajlja nem olvashato; marveen-kent fut.'); return 1 }
  if (!password) { say('NEM FUT: a smoke-fiok jelszofajlja ures.'); return 1 }
  const json = { 'content-type': 'application/json' }
  const login = await osCall(doFetch, `${api}/auth/mobile/login/password`, { method: 'POST', headers: json, body: JSON.stringify({ email: o.email, password }) })
  if (!login.ok) { say(`NEM FUT: a belepes nem sikerult (${login.why}).`); return 1 }
  const token = isObject(login.body) && typeof login.body.token === 'string' ? login.body.token : ''
  if (!token) { say('NEM FUT: a belepes valasza nem tartalmaz tokent.'); return 1 }
  const auth = { ...json, authorization: `Bearer ${token}` }

  const q = new URLSearchParams({ targetType: TARGET[o.set], limit: String(o.limit) })
  const got = await osCall(doFetch, `${api}/knowledge-base/model-flags/pending?${q}`, { headers: auth })
  if (!got.ok) { say(`NINCS IRAS: a varo tetelek nem kerhetok le (${got.why}).`); return 1 }
  const pending = parsePending(got.body, o.set)
  if (!pending.ok) { say(`NINCS IRAS: ${pending.why}.`); return 1 }
  const shaped = shape(o.set, pending.items)
  const byReason = countByReason(pending.notOffered)
  const reasons = Object.entries(byReason).map(([r, n]) => `${r} ${n}`).join(', ')
  const head = `${TARGET[o.set]}: ${pending.items.length} lekerve (osszesen ${pending.total} var), ${pending.notOffered.length} nem adhato at (OS${reasons ? `: ${reasons}` : ''}), ${shaped.skipped.length} kihagyva (a futtato szabalya), ${shaped.deferred} a kovetkezo korre`
  mkdirSync(o.outDir, { recursive: true, mode: 0o750 })
  const summary = (extra: Record<string, unknown>) =>
    writeFileSync(join(o.outDir, 'sync.json'), `${JSON.stringify({ runId: o.runId, set: o.set, fetched: pending.items.length, total: pending.total, notOffered: { count: pending.notOffered.length, byReason, items: pending.notOffered }, skipped: shaped.skipped, deferred: shaped.deferred, ...extra }, null, 2)}\n`, { mode: 0o640 })
  if (shaped.inputs.length === 0) { summary({ written: 0 }); say(`${head}; nincs mit futtatni.`); return pending.items.length === 0 ? 0 : 1 }

  const inputFile = join(o.outDir, 'inputs.json')
  writeFileSync(inputFile, `${JSON.stringify(shaped.inputs, null, 2)}\n`, { mode: 0o640 })
  say(`${head}; ${shaped.inputs.length} sor megy a futtatohoz.`)
  const code = await run({ inputFile, set: o.set, proba: o.proba, outDir: o.outDir, pkg: o.pkg, runner: o.runner }, deps)
  if (code !== 0 || o.proba) { summary({ written: 0, runner: code }); return code }

  let answer: string
  let promptSha256: string
  try {
    answer = readFileSync(join(o.outDir, 'answer.txt'), 'utf8')
    const r = JSON.parse(readFileSync(join(o.outDir, 'run.json'), 'utf8')) as { prompt_sha256?: unknown }
    promptSha256 = typeof r.prompt_sha256 === 'string' ? r.prompt_sha256 : ''
  } catch { say('NINCS IRAS: a futtato valasza nem olvashato vissza.'); return 1 }
  const read = flagsFrom(answer, shaped.key)
  if (!read.ok) { summary({ written: 0, refused: read.why }); say(`NINCS IRAS: ${read.why}.`); return 1 }
  if (read.flags.length === 0) { summary({ written: 0, unanswered: read.unanswered, unreadable: read.unreadable }); say('NINCS IRAS: a valasz egyetlen tetelrol sem itelt.'); return 1 }

  const posted = await osCall(doFetch, `${api}/knowledge-base/model-flags`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      source: SOURCE,
      runId: o.runId,
      model: MODEL_LABEL,
      promptSha256,
      flags: read.flags.map((f) => ({ targetType: TARGET[o.set], ...f })),
    }),
  })
  if (!posted.ok) { summary({ written: 0, writeError: posted.why }); say(`NINCS IRAS: az OS elutasitotta (${posted.why}).`); return 1 }
  const res = isObject(posted.body) ? posted.body : {}
  const rejected = Array.isArray(res.rejected) ? res.rejected : []
  // which items got which verdict: ids only, so the editor's surface can be checked item by item
  summary({ written: res.written, alreadyWritten: res.alreadyWritten, rejected, unanswered: read.unanswered, unreadable: read.unreadable, jelzett: read.flags.filter((f) => f.flagged).length, flags: read.flags.map((f) => ({ targetId: f.targetId, flagged: f.flagged })) })
  say(`${o.runId}: ${String(res.written)} jelzes beirva (${read.flags.filter((f) => f.flagged).length} JELEZ), ${String(res.alreadyWritten)} mar bent, ${rejected.length} elutasitva, ${read.unanswered.length} itelet nelkul (var tovabb), ${read.unreadable} olvashatatlan sor. Osszegzes: ${join(o.outDir, 'sync.json')}`)
  return 0
}

export function parseArgs(argv: string[]): { set: SetName; limit: number; proba: boolean } | null {
  let set: SetName | null = null
  let limit = DEFAULT_LIMIT
  let proba = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--proba') proba = true
    else if (argv[i] === '--keszlet' && (argv[i + 1] === 't13' || argv[i + 1] === 't12')) set = argv[++i] as SetName
    else if (argv[i] === '--limit' && /^\d{1,2}$/.test(argv[i + 1] ?? '') && Number(argv[i + 1]) >= 1 && Number(argv[i + 1]) <= 50) limit = Number(argv[++i])
    else return null
  }
  return set ? { set, limit, proba } : null
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  if (!a) {
    process.stderr.write('Hasznalat: node dist/model-flag-sync.js --keszlet t13|t12 [--limit 1-50] [--proba]\n')
    process.exitCode = 2
    return
  }
  // the settings only now, so that a test importing this module reads no .env
  const cfg = await import('./config.js')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const runId = `os-jelzes-${a.set}-${stamp}`
  process.exitCode = await sync({
    ...a,
    api: process.env.STAGE_OS_API ?? STAGE_OS_API_DEFAULT,
    email: process.env.STAGE_OS_EMAIL ?? STAGE_OS_EMAIL_DEFAULT,
    passwordFile: join(cfg.STORE_DIR, '.stage-os-smoke-password'),
    outDir: join(cfg.PROJECT_ROOT, 'logs', 'gpt-csomag', runId),
    runId,
    // the same settings as the runner's own CLI (t13-flag-runner.ts main)
    pkg: {
      storeDir: cfg.STORE_DIR,
      envFile: join(cfg.PROJECT_ROOT, '.env'),
      logDir: join(cfg.PROJECT_ROOT, 'logs', 'gpt-csomag'),
      boundary: { python: 'python3', script: join(cfg.PROJECT_ROOT, 'scripts', 'gpt-csomag', 'hatar.py'), timeoutMs: 20_000 },
      maxBytes: 32 * 1024,
    },
    runner: {
      enabled: cfg.DEBATE_GPT_RUNNER_ENABLED,
      url: cfg.DEBATE_GPT_RUNNER_URL,
      tokenFile: cfg.DEBATE_GPT_RUNNER_TOKEN_FILE,
      timeoutMs: cfg.DEBATE_GPT_RUNNER_TIMEOUT_SECONDS * 1000,
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
