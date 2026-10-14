import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// The recursive fs.watch reports an unreadable subdirectory (store/tokens is
// root:root 0711 since P0-1 L2) as an async 'error' event. Without a listener
// Node throws it and the dashboard dies at startup (measured 2026-10-14 09:36).

const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void }
fakeWatcher.close = () => {}

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, watch: vi.fn(() => fakeWatcher), readdirSync: vi.fn(() => []) }
})
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn, error: vi.fn() } }))

describe('store watcher', () => {
  let mod: typeof import('../store-watcher.js')
  beforeEach(async () => {
    mod = await import('../store-watcher.js')
    mod.startStoreWatcher()
  })
  afterEach(() => mod.stopStoreWatcher())

  it('survives an EACCES error event from an unreadable subdirectory', () => {
    const err = Object.assign(new Error("EACCES: permission denied, watch '/x/store/tokens'"), { code: 'EACCES' })
    expect(() => fakeWatcher.emit('error', err)).not.toThrow()
    expect(warn).toHaveBeenCalledWith({ err }, 'store-watcher: watch error (non-fatal)')
  })
})
