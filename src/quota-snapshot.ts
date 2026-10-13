// Reads the fleet's quota state and hands it to the pure gate in quota-gate.ts.
//
// Two inputs, the newer one wins:
//
//   store/measurements/quota-samples.jsonl -- one line per statusline render
//     (scripts/measure-statusline.py, at most every 5 minutes fleet-wide), with
//     the rate_limits Claude Code itself reports. This is the live source.
//   store/usage-latest.json -- scripts/usage-collect.py's snapshot. Nothing
//     schedules that collector today (measured 2026-10-13: the file does not
//     exist), so reading only this file left the gate blind: it failed open on
//     every tick and never held anything back.
//
// Everything here degrades to null: a missing file, a half-written line, a
// shape we do not recognise. Null means "we do not know", and the gate treats
// not-knowing as permission to run (see quota-gate.ts, FAIL OPEN) -- the caller
// is expected to SAY so (quotaInputProblem), not to stay silent.

import { closeSync, openSync, readFileSync, readSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import type { QuotaSnapshot } from './quota-gate.js'
import { parseQuotaSampleLine } from './web/measurements.js'

export const USAGE_SNAPSHOT_PATH = join(STORE_DIR, 'usage-latest.json')
export const QUOTA_SAMPLES_PATH = join(STORE_DIR, 'measurements', 'quota-samples.jsonl')

/** The statusline log only grows; its newest sample is in the last few lines. */
const SAMPLES_TAIL_BYTES = 16 * 1024

/**
 * Map the collector's on-disk JSON onto the gate's input shape.
 * Exported separately from the file read so the mapping is unit-testable.
 */
export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const claude = root.claude
  if (!claude || typeof claude !== 'object') return null
  const c = claude as Record<string, unknown>

  // generated_at is an ISO-8601 string on disk; the gate wants epoch ms.
  let generatedAtMs: number | null = null
  if (typeof root.generated_at === 'string') {
    const parsed = Date.parse(root.generated_at)
    if (!Number.isNaN(parsed)) generatedAtMs = parsed
  }

  const windows = c.windows && typeof c.windows === 'object'
    ? (c.windows as QuotaSnapshot['windows'])
    : null

  return {
    source: typeof c.source === 'string' ? c.source : null,
    generatedAtMs,
    windows,
  }
}

/**
 * The newest usable statusline sample in `text` (JSONL), as a gate snapshot.
 * Scans from the end, so a torn last line falls back to the one before it.
 */
export function parseLatestQuotaSample(text: string): QuotaSnapshot | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseQuotaSampleLine(lines[i])
    if (!s) continue
    return {
      source: s.source,
      generatedAtMs: s.sampled_at * 1000,
      windows: {
        five_hour: { used_percent: s.five_hour_pct, resets_at: s.five_hour_resets_at },
        seven_day: { used_percent: s.seven_day_pct, resets_at: s.seven_day_resets_at },
      },
    }
  }
  return null
}

function readFileTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

export function readQuotaSnapshot(
  paths: { usageLatest?: string; samples?: string } = {},
): QuotaSnapshot | null {
  const candidates: QuotaSnapshot[] = []
  try {
    const s = parseLatestQuotaSample(readFileTail(paths.samples ?? QUOTA_SAMPLES_PATH, SAMPLES_TAIL_BYTES))
    if (s) candidates.push(s)
  } catch { /* missing or unreadable: not a candidate */ }
  try {
    const s = parseQuotaSnapshot(JSON.parse(readFileSync(paths.usageLatest ?? USAGE_SNAPSHOT_PATH, 'utf-8')))
    if (s) candidates.push(s)
  } catch { /* missing or unreadable: not a candidate */ }
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => ((b.generatedAtMs ?? -Infinity) > (a.generatedAtMs ?? -Infinity) ? b : a))
}
