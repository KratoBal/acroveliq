// The GPT debate package and its filters: the multi-model plan's PR 2 (task
// t-20261014-gpt-futtato-kontener; nautilus's plan, point 2; barracuda 30721).
//
// WHAT GOES OUT: only this debate's own record. The owner's messages (debate_owner_messages) and
// the texts the controller itself posted (debate_turns, answered: Acrobot's and GPT's), in time
// order, with the project and the topic. Nothing else reaches the tables (another author, the
// approval path's request, Acrobot outside a round), so nothing else can go out.
//
// THE FILTERS, in this order, each one closed on failure (no send, the thread is told which
// message stopped it, never its content):
//   1. secrets, on every raw piece: the repository's secret shapes (src/security/secret-gate.ts)
//      and the fleet's own token VALUES read from the store, verbatim;
//   2. personal data: the whole body through scripts/gpt-csomag/hatar.py, the JEV boundary's
//      redactor in its full mode, behind its leak gate (names, e-mails, phones, addresses... are
//      replaced by placeholders); a refusal there blocks;
//   3. the size limit: the oldest messages are left out, and the thread is told how many.
// Every package that goes out is logged by its SHA-256 and size, never its text.
//
// THE WAY BACK: GPT's answer passes the secret filter (1) before it is posted; a hit blocks it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Debate } from './debates.js'
import { SECRET_PATTERNS } from './security/secret-gate.js'

/** GPT's answer the output filter stopped (the runner WAS called: an attempt). Safe to post. */
export class GptOutputBlocked extends Error {
  readonly publicMessage = 'GPT válasza a kimeneti titok-szűrőn fennakadt, nem került ki (a részlet a naplóban).'
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'GptOutputBlocked'
  }
}

/** A package the filters stopped. The message is safe to post: it names the piece, not its content. */
export class GptBlocked extends Error {
  constructor(readonly publicMessage: string, readonly reason: string) {
    super(reason)
    this.name = 'GptBlocked'
  }
}

export interface GptPackage {
  prompt: string
  /** Said in the thread before GPT's answer (e.g. older messages left out). */
  notice?: string
}

export interface PackageOptions {
  storeDir: string
  /** The dashboard's .env: the VALUES of its secret-named settings are compared too (barracuda, #149). */
  envFile?: string
  logDir: string
  /** The boundary script and the interpreter; a test may point them elsewhere. */
  boundary: { python: string; script: string; env?: Record<string, string>; timeoutMs: number }
  maxBytes: number
  now?: () => Date
}

/** The marker GPT ends its answer with when the phase may stop (read by the client). */
export const FINAL_MARK = '[VÉGE]'

// ---------------------------------------------------------------------------
// The source: this debate's own record only
// ---------------------------------------------------------------------------

export interface PackagePiece { who: 'gazda' | 'acrobot' | 'gpt'; label: string; text: string; at: number }

export function debatePieces(db: Database.Database, debate: Debate): PackagePiece[] {
  const owner = db.prepare('SELECT text, at FROM debate_owner_messages WHERE debate_id = ? ORDER BY at, message_id')
    .all(debate.id) as { text: string; at: number }[]
  const turns = db.prepare(`SELECT speaker, round, kind, text, answered_at FROM debate_turns
                            WHERE debate_id = ? AND status = 'answered' AND text IS NOT NULL ORDER BY answered_at, id`)
    .all(debate.id) as { speaker: 'acrobot' | 'gpt'; round: number; kind: string; text: string; answered_at: number }[]
  const pieces: PackagePiece[] = [
    ...owner.map((o, i) => ({ who: 'gazda' as const, label: `Balázs ${i + 1}. üzenete`, text: o.text, at: o.at })),
    ...turns.map((t) => ({
      who: t.speaker,
      label: `${t.speaker === 'acrobot' ? 'Acrobot' : 'GPT'} ${t.kind === 'summary' ? 'összegzése' : t.kind === 'direct' ? 'közvetlen válasza' : `${t.round}. körös válasza`}`,
      text: t.text,
      at: t.answered_at,
    })),
  ]
  // stable: by time, the owner first at the same second (he wrote, then the controller answered)
  return pieces.map((p, i) => ({ p, i })).sort((a, b) => a.p.at - b.p.at || a.i - b.i).map(({ p }) => p)
}

// ---------------------------------------------------------------------------
// Filter 1: secrets
// ---------------------------------------------------------------------------

/** The names of .env settings whose values are secrets (a token, a key, a secret, a password). */
export const SECRET_SETTING = /(TOKEN|KEY|SECRET|PASS|PASSWORD|CREDENTIAL)/i

/** The VALUES of the secret-named settings of an .env file (16 characters or more). */
export function envSecretValues(envFile: string | undefined): string[] {
  if (!envFile) return []
  let raw: string
  try { raw = readFileSync(envFile, 'utf8') } catch { return [] }
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || !SECRET_SETTING.test(m[1]!)) continue
    const v = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
    if (v.length >= 16) out.push(v)
  }
  return out
}

/** The fleet's own secret VALUES, read at every call (a rotation needs no restart): the store's
 *  token files, and the secret-named settings of the dashboard's .env. */
export function knownSecretValues(storeDir: string, envFile?: string): string[] {
  const files = ['.dashboard-token', '.gpt-futtato-token', '.federation-token', '.claude-oauth-token', '.github-token', '.vault-key']
  try {
    for (const f of readdirSync(join(storeDir, 'tokens'))) if (f.endsWith('.token')) files.push(join('tokens', f))
  } catch { /* no per-agent tokens */ }
  const out: string[] = []
  for (const f of files) {
    try {
      const v = readFileSync(join(storeDir, f), 'utf8').trim()
      if (v.length >= 16) out.push(v)
    } catch { /* missing or not readable: nothing to compare */ }
  }
  return [...out, ...envSecretValues(envFile)]
}

/** The name of the secret found in a text, or null. */
export function secretIn(text: string, known: string[]): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) if (pattern.test(text)) return name
  for (const v of known) if (text.includes(v)) return 'a flotta egyik tokenje'
  return null
}

// ---------------------------------------------------------------------------
// Filter 2: personal data (the JEV boundary, full mode)
// ---------------------------------------------------------------------------

export function redactBody(text: string, b: PackageOptions['boundary']): Promise<{ ok: true; text: string; counts: Record<string, number> } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (r: { ok: true; text: string; counts: Record<string, number> } | { ok: false; why: string }) => { if (!done) { done = true; resolve(r) } }
    const child = spawn(b.python, ['-I', b.script], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...(b.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, why: 'a szemelyesadat-szuro nem valaszolt idoben' }) }, b.timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); finish({ ok: false, why: 'a szemelyesadat-szuro nem indult el' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return finish({ ok: false, why: `a szemelyesadat-szuro hibaval allt le (${code})` })
      try {
        const r = JSON.parse(out) as { ok?: unknown; text?: unknown; counts?: unknown; why?: unknown }
        if (r.ok === true && typeof r.text === 'string' && r.text.trim()) return finish({ ok: true, text: r.text, counts: (r.counts ?? {}) as Record<string, number> })
        return finish({ ok: false, why: typeof r.why === 'string' ? r.why : 'a szemelyesadat-szuro elutasitotta' })
      } catch {
        return finish({ ok: false, why: 'a szemelyesadat-szuro valasza nem olvashato' })
      }
    })
    child.stdin.end(JSON.stringify({ text }))
  })
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

function render(debate: Debate, pieces: PackagePiece[], dropped: number, ask: string): string {
  const lines = [
    `Ez egy vita a(z) ${debate.project} projektről. Résztvevők: [gazda] Balázs, a döntéshozó; [acrobot] Acrobot, Balázs asszisztense; [gpt] te.`,
    'A döntést egyikőtök sem mondja ki, az a gazdáé. A szövegben a személyes adatok helyőrzőre cserélve (például <PERSON_1>).',
    `Téma: ${debate.topic}`,
    '--- a beszélgetés eddig ---',
    ...(dropped ? [`(a régebbi ${dropped} üzenet a méretkorlát miatt kimaradt)`] : []),
    ...pieces.map((p) => `[${p.who}] ${p.text}`),
    '--- a feladatod ---',
    ask,
  ]
  return lines.join('\n')
}

/**
 * Builds the package for one GPT run, or throws GptBlocked. `ask` is the controller's request for
 * this run (it may carry the owner's own words, so it is filtered like the rest).
 */
export async function buildPackage(db: Database.Database, debate: Debate, ask: string, o: PackageOptions): Promise<GptPackage> {
  const all = debatePieces(db, debate)
  const known = knownSecretValues(o.storeDir, o.envFile)
  // 1. secrets, on every raw piece, before anything leaves this process (the boundary script too)
  for (const [label, text] of [['A vita témája', debate.topic] as const, ...all.map((p) => [p.label, p.text] as const), ['A GPT-nek szóló kérés', ask] as const]) {
    const hit = secretIn(text, known)
    if (hit) {
      logPackage(o, { debate: debate.id, result: 'titok', reason: hit })
      throw new GptBlocked(`GPT most nem kapja meg a beszélgetést: ${label} titok-alakot tartalmaz (${hit}). Írd át, vagy töröld a szálból, és kérd újra.`, `secret: ${hit}`)
    }
  }
  // 3. the size limit (counted on the raw text; the redacted one is not longer by much)
  let dropped = 0
  let pieces = all
  while (pieces.length && Buffer.byteLength(render(debate, pieces, dropped, ask)) > o.maxBytes) { pieces = pieces.slice(1); dropped++ }
  const body = render(debate, pieces, dropped, ask)
  if (Buffer.byteLength(body) > o.maxBytes) {
    logPackage(o, { debate: debate.id, result: 'meret', bytes: Buffer.byteLength(body) })
    throw new GptBlocked('GPT most nem kapja meg a beszélgetést: a téma és a kérés maga is túl hosszú.', 'size')
  }
  // 2. personal data, on the whole body at once (one placeholder per person across the messages)
  const r = await redactBody(body, o.boundary)
  if (!r.ok) {
    logPackage(o, { debate: debate.id, result: 'szemelyes-adat', reason: r.why })
    throw new GptBlocked('GPT most nem kapja meg a beszélgetést: a személyesadat-szűrő nem engedte ki (a részlet a naplóban).', `personal data: ${r.why}`)
  }
  // internal addresses the redactor left (barracuda, #149), then a last secret look at what goes out
  const masked = maskInternalIpv4(r.text)
  r.text = masked.text
  if (masked.count) r.counts = { ...r.counts, BELSO_IP: masked.count }
  const late = secretIn(r.text, known)
  if (late) {
    logPackage(o, { debate: debate.id, result: 'titok', reason: late })
    throw new GptBlocked(`GPT most nem kapja meg a beszélgetést: a kész csomag titok-alakot tartalmaz (${late}).`, `secret after redaction: ${late}`)
  }
  logPackage(o, { debate: debate.id, result: 'kiment', sha256: createHash('sha256').update(r.text).digest('hex'), bytes: Buffer.byteLength(r.text), dropped, counts: r.counts })
  return { prompt: r.text, ...(dropped ? { notice: `A GPT-nek küldött csomagból a régebbi ${dropped} üzenet a méretkorlát miatt kimaradt.` } : {}) }
}

/** GPT's answer may be posted only without a secret shape or a fleet token in it. */
export function outputAllowed(text: string, o: Pick<PackageOptions, 'storeDir' | 'envFile'>): boolean {
  return secretIn(text, knownSecretValues(o.storeDir, o.envFile)) == null
}

/** Private, tailnet, loopback and link-local IPv4 addresses (with a port, if any). The JEV
 *  redactor misses one at the end of a sentence ("10.0.2.4."); these are infrastructure, not
 *  personal data, and do not go out either (barracuda, #149). */
export const INTERNAL_IPV4 = /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?::\d{1,5})?(?!\d)/g

/** Each internal address becomes a stable placeholder (the same address, the same placeholder). */
export function maskInternalIpv4(text: string): { text: string; count: number } {
  const seen = new Map<string, string>()
  const out = text.replace(INTERNAL_IPV4, (ip) => {
    if (!seen.has(ip)) seen.set(ip, `<BELSO_IP_${seen.size + 1}>`)
    return seen.get(ip)!
  })
  return { text: out, count: seen.size }
}

/** One line per package: its hash and size, never its text. */
export function logPackage(o: PackageOptions, entry: Record<string, unknown>): void {
  try {
    mkdirSync(o.logDir, { recursive: true, mode: 0o750 })
    const at = (o.now ?? (() => new Date()))()
    appendFileSync(join(o.logDir, `${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ at: at.toISOString(), ...entry })}\n`, { mode: 0o640 })
  } catch { /* the log must not stop the debate; a missing line is seen at the next audit */ }
}
