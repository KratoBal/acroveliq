// The router's side of the root broker into agent panes (scripts/root/fleet-pane.py; B48 (2),
// P1-13, task t-20261015-b48-fleet-pane; plan exchange/biztonsag/baseline/b48-kezbesito-terv-2026-10-13.md).
//
// With FLEET_PANE_BROKER=on (default OFF), every tmux call aimed at an agent that runs under
// its own OS user goes through `sudo -n /usr/local/sbin/fleet-pane <verb>` instead of
// `sudo -n -u <user> tmux <anything>`:
//   - the read and lifecycle shapes (has-session, list-sessions, display-message
//     #{session_created}, capture-pane, kill-session) are translated to a verb here;
//   - typing goes through the broker's own verbs (deliver, dismiss, clear, submit, interrupt),
//     called by the router's typing functions (agent-process.ts), and the broker looks at the
//     pane before every key: the router's look is no longer the gate;
//   - a start goes through `generate` (the broker rewrites the agent's root-owned start script
//     from root's files and value-set-checked config fields) and `start` (that script, with one
//     item of the closed launch list): brokerStartAgent below, called by startAgentProcess;
//   - any other tmux shape (raw send-keys, run-shell, new-session, ...) has NO verb and is refused
//     here, loudly: an unknown call must not fall back to the old sudo line.
// The switch goes on only after the broker is installed (Balázs's step), on the stage first.
import { execFile, execFileSync } from 'node:child_process'
import { FLEET_PANE_BROKER } from '../config.js'

/** The installed broker. Fixed: sudo allows only this path, and the repo copy must never run. */
export const FLEET_PANE_BIN = '/usr/local/sbin/fleet-pane'

let brokerOverride: boolean | null = null
export function fleetPaneBrokerOn(): boolean {
  return brokerOverride ?? FLEET_PANE_BROKER
}
export function _setFleetPaneBrokerForTest(on: boolean | null): void {
  brokerOverride = on
}

/** The agent name behind a session name (`agent-<name>`), or null. */
export function agentOfSession(session: string): string | null {
  const m = /^agent-([a-z][a-z0-9-]{1,30})$/.exec(session)
  return m ? m[1]! : null
}

/**
 * The broker verb for a tmux call aimed at `agent`, or null when the shape has no verb (refused).
 * Only the exact read and lifecycle shapes the router uses are known; anything else is null. A
 * new-session is null too: the router's command string must never reach the broker, a start is
 * brokerStartAgent.
 */
export function brokerArgsForTmux(tmuxArgs: readonly string[], agent: string): string[] | null {
  const a = [...tmuxArgs]
  const session = `agent-${agent}`
  const targets = (i: number) => a[i] === '-t' && a[i + 1] === session
  switch (a[0]) {
    case 'has-session':
      return a.length === 3 && targets(1) ? ['status', agent] : null
    case 'list-sessions':
      // the broker's status prints the session name when it runs: the same answer for one agent
      return a.length === 3 && a[1] === '-F' && a[2] === '#{session_name}' ? ['status', agent] : null
    case 'display-message':
      return a.length === 5 && a[1] === '-p' && targets(2) && a[4] === '#{session_created}' ? ['status', agent, '--created'] : null
    case 'kill-session':
      return a.length === 3 && targets(1) ? ['stop', agent] : null
    case 'capture-pane': {
      if (!targets(1)) return null
      const out = ['capture', agent]
      const rest = a.slice(3)
      if (!rest.includes('-p')) return null
      for (let i = 0; i < rest.length; i++) {
        const f = rest[i]
        if (f === '-p') continue
        if (f === '-e') out.push('--ansi')
        else if (f === '-S' && /^-[1-9][0-9]{0,3}$/.test(rest[i + 1] ?? '') && Number(rest[i + 1]!.slice(1)) <= 2000) {
          out.push('--lines', rest[i + 1]!.slice(1))
          i++
        } else return null
      }
      return out
    }
    default:
      return null
  }
}

/** The invocation for one broker call. */
export function brokerInvocation(verbArgs: readonly string[]): { file: string; args: string[] } {
  return { file: 'sudo', args: ['-n', FLEET_PANE_BIN, ...verbArgs] }
}

export interface BrokerResult {
  /** 0 done; 10 refused before any key; 11 typed but not landed; 12 nothing to do; 13 tmux failed; other: error */
  code: number
  out: string
}

type ExecFileLike = typeof execFile
let execImpl: ExecFileLike = execFile
let execSyncImpl: typeof execFileSync = execFileSync
export function _setBrokerExecForTest(e: ExecFileLike | null, s: typeof execFileSync | null = null): void {
  execImpl = e ?? execFile
  execSyncImpl = s ?? execFileSync
}

/** One broker call, async (deliver can take seconds: it must not block the event loop). */
export function callBroker(verbArgs: readonly string[], input?: string, timeoutMs = 60_000): Promise<BrokerResult> {
  const inv = brokerInvocation(verbArgs)
  return new Promise((resolve) => {
    const child = execImpl(inv.file, inv.args, { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0
      resolve({ code, out: String(stdout ?? '').trim() })
    })
    if (input !== undefined) {
      child.stdin?.end(input)
    } else {
      child.stdin?.end()
    }
  })
}

/** One short broker call, sync (submit: one look and one key). */
export function callBrokerSync(verbArgs: readonly string[]): BrokerResult {
  const inv = brokerInvocation(verbArgs)
  try {
    const out = execSyncImpl(inv.file, inv.args, { timeout: 10_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out: String(out).trim() }
  } catch (err) {
    const status = (err as { status?: unknown }).status
    return { code: typeof status === 'number' ? status : -1, out: String((err as { stdout?: unknown }).stdout ?? '').trim() }
  }
}

/**
 * Start an agent through the broker: `generate` rewrites its start script, `start` runs it.
 * `launch` is the closed list (nautilus 31151): [] | ['--continue'] | ['--session-id', <uuid>];
 * the broker checks it again. A refusal names the broker's reason (model-not-allowed,
 * profile-mismatch, claude-bin-..., running) and nothing was started.
 */
export async function brokerStartAgent(agent: string, launch: readonly string[]): Promise<{ ok: boolean; error?: string }> {
  const gen = await callBroker(['generate', agent], undefined, 30_000)
  if (gen.code !== 0) return { ok: false, error: `fleet-pane generate refused: ${gen.out || gen.code}` }
  const st = await callBroker(['start', agent, ...launch], undefined, 30_000)
  if (st.code !== 0) return { ok: false, error: `fleet-pane start refused: ${st.out || st.code}` }
  return { ok: true }
}

/** The broker's deliver limit (scripts/root/fleet-pane.py MAX_TEXT), and its piece size. */
export const DELIVER_MAX_CHARS = 32_000
const DELIVER_PIECE = 80

/**
 * How long a deliver of `chars` characters may take: 30 s for the looks and the Enter retries,
 * plus 250 ms per piece (a look, a send and a 30 ms pause, each through runuser). For the
 * broker's longest text (400 pieces) that is 130 s; a fixed 60 s could cut a long message
 * half-typed (barracuda, #182).
 */
export function deliverTimeoutMs(chars: number): number {
  return 30_000 + 250 * Math.ceil(Math.min(Math.max(chars, 0), DELIVER_MAX_CHARS) / DELIVER_PIECE)
}

/** The router's sendPromptToSession outcome for a broker deliver result. */
export function deliverOutcome(r: BrokerResult): 'sent' | 'not-landed' | 'aborted-busy' {
  if (r.code === 0) return 'sent'
  if (r.code === 10 && /^busy(@confirm)?$/.test(r.out)) return 'aborted-busy'
  return 'not-landed'
}
