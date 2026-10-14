// Types for proba.mjs (plain JS in the image: no build step inside the runner container).
export type Verdict = 'OK' | 'FAIL' | 'NEM_MERHETO'
export type Say = (id: string, verdict: Verdict, detail: string) => void
export type RunResult = { code: number; out: string }
export type Run = (cmd: string, args: string[]) => RunResult

export const FLEET_IDS: number[]
export const RUNNER_ID: number
export const RUNNER_HOME: string
export function checkHome(home: string | undefined): [Verdict, string]
export const CLOSED_PORTS: number[]
export const HOST_PORTS: number[]
export const SYSTEM_EXACT: string[]
export const PINNED_CODEX: string
export const SYSTEM_PREFIXES: string[]
export const FLEET_MARKERS: RegExp
export const NET_PROBE: string[]
export const WRITE_PROBE: string[]
export const SANDBOX_FORMS: string[][]

export function idsFromStatus(status: string): { uid: number[]; gid: number[]; groups: number[] }
export function checkIds(ids: { uid: number[]; gid: number[]; groups: number[] }): [Verdict, string]
export function checkCaps(status: string): [Verdict, string]
export function classifyReadable(paths: string[], ownHome?: string | null): { outside: string[]; marked: string[]; own: string[] }
export function judgeNetwork(
  results: Array<{ host: string; port: number; open: boolean }>,
  control: { host: string; port: number; open: boolean },
): [Verdict, string]
export function judgeSandboxRun(r: RunResult): 'usage' | 'never-started' | 'allowed' | 'blocked'
export function networkTargets(gateway: string | null, hostAddrs: string[], fleetAddrs: string[]): Array<{ host: string; port: number }>
export function globalIpv6(ifInet6: string): string[]
export function checkIpv6(ifInet6: string): [Verdict, string]
export function summarize(lines: Array<[string, string, string]>): { ok: number; fail: number; nem: number }
export function codexSandboxChecks(say: Say, run: Run): Promise<void>
export function main(): Promise<void>
