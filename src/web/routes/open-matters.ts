import { getDb } from '../../db.js'
import { buildOpenMatters } from '../../open-matters.js'
import { acroveliqOpenMattersView } from '../acroveliq-host.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// The open-matters summary (koord-munkamenet, plan item 1). See src/open-matters.ts.
//
//   GET /api/open-matters               {generated_at, text, counts, omitted, items}
//   GET /api/open-matters?format=text   the text alone, for a session's first read
//
// On the AcrovelIQ surface only {generated_at, items}, and no text form
// (acroveliqOpenMattersView, task acroveliq-donteseim).
//
// Read-only: it only reads Task Core, handoff records, hot memories and kanban cards.

export async function tryHandleOpenMatters(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/open-matters' || method !== 'GET') return false
  const unknown = [...url.searchParams.keys()].filter((k) => k !== 'format')
  const format = url.searchParams.get('format')
  if (unknown.length || (format !== null && format !== 'text' && format !== 'json')) {
    json(res, { error: 'only ?format=text or ?format=json' }, 400)
    return true
  }
  if (ctx.surface === 'acroveliq' && format === 'text') {
    json(res, { error: 'only the JSON view here' }, 400)
    return true
  }
  const out = buildOpenMatters(getDb(), { now: Math.floor(Date.now() / 1000) })
  if (ctx.surface === 'acroveliq') {
    json(res, acroveliqOpenMattersView(out))
    return true
  }
  if (format === 'text') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(out.text)
    return true
  }
  json(res, out)
  return true
}
