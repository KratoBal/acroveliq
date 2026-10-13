import { describe, expect, it } from 'vitest'

import { startToolLogPruner, TOOL_LOG_PRUNE_EVERY_MS } from '../web/tool-log-pruner.js'

describe('startToolLogPruner', () => {
  it('PRUNE-START: prunes once at start, before the first tick, then schedules hourly', () => {
    const calls: string[] = []
    let scheduled: { fn: () => void; ms: number } | null = null
    startToolLogPruner(() => calls.push('prune'), () => calls.push('warn'), (fn, ms) => {
      scheduled = { fn, ms }
      return 0 as unknown as ReturnType<typeof setInterval>
    })
    expect([calls, scheduled!.ms], 'PRUNE-START').toEqual([['prune'], TOOL_LOG_PRUNE_EVERY_MS])
    scheduled!.fn()
    expect(calls).toEqual(['prune', 'prune'])
  })

  it('PRUNE-WARN: a failing prune is reported, not thrown, at start and on a tick', () => {
    const warned: unknown[] = []
    let tick: () => void = () => {}
    expect(() => startToolLogPruner(() => { throw new Error('locked') }, (e) => warned.push(e), (fn) => {
      tick = fn
      return 0 as unknown as ReturnType<typeof setInterval>
    })).not.toThrow()
    tick()
    expect(warned.map((e) => (e as Error).message)).toEqual(['locked', 'locked'])
  })
})
