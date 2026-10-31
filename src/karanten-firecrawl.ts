// The quarantine reader's URL mode, the fallback for a Cloudflare-protected page (task karanten-firecrawl; acrobot 39370).
//
// WHO DECIDED WHAT: the Firecrawl account is Balázs's approval (3D printer thread, message 1566156417268719767, 2026-10-31 18:26:27 UTC; just
// before it, 1566156023293681665, "Regisztralj te"). Where the key is kept (store/.firecrawl-key, mode 600, owner marveen, read by the
// calling user) is acrobot's decision (39370): Balázs said nothing on the place of the storage.
//
// Measured 2026-10-31 (acrobot): four reef2reef threads answered 403 to the direct download and to a headless browser, and 200 with
// 30-40 thousand characters of markdown to Firecrawl's /v2/scrape. When the direct download gets a 403 or a Cloudflare challenge, the
// command asks Firecrawl to fetch the page, and the reader gets the markdown as a file, like the text of a long-line page.
//
// WHAT DOES NOT LOOSEN:
//   - the gate: the Firecrawl branch starts only for a URL the egress gate allows (the same decision the download took, taken again
//     right before the call); a host the gate refuses never reaches Firecrawl;
//   - the key: read here, at the moment of the call, by the user who runs the command (store/.firecrawl-key is 600, marveen's); it goes
//     only into the Authorization header of a request pinned to a checked PUBLIC address of the API host, never into an argument, a log,
//     an error text, the reader's environment or file; the reader's answer is also checked for it (code 3);
//   - what goes out: the URL, and nothing else (no cookie, no header of the original request). A URL that carries a secret shape or a
//     fleet token (a query string with a token) is not sent;
//   - the answer is untrusted data like any page: it goes to the same quarantined reader as a file, wrapped, secret-filtered and cut;
//     the reader's tool list is not touched. Firecrawl's own error text is never passed on: only a class of the failure.
//   - where the page ends up: the final address Firecrawl reports must also be allowed by the gate (a redirect to a host that is not
//     on the list refuses the content).
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { MAX_TEXT_CHARS } from './karanten-szoveg.js'
import { pinnedPost, type DownloadDeps, type Response } from './karanten-letolt.js'
import { secretIn } from './gpt-package.js'

export const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape'
export const FIRECRAWL_KEY_FILE = '.firecrawl-key'
export const FIRECRAWL_TIMEOUT_MS = 60_000
export const FIRECRAWL_MAX_BYTES = 5 * 1024 * 1024

/** What made the command ask Firecrawl: the direct download's 403, or a Cloudflare challenge (on any status, 200 included). */
export type Trigger = '403' | 'kihivas'

export type Key = { ok: true; key: string } | { ok: false; why: string }

/** The key, read by the calling user; a reason (never the key, never the path of an unreadable file's content) when there is none. */
export function readFirecrawlKey(storeDir: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Key {
  let raw: string
  try {
    raw = read(`${storeDir}/${FIRECRAWL_KEY_FILE}`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { ok: false, why: code === 'ENOENT' ? 'nincs Firecrawl-kulcs (store/.firecrawl-key)' : code === 'EACCES' || code === 'EPERM' ? 'a Firecrawl-kulcsot ez a felhasznalo nem olvashatja (store/.firecrawl-key)' : 'a Firecrawl-kulcs nem olvashato' }
  }
  const key = raw.trim()
  if (key.length < 8 || /\s/.test(key)) return { ok: false, why: 'a Firecrawl-kulcs fajl nem kulcs-alaku (ures, tul rovid vagy tobb szavas)' }
  return { ok: true, key }
}

export type ScrapeResult = { ok: true; markdown: string; finalUrl: string } | { ok: false; why: string }

const CHALLENGE_TEXT = /just a moment|performing security verification|checking your browser before accessing|enable javascript and cookies to continue/i

/** One Firecrawl scrape of `target`, or why not (never with content, never with the key or Firecrawl's own error text). */
export async function firecrawlScrape(target: string, key: string, deps: DownloadDeps, endpoint = FIRECRAWL_ENDPOINT): Promise<ScrapeResult> {
  let url: URL
  try { url = new URL(target) } catch { return { ok: false, why: 'nem URL' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: `nem http(s): ${url.protocol}` }
  if (url.username || url.password) return { ok: false, why: 'hitelesito adat az URL-ben' }
  // the gate, again, right before the call: only an allowed host is ever handed to Firecrawl
  if (!deps.allowed(url.href)) return { ok: false, why: `az egress-kapu nem engedi: ${url.hostname}` }
  const api = new URL(endpoint)
  // the API host: resolved once, every address public, the connection pinned to it (the key goes nowhere else)
  let addrs: string[]
  try { addrs = net.isIP(api.hostname) ? [api.hostname] : await deps.resolve(api.hostname) } catch { return { ok: false, why: 'a Firecrawl cime nem oldhato fel' } }
  if (!addrs.length || addrs.some((a) => deps.isBlocked(a))) return { ok: false, why: 'a Firecrawl cime nem publikus cimre mutat' }
  const post = deps.post ?? pinnedPost
  let res: Response
  try {
    res = await post(api, addrs[0]!, {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${key}`,
      'user-agent': 'acroveliq-karanten/1',
    }, JSON.stringify({ url: url.href, formats: ['markdown'], onlyMainContent: true }), FIRECRAWL_TIMEOUT_MS, FIRECRAWL_MAX_BYTES)
  } catch (e) {
    const m = e instanceof Error ? e.message : ''
    return { ok: false, why: m === 'idotullepes' ? 'a Firecrawl nem valaszolt idoben' : m === 'tul nagy' ? 'a Firecrawl valasza tul nagy' : 'a Firecrawl hivasa hibaval allt le' }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, why: 'a Firecrawl elutasitotta a kulcsot' }
  if (res.status === 402) return { ok: false, why: 'a Firecrawl-kredit elfogyott' }
  if (res.status === 429) return { ok: false, why: 'a Firecrawl korlatozza a hivasokat (429)' }
  if (res.status !== 200) return { ok: false, why: `a Firecrawl valasza ${res.status}` }
  let json: unknown
  try { json = JSON.parse(res.body.toString('utf8')) } catch { return { ok: false, why: 'a Firecrawl valasza nem JSON' } }
  const j = json as { success?: unknown; data?: { markdown?: unknown; metadata?: { statusCode?: unknown; url?: unknown; sourceURL?: unknown } } }
  if (j?.success !== true || typeof j.data?.markdown !== 'string') return { ok: false, why: 'a Firecrawl nem adott markdownt' }
  const meta = j.data.metadata ?? {}
  // the page's own answer, as Firecrawl saw it: a 403 there is a 403 here
  if (typeof meta.statusCode === 'number' && meta.statusCode !== 200) return { ok: false, why: `az oldal a Firecrawlnak is ${meta.statusCode}-t adott` }
  // where it ended up: a redirect to a host the gate does not allow refuses the content
  const finalUrl = typeof meta.url === 'string' ? meta.url : typeof meta.sourceURL === 'string' ? meta.sourceURL : url.href
  let finalParsed: URL
  try { finalParsed = new URL(finalUrl) } catch { return { ok: false, why: 'a Firecrawl hibas veg-cimet adott' } }
  if (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:') return { ok: false, why: `a Firecrawl nem http(s) veg-cimet adott: ${finalParsed.protocol}` }
  if (!deps.allowed(finalParsed.href)) return { ok: false, why: `a Firecrawl atiranyitasa nem engedelyezett helyre vitt: ${finalParsed.hostname}` }
  const markdown = j.data.markdown.trim()
  if (!markdown) return { ok: false, why: 'a Firecrawl ures markdownt adott' }
  // a challenge page that Firecrawl returned as "the page"
  if (markdown.length < 2000 && CHALLENGE_TEXT.test(markdown)) return { ok: false, why: 'a Firecrawl is a Cloudflare kihivast kapta' }
  return { ok: true, markdown: markdown.length > MAX_TEXT_CHARS ? markdown.slice(0, MAX_TEXT_CHARS) : markdown, finalUrl: finalParsed.href }
}

/** True when the URL (the only thing that goes out) carries a secret shape or a fleet token value: it is not sent. */
export function urlHasSecret(url: string, known: string[]): string | null {
  let decoded = url
  try { decoded = decodeURIComponent(url) } catch { /* keep the raw form */ }
  return secretIn(url, known) ?? secretIn(decoded, known)
}
