// Who did it, as the server stores it (acrovelIQ P0-1, PR 3c; plan 2.1:
// "identity from the token, not from the request body"). A field a caller
// used to declare about itself (a message's `from`, an approval's
// `resolved_by`, a handoff's `agent`, a token-usage event's `actor`, the
// author of a scheduled task) is filled from the credential where the
// credential names someone:
//   an agent's own token      its name; a different body value is ignored and logged
//   the session               Balázs chooses (the dashboard composes as the owner)
//   a device                  the body's value where the setting does not
//                             enforce for devices (`naplo`, `legacy-szukitett`);
//                             where it does, `device:<name>`, marked unverified: a
//                             stolen phone key must not write as any agent
//                             (barracuda, #27)
//   the old shared token      the body's value only in `naplo` (the fleet still
//                             runs on it there); in an enforcing position the
//                             server writes `legacy-ismeretlen`, marked unverified
// The shared token never names anyone, so in `naplo` its claims stay what
// they are today: self-declared.

import { logger } from '../logger.js'
import { enforces, type AccessMode } from './access-enforcement.js'
import type { RouteContext } from './routes/types.js'

/** The sender the server writes for the shared token outside `naplo`. */
export const LEGACY_ACTOR = 'legacy-ismeretlen'

export type ClaimAuth = RouteContext['auth']

/** The agent an agent token names (`project/actor` outside the default project); null for every other credential. */
export function tokenAgent(auth: ClaimAuth): string | null {
  if (auth?.kind !== 'token' || !auth.actor || auth.actor === 'legacy') return null
  return auth.project && auth.project !== 'acropora' ? `${auth.project}/${auth.actor}` : auth.actor
}

export interface Claim {
  /** The value to store; null when there is none (the handler's own "required" check applies). */
  value: string | null
  /** True when the credential, not the body, says who it is. */
  verified: boolean
}

/**
 * The stored value of a self-declared actor field. `field` names it in the
 * log when an agent token's body says something else (the body value itself
 * is not logged: it is a request value).
 */
export function claimActor(auth: ClaimAuth, mode: AccessMode, claimed: unknown, field: string): Claim {
  const body = typeof claimed === 'string' && claimed.trim() ? claimed.trim() : null
  const agent = tokenAgent(auth)
  if (agent) {
    if (body !== null && body !== agent) logger.warn({ field, actor: agent }, 'self-declared actor ignored: the token names the caller')
    return { value: agent, verified: true }
  }
  if (auth?.kind === 'token') return enforces(mode, 'L') ? { value: LEGACY_ACTOR, verified: false } : { value: body, verified: false }
  if (auth?.kind === 'device' && enforces(mode, 'D')) return { value: `device:${auth.device ?? ''}`, verified: false }
  return { value: body, verified: auth?.kind === 'session' }
}

/** A sender the server wrote for a credential that names no agent: the shared token, or a device. */
export function isServerSetSender(claim: Claim): boolean {
  return !claim.verified && claim.value !== null && (claim.value === LEGACY_ACTOR || claim.value.startsWith('device:'))
}

/**
 * Who wrote a scheduled task's content through the API, as the runner reads
 * it: `session:<user>` keeps the operator frame; anything else runs with a
 * peer frame naming it.
 */
export function authorOf(auth: ClaimAuth): string {
  if (auth?.kind === 'session') return `session:${auth.user ?? ''}`
  const agent = tokenAgent(auth)
  if (agent) return agent
  if (auth?.kind === 'device') return `device:${auth.device ?? ''}`
  return LEGACY_ACTOR // the shared token names no one; nor does a missing credential
}
