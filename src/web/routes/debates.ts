import { getDb } from '../../db.js'
import { debateTurns, getDebate, listDebates, submitAcrobotTurn } from '../../debates.js'
import { resolveProject } from '../../projects.js'
import { discordTransportFromEnv, type DiscordTransport } from '../approval-discord.js'
import { debateConfig, debateDeps } from '../debates-discord.js'
import { callerOfContext } from '../field-gate.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Többmodelles V1, PR 1 (task t-20261014-tobbmodelles-vezerlo). See src/debates.ts.
//
//   GET  /api/debates[?project=<id>]        the debates, newest first
//   GET  /api/debates/:id                   one debate with its turns
//   POST /api/debates/:id/turns/:token      {text, final?}: Acrobot hands in its round. ONLY the
//        main agent's own token, not on the AcrovelIQ host. Once per token (409 after), so a
//        round is a record, not a Discord reading (barracuda 30721); the controller posts it.

const PATH = /^\/api\/debates(?:\/([^/]+)(?:\/turns\/([^/]+))?)?$/

/** The transport, injectable for tests. */
let transportFor: () => DiscordTransport | null = discordTransportFromEnv
export function setDebateTransportForTest(t: (() => DiscordTransport | null) | null): void {
  transportFor = t ?? discordTransportFromEnv
}

export async function tryHandleDebates(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  const m = PATH.exec(path)
  if (!m) return false
  const id = m[1] ? decodeURIComponent(m[1]) : null
  const token = m[2] ? decodeURIComponent(m[2]) : null

  if (method === 'GET' && !id) {
    const asked = url.searchParams.get('project')
    const project = asked ? resolveProject(getDb(), asked) : null
    if (asked && !project) {
      json(res, { error: `unknown project: ${asked}` }, 400)
      return true
    }
    json(res, listDebates(getDb(), project))
    return true
  }
  if (method === 'GET' && id && !token) {
    const debate = getDebate(getDb(), id)
    if (!debate) {
      json(res, { error: `no debate ${id}` }, 404)
      return true
    }
    json(res, { debate, turns: debateTurns(getDb(), id) })
    return true
  }
  if (method !== 'POST' || !id || !token) return false

  if (ctx.surface === 'acroveliq') {
    json(res, { error: 'not on this surface' }, 403)
    return true
  }
  if (callerOfContext(ctx.auth)?.column !== 'A') {
    json(res, { error: 'a round is handed in by the main agent\'s own token only' }, 403)
    return true
  }
  let b: Record<string, unknown> | null = null
  try {
    const v = JSON.parse((await readBody(ctx.req)).toString())
    b = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { /* b stays null */ }
  if (!b) {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }
  const transport = transportFor()
  if (!transport) {
    json(res, { error: 'no Discord bot token: the controller cannot post' }, 503)
    return true
  }
  const out = await submitAcrobotTurn(getDb(), debateDeps(transport), debateConfig(), id, token,
    typeof b.text === 'string' ? b.text : '', b.final === true)
  json(res, out.body, out.status)
  return true
}
