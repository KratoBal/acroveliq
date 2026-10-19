// What must not come out of a mailbox into a model's context (plan v2, point C; barracuda's review).
// A personal mailbox holds password-reset links, one-time codes and bank notices. The secret scanner
// catches tokens; it does not catch a six-digit code or a reset URL. So the relay takes them out BEFORE
// the text leaves it, in two layers, and the caller cannot switch either off.
//
//   1. excluded SENDERS (account-security and bank senders): the text and the attachments do not come out at all
//   2. redaction in every other mail: standalone 4-8 digit numbers and links that carry a token
//
// Neither is a promise that a secret never gets through: a code written in words, or a secret under an
// innocent sender, is not caught. The caller is still a model reading untrusted text; this narrows what
// the text can hold.
import type { RedactionMode } from './config.js'

const ADDRESS_RX = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/**
 * Every address the From header mentions, lower-cased. ALL of them, display name included: a header like
 * `"accounts@google.com" <someone@elsewhere.example>` names an excluded address in the display name, and
 * the safe reading is to treat the mail as excluded rather than to guess which address is the sender.
 */
export function senderAddresses(from: string): string[] {
  return [...from.matchAll(ADDRESS_RX)].map((m) => m[0].toLowerCase())
}

export interface ExcludedSenders {
  domains: readonly string[]
  addresses: readonly string[]
}

/** The first excluded domain or address the From header names, or null. A domain covers its subdomains. */
export function excludedSender(from: string, excluded: ExcludedSenders): string | null {
  for (const address of senderAddresses(from)) {
    if (excluded.addresses.includes(address)) return address
    const domain = address.slice(address.lastIndexOf('@') + 1)
    const hit = excluded.domains.find((d) => domain === d || domain.endsWith(`.${d}`))
    if (hit) return hit
  }
  return null
}

/** The domain of the first address in the From header, for a line that says who an excluded mail came from. */
export function senderDomain(from: string): string {
  const [first] = senderAddresses(from)
  return first ? first.slice(first.lastIndexOf('@') + 1) : 'ismeretlen'
}

const URL_RX = /https?:\/\/[^\s<>"')\]]+/gi
const LONG_SEGMENT = 20

/**
 * A link that carries something: a query string, a fragment, or a path segment longer than 20 characters
 * (a reset token is one). A plain `https://example.com/kapcsolat` stays, so a mail that points at a page
 * still reads as one.
 */
function redactLinks(text: string): string {
  return text.replace(URL_RX, (match) => {
    let url: URL
    try {
      url = new URL(match)
    } catch {
      return '[LINK]'
    }
    const carries = url.search !== '' || url.hash.length > 1 || url.pathname.split('/').some((s) => s.length > LONG_SEGMENT)
    return carries ? `[LINK ${url.hostname}]` : match
  })
}

// A standalone number of 4-8 digits: not part of a longer number or word, not part of a date, an amount
// with a separator, or a number/year style `7841/26`.
const NUMBER_RX = /(?<![\p{L}\p{N}_.,/:+@-])(\d{4,8})(?![\p{L}\p{N}_@]|[.,/:-]\d)/gu
const CODE_WORD_RX = /(k[óo]d|code|pin\b|otp|jelsz[óo]|password|verif|megerős|biztons|authentic|token|belép)/i
const NEAR = 40

function redactNumbers(text: string, mode: RedactionMode): string {
  return text.replace(NUMBER_RX, (match, _digits: string, offset: number) => {
    if (mode === 'all-short-numbers') return '[KOD]'
    const window = text.slice(Math.max(0, offset - NEAR), offset + match.length + NEAR)
    return CODE_WORD_RX.test(window) ? '[KOD]' : match
  })
}

// A long unbroken run of letters, digits, `_` and `-` that mixes both letters and digits: an API key, a
// session id, a base64 token written into the body.
const TOKEN_RX = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g

export function redactBody(text: string, mode: RedactionMode): string {
  return redactNumbers(redactLinks(text), mode).replace(TOKEN_RX, '[AZON]')
}
