import { DECISION_OWNER_USER } from '../../config.js'
import { decisionOwner } from '../../decisions.js'
import { callerOfContext } from '../field-gate.js'
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import {
  callSecretDoor,
  SECRET_DOOR_TARGETS,
  type SecretDoorAnswer,
  type SecretDoorTarget,
  type SecretDoorVerb,
} from '../titok-kozvetito.js'
import type { RouteContext } from './types.js'

// The secret form's backend (task parancssor-f-titok-urlap, contract v2 section 2.9).
//
//   POST /api/titok-urlap/<target>/<verb>   verb: ir {ertek} | lezar | visszaall
//        hands a secret from a provider to the mail relay's own store; the answer is the length, the version and the state
//
// ONLY the logged-in session of the configured owner (DECISION_OWNER_USER), in every access mode and on the dashboard surface
// only: an agent token, the shared token, a device key or another user gets a 403 even where the access mode only logs.
// Note what that gate is: the owner's hand at the button. The protection against a wrong value is the relay's pre-flight
// and its fixed target list (the main agent runs under the same OS user and could call the relay directly; contract 2.2).
// The body is read, forwarded and dropped: it is never logged, stored or put in an answer or an error.

// the target names spelled out, so the route inventory reads this matcher as the rule's route
const PATH = /^\/api\/titok-urlap\/(oauth-client-secret)\/(ir|lezar|visszaall)$/
const MAX_BODY_BYTES = 2 * 1024

export type SecretDoorCaller = (target: SecretDoorTarget, verb: SecretDoorVerb, value: string | null) => Promise<SecretDoorAnswer>

export async function tryHandleTitokUrlap(
  ctx: RouteContext,
  call: SecretDoorCaller = (t, v, value) => callSecretDoor(t, v, value),
): Promise<boolean> {
  const { res, path, method } = ctx
  const m = PATH.exec(path)
  if (!m || method !== 'POST') return false
  if (ctx.surface === 'acroveliq') {
    json(res, { error: 'not on this surface' }, 403)
    return true
  }
  const who = decisionOwner(ctx.auth, callerOfContext(ctx.auth)?.column, DECISION_OWNER_USER)
  if (!who.ok) {
    json(res, { error: who.error }, 403)
    return true
  }
  const target = m[1] as SecretDoorTarget
  const verb = m[2] as SecretDoorVerb
  if (!(SECRET_DOOR_TARGETS as readonly string[]).includes(target)) {
    json(res, { error: 'ismeretlen-cel' }, 404)
    return true
  }

  let value: string | null = null
  try {
    const raw = (await readBody(ctx.req, { maxBytes: MAX_BODY_BYTES })).toString()
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : null
    if (keys === null) throw new SyntaxError('body')
    if (verb === 'ir') {
      const v = (parsed as Record<string, unknown>)['ertek']
      if (keys.length !== 1 || typeof v !== 'string') throw new SyntaxError('body')
      value = v
    } else if (keys.length > 0) {
      throw new SyntaxError('body')
    }
  } catch (err) {
    // the error text is fixed: a parser message can quote the text it failed on
    json(
      res,
      { error: err instanceof RequestBodyTooLargeError ? 'torzs-tul-nagy' : 'ervenytelen-keres' },
      err instanceof RequestBodyTooLargeError ? 413 : 400,
    )
    return true
  }

  const answer = await call(target, verb, value)
  json(res, answer.body, answer.status)
  return true
}
