// The relay's secret-writing door (task parancssor-f-titok-urlap, contract v1 sections 2.1-2.8): the control panel
// hands a secret it got from a provider to the relay, and the relay writes its OWN store. The value goes into the
// store and nowhere else: not into the answer (only its length), not into the log, not into an error text.
//
//   POST /titok/<target>/ir         {"ertek": "<value>"}   pre-flight, then a new active version; the old one stays
//   POST /titok/<target>/lezar      {}                     the rotation is closed: the previous value is deleted
//   POST /titok/<target>/visszaall  {}                     the previous value is the active one again
//
// The targets are the constant list below: a name from a request is looked up in it and never builds a path. The
// callers are the `secretWriters` of the settings, a list apart from the mail callers.
import { createHash, timingSafeEqual } from 'node:crypto'

import type { RelayConfig } from './config.js'
import { Refusal, type LogFields } from './errors.js'
import { GoogleError, type ClientSecretProbe } from './google.js'
import type { SecretStore, SecretState } from './secret-store.js'

/** What may be written. Adding a target is a code change and a review, never a setting. */
export const SECRET_TARGETS = ['oauth-client-secret'] as const
export type SecretTarget = (typeof SECRET_TARGETS)[number]

const VERBS = ['ir', 'lezar', 'visszaall'] as const
const VALUE = /^[\x21-\x7e]{8,512}$/
const WRITES_PER_HOUR = 5
const HOUR_MS = 3_600_000

export interface SecretServiceDeps {
  config: RelayConfig
  google: ClientSecretProbe
  store: SecretStore
  log: (fields: LogFields) => void
  nowMs?: () => number
}

function isTarget(value: string): value is SecretTarget {
  return (SECRET_TARGETS as readonly string[]).includes(value)
}

/** A request path part reduced to what may go into the log. */
function safeWord(value: string): string {
  return /^[a-z-]{1,32}$/.test(value) ? value : 'ervenytelen'
}

export class SecretService {
  private readonly byHash = new Map<string, string>()
  private readonly attempts = new Map<string, number[]>()
  private readonly busy = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: SecretServiceDeps) {
    for (const w of deps.config.secretWriters) this.byHash.set(w.tokenSha256, w.name)
    this.now = deps.nowMs ?? Date.now
  }

  private authenticate(token: string | undefined): string | null {
    if (!token) return null
    const given = Buffer.from(createHash('sha256').update(token).digest('hex'))
    let found: string | null = null
    for (const [hash, name] of this.byHash) {
      const want = Buffer.from(hash)
      if (want.length === given.length && timingSafeEqual(want, given)) found = name
    }
    return found
  }

  private throttle(target: string): void {
    const cutoff = this.now() - HOUR_MS
    const recent = (this.attempts.get(target) ?? []).filter((t) => t > cutoff)
    if (recent.length >= WRITES_PER_HOUR) {
      this.attempts.set(target, recent)
      throw new Refusal(429, 'rate-limit')
    }
    recent.push(this.now())
    this.attempts.set(target, recent)
  }

  async handle(token: string | undefined, target: string, verb: string, body: Record<string, unknown>): Promise<unknown> {
    const at = new Date(this.now()).toISOString()
    const caller = this.authenticate(token)
    // an unknown caller is logged by what it asked, never by the token it presented
    if (!caller) {
      this.deps.log({
        at,
        event: 'titok_elutasitva',
        hivo: 'ismeretlen',
        cel: safeWord(target),
        ige: safeWord(verb),
        reason: 'caller',
      })
      throw new Refusal(403, 'caller')
    }
    const entry = {
      at,
      hivo: caller,
      cel: safeWord(target),
      ige: safeWord(verb),
    }
    try {
      if (!isTarget(target)) throw new Refusal(404, 'ismeretlen-cel')
      if (!(VERBS as readonly string[]).includes(verb)) throw new Refusal(404, 'ismeretlen-ige')
      if (this.busy.has(target)) throw new Refusal(409, 'foglalt')
      this.busy.add(target)
      try {
        const state = await this.run(target, verb, body)
        const hossz = this.deps.store.read(target).length
        this.deps.log({
          ...entry,
          event: `titok_${verb}`,
          hossz,
          verzio: state.verzio,
          rotacio: state.rotacioNyitva,
          eredmeny: 'ok',
        })
        return {
          cel: target,
          hossz,
          verzio: state.verzio,
          allapot: state.rotacioNyitva ? 'rotacio-nyitva' : 'aktiv',
        }
      } finally {
        this.busy.delete(target)
      }
    } catch (err) {
      const reason = err instanceof Refusal ? err.reason : err instanceof GoogleError ? 'szolgaltato' : 'internal'
      this.deps.log({
        ...entry,
        event: 'titok_elutasitva',
        eredmeny: 'hiba',
        reason,
      })
      throw err
    }
  }

  private async run(target: SecretTarget, verb: string, body: Record<string, unknown>): Promise<SecretState> {
    const keys = Object.keys(body)
    if (verb !== 'ir') {
      // nothing else is read from the body; a stray key is an error text-free 400, so a pasted value is not echoed
      if (keys.length > 0) throw new Refusal(400, 'torzs: nem vart kulcs')
      return verb === 'lezar' ? this.deps.store.close(target) : this.deps.store.rollBack(target)
    }
    if (keys.length !== 1 || keys[0] !== 'ertek') throw new Refusal(400, 'torzs: csak az ertek kulcs')
    const value = body['ertek']
    if (typeof value !== 'string' || !VALUE.test(value)) throw new Refusal(400, 'ertek: ervenytelen alak')
    this.throttle(target)
    return this.deps.store.write(target, value, async (candidate) => {
      try {
        await this.deps.google.probeClientSecret(candidate)
      } catch (err) {
        if (err instanceof GoogleError && err.kind === 'token' && err.status > 0) {
          // invalid_grant says the REFRESH TOKEN is bad (a withdrawn consent): it is not a verdict on the candidate
          if (err.code === 'invalid_grant') throw new Refusal(502, 'frissito-token-hiba')
          throw new Refusal(502, 'szolgaltato-elutasitotta')
        }
        throw new Refusal(502, 'szolgaltato-nem-elerheto')
      }
    })
  }
}
