// POST /api/kanban/:id/measure and the list's `measure_state` (T6.5, card b3d8174e).
//
// What turns this red: a bad or missing result accepted; a non-string note or basis accepted; an over-long note or
// basis accepted; an unknown card answered 200 (the stamp would vanish: the same silent loss the comment endpoint once
// had); the time taken from the body instead of the server's clock; updated_at moved by a stamp; the list without
// measure_state, or judging by updated_at; a malformed body a 500.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, createKanbanCard, getKanbanCard } from '../db.js'

const { tryHandleKanban } = await import('../web/routes/kanban.js')

const NOW = 1_800_000_000

async function call(method: string, path: string, payload?: unknown, rawBody?: string) {
  const chunks = [Buffer.from(rawBody ?? (payload === undefined ? '' : JSON.stringify(payload)))]
  const req = {
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') cb()
      return req
    },
    headers: {},
    socket: {},
  } as unknown as RouteContext['req']
  let status = 200
  let body = ''
  const res = {
    writeHead(code: number) { status = code; return res },
    setHeader() { return res },
    end(text?: string) { if (text) body = text },
  } as unknown as RouteContext['res']
  const handled = await tryHandleKanban({ req, res, path, method, url: path } as unknown as RouteContext)
  return { handled, status, json: body ? JSON.parse(body) : null }
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW * 1000))
  createKanbanCard({ id: 'c1', title: 'x', basis: 'os:apps/api/src/a.ts' })
})
afterEach(() => vi.useRealTimers())

describe('POST /api/kanban/:id/measure', () => {
  it('stamps the server time and the result; the body cannot set the time; updated_at stays', async () => {
    const updatedBefore = getKanbanCard('c1')!.updated_at
    vi.setSystemTime(new Date((NOW + 600) * 1000))
    const r = await call('POST', '/api/kanban/c1/measure', { result: 'OK', note: 'rendben', measured_at: 1, updated_at: 1 })
    expect(r).toMatchObject({ handled: true, status: 200, json: { ok: true } })
    const card = getKanbanCard('c1')!
    expect(card.measured_at).toBe(NOW + 600)
    expect(card.measure_result).toBe('OK')
    expect(card.updated_at).toBe(updatedBefore)
  })

  it('a basis in the body replaces the card basis; without one it stays', async () => {
    await call('POST', '/api/kanban/c1/measure', { result: 'OK' })
    expect(getKanbanCard('c1')?.basis).toBe('os:apps/api/src/a.ts')
    await call('POST', '/api/kanban/c1/measure', { result: 'DIVERGED', basis: 'os:b.ts#f', note: 'a.ts nincs' })
    expect(getKanbanCard('c1')).toMatchObject({ basis: 'os:b.ts#f', measure_result: 'DIVERGED', measure_note: 'a.ts nincs' })
  })

  it('a missing or unknown result, a non-string note or basis, and over-long values are 400 and write nothing', async () => {
    const bad: unknown[] = [
      {},
      { result: 'MAYBE' },
      { result: 3 },
      { result: 'OK', note: 5 },
      { result: 'OK', basis: ['x'] },
      { result: 'OK', note: 'x'.repeat(501) },
      { result: 'OK', basis: 'x'.repeat(4001) },
    ]
    for (const body of bad) {
      const r = await call('POST', '/api/kanban/c1/measure', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect((await call('POST', '/api/kanban/c1/measure', undefined, 'nem json')).status).toBe(400)
    expect(getKanbanCard('c1')?.measured_at).toBeNull()
  })

  it('an unknown card is 404, not a silent 200', async () => {
    const r = await call('POST', '/api/kanban/nincs/measure', { result: 'OK' })
    expect(r.status).toBe(404)
  })
})

describe('GET /api/kanban carries measure_state', () => {
  it('unmeasured, then fresh, stale and diverged by the stamp and the clock, never by updated_at', async () => {
    const state = async () => (await call('GET', '/api/kanban')).json.find((c: { id: string }) => c.id === 'c1').measure_state
    expect(await state()).toBe('unmeasured')
    await call('POST', '/api/kanban/c1/measure', { result: 'OK' })
    expect(await state()).toBe('fresh')
    // 25 hours later the card was written to (updated_at fresh), the measurement is not
    vi.setSystemTime(new Date((NOW + 25 * 3600) * 1000))
    await call('POST', '/api/kanban/c1/comments', { author: 'x', content: 'komment' })
    expect(await state()).toBe('stale')
    await call('POST', '/api/kanban/c1/measure', { result: 'DIVERGED' })
    expect(await state()).toBe('diverged')
  })

  it('a card with no basis and no measurement has no state to show', async () => {
    createKanbanCard({ id: 'c2', title: 'y' })
    const cards = (await call('GET', '/api/kanban')).json
    expect(cards.find((c: { id: string }) => c.id === 'c2').measure_state).toBe('none')
  })
})
