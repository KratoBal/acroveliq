// The ACCESS_MODE switch as ONE named, logged step (acrobot 35368; P0-1 / B3; Balázs 2026-10-12: the
// installation is a separate approval, and switching the access check off in general is NOT a normal way
// back). Before this file the switch was two hand steps: edit the `ACCESS_MODE=` line in `.env`, restart
// the dashboard. The mode is read ONCE at start (src/config.ts ACCESS_MODE_SETTING, from `.env` only, not
// from the process environment), so a line edited and never restarted is a switch that has not happened,
// and a switch that has happened left only the start-up `Access check` log line behind.
//
// The step (scripts/access-mode.ts is the thin wire around runSwitch):
//   1. plan:   the target is one of the three positions (there is no "off"), a forward step is ONE
//              position at a time and carries an approval reference, and it needs two CLEAN daily
//              preflight runs one after the other (napi.tortenet); the way back is to `naplo` only,
//              with a reason;
//   2. write:  the `.env` line, one line, nothing else touched;
//   3. record: one JSON line in store/access-mode.log (who, from, to, the approval or reason, the
//              preflight it relied on);
//   4. restart the dashboard;
//   5. probe:  read-only calls whose answers tell the RUNNING mode (an unruled route is a 404 in
//              `naplo`, a 403 for the shared token in `legacy-szukitett`, a 403 for everyone in
//              `kikenyszerit`) and prove the main agent's fixed routes still answer 200;
//   6. a failed probe turns the setting back to the position the step STARTED from (one position, never
//      further: from a stricter position the check is never dropped to `naplo` by itself), restarts,
//      records it, and says so. `naplo` is reached only by hand, by the named `vissza` step with a reason.
// A dry run (`szaraz`) stops after the plan.

import { ACCESS_MODES, parseAccessMode, type AccessMode } from './access-enforcement.js'

export const ROLLBACK_TARGET: AccessMode = 'naplo'
/** Two clean daily runs: the older at least this long before the newer (a day, less the jitter of a schedule). */
export const CLEAN_RUNS_MIN_GAP_S = 20 * 3600
/** ... and the newer one not older than this (a missed day is not a clean day). */
export const CLEAN_RUN_MAX_AGE_S = 36 * 3600
export const SETTING = 'ACCESS_MODE'
/** The route the probes call: nothing answers it, so the matrix' default-deny decides. */
export const PROBE_UNRULED_PATH = '/api/access-mode-proba-nincs-ilyen-utvonal'

// ---- the preflight history --------------------------------------------------------------

export interface HistoryEntry {
  ts: number
  verdict: string
  rest: string
}

/** napi.tortenet: one `<epoch> <verdict> <first line of the report>` per daily run; bad lines are skipped, order kept. */
export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^(\d{9,11}) (\S+)(?: (.*))?$/.exec(line.trim())
    if (m) entries.push({ ts: Number(m[1]), verdict: m[2]!, rest: m[3] ?? '' })
  }
  return entries
}

export interface CleanRuns {
  ok: boolean
  reason: string
}

/**
 * "Two clean daily preflights one after the other": the newest run is RENDBEN and not stale, and walking
 * back through RENDBEN runs only (a JELZES or any other verdict in between breaks the chain) there is one
 * at least CLEAN_RUNS_MIN_GAP_S before it.
 */
export function cleanRuns(entries: readonly HistoryEntry[], now: number): CleanRuns {
  if (entries.length === 0) return { ok: false, reason: 'the daily preflight has no history yet (napi.tortenet is empty or missing)' }
  const newest = entries[entries.length - 1]!
  if (newest.verdict !== 'RENDBEN') return { ok: false, reason: `the newest daily preflight is ${newest.verdict}, not RENDBEN` }
  if (now - newest.ts > CLEAN_RUN_MAX_AGE_S) {
    return { ok: false, reason: `the newest clean daily preflight is ${Math.floor((now - newest.ts) / 3600)} hours old (limit ${CLEAN_RUN_MAX_AGE_S / 3600})` }
  }
  for (let i = entries.length - 2; i >= 0; i--) {
    const e = entries[i]!
    if (e.verdict !== 'RENDBEN') return { ok: false, reason: `a ${e.verdict} daily preflight stands between the clean runs: the chain starts again` }
    if (newest.ts - e.ts >= CLEAN_RUNS_MIN_GAP_S) return { ok: true, reason: 'two clean daily preflights, one after the other' }
  }
  return { ok: false, reason: `the clean daily preflights span less than ${CLEAN_RUNS_MIN_GAP_S / 3600} hours: one more clean day is needed` }
}

// ---- the plan ----------------------------------------------------------------------------

export interface PlanInput {
  from: AccessMode
  to: string
  /** The reference of the owner's explicit word (a Discord message id or a card comment), for a forward step. */
  approval?: string
  /** Why, for the way back. */
  reason?: string
  history: readonly HistoryEntry[]
  now: number
}

export type Plan =
  | { ok: true; kind: 'forward' | 'rollback'; from: AccessMode; to: AccessMode; preflight: string }
  | { ok: false; refusals: string[] }

const MIN_TEXT = 8

export function planTransition(input: PlanInput): Plan {
  const refusals: string[] = []
  const to = input.to.trim().toLowerCase()
  if (!(ACCESS_MODES as readonly string[]).includes(to)) {
    return { ok: false, refusals: [`${JSON.stringify(input.to)} is none of ${ACCESS_MODES.join(', ')}: there is no position that switches the check off`] }
  }
  const target = to as AccessMode
  const fromIndex = ACCESS_MODES.indexOf(input.from)
  const toIndex = ACCESS_MODES.indexOf(target)
  if (toIndex === fromIndex) return { ok: false, refusals: [`the setting is already ${target}`] }

  if (toIndex > fromIndex) {
    if (toIndex !== fromIndex + 1) {
      refusals.push(`one position at a time: ${input.from} goes to ${ACCESS_MODES[fromIndex + 1]}, not to ${target}`)
    }
    if ((input.approval ?? '').trim().length < MIN_TEXT) {
      refusals.push("a forward step names the owner's approval (--engedely): a Discord message id or a card comment, at least 8 characters")
    }
    const clean = cleanRuns(input.history, input.now)
    if (!clean.ok) refusals.push(`the preflight does not allow it: ${clean.reason}`)
    return refusals.length ? { ok: false, refusals } : { ok: true, kind: 'forward', from: input.from, to: target, preflight: clean.reason }
  }

  // the way back: to naplo, with a reason; never to "off" (there is none), never half way
  if (target !== ROLLBACK_TARGET) {
    refusals.push(`the way back goes to ${ROLLBACK_TARGET}, in one step`)
  }
  if ((input.reason ?? '').trim().length < MIN_TEXT) {
    refusals.push('the way back names its reason (--ok), at least 8 characters; it is an emergency path, the normal one is fixing the matrix')
  }
  return refusals.length ? { ok: false, refusals } : { ok: true, kind: 'rollback', from: input.from, to: target, preflight: 'not needed on the way back' }
}

// ---- the .env line -----------------------------------------------------------------------

/** The position the dashboard WOULD read from this `.env` text: the last `ACCESS_MODE=` line wins (src/env.ts), a typo is `kikenyszerit`. */
export function modeInEnv(envText: string): { mode: AccessMode; raw: string | undefined; problem: string | null } {
  let raw: string | undefined
  for (const line of envText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1 || trimmed.slice(0, eq).trim() !== SETTING) continue
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    raw = value
  }
  return { ...parseAccessMode(raw), raw }
}

/** The `.env` text with exactly one `ACCESS_MODE=<value>` line: the first one replaced, the others removed, appended when missing. Nothing else is touched. */
export function setModeInEnv(envText: string, value: AccessMode): string {
  const lines = envText.split('\n')
  const isSetting = (line: string) => {
    const t = line.trim()
    return !t.startsWith('#') && t.slice(0, Math.max(0, t.indexOf('='))).trim() === SETTING && t.includes('=')
  }
  let placed = false
  const out: string[] = []
  for (const line of lines) {
    if (!isSetting(line)) {
      out.push(line)
    } else if (!placed) {
      out.push(`${SETTING}=${value}`)
      placed = true
    }
  }
  if (!placed) {
    // before the trailing newline's empty element
    if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${SETTING}=${value}`)
    else out.push(`${SETTING}=${value}`)
  }
  return out.join('\n')
}

// ---- the probes --------------------------------------------------------------------------

export type ProbeCaller = 'L' | 'A'
export interface Probe {
  name: string
  caller: ProbeCaller
  path: string
  expected: number
}

/**
 * The read-only calls that tell the running mode and prove the main agent's fixed routes. `A` is the main
 * agent's own token, `L` the shared one. The unruled route has no handler: where the check lets the
 * request through it is a 404, where it holds the caller it is a 403 (the matrix is default-deny for
 * a route no rule answers). Nothing here writes.
 */
export function probesFor(mode: AccessMode, today: string): Probe[] {
  const unruled: Record<AccessMode, [number, number]> = {
    naplo: [404, 404], // [L, A]
    'legacy-szukitett': [403, 404],
    kikenyszerit: [403, 403],
  }
  const [forL, forA] = unruled[mode]
  return [
    { name: 'shared token, route no rule answers', caller: 'L', path: PROBE_UNRULED_PATH, expected: forL },
    { name: 'main agent token, route no rule answers', caller: 'A', path: PROBE_UNRULED_PATH, expected: forA },
    { name: 'main agent: agents', caller: 'A', path: '/api/agents', expected: 200 },
    { name: 'main agent: kanban', caller: 'A', path: '/api/kanban', expected: 200 },
    { name: 'main agent: messages', caller: 'A', path: '/api/messages?agent=__probe__', expected: 200 },
    { name: 'main agent: fixed read (access decisions)', caller: 'A', path: `/api/fleet-reads/access-decisions?nap=${today}`, expected: 200 },
  ]
}

/** The mode the answers of the first two probes (the unruled route) show. Null when they fit none. */
export function modeFromStatuses(forL: number, forA: number): AccessMode | null {
  for (const mode of ACCESS_MODES) {
    const probes = probesFor(mode, '2000-01-01')
    if (probes[0]!.expected === forL && probes[1]!.expected === forA) return mode
  }
  return null
}

// ---- the restart, proven ------------------------------------------------------------------

export interface RestartIo {
  /** The dashboard process's pid (supervisorctl pid dashboard); null when it cannot be read. */
  pid: () => Promise<number | null>
  /** supervisorctl restart dashboard; resolves its exit code (null when it could not be run). */
  restart: () => Promise<number | null>
  /** Does the dashboard answer (a 200 for the main agent)? */
  answers: () => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * A restart is a NEW process answering. supervisorctl's exit code alone proves nothing (the old process
 * keeps answering when it fails to stop, and a 200 from it would pass for "restarted"), and a 200 alone proves
 * nothing either: the pid before and after must differ (barracuda, #300 review).
 */
export async function restartDashboard(io: RestartIo, waitMs: number): Promise<{ ok: boolean; why: string }> {
  const before = await io.pid()
  if (before === null) return { ok: false, why: 'the dashboard pid could not be read before the restart: a restart cannot be proven' }
  const code = await io.restart()
  if (code !== 0) return { ok: false, why: `supervisorctl exited ${code === null ? 'without running' : code}: nothing was restarted` }
  const until = io.now() + waitMs
  let last: number | null = null
  while (io.now() < until) {
    await io.sleep(2000)
    last = await io.pid()
    if (last !== null && last !== before && (await io.answers())) return { ok: true, why: `new process ${last} (was ${before}) answers` }
  }
  return {
    ok: false,
    why: last === before ? `the same process (pid ${before}) is still there: nothing was restarted` : `no new process answered within ${Math.round(waitMs / 1000)} s (pid before ${before}, now ${last ?? 'unreadable'})`,
  }
}

// ---- the step ----------------------------------------------------------------------------

export interface SwitchRecord {
  ts: number
  utc: string
  kind: 'forward' | 'rollback' | 'auto-rollback'
  from: AccessMode
  to: AccessMode
  approval: string | null
  reason: string | null
  preflight: string
  result: 'ok' | 'probe-failed' | 'restart-failed'
  failed?: string[]
}

export interface SwitchDeps {
  now: () => number
  today: () => string
  readEnv: () => string
  writeEnv: (text: string) => void
  readHistory: () => string
  /** Appends one JSON line to store/access-mode.log. */
  record: (entry: SwitchRecord) => void
  /** Restarts the dashboard and waits until it answers; resolves false when it does not come back. */
  restart: () => Promise<boolean>
  /** One read-only call; resolves the status code, or 0 when the dashboard did not answer. */
  probe: (probe: Probe) => Promise<number>
}

export interface SwitchRequest {
  to: string
  approval?: string
  reason?: string
  dryRun?: boolean
}

export interface SwitchOutcome {
  ok: boolean
  /** Human lines, in order. */
  lines: string[]
  plan: Plan
  /** The position the system is in at the end; null when it is not known (the .env and the running dashboard may differ). */
  finalMode: AccessMode | null
}

async function probeAll(mode: AccessMode, deps: SwitchDeps): Promise<string[]> {
  const failed: string[] = []
  for (const p of probesFor(mode, deps.today())) {
    const got = await deps.probe(p)
    if (got !== p.expected) failed.push(`${p.name} (${p.path}): ${got}, expected ${p.expected}`)
  }
  return failed
}

function recordOf(deps: SwitchDeps, kind: SwitchRecord['kind'], from: AccessMode, to: AccessMode, req: SwitchRequest, preflight: string, result: SwitchRecord['result'], failed?: string[]): SwitchRecord {
  const ts = deps.now()
  return {
    ts,
    utc: new Date(ts * 1000).toISOString(),
    kind,
    from,
    to,
    approval: req.approval?.trim() || null,
    reason: req.reason?.trim() || null,
    preflight,
    result,
    ...(failed ? { failed } : {}),
  }
}

/** The whole step; every side effect goes through deps, so the test drives it with fakes. */
export async function runSwitch(req: SwitchRequest, deps: SwitchDeps): Promise<SwitchOutcome> {
  const envText = deps.readEnv()
  const current = modeInEnv(envText)
  const plan = planTransition({ from: current.mode, to: req.to, approval: req.approval, reason: req.reason, history: parseHistory(deps.readHistory()), now: deps.now() })
  const lines: string[] = [`the setting in .env: ${current.raw === undefined ? '(none, so naplo)' : current.raw} -> reads as ${current.mode}`]
  if (current.problem) lines.push(`WARNING: ${current.problem}`)
  if (!plan.ok) {
    lines.push(...plan.refusals.map((r) => `REFUSED: ${r}`))
    return { ok: false, lines, plan, finalMode: current.mode }
  }
  lines.push(`plan: ${plan.kind} ${plan.from} -> ${plan.to} (${plan.preflight})`)
  if (req.dryRun) {
    lines.push('dry run: nothing written, nothing restarted')
    return { ok: true, lines, plan, finalMode: current.mode }
  }

  deps.writeEnv(setModeInEnv(envText, plan.to))
  lines.push(`.env: ${SETTING}=${plan.to}`)
  const restarted = await deps.restart()
  if (!restarted) {
    // the line is written but no NEW dashboard answered (the old one may still): the line goes back to the position the step started
    // from, written onto a FRESH read of .env (anything else written in the meantime stays), and the dashboard is restarted once more
    deps.writeEnv(setModeInEnv(deps.readEnv(), plan.from))
    deps.record(recordOf(deps, plan.kind, plan.from, plan.to, req, plan.preflight, 'restart-failed'))
    const back = await deps.restart()
    if (!back) lines.unshift(`UNKNOWN STATE: the .env says ${plan.from} and the running dashboard may be in another position; run \`allapot\``)
    lines.push(`FAILED: no new dashboard answered after the restart; the .env line is put back to ${plan.from} (${back ? 'a new process answers again' : 'IT DOES NOT ANSWER: look at supervisorctl status dashboard'})`)
    return { ok: false, lines, plan, finalMode: back ? plan.from : null }
  }
  const failed = await probeAll(plan.to, deps)
  if (failed.length === 0) {
    deps.record(recordOf(deps, plan.kind, plan.from, plan.to, req, plan.preflight, 'ok'))
    lines.push(`restarted; ${probesFor(plan.to, deps.today()).length} probes agree with ${plan.to}`)
    return { ok: true, lines, plan, finalMode: plan.to }
  }

  // a probe failed: back to the position the step STARTED from, at once, and said aloud. One position, never further: from a stricter
  // position the check is not dropped to naplo by itself (acrobot 35377); naplo is reached by hand, with the `vissza` step.
  deps.record(recordOf(deps, plan.kind, plan.from, plan.to, req, plan.preflight, 'probe-failed', failed))
  lines.push(...failed.map((f) => `PROBE FAILED: ${f}`))
  if (plan.kind === 'rollback') {
    lines.push('the step was the way back itself: nothing further to turn back to; look at the probes above')
    return { ok: false, lines, plan, finalMode: plan.to }
  }
  deps.writeEnv(setModeInEnv(deps.readEnv(), plan.from))
  const back = await deps.restart()
  const backFailed = back ? await probeAll(plan.from, deps) : ['no new dashboard answered after the restart']
  deps.record(recordOf(deps, 'auto-rollback', plan.to, plan.from, { ...req, reason: `probe failed after ${plan.to}` }, 'automatic', backFailed.length === 0 ? 'ok' : 'probe-failed', backFailed.length ? backFailed : undefined))
  if (backFailed.length) lines.unshift(`UNKNOWN STATE: the .env says ${plan.from}; the running dashboard may not be in it (${backFailed.join('; ')}); run \`allapot\``)
  lines.push(`turned back to ${plan.from}${backFailed.length === 0 ? ' and the probes agree' : `, BUT: ${backFailed.join('; ')}`}`)
  return { ok: false, lines, plan, finalMode: backFailed.length === 0 ? plan.from : null }
}
