// The debate controller's side of the GPT runner's channel (task t-20261014-gpt-futtato-kontener;
// acrobot 30864/30868, barracuda 30866). The runner's side is gpt-runner/szolga.mjs.
//
// The switch (DEBATE_GPT_RUNNER_ENABLED) is off by default, and it cannot be switched on by a
// setting alone: the controller gets a runner ONLY together with the conversation package and its
// filters (src/gpt-package.ts, PR 2 of the multi-model plan). Without them, `on` still gives
// `runGpt: null` and one log line, so an unfiltered thread text can never reach the runner through
// a wrong setting (barracuda 30866, point 4).
//
// Every round is a new Codex run: whether `codex exec resume` keeps the read-only sandbox and the
// tools-off flags is not provable from the 0.159.3 source, so there is no session (acrobot 30864).
import { readFileSync } from 'node:fs'
import type { Debate, DebateDeps, GptAnswer } from './debates.js'
import { FINAL_MARK, GptOutputBlocked, type GptPackage } from './gpt-package.js'

/** The runner could not be reached at all (refused, reset, timed out): most likely the service is
 *  not running (the systemd unit past its restart limit). Safe to post; it names the host command. */
export class GptRunnerUnavailable extends Error {
  readonly publicMessage = 'GPT most nem szólhat: a futtató nem érhető el, valószínűleg a szolgáltatás nem fut (a hoston: systemctl status gpt-szolga.service).'
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'GptRunnerUnavailable'
  }
}

/** The package sent out, and the check of what comes back (src/gpt-package.ts gives both). */
export interface GptFilters {
  /** The filtered package for this turn; throws GptBlocked when it must not go out. */
  buildPrompt(debate: Debate, ask: string): Promise<GptPackage>
  /** Whether GPT's answer may be posted (the output filter, barracuda 30721). */
  allowOutput(text: string): boolean
}

/** GPT's answer, and whether its last line is the end mark (then the mark is not posted). */
export function readFinal(text: string): { text: string; final: boolean } {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines[lines.length - 1]!.trim() !== FINAL_MARK) return { text, final: false }
  const rest = lines.slice(0, -1).join('\n').replace(/\s+$/, '')
  return rest ? { text: rest, final: true } : { text, final: false }
}

export interface RunnerClientOptions {
  enabled: boolean
  url: string
  tokenFile: string
  timeoutMs: number
  filters: GptFilters | null
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

/** The runner's address: plain http to an IPv4 address and port, nothing else (no name, no path). */
export function runnerEndpoint(url: string): string | null {
  const m = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\/?$/.exec(url.trim())
  if (!m || m[1]!.split('.').some((o) => Number(o) > 255) || Number(m[2]) > 65535) return null
  return `http://${m[1]}:${m[2]}/futtat`
}

/** The token, read at every call (a rotation needs no restart); missing or malformed: no call. */
export function readRunnerToken(file: string): string | null {
  let raw: string
  try { raw = readFileSync(file, 'utf8').trim() } catch { return null }
  return /^[A-Za-z0-9._~+/=-]{16,512}$/.test(raw) ? raw : null
}

/**
 * The controller's `runGpt`, or null. Null unless the switch is on AND the address is valid AND
 * the filters exist; each missing condition is said once in the log.
 */
export function makeRunGpt(o: RunnerClientOptions): DebateDeps['runGpt'] {
  const log = o.log ?? (() => {})
  if (!o.enabled) return null
  if (!o.filters) {
    log('GPT-futtato: a kapcsolo be van kapcsolva, de nincs csomag-epito es szuro (2. PR): a GPT-oldal kikapcsolva marad')
    return null
  }
  const endpoint = runnerEndpoint(o.url)
  if (!endpoint) {
    log('GPT-futtato: a DEBATE_GPT_RUNNER_URL nem http://<IPv4>:<port> alaku: a GPT-oldal kikapcsolva marad')
    return null
  }
  const filters = o.filters
  const doFetch = o.fetchImpl ?? fetch
  return async (debate: Debate, ask: string): Promise<GptAnswer> => {
    // throws GptBlocked when a filter stops it: the controller says which piece, nothing was sent
    const pkg = await filters.buildPrompt(debate, ask)
    const token = readRunnerToken(o.tokenFile)
    if (!token) throw new Error('nincs olvashato futtato-token')
    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: pkg.prompt }),
        signal: AbortSignal.timeout(o.timeoutMs),
        redirect: 'error',
      })
    } catch (err) {
      throw new GptRunnerUnavailable(err instanceof Error ? err.message : String(err))
    }
    if (!res.ok) throw new Error(`a futtato ${res.status} valaszt adott`)
    const body = (await res.json()) as unknown
    const text = body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text : null
    if (text == null || !text.trim()) throw new Error('a futtato valasza nem tartalmaz szoveget')
    if (!filters.allowOutput(text)) throw new GptOutputBlocked('a valasz a kimeneti titok-szuron fennakadt')
    return { ...readFinal(text), ...(pkg.notice ? { notice: pkg.notice } : {}) }
  }
}
