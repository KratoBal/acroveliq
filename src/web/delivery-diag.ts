// Delivery diagnostics (task kezbesites-busy-panelre, acrobot 30621).
//
// After #117+#118 nautilus still waited minutes for messages while busy, and the logs could
// not say why: the dashboard log goes to the container's stdout, which the fleet cannot read,
// and a 'not-landed' send did not name the look that refused it. This file records, per
// delivery attempt, WHICH path it took and WHERE it stopped -- so an hour of live data can
// tell the 30524-type failure apart (a dialog, a parked line, a tall box, the confirming
// capture...).
//
// What a line holds, and only this (no message text, no pane text, no sender):
//   ts, agent, msg (id), path ('idle' | 'queued' | 'skipped'), result, and when it failed:
//   reason (the refusing look's name), stage, chunk, chunks, retries.
// The names come from our own code (queuedPromptRefusal, liveInputRefusal, busy-pane-emit),
// never from the pane.
//
// The file: logs/delivery/busy-pane.log under the install, readable by the logs/ group
// (setgid directory, mode 2750/0640). Size-capped: past DELIVERY_DIAG_MAX_BYTES it rotates
// to busy-pane.log.1 (one generation), so it never grows unbounded. Best-effort: a write
// error is logged at debug and never touches the delivery.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const DELIVERY_DIAG_MAX_BYTES = 1_000_000

export interface DeliveryDiagEntry {
  agent: string
  msg: number
  path: 'idle' | 'queued' | 'skipped'
  result: string
  reason?: string
  stage?: string
  chunk?: number
  chunks?: number
  retries?: number
}

/** DELIVERY_DIAG_LOG overrides the place (tests). */
export function deliveryDiagPath(): string {
  return process.env.DELIVERY_DIAG_LOG || join(PROJECT_ROOT, 'logs', 'delivery', 'busy-pane.log')
}

/** One JSON line from the named fields only: nothing a caller adds beyond them is written. */
export function deliveryDiagLine(e: DeliveryDiagEntry, now: Date = new Date()): string {
  const line: Record<string, string | number> = { ts: now.toISOString(), agent: e.agent, msg: e.msg, path: e.path, result: e.result }
  if (e.reason != null) line.reason = e.reason
  if (e.stage != null) line.stage = e.stage
  if (e.chunk != null) line.chunk = e.chunk
  if (e.chunks != null) line.chunks = e.chunks
  if (e.retries != null) line.retries = e.retries
  return JSON.stringify(line) + '\n'
}

export function recordDeliveryDiag(e: DeliveryDiagEntry, now: Date = new Date(), maxBytes = DELIVERY_DIAG_MAX_BYTES): void {
  try {
    const file = deliveryDiagPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o2750 })
    const line = deliveryDiagLine(e, now)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      // no file yet
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`)
    appendFileSync(file, line, { mode: 0o640 })
  } catch (err) {
    logger.debug({ err }, 'delivery-diag: write failed (delivery unaffected)')
  }
}

// A message waiting for a busy pane is looked at every tick (5 s): a 'skipped' line goes out
// only when its reason CHANGES, so an hour of waiting is a few lines, not 720.
const lastSkipReason = new Map<number, string>()
const SKIP_MEMORY_MAX = 2000

/** True when this message's skip reason differs from the last one recorded (and remembers it). */
export function skipReasonChanged(msgId: number, reason: string): boolean {
  if (lastSkipReason.get(msgId) === reason) return false
  lastSkipReason.delete(msgId)
  lastSkipReason.set(msgId, reason)
  // bounded: the oldest entries go first (messages long delivered or failed)
  while (lastSkipReason.size > SKIP_MEMORY_MAX) lastSkipReason.delete(lastSkipReason.keys().next().value!)
  return true
}

/** The message left the pending queue (delivered or failed): forget its skip reason. */
export function forgetSkipReason(msgId: number): void {
  lastSkipReason.delete(msgId)
}
