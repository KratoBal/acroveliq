// A short-lived, shared pane snapshot per tmux session, fetched WITHOUT blocking
// the event loop.
//
// Why it exists (card b8ed4f45, measured 2026-11-14 10:35-11:20): the dashboard
// /api stopped answering for 10-60 s because every pane read was a synchronous
// `sudo -n fleet-pane capture <agent>` child (execFileSync). The dashboard list
// polls, the router's delivery retries and the watchers each paid that cost on
// the one main thread, so a slow capture stalled the whole HTTP server and the
// approval gate's own 10 s timeout then produced MORE captures.
//
// Two rules make a read cheap again:
//   1. Callers that only DISPLAY the pane (dashboard badges, activity tail) share
//      one snapshot per session: a read inside the TTL costs nothing.
//   2. Concurrent reads of the same session share ONE in-flight child.
// Callers that DECIDE something from the pane (delivery readiness, an approval
// keypress) pass maxAgeMs 0 and still get a fresh read, only now asynchronously.
//
// A capture that fails is stored as null (the capturePane contract: "capture
// failed" reads as "not ready"), so a dead session is re-probed once per TTL,
// not once per poll.

export type PaneFetcher = () => Promise<string | null>

interface Entry {
  value: string | null
  at: number
}

export class PaneSnapshotCache {
  private readonly store = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  /**
   * Bumped by invalidate() and clear(). A fetch that started under an older generation still answers its own waiters,
   * but stores nothing and is never joined by a later reader: otherwise a poll that began BEFORE a start or stop would
   * write the old state back with a fresh timestamp after the entry was dropped (barracuda, #363).
   */
  private readonly generations = new Map<string, number>()
  private epoch = 0
  private generationOf(key: string): number {
    return this.epoch + (this.generations.get(key) ?? 0)
  }

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last known value whatever its age; undefined when this key was never read. */
  peek(key: string): string | null | undefined {
    return this.store.get(key)?.value
  }

  /**
   * A snapshot no older than `maxAgeMs` (default: the TTL), or one shared fetch.
   * `maxAgeMs: 0` forces a fetch but still joins one already running. Never rejects.
   */
  get(key: string, fetch: PaneFetcher, maxAgeMs: number = this.ttlMs): Promise<string | null> {
    const entry = this.store.get(key)
    if (entry && maxAgeMs > 0 && this.now() - entry.at < maxAgeMs) return Promise.resolve(entry.value)
    const running = this.inflight.get(key)
    if (running) return running
    const generation = this.generationOf(key)
    const p: Promise<string | null> = fetch()
      .catch((): string | null => null)
      .then((value) => {
        if (this.generationOf(key) === generation) this.store.set(key, { value, at: this.now() })
        return value
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key)
      })
    this.inflight.set(key, p)
    return p
  }

  /**
   * A read that is NEVER shared with one already running: it starts its own fetch and stores the result. For a
   * decision made right after a keystroke or between two samples (readiness, an input-box check): a running
   * fetch may have started before the thing the caller wants to see, and joining it would hand back that
   * older frame (barracuda, #362 and #363).
   */
  fresh(key: string, fetch: PaneFetcher): Promise<string | null> {
    const generation = this.generationOf(key)
    return fetch()
      .catch((): string | null => null)
      .then((value) => {
        if (this.generationOf(key) === generation) this.store.set(key, { value, at: this.now() })
        return value
      })
  }

  /**
   * For a SYNCHRONOUS caller (a list builder that cannot await): return what is
   * known now and, when it is older than the TTL, start a background refresh so
   * the next poll sees a newer one. undefined on the very first read of a key.
   */
  peekAndRefresh(key: string, fetch: PaneFetcher): string | null | undefined {
    const entry = this.store.get(key)
    if (!entry || this.now() - entry.at >= this.ttlMs) void this.get(key, fetch, 0)
    return entry?.value
  }

  invalidate(key: string): void {
    this.store.delete(key)
    this.inflight.delete(key)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }

  /** Forget every snapshot (a test seam); a fetch still in flight stores nothing. */
  clear(): void {
    this.store.clear()
    this.inflight.clear()
    this.epoch += 1
  }
}
