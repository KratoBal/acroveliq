import { getDb } from '../../db.js'
import { buildOpenMatters } from '../../open-matters.js'
import { acroveliqOpenMattersView } from '../acroveliq-host.js'
import { callerOfContext } from '../field-gate.js'
import { json } from '../http-helpers.js'
import { listProjects } from '../../projects.js'
import type { RouteContext } from './types.js'

// The open-matters summary (koord-munkamenet, plan item 1). See src/open-matters.ts.
//
//   GET /api/open-matters               {generated_at, text, counts, omitted, items}
//   GET /api/open-matters?format=text   the text alone, for a session's first read
//
// On the AcrovelIQ surface only {generated_at, items}, no text form
// (acroveliqOpenMattersView, task acroveliq-donteseim), and only for Balázs's
// session (column S): a device key, an agent token or the shared token gets a
// 403 there, in every access mode. The memory text is internal working notes
// (barracuda, #88 review; acrobot's decision, 2026-10-13, msg 30039). The
// dashboard port keeps the route rule's read access.
//
// Read-only: it only reads Task Core, handoff records, hot memories and kanban cards.

export async function tryHandleOpenMatters(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/open-matters' || method !== 'GET') return false
  const unknown = [...url.searchParams.keys()].filter((k) => k !== 'format' && k !== 'project')
  const format = url.searchParams.get('format')
  if (unknown.length || (format !== null && format !== 'text' && format !== 'json')) {
    json(res, { error: 'only ?format=text or ?format=json, and ?project=<id>' }, 400)
    return true
  }
  // Projektek V1: the server filters by a registry project; an unknown id is a 400, not an empty answer
  const project = url.searchParams.get('project')
  if (project !== null && !listProjects(getDb()).some((p) => p.id === project)) {
    json(res, { error: 'unknown project', known: listProjects(getDb()).map((p) => p.id) }, 400)
    return true
  }
  if (ctx.surface === 'acroveliq' && callerOfContext(ctx.auth)?.column !== 'S') {
    json(res, { error: 'the AcrovelIQ surface gives this to the owner\'s session only' }, 403)
    return true
  }
  if (ctx.surface === 'acroveliq' && format === 'text') {
    json(res, { error: 'only the JSON view here' }, 400)
    return true
  }
  const out = buildOpenMatters(getDb(), { now: Math.floor(Date.now() / 1000), ...(project ? { project } : {}) })
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
