// The quarantine reader's URL mode, the page-to-text half (src/karanten-szoveg.ts; task
// karanten-bongeszo-render, acrobot 39322). WHAT TURNS THIS RED:
//   - code (script, style, comment, doctype) or markup reaches the text, or a visible word is lost;
//   - a table loses its cell boundaries, or a footer's links run together into one word;
//   - a page of unclosed tags makes the command slow (quadratic), or an unclosed script keeps its code as text;
//   - the decision whether the reader could see a page is off: a large or long-lined HTML goes as HTML,
//     a PDF or a plain text is touched, a page with no text of its own is turned into an empty file.
import { describe, it, expect } from 'vitest'
import { LARGE_HTML_BYTES, MAX_LINE, READ_LINE_LIMIT, htmlToText, longestLine, readerWouldNotSee } from '../karanten-szoveg.js'
import { pageInput } from '../karanten-olvas.js'

describe('htmlToText', () => {
  it('SZ-CODE: scripts, styles, comments, the doctype, the head and svg are not text; the title comes first', () => {
    const t = htmlToText('<!DOCTYPE html><html><head><title>Cím &amp; más</title><meta charset="utf-8"><style>p{color:red}</style></head><body><!-- megjegyzés --><p>Látható</p><script>var rejtett = "x < y";</script><svg><text>ikon</text></svg><noscript>engedélyezd</noscript></body></html>')
    expect(t).toBe('Cím & más\n\nLátható')
  })

  it('SZ-ZEROWIDTH: a zero-width spacer (literal or as an entity) between lines is gone, not a line of its own', () => {
    expect(htmlToText('<div>X2D</div><div>\u200b</div><div>&#8203;$699 USD</div>')).toBe('X2D\n$699 USD')
  })

  it('SZ-TABLE: a table keeps its rows and its cells apart (a tab between cells), a block is a line, a paragraph or a table is set off by a blank line, entities are decoded', () => {
    const t = htmlToText('<table><tr><td>Max Nozzle Temperature</td><td>300&nbsp;&deg;C</td></tr><tr><th>Súly</th><td>16,25&#32;kg</td></tr></table><div>egy</div><div>két&#x20;sor<br>harmadik</div><p>5 &lt; 6 &amp;&amp; &unknown; &#0;</p>')
    expect(t).toBe('Max Nozzle Temperature\t300 °C\nSúly\t16,25 kg\n\negy\nkét sor\nharmadik\n\n5 < 6 && &unknown;')
  })

  it('SZ-APART: links, buttons and labels laid out by styles stay apart; text split by inline emphasis stays one word', () => {
    expect(htmlToText('<footer><a href="/a">Academy</a><a href="/b">Filament</a><button>Küldés</button></footer><p>sze<b>r</b>viz</p>')).toBe('Academy Filament Küldés\n\nszerviz')
  })

  it('SZ-UNCLOSED: an unclosed script drops the rest (code, not text); an unclosed svg or noscript does not eat the page', () => {
    expect(htmlToText('<p>előtte</p><script>var a = "<p>nem szöveg</p>"')).toBe('előtte')
    expect(htmlToText('<svg><p>marad</p>')).toBe('marad')
    expect(htmlToText('<noscript><p>marad is</p>')).toBe('marad is')
  })

  it('SZ-FAST: millions of unclosed svg, noscript, head and title tags, cell tags in the middle of a line, bare < signs and unclosed comments finish in seconds, not minutes (no quadratic scan)', () => {
    for (const bad of ['<svg>'.repeat(1_000_000), '<noscript>x'.repeat(500_000), '<'.repeat(5_000_000), '<a '.repeat(1_600_000), '<a>x'.repeat(1_200_000), '<!-- '.repeat(1_000_000), '<p>&amp;'.repeat(600_000),
      // barracuda, #326: the tab trim, the title lookup unclosed, and a title full of bare < signs were quadratic
      'x' + '<td>'.repeat(1_200_000) + 'x', '<title>'.repeat(700_000), '<title>' + '<'.repeat(4_000_000) + '</title>', '<head>' + '</header>'.repeat(500_000)]) {
      const t0 = Date.now()
      htmlToText(bad)
      expect(Date.now() - t0).toBeLessThan(2500)
    }
  })

  it('SZ-HEAD: a head that is never closed does not swallow the body up to the first header element (</header is not </head); a title is found, cleaned and bounded', () => {
    expect(htmlToText('<html><head><title>Cím</title><body><header>Menü</header><p>Szöveg</p>')).toBe('Cím\nMenü\n\nSzöveg')
    expect(htmlToText('<head><title>Egy <b>cím</b>\n&amp; más</title></head><p>x</p>')).toBe('Egy cím & más\n\nx')
    expect(htmlToText('<head><title>' + 'c'.repeat(5000) + '</title></head><p>x</p>')).toBe('x')
    expect(htmlToText('<head><title>' + 'c'.repeat(3500) + '</title></head><p>x</p>').split('\n')[0]!.length).toBe(300)
  })

  it('SZ-WRAP: a paragraph longer than the reader can see in one line is broken at blanks (no word cut), a word with no blank is cut at the limit; nothing is lost', () => {
    const words = Array.from({ length: 1200 }, (_, i) => `szo${i}`)
    const t = htmlToText(`<p>${words.join(' ')}</p>`)
    expect(Math.max(...t.split('\n').map((l) => l.length))).toBeLessThanOrEqual(MAX_LINE)
    expect(t.split('\n').length).toBeGreaterThan(1)
    expect(t.split(/\s+/)).toEqual(words)
    const blob = htmlToText(`<p>${'x'.repeat(5000)}</p>`).split('\n')
    expect([blob.length, blob.map((l) => l.length)]).toEqual([3, [1800, 1800, 1400]])
  })

  it('SZ-CUT: the text is cut at the size limit, and a page with no text gives an empty string', () => {
    expect(htmlToText(`<p>${'a'.repeat(2_000_000)}</p>`).length).toBe(1_500_000)
    expect(htmlToText('<html><head><script src="/a.js"></script></head><body><div id="root"></div></body></html>')).toBe('')
  })
})

describe('readerWouldNotSee and pageInput', () => {
  it('SZ-LIMITS: a large file or one line past the Read limit is not seen; a small file of short lines is', () => {
    expect([readerWouldNotSee('<p>kicsi</p>', 12), readerWouldNotSee('<p>kicsi</p>', LARGE_HTML_BYTES + 1), readerWouldNotSee(`<p>${'x'.repeat(READ_LINE_LIMIT + 1)}</p>`, 2100), readerWouldNotSee(`<p>${'x'.repeat(READ_LINE_LIMIT - 20)}</p>\n<p>b</p>`, 2000)]).toEqual([false, true, true, false])
    expect([longestLine(''), longestLine('ab'), longestLine('ab\ncdef\n'), longestLine('a\n\nbcd')]).toEqual([0, 2, 4, 3])
  })

  it('SZ-INPUT: a PDF and a plain text go as they are; a small page stays HTML; a long-lined or large page goes as text with its address; a page with no text stays HTML', () => {
    const b = (s: string) => Buffer.from(s)
    const at = 'https://pelda.test/x'
    expect(pageInput({ body: b('%PDF'), contentType: 'application/pdf', finalUrl: at })).toMatchObject({ name: 'bemenet-oldal.pdf', source: 'karanten-url' })
    expect(pageInput({ body: b('x'.repeat(300_000)), contentType: 'text/plain', finalUrl: at })).toMatchObject({ name: 'bemenet-oldal.txt', source: 'karanten-url' })
    expect(pageInput({ body: b('<p>kicsi</p>'), contentType: 'text/html', finalUrl: at })).toMatchObject({ name: 'bemenet-oldal.html', source: 'karanten-url' })
    const longLine = pageInput({ body: b(`<p>Szöveg</p><script>${'x'.repeat(3000)}</script>`), contentType: 'text/html; charset=utf-8', finalUrl: at })
    expect([longLine.name, longLine.source, longLine.body.toString()]).toEqual(['bemenet-oldal.txt', 'karanten-url-szoveg', `URL: ${at}\n\nSzöveg\n`])
    expect(pageInput({ body: b(`<html><head><script src="/a.js"></script></head><body><script>${'x'.repeat(200_000)}</script></body></html>`), contentType: 'text/html', finalUrl: at })).toMatchObject({ name: 'bemenet-oldal.html', source: 'karanten-url' })
  })
})
