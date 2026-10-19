// The control panel's client of the mail relay's secret door (task parancssor-f-titok-urlap, contract v2 section 2.9).
// The panel hands a secret to the relay and gets back only its length, a version and a state. The value is a
// parameter and a request body: this module never logs it, never stores it, never puts it in an error.
//
// The relay is the fixed http://levelkozvetito:8788 on the internal network; TITOK_KOZVETITO_URL counts only for
// http://127.0.0.1[:port] or http://localhost[:port] (the tests), so no setting can send the writer token to another host.
// The token is the panel's own file (0400); it goes only into the Authorization header of the one request, and the call
// has no retry and follows no redirect.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { STORE_DIR } from '../config.js'

export const SECRET_DOOR_TARGETS = ['oauth-client-secret'] as const
export const SECRET_DOOR_VERBS = ['ir', 'lezar', 'visszaall'] as const
export type SecretDoorTarget = (typeof SECRET_DOOR_TARGETS)[number]
export type SecretDoorVerb = (typeof SECRET_DOOR_VERBS)[number]

const RELAY_URL = 'http://levelkozvetito:8788'
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/
const TIMEOUT_MS = 45_000 // the relay's pre-flight makes up to two calls to Google, each with its own 15 s limit

/** The only error words the panel passes on: the relay's fixed reasons. Anything else becomes `kozvetito-hiba`. */
const REASONS = [
  'caller',
  'ismeretlen-cel',
  'ismeretlen-ige',
  'foglalt',
  'rate-limit',
  'rotacio-nyitva',
  'nincs-nyitott-rotacio',
  'szolgaltato-elutasitotta',
  'frissito-token-hiba',
  'szolgaltato-nem-elerheto',
] as const

export interface SecretDoorAnswer {
  status: number
  body: { cel: string; hossz: number; verzio: number; allapot: string } | { error: string }
}

export interface SecretDoorOptions {
  tokenFile?: string
  url?: string
  fetchImpl?: typeof fetch
}

function relayUrl(url: string | undefined): string {
  const given = url ?? process.env['TITOK_KOZVETITO_URL']
  return given && LOOPBACK.test(given) ? given : RELAY_URL
}

function writerToken(file: string): string | null {
  try {
    // a token other users can read is no secret: refuse it before any request
    if ((statSync(file).mode & 0o077) !== 0) return null
    const token = readFileSync(file, 'utf8').trim()
    return token !== '' && !/\s/.test(token) ? token : null
  } catch {
    return null
  }
}

/** One call of the secret door. `value` is only for `ir`. The answer carries fixed fields and fixed words, never relay text. */
export async function callSecretDoor(
  target: SecretDoorTarget,
  verb: SecretDoorVerb,
  value: string | null,
  opts: SecretDoorOptions = {},
): Promise<SecretDoorAnswer> {
  const token = writerToken(
    opts.tokenFile ?? process.env['TITOK_IRO_TOKEN_FILE'] ?? join(STORE_DIR, 'tokens', 'levelkozvetito-vezerlopult.token'),
  )
  if (!token) return { status: 503, body: { error: 'iro-token-hiany' } }
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(`${relayUrl(opts.url)}/titok/${target}/${verb}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(verb === 'ir' ? { ertek: value } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { status: 502, body: { error: 'kozvetito-nem-elerheto' } }
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (
    res.ok &&
    parsed &&
    typeof parsed['cel'] === 'string' &&
    Number.isInteger(parsed['hossz']) &&
    Number.isInteger(parsed['verzio']) &&
    typeof parsed['allapot'] === 'string'
  ) {
    return {
      status: 200,
      body: { cel: parsed['cel'], hossz: parsed['hossz'] as number, verzio: parsed['verzio'] as number, allapot: parsed['allapot'] },
    }
  }
  const reason = (REASONS as readonly unknown[]).find((r) => r === parsed?.['error'])
  return {
    status: res.ok ? 502 : res.status === 400 ? 400 : res.status,
    body: { error: typeof reason === 'string' ? reason : res.status === 400 ? 'ervenytelen-keres' : 'kozvetito-hiba' },
  }
}
