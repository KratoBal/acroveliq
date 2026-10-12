// A denial inside a handler, under the same setting as the access check
// (acrovelIQ P0-1): some rules are about a field of the body, not the route
// (a schedule's command, preCheck and targetSession), so the dispatcher's
// matrix cannot see them. They follow the setting all the same (Balázs,
// 2026-10-12 10:58 UTC: the restrictions are not enabled yet, we measure and
// log): in `naplo` the request goes on and a `would-deny` row is logged; where
// the setting enforces for the caller, it is a 403.

import { getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { enforces, recordAccessDenial, type AccessMode } from './access-enforcement.js'
import type { Caller } from './route-access.js'
import { matchRouteRule } from './route-match.js'
import type { RouteContext } from './routes/types.js'

/** The matrix column of a handler's caller, from the context the dispatcher built. */
export function callerOfContext(auth: RouteContext['auth'], mainAgent: string = MAIN_AGENT_ID): Caller | null {
  switch (auth?.kind) {
    case 'session':
      return { column: 'S', name: `session:${auth.user ?? ''}` }
    case 'device':
      return { column: 'D', name: `device:${auth.device ?? ''}` }
    case 'federation':
      return { column: 'F', name: auth.peer ?? '' }
    case 'token': {
      if (!auth.actor || auth.actor === 'legacy') return { column: 'L', name: 'legacy' }
      if (auth.project && auth.project !== 'acropora') return { column: 'G', name: `${auth.project}/${auth.actor}` }
      return { column: auth.actor === mainAgent ? 'A' : 'G', name: auth.actor }
    }
    default:
      return null
  }
}

/**
 * Logs a field rule the caller broke, and says whether to refuse: true where
 * the setting enforces for this caller (answer 403), false in `naplo` (go on;
 * a `would-deny` row is logged). `always` refuses in every mode, for a rule
 * the owner closed apart from the setting. `rule` names the rule in the log;
 * no value from the request goes there.
 */
export function fieldGate(ctx: RouteContext, rule: string, opts: { always?: boolean } = {}): boolean {
  const caller = callerOfContext(ctx.auth)
  if (!caller || caller.column === 'S') return false
  const mode: AccessMode = ctx.accessMode ?? 'naplo'
  const enforced = opts.always === true || enforces(mode, caller.column)
  recordAccessDenial(
    getDb(),
    { rule: matchRouteRule(ctx.method, ctx.path), caller, decision: { allowed: false, reason: rule }, enforced },
    mode,
    ctx.method,
    Math.floor(Date.now() / 1000),
  )
  return enforced
}
