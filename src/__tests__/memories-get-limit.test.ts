/**
 * GET /api/memories ?limit= (card 1daee3a5, measured 2026-10-21 on main 0d6d9361).
 *
 * The card's title said the limit was ignored and the answer cut at 200. Measured: the limit was
 * honoured up to 200 and silently capped above. The real defect was next to it: the value went
 * through `Math.min(parseInt(limit), 200)`, so a negative one reached SQLite, where LIMIT -1 means
 * no limit at all (past the cap), "abc" became NaN (a datatype-mismatch error) and "1e3" became 1.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory } from '../db.js'
import { MEMORY_LIST_MAX, parseMemoryLimit, tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const STORED = 250

async function get(params: Record<string, string>) {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let status = 0
  let body = ''
  const headers: Record<string, string> = {}
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { body = chunk || '' },
  }
  const ctx = { req: { headers: {} } as any, res: res as any, path: '/api/memories', method: 'GET', url } as RouteContext
  await tryHandleMemories(ctx)
  return { status, headers, body: body ? JSON.parse(body) : null }
}

beforeAll(() => {
  initDatabase(':memory:')
  for (let i = 0; i < STORED; i++) saveAgentMemory('agent-limit', `limit probe ${i}`, 'warm', 'probe')
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('GET /api/memories ?limit=', () => {
  it('honours the limit up to the cap, 50 without one, and says so above the cap', async () => {
    const answers: Record<string, unknown> = {}
    for (const limit of ['', '10', '200', '500']) {
      const r = await get(limit ? { agent: 'agent-limit', limit } : { agent: 'agent-limit' })
      answers[limit || '(none)'] = { status: r.status, rows: r.body.length, capped: r.headers['x-limit-capped'] ?? null }
    }
    expect(answers).toEqual({
      '(none)': { status: 200, rows: 50, capped: null },
      '10': { status: 200, rows: 10, capped: null },
      '200': { status: 200, rows: MEMORY_LIST_MAX, capped: null },
      '500': { status: 200, rows: MEMORY_LIST_MAX, capped: String(MEMORY_LIST_MAX) },
    })
  })

  it('refuses what is not a whole number from 1 up: -1 (no limit in SQLite), 0, abc (NaN), 1e3 (was 1)', async () => {
    const answers: Record<string, number> = {}
    for (const limit of ['-1', '0', 'abc', '1e3', '2.5', ' ']) {
      answers[limit] = (await get({ agent: 'agent-limit', limit })).status
    }
    // ' ' trims to empty: the default, like no limit at all
    expect(answers).toEqual({ '-1': 400, '0': 400, abc: 400, '1e3': 400, '2.5': 400, ' ': 200 })
    const refused = await get({ agent: 'agent-limit', limit: '-1' })
    expect(refused.body.error).toMatch(/1 to 200/)
  })

  it('parseMemoryLimit, on its own', () => {
    expect(parseMemoryLimit(null)).toEqual({ limit: 50, capped: false })
    expect(parseMemoryLimit('200')).toEqual({ limit: 200, capped: false })
    expect(parseMemoryLimit('201')).toEqual({ limit: 200, capped: true })
    expect(parseMemoryLimit('-1')).toHaveProperty('error')
  })
})
