import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PaneSnapshotCache } from '../web/pane-snapshot.js'
import {
  capturePaneAsync,
  capturePaneSnapshot,
  isSessionReadyForPrompt,
  peekPaneSnapshot,
  resetPaneSnapshotsForTest,
  setCaptureExecForTest,
} from '../web/agent-process.js'

// Card b8ed4f45: a slow `sudo fleet-pane capture` held the main thread for 10-60 s and the
// dashboard /api went silent. These tests pin what the fix must keep true: a slow capture
// never holds the event loop, and many readers share one child.

const PANE = ['some output', '❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

type ExecCb = (err: Error | null, stdout: string) => void
interface FakeExec {
  impl: never
  calls: () => number
  release: () => void
}

/** A child launcher whose capture finishes only after `delayMs` of REAL timer time (never a busy wait). */
function slowExec(delayMs: number, stdout: string = PANE): FakeExec {
  let calls = 0
  const timers: ReturnType<typeof setTimeout>[] = []
  const impl = ((_file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    calls++
    timers.push(setTimeout(() => cb(null, stdout), delayMs))
    return { stdin: { end: () => undefined } }
  }) as unknown as never
  return { impl, calls: () => calls, release: () => timers.forEach(clearTimeout) }
}

/** How many 10 ms timer ticks fire while `work` is pending: 0 means the loop was held. */
async function ticksDuring(work: Promise<unknown>): Promise<number> {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 10)
  try {
    await work
  } finally {
    clearInterval(timer)
  }
  return ticks
}

describe('capturePaneAsync: a slow capture does not hold the event loop', () => {
  beforeEach(() => resetPaneSnapshotsForTest())
  afterEach(() => setCaptureExecForTest(null))

  it('keeps timers firing while a 300 ms capture is in flight', async () => {
    const fake = slowExec(300)
    setCaptureExecForTest(fake.impl)
    const ticks = await ticksDuring(capturePaneAsync('agent-slow'))
    // a blocked loop would report 0 here; ~30 expected, 10 leaves room for a loaded CI box
    expect(ticks).toBeGreaterThanOrEqual(10)
    expect(fake.calls()).toBe(1)
  })

  it('returns the pane with the same post-processing as capturePane (ANSI stripped)', async () => {
    const fake = slowExec(1, '\u001b[2mghost\u001b[0m\nreal line\n')
    setCaptureExecForTest(fake.impl)
    expect(await capturePaneAsync('agent-ansi')).toBe('ghost\nreal line\n')
  })

  it('is null (capture failed) when the child errors, never a rejection', async () => {
    setCaptureExecForTest(((_f: string, _a: string[], _o: unknown, cb: ExecCb) => {
      cb(new Error("can't find session: agent-gone"), '')
      return { stdin: { end: () => undefined } }
    }) as unknown as never)
    expect(await capturePaneAsync('agent-gone')).toBeNull()
  })
})

describe('isSessionReadyForPrompt: the router readiness check does not hold the event loop', () => {
  beforeEach(() => resetPaneSnapshotsForTest())
  afterEach(() => setCaptureExecForTest(null))

  it('keeps timers firing while its capture is slow (a not-ready pane stops after one read)', async () => {
    const fake = slowExec(300, ['✻ Brewing… (23s · ↓ 1.4k tokens)', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'].join('\n'))
    setCaptureExecForTest(fake.impl)
    let ready: boolean | undefined
    const ticks = await ticksDuring(isSessionReadyForPrompt('agent-busy').then((r) => (ready = r)))
    expect(ready).toBe(false)
    expect(ticks).toBeGreaterThanOrEqual(10)
    expect(fake.calls()).toBe(1)
  })
})

// The typing branch used to start a SECOND, synchronous child (captureParkedInputView) per
// sample (barracuda, #362 review). Both views now come from the one raw capture.
describe('isSessionReadyForPrompt: the typing branch needs no extra child', () => {
  beforeEach(() => resetPaneSnapshotsForTest())
  afterEach(() => setCaptureExecForTest(null))

  const ESC = '\x1b'
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ↓ to manage'
  const box = (inputLine: string): string => [SEP, inputLine, SEP, FOOTER].join('\n')
  const GHOST_BOX = box(`${ESC}[39m❯ ${ESC}[2mConfirm Samu got my last update${ESC}[0m`)
  const REAL_INPUT_BOX = box(`${ESC}[39m❯ ${ESC}[38;5;253mFinish the migration before lunch${ESC}[39m`)

  it('a dim ghost in the box reads ready, from exactly one child per sample, with the loop free', async () => {
    const fake = slowExec(150, GHOST_BOX)
    setCaptureExecForTest(fake.impl)
    let ready: boolean | undefined
    const ticks = await ticksDuring(isSessionReadyForPrompt('agent-ghost').then((r) => (ready = r)))
    expect(ready).toBe(true)
    expect(fake.calls()).toBe(2) // two samples, one child each; a sync parked-view child would not show here
    expect(ticks).toBeGreaterThanOrEqual(10)
  })

  it('real parked input is NOT ready (the strip keeps normal-intensity text), one child for the one sample', async () => {
    const fake = slowExec(5, REAL_INPUT_BOX)
    setCaptureExecForTest(fake.impl)
    expect(await isSessionReadyForPrompt('agent-parked')).toBe(false)
    expect(fake.calls()).toBe(1)
  })

  it('a decision read never joins a display read that started before it', async () => {
    const fake = slowExec(40)
    setCaptureExecForTest(fake.impl)
    const display = capturePaneSnapshot('agent-key')
    await capturePaneAsync('agent-key')
    await display
    expect(fake.calls()).toBe(2)
  })
})

describe('shared snapshots: many readers, one child', () => {
  beforeEach(() => resetPaneSnapshotsForTest())
  afterEach(() => setCaptureExecForTest(null))

  it('twenty concurrent display reads of one session spawn ONE child', async () => {
    const fake = slowExec(50)
    setCaptureExecForTest(fake.impl)
    const reads = await Promise.all(Array.from({ length: 20 }, () => capturePaneSnapshot('agent-shared')))
    expect(fake.calls()).toBe(1)
    expect(new Set(reads).size).toBe(1)
  })

  it('a read inside the TTL costs no child; a decision read (fresh) still spawns one', async () => {
    const fake = slowExec(1)
    setCaptureExecForTest(fake.impl)
    await capturePaneSnapshot('agent-ttl')
    await capturePaneSnapshot('agent-ttl')
    expect(fake.calls()).toBe(1)
    await capturePaneAsync('agent-ttl')
    expect(fake.calls()).toBe(2)
  })

  it('sessions are independent', async () => {
    const fake = slowExec(1)
    setCaptureExecForTest(fake.impl)
    await Promise.all([capturePaneSnapshot('agent-a'), capturePaneSnapshot('agent-b')])
    expect(fake.calls()).toBe(2)
  })

  it('peekPaneSnapshot answers at once: undefined cold, then the last known value', async () => {
    const fake = slowExec(20)
    setCaptureExecForTest(fake.impl)
    expect(peekPaneSnapshot('agent-peek')).toBeUndefined() // cold: returns immediately, refresh runs behind
    await capturePaneSnapshot('agent-peek') // joins the refresh the peek started
    expect(fake.calls()).toBe(1)
    expect(peekPaneSnapshot('agent-peek')).toBe(PANE)
  })
})

describe('PaneSnapshotCache: an invalidate beats a fetch that was already running (barracuda, #363)', () => {
  it('the old fetch answers its own waiter but stores nothing, and a later read starts a fresh fetch', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    let releaseOld: (v: string) => void = () => undefined
    const oldFetch = vi.fn(() => new Promise<string>((r) => (releaseOld = r)))
    const waiter = cache.get('k', oldFetch)
    cache.invalidate('k') // the agent was started or stopped while the poll was running
    const fresh = vi.fn(async () => 'new')
    expect(await cache.get('k', fresh)).toBe('new') // does not join the stale fetch
    releaseOld('old')
    expect(await waiter).toBe('old')
    expect(cache.peek('k')).toBe('new') // the old answer did not overwrite the newer one
    expect(oldFetch).toHaveBeenCalledTimes(1)
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('a stale fetch that lands after the invalidate leaves the key empty, not holding the old value with a new time', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    let releaseOld: (v: string) => void = () => undefined
    const waiter = cache.get('k', () => new Promise<string>((r) => (releaseOld = r)))
    cache.invalidate('k')
    releaseOld('old')
    await waiter
    expect(cache.peek('k')).toBeUndefined()
  })

  it('the old fetch finishing does not unregister the NEWER running fetch: a third reader still joins it', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    let releaseOld: (v: string) => void = () => undefined
    let releaseFresh: (v: string) => void = () => undefined
    const old = cache.get('k', () => new Promise<string>((r) => (releaseOld = r)))
    cache.invalidate('k')
    const freshFetch = vi.fn(() => new Promise<string>((r) => (releaseFresh = r)))
    const second = cache.get('k', freshFetch)
    releaseOld('old')
    await old
    const third = cache.get('k', freshFetch) // the fresh fetch is still running: join it, start no second child
    releaseFresh('new')
    expect(await Promise.all([second, third])).toEqual(['new', 'new'])
    expect(freshFetch).toHaveBeenCalledTimes(1)
  })

  it('invalidating one key leaves the others alone; clear() drops a running fetch too', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    await cache.get('a', async () => 'A')
    await cache.get('b', async () => 'B')
    cache.invalidate('a')
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe('B')
    let release: (v: string) => void = () => undefined
    const running = cache.get('c', () => new Promise<string>((r) => (release = r)))
    cache.clear()
    release('late')
    await running
    expect(cache.peek('c')).toBeUndefined()
  })
})

describe('PaneSnapshotCache', () => {
  it('re-fetches after the TTL and not before', async () => {
    let t = 1000
    const cache = new PaneSnapshotCache(3000, () => t)
    const fetch = vi.fn(async () => `v${t}`)
    expect(await cache.get('k', fetch)).toBe('v1000')
    t = 3999
    expect(await cache.get('k', fetch)).toBe('v1000')
    t = 4000
    expect(await cache.get('k', fetch)).toBe('v4000')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stores a failed fetch as null for one TTL, so a dead session is not re-probed per poll', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    const fetch = vi.fn(async (): Promise<string | null> => {
      throw new Error('boom')
    })
    expect(await cache.get('k', fetch)).toBeNull()
    expect(await cache.get('k', fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('maxAgeMs 0 forces a fetch but joins one already running', async () => {
    const cache = new PaneSnapshotCache(3000, () => 5)
    let release: (v: string) => void = () => undefined
    const fetch = vi.fn(() => new Promise<string>((r) => (release = r)))
    const a = cache.get('k', fetch, 0)
    const b = cache.get('k', fetch, 0)
    release('x')
    expect(await Promise.all([a, b])).toEqual(['x', 'x'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// The routes are not runnable in a unit test (they read the live fleet), so the wiring
// is guarded structurally, the way activity-no-main-duplicate.test.ts does it.
describe('dashboard routes read the pane without the sync capture', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')

  it('/api/agents/activity uses the shared async snapshot, not capturePane()', () => {
    const start = source.indexOf("if (path === '/api/agents/activity' && method === 'GET')")
    const end = source.indexOf("if (path === '/api/agents/model-suggest'", start)
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, end)
    expect(block).toContain('capturePaneSnapshot(')
    expect(block).not.toMatch(/\bcapturePane\(/)
  })

  it('the list summary reads the reauth pane from the last known snapshot', () => {
    const start = source.indexOf('function getAgentSummary(')
    const end = source.indexOf('\n}\n', start)
    const block = source.slice(start, end)
    expect(block).toContain('peekPaneSnapshot(')
    expect(block).not.toMatch(/\bcapturePane\(/)
  })
})
