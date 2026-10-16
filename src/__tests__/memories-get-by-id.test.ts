// P0-1 (task p0-1-harom-javitas): GET /api/memories/:id existed in no handler and no rule, so the
// main agent's call got 404 and the access log a default-deny. WHAT TURNS THIS RED: the handler not
// answering by id, answering a missing id with anything but 404, returning the embedding, touching
// accessed_at (a read is not a recall), or the route rule missing or not in the list's class.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { initDatabase, saveAgentMemory, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { matchRouteRule } from '../web/route-match.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function call(path: string): { readonly status: number; readonly body: any; run: () => Promise<boolean> } {
  let status = 200
  let raw = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { raw = b || '' },
  }
  const ctx = { req: {} as any, res: res as any, path, method: 'GET', url: new URL(`http://localhost:3420${path}`) } as RouteContext
  return {
    get status() { return status },
    get body() { return raw ? JSON.parse(raw) : null },
    run: () => tryHandleMemories(ctx),
  }
}

let id = 0
beforeAll(() => {
  initDatabase(':memory:')
  saveAgentMemory('agent-a', 'egy olvasando emlek', 'warm', 'proba')
  id = (getDb().prepare('SELECT id FROM memories ORDER BY id DESC LIMIT 1').get() as { id: number }).id
  getDb().prepare('UPDATE memories SET accessed_at = 1000 WHERE id = ?').run(id)
})

describe('GET /api/memories/:id', () => {
  it('returns the memory, without its embedding, and does not touch accessed_at', async () => {
    const c = call(`/api/memories/${id}`)
    expect(await c.run()).toBe(true)
    expect(c.status).toBe(200)
    expect(c.body.id).toBe(id)
    expect(c.body.content).toBe('egy olvasando emlek')
    expect(c.body.agent_id).toBe('agent-a')
    expect(c.body.embedding).toBeUndefined()
    expect(typeof c.body.created_label).toBe('string')
    const after = getDb().prepare('SELECT accessed_at FROM memories WHERE id = ?').get(id) as { accessed_at: number }
    expect(after.accessed_at).toBe(1000)
  })

  it('a missing id is 404', async () => {
    const c = call('/api/memories/999999')
    expect(await c.run()).toBe(true)
    expect(c.status).toBe(404)
  })

  it('the route has a rule, in the same class as the list, and stats is not taken for an id', () => {
    expect(matchRouteRule('GET', '/api/memories/12')?.path).toBe('/api/memories/:id')
    expect(matchRouteRule('GET', '/api/memories/12')?.class).toBe(matchRouteRule('GET', '/api/memories')?.class)
    expect(matchRouteRule('GET', '/api/memories/stats')?.path).toBe('/api/memories/stats')
  })
})
