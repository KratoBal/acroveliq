// Reads the fleet's quota state and hands it to the pure gate in quota-gate.ts.
//
// The ONLY input is store/quota-gate-sample.json: one statusline sample (the
// rate_limits Claude Code itself reports), written by scripts/
// measure-statusline.py when it runs as the router user -- the same user as
// this dashboard -- into store/, which no agent can write.
//
// Why not the inputs this module used to read (acrobot's decision on #76,
// 2026-10-13, after barracuda's review):
//   store/usage-latest.json -- nothing schedules scripts/usage-collect.py, so
//     the file did not exist and the gate failed open on every tick, silently.
//   store/measurements/quota-samples.jsonl -- live, but 664 in a 2775 directory
//     without the sticky bit: every agent's statusline appends to it, so any
//     fleet member could forge a high value and defer the heartbeats, which is
//     the monitoring itself. The agents' samples stay there for measurement.
//
// Everything here degrades to "no snapshot": the gate then fails open (see
// quota-gate.ts, FAIL OPEN). A REJECTED input is not the same as a missing
// one, so the read returns the reason, and the runner logs it.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import type { QuotaSnapshot } from './quota-gate.js'
import { parseQuotaSampleLine } from './web/measurements.js'

export const QUOTA_GATE_SAMPLE_PATH = join(STORE_DIR, 'quota-gate-sample.json')

/** One JSON line is a few hundred bytes; anything far larger is not ours. */
const GATE_SAMPLE_MAX_BYTES = 16 * 1024

export interface QuotaRead {
  snapshot: QuotaSnapshot | null
  /** Why the file was REJECTED (not merely absent), or null. */
  problem: string | null
}

/** Map one statusline sample line onto the gate input. */
export function parseGateSample(text: string): QuotaSnapshot | null {
  const s = parseQuotaSampleLine(text.trim())
  if (!s) return null
  return {
    source: s.source,
    generatedAtMs: s.sampled_at * 1000,
    windows: {
      five_hour: { used_percent: s.five_hour_pct, resets_at: s.five_hour_resets_at },
      seven_day: { used_percent: s.seven_day_pct, resets_at: s.seven_day_resets_at },
    },
  }
}

/**
 * Read the gate sample only if it is a regular file owned by this process's
 * user and writable by nobody else. The checks run on the OPENED descriptor
 * (fstat), so nothing can be swapped in between check and read. O_NOFOLLOW
 * refuses a symlink; O_NONBLOCK keeps a FIFO from parking this synchronous
 * read -- and with it the whole dashboard -- until a writer shows up.
 */
export function readQuotaSnapshot(
  path: string = QUOTA_GATE_SAMPLE_PATH,
  uid: number | undefined = process.getuid?.(),
): QuotaRead {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { snapshot: null, problem: null }
    if (code === 'ELOOP') return { snapshot: null, problem: 'gate-input:symlink' }
    return { snapshot: null, problem: `gate-input:unreadable:${code ?? 'unknown'}` }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { snapshot: null, problem: 'gate-input:not-a-regular-file' }
    if (uid === undefined || st.uid !== uid) return { snapshot: null, problem: 'gate-input:foreign-owner' }
    if ((st.mode & 0o022) !== 0) return { snapshot: null, problem: 'gate-input:group-or-world-writable' }
    if (st.size > GATE_SAMPLE_MAX_BYTES) return { snapshot: null, problem: 'gate-input:too-large' }
    const buf = Buffer.alloc(st.size)
    readSync(fd, buf, 0, st.size, 0)
    const snapshot = parseGateSample(buf.toString('utf-8'))
    return snapshot ? { snapshot, problem: null } : { snapshot: null, problem: 'gate-input:unparseable' }
  } catch (err) {
    return { snapshot: null, problem: `gate-input:unreadable:${(err as NodeJS.ErrnoException).code ?? 'unknown'}` }
  } finally {
    closeSync(fd)
  }
}
