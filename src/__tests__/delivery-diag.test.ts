// The delivery diagnostics file (delivery-diag.ts; acrobot 30621: fleet-readable, no content,
// rotation or a size cap so it never grows unbounded).
//
// WHAT TURNS THIS RED:
//   - the file grows past the cap, or rotation keeps more than one old generation;
//   - a field outside the named ones (a caller's extra, e.g. message text) reaches the line;
//   - the file or its directory is not group-readable, or is world-readable;
//   - a write error throws into the delivery;
//   - the skip memory repeats a reason, misses a change, or grows without bound.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveryDiagLine, forgetSkipReason, recordDeliveryDiag, skipReasonChanged, type DeliveryDiagEntry } from '../web/delivery-diag.js'

const E: DeliveryDiagEntry = { agent: 'nautilus', msg: 30524, path: 'queued', result: 'not-landed', reason: 'box-not-free', stage: 'chunk', chunk: 2, chunks: 9, retries: 0 }

describe('delivery-diag', () => {
  let dir = ''
  let file = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-diag-'))
    file = join(dir, 'delivery', 'busy-pane.log')
    process.env.DELIVERY_DIAG_LOG = file
    return () => {
      delete process.env.DELIVERY_DIAG_LOG
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DIAG-LINE: only the named fields, in one JSON line', () => {
    const withExtra = { ...E, content: 'TITKOS UZENET SZOVEGE', from: 'acrobot' } as DeliveryDiagEntry
    const line = deliveryDiagLine(withExtra, new Date('2026-10-14T13:00:00Z'))
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ ts: '2026-10-14T13:00:00.000Z', ...E })
  })

  it('DIAG-ROTATE: past the cap the file moves to .1 (one generation) and the new one starts small', () => {
    const cap = 600
    for (let i = 0; i < 40; i++) recordDeliveryDiag({ ...E, msg: i }, new Date(), cap)
    const size = statSync(file).size
    const old = readFileSync(`${file}.1`, 'utf8').trim().split('\n')
    const cur = readFileSync(file, 'utf8').trim().split('\n')
    expect([size <= cap, statSync(`${file}.1`).size <= cap, existsSync(`${file}.2`)]).toEqual([true, true, false])
    // nothing lost at the seam: the newest line is the last written, the old file ends right before the new one starts
    expect(JSON.parse(cur.at(-1)!).msg).toBe(39)
    expect(JSON.parse(old.at(-1)!).msg + 1).toBe(JSON.parse(cur[0]!).msg)
  })

  it('DIAG-MODE: the directory and the file are group-readable, not world-readable', () => {
    recordDeliveryDiag(E)
    const fileMode = statSync(file).mode & 0o777
    const dirMode = statSync(join(dir, 'delivery')).mode & 0o777
    expect([fileMode & 0o040, fileMode & 0o007, dirMode & 0o050, dirMode & 0o007]).toEqual([0o040, 0, 0o050, 0])
  })

  it('DIAG-NO-THROW: a write that cannot happen does not throw into the delivery', () => {
    writeFileSync(join(dir, 'blocker'), 'x')
    process.env.DELIVERY_DIAG_LOG = join(dir, 'blocker', 'busy-pane.log')
    expect(() => recordDeliveryDiag(E)).not.toThrow()
  })

  it('DIAG-SKIP-MEMORY: a reason is reported once per change, forgotten on delivery, and the memory is bounded', () => {
    expect([
      skipReasonChanged(1, 'box-not-free'),
      skipReasonChanged(1, 'box-not-free'),
      skipReasonChanged(1, 'menu'),
      skipReasonChanged(1, 'box-not-free'),
    ]).toEqual([true, false, true, true])
    forgetSkipReason(1)
    expect(skipReasonChanged(1, 'box-not-free')).toBe(true)
    // 3000 other messages push the oldest out: message 1 counts as new again
    for (let i = 100; i < 3100; i++) skipReasonChanged(i, 'x')
    expect(skipReasonChanged(1, 'box-not-free')).toBe(true)
    expect(skipReasonChanged(3099, 'x')).toBe(false)
  })
})
