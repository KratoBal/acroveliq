// The quarantine reader's URL mode, the page-to-text half (task karanten-bongeszo-render; acrobot 39322,
// Balázs 2026-10-31 17:27 UTC). WHY IT EXISTS: a modern page is one HTML line of 600 KB (the scripts and
// their JSON inline), and the reader's Read tool shows a line only up to its limit, so the reader saw the
// first lines and none of the text (measured 2026-10-31 on bambulab.com/en/x2d/specs, /en/compare and
// /en-us/x2d/faq: 656-756 KB, the longest line 570-610 KB). The visible text of those pages is in the
// HTML itself (measured: 5545 characters of tag-stripped text against 5565 in the rendered page), so the
// command hands the reader TEXT as a file, not the HTML.
//
// This is not a security boundary (the reader is the quarantine; the text is as untrusted as the HTML
// was) and it is deliberately small: scripts, styles and comments go, block tags become line breaks,
// table cells tab-separated, entities decoded. A page whose text is NOT in the HTML (a script-built
// shell) gives no text here and is handed over as the HTML, as before.

/** The reader's Read tool shows a line only up to about this many characters: a longer one is cut. */
export const READ_LINE_LIMIT = 2000
/** An HTML file above this size is handed over as text even when its lines are short. */
export const LARGE_HTML_BYTES = 100 * 1024
/** The text handed to the reader is cut here (its answer is cut much lower anyway). */
export const MAX_TEXT_CHARS = 1_500_000

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', times: '×', plusmn: '±', sup2: '²', sup3: '³', micro: 'µ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' '
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

// elements whose content is not text a person reads
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object', 'canvas', 'select'])
// code: when it is never closed, everything after it is code, not text
const RAW = new Set(['script', 'style'])
// a line break only (a row, an item, a <br>) and a paragraph break (a block): each is one mark in the text, so the
// open and the close of a tag, or a run of nested blocks, make ONE break and not a blank line per tag
const LINE = new Set(['address', 'aside', 'body', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'html', 'legend', 'li', 'main', 'nav', 'option', 'summary', 'tbody', 'tfoot', 'thead', 'tr'])
const PARA = new Set(['article', 'blockquote', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'section', 'table', 'ul'])
const MARK_LINE = '\u0001'
const MARK_PARA = '\u0002'
const CELL = new Set(['td', 'th'])
// inline elements that a page lays out apart with its styles (a footer's links): a space keeps the words apart
const APART = new Set(['a', 'button', 'label'])

/** The page's title (the head is dropped from the body text), or ''. */
function titleOf(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return m ? decodeEntities(m[1]!.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : ''
}

/**
 * One pass over the markup, no backtracking: every `<` is looked at once and every search for a closing
 * mark runs forward only (and not again for a name that already had none), so a page made of unclosed
 * tags cannot make the command quadratic.
 */
function strip(html: string): string {
  const lower = html.toLowerCase()
  const out: string[] = []
  const noClose = new Set<string>()
  const n = html.length
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { out.push(html.slice(i).replace(/\s+/g, ' ')); break }
    out.push(html.slice(i, lt).replace(/\s+/g, ' '))
    if (lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) break
      out.push(' ')
      i = end + 3
      continue
    }
    // a doctype or a processing instruction: markup, not text
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      if (end === -1) break
      i = end + 1
      continue
    }
    const m = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 24))
    if (!m) { out.push('<'); i = lt + 1; continue }
    const [, slash, name] = m as unknown as [string, string, string]
    const gt = html.indexOf('>', lt)
    if (gt === -1) { out.push(html.slice(lt).replace(/\s+/g, ' ')); break }
    if (!slash && DROP.has(name)) {
      const close = noClose.has(name) ? -1 : lower.indexOf(`</${name}`, gt)
      if (close !== -1) {
        const end = html.indexOf('>', close)
        out.push(' ')
        i = end === -1 ? n : end + 1
        continue
      }
      noClose.add(name)
      if (RAW.has(name)) break
    }
    out.push(PARA.has(name) ? MARK_PARA : LINE.has(name) ? MARK_LINE : CELL.has(name) ? (slash ? '' : '\t') : APART.has(name) ? ' ' : '')
    i = gt + 1
  }
  return out.join('')
}

/** The visible text of an HTML page, line by line; '' when there is none. */
export function htmlToText(html: string): string {
  const title = titleOf(html)
  // a run of marks (with the blanks between them) is one break: a paragraph break if any of them is one
  // zero-width characters (a page's spacer between a name and its price) are not text and only add noise
  const s = decodeEntities(strip(html)).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\u0001\u0002](?:[\u0001\u0002]|[ \t])*/g, (run) => (run.includes(MARK_PARA) ? '\n\n' : '\n'))
  const lines = s
    .split('\n')
    .map((l) => l.replace(/[ \u00a0\r\f\v]+/g, ' ').replace(/ ?\t ?/g, '\t').replace(/^\t+|\t+$/g, '').trim())
  // an empty line stays only as one separator between blocks
  const out: string[] = []
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(l)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  const body = out.join('\n')
  const text = title && !body.startsWith(title) ? `${title}\n\n${body}` : body
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
}

/** The longest line of a text, in characters. */
export function longestLine(s: string): number {
  let max = 0
  let from = 0
  for (;;) {
    const nl = s.indexOf('\n', from)
    const end = nl === -1 ? s.length : nl
    if (end - from > max) max = end - from
    if (nl === -1) return max
    from = nl + 1
  }
}

/** True when the reader would not see an HTML file's text: it is large, or one of its lines passes the limit. */
export function readerWouldNotSee(html: string, bytes: number): boolean {
  return bytes > LARGE_HTML_BYTES || longestLine(html) > READ_LINE_LIMIT
}
