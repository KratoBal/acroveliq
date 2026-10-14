import type http from 'node:http'
import type os from 'node:os'

export const PORT: number
export const MAX_BODY: number
export const MAX_PROMPT: number
export const MAX_OUTPUT: number
export const PROMPT_FROM_STDIN: '-'
export const SERVICE_ARGS: readonly string[]
export interface CodexRun { code: number | null; out: string; timedOut: boolean; over: boolean }
export function listenAddress(ifaces?: ReturnType<typeof os.networkInterfaces>): string
export function tokenOk(header: unknown, hashHex: unknown): boolean
export function parseRequest(buf: Buffer): { prompt: string; error?: undefined } | { error: string; prompt?: undefined }
export function answerFrom(jsonl: string): { text: string; refused?: undefined } | { refused: string; text?: undefined }
export function capTake(file: string, day: string, cap: number): boolean
export function runCodex(args: readonly string[], prompt: string, timeoutMs: number, bin?: string): Promise<CodexRun>
export function createService(o: {
  hash: string
  cap: number
  timeoutMs: number
  stateFile: string
  run?: (args: readonly string[], prompt: string, timeoutMs: number) => Promise<CodexRun>
  now?: () => Date
  log?: (line: string) => void
}): http.Server
export function main(): Promise<void>
