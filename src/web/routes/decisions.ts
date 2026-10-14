import { DECISION_OWNER_USER, MAIN_AGENT_ID } from '../../config.js'
import { getDb } from '../../db.js'
import { attachDiscordReply, decide, decisionOwner, DECISION_ACTIONS, type DecisionAction } from '../../decisions.js'
import { callerOfContext } from '../field-gate.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Dontéseim V1 (task dontesek-v1-backend). See src/decisions.ts.
//
//   POST /api/decisions/:id                {action: approve|reject|discuss}
//        the owner's answer on a decision row. ONLY the logged-in session of the
//        configured owner (DECISION_OWNER_USER; unset: nobody), in every access mode and
//        on both surfaces: another dashboard user, a device key, an agent token or the
//        shared token gets a 403 even where the access mode only logs (Balázs's
//        requirement 1, 2026-10-14 08:52:26 UTC, msg 1559851364950220852; barracuda's
//        review of #104). This is the one write the AcrovelIQ host lets through.
//   POST /api/decisions/:id/discord-reply  {message_id, channel_id?}
//        the main agent attaches the Discord message the owner answered in. Decides
//        nothing. Only the main agent's own token, only on the dashboard surface.

const PATH = /^\/api\/decisions\/([^/]+)(\/discord-reply)?$/

async function body(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse((await readBody(ctx.req)).toString())
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function tryHandleDecisions(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  const m = PATH.exec(path)
  if (!m || method !== 'POST') return false
  const id = decodeURIComponent(m[1]!)
  const caller = callerOfContext(ctx.auth)
  const now = Math.floor(Date.now() / 1000)

  if (m[2]) {
    if (ctx.surface === 'acroveliq') {
      json(res, { error: 'not on this surface' }, 403)
      return true
    }
    if (caller?.column !== 'A') {
      json(res, { error: 'only the main agent\'s own token attaches a Discord reply' }, 403)
      return true
    }
    const b = await body(ctx)
    const messageId = typeof b?.message_id === 'string' ? b.message_id.trim() : ''
    // the channel or thread the message is in: optional, only for the link on the page
    const channelId = typeof b?.channel_id === 'string' && b.channel_id.trim() ? b.channel_id.trim() : null
    const out = attachDiscordReply(getDb(), id, messageId, channelId)
    json(res, out.body, out.status)
    return true
  }

  const who = decisionOwner(ctx.auth, caller?.column, DECISION_OWNER_USER)
  if (!who.ok) {
    json(res, { error: who.error }, 403)
    return true
  }
  const user = who.user
  const b = await body(ctx)
  const action = typeof b?.action === 'string' ? b.action : ''
  if (!(DECISION_ACTIONS as readonly string[]).includes(action)) {
    json(res, { error: `action: one of ${DECISION_ACTIONS.join(', ')}` }, 400)
    return true
  }
  const out = decide(getDb(), id, action as DecisionAction, user, now, MAIN_AGENT_ID)
  json(res, out.body, out.status)
  return true
}
