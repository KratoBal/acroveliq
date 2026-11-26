// POST /api/kanban: a wrong field is a 400 that names it (2026-11-26, acrobot 63298).
//
// What turns this red: `fleet-api.sh kanban-new acrobot "cim"` sent "cim" as the status, the table's CHECK refused the
// insert and the route answered a bare 500 naming nothing. An unknown status or priority, a missing or empty title, a
// malformed body or a non-text optional field must be a 400 naming the field, and nothing written; a good card with a
// project must still be written with it.
import { describe, it, expect, beforeEach } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getKanbanCard, listKanbanCards } from '../db.js'

const { tryHandleKanban } = await import('../web/routes/kanban.js')

async function call(payload?: unknown, rawBody?: string) {
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
  await tryHandleKanban({ req, res, path: '/api/kanban', method: 'POST', url: '/api/kanban' } as unknown as RouteContext)
  return { status, json: body ? JSON.parse(body) : null }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('POST /api/kanban', () => {
  it('the 2026-11-26 call (title "acrobot", status "cim") is a 400 naming the status, and writes nothing', async () => {
    const r = await call({ title: 'acrobot', status: 'cim', assignee: '', priority: 'normal' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/status/)
    expect(r.json.error).toMatch(/"cim"/)
    expect(listKanbanCards()).toEqual([])
  })

  it('a bad priority, a missing or empty title, a malformed body and a non-text field are 400s naming the field', async () => {
    const cases: [unknown, string | undefined, RegExp][] = [
      [{ title: 'x', priority: 'surgos' }, undefined, /priority/],
      [{ status: 'planned' }, undefined, /title/],
      [{ title: '   ' }, undefined, /title/],
      [undefined, '{ nem json', /JSON/],
      [[{ title: 'x' }], undefined, /objektum/],
      [{ title: 'x', project: 7 }, undefined, /project/],
      [{ title: 'x', due_date: 'holnap' }, undefined, /due_date/],
    ]
    for (const [payload, raw, field] of cases) {
      const r = await call(payload, raw)
      expect(r.status, JSON.stringify(payload ?? raw)).toBe(400)
      expect(r.json.error).toMatch(field)
    }
    expect(listKanbanCards()).toEqual([])
  })

  it('a good card with a project is written, with it', async () => {
    const r = await call({ title: '[flotta] kartya', status: 'planned', assignee: 'nautilus', priority: 'high', project: 'acropora-os' })
    expect(r.status).toBe(200)
    const card = getKanbanCard(r.json.id)
    expect(card?.project).toBe('acropora-os')
    expect(card?.priority).toBe('high')
  })
})
