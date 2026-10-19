// WHAT THE RELAY'S SOURCE MAY NOT CONTAIN (plan v2, point D, barracuda's wording). The `gmail.modify` scope
// does not only allow moving a mail to the trash: it allows SENDING mail in Balázs's name, and inserting and
// importing mail. The protection is therefore not the scope, it is this code and the container around it, and
// the code is checked here by reading its source: any Gmail endpoint that sends, trashes, deletes, imports,
// inserts or changes settings turns this red. The only write file is modify.ts (label and archive): the
// `/modify` and `/labels` endpoints may be named THERE and nowhere else, and what it may put in a request is
// narrowed further below (a label id of the trash, spam or sent mail never appears in the source).
//
// The patterns are measured on samples first: a pattern that matched nothing would let everything through.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'src', 'level-kozvetito')

/**
 * The code without its comments and without the paths of its imports: a comment may say "send" without
 * calling it, and `from './modify.js'` is a module name, not an endpoint.
 */
function code(source: string): string {
  return stripComments(source).replace(/\bfrom\s+'[^']*'/g, "from ''")
}

/** Comments off, imports kept: for the check of WHAT is imported. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

export const FORBIDDEN: readonly [string, RegExp][] = [
  ['a labels endpoint', /\/labels\b/],
  ['a send endpoint', /\/(messages|drafts)(\/[^/\s'"`]+)?\/send\b|\/messages\/send\b|\/drafts\/send\b/],
  ['a trash or untrash endpoint', /\/(trash|untrash)\b/],
  ['a delete or batchDelete endpoint', /\/batchDelete\b|\bmethod:\s*['"`]DELETE['"`]/],
  ['an import or insert endpoint', /\/messages\/(import|insert)\b/],
  ['a settings endpoint (filters, forwarding, delegates)', /\/settings\b/],
  ['a batchModify endpoint', /\/batchModify\b/],
  ['a modify endpoint', /\/modify\b/],
  ['a watch endpoint', /\/(watch|stop)\b/],
  ['the client-library form of a write', /\b(messages|drafts|threads)\.(send|trash|untrash|delete|import|insert|modify|batchDelete|batchModify)\b/],
  ['a write HTTP method other than the token refresh', /\bmethod:\s*['"`](PUT|PATCH)['"`]/],
  ['a send or compose scope', /gmail\.(send|compose|insert)\b|mail\.google\.com\//],
]

const SAMPLES: Record<string, string> = {
  'a send endpoint': 'fetch(`${GMAIL}/messages/${id}/send`)',
  'a trash or untrash endpoint': 'url = `${GMAIL}/messages/${id}/trash`',
  'a delete or batchDelete endpoint': "{ method: 'DELETE' }",
  'an import or insert endpoint': 'post(`${GMAIL}/messages/import`)',
  'a settings endpoint (filters, forwarding, delegates)': "get(`${GMAIL}/settings/filters`)",
  'a batchModify endpoint': 'post(`${GMAIL}/messages/batchModify`)',
  'a modify endpoint': 'post(`${GMAIL}/messages/${id}/modify`)',
  'a labels endpoint': 'get(`${GMAIL}/labels`)',
  'a watch endpoint': 'post(`${GMAIL}/watch`)',
  'the client-library form of a write': 'gmail.users.messages.send({})',
  'a write HTTP method other than the token refresh': "{ method: 'PATCH' }",
  'a send or compose scope': "scope: 'https://www.googleapis.com/auth/gmail.send'",
}

/** The only file allowed to name these (the write half). */
const ONLY_IN_MODIFY = new Set(['a modify endpoint', 'a labels endpoint'])

const sources = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const)

describe('the relay\'s source', () => {
  it('reads the files at all', () => {
    expect(sources().map(([f]) => f)).toEqual(expect.arrayContaining(['relay.ts', 'google.ts', 'http.ts', 'config.ts', 'redact.ts', 'main.ts']))
  })

  it.each(FORBIDDEN)('every pattern matches a sample of what it forbids: %s', (name, pattern) => {
    expect(pattern.test(SAMPLES[name]!), name).toBe(true)
  })

  it('contains no endpoint, method or scope that sends, trashes, deletes, imports, inserts or changes settings; modify and labels only in modify.ts', () => {
    const found: string[] = []
    for (const [file, source] of sources()) {
      const text = code(source)
      for (const [name, pattern] of FORBIDDEN) {
        if (ONLY_IN_MODIFY.has(name) && file === 'modify.ts') continue
        if (pattern.test(text)) found.push(`${file}: ${name}`)
      }
    }
    expect(found).toEqual([])
  })

  it('modify.ts does name both of its endpoints (the allowance is not an empty one)', () => {
    const modify = code(readFileSync(join(DIR, 'modify.ts'), 'utf8'))
    expect(FORBIDDEN.filter(([name, pattern]) => ONLY_IN_MODIFY.has(name) && pattern.test(modify)).map(([name]) => name).sort()).toEqual(['a labels endpoint', 'a modify endpoint'])
  })

  it('the transport posts only to a shape its constructor was given: its two POSTs are the token refresh and the guarded post', () => {
    const google = code(readFileSync(join(DIR, 'google.ts'), 'utf8'))
    expect(google.match(/method:\s*['"`]POST['"`]/g)).toHaveLength(2)
    expect(google).toContain("const TOKEN_URL = 'https://oauth2.googleapis.com/token'")
    // the guard comes BEFORE the post, and the default is no shape at all
    expect(google.indexOf('writeShapes.some(')).toBeGreaterThan(-1)
    expect(google.indexOf('writeShapes.some(')).toBeLessThan(google.indexOf("method: 'POST',\n        headers: { Authorization"))
    expect(google).toContain('opts.writeShapes ?? []')
  })

  it('no source names a label of the trash, spam, sent, drafts, chat or the star/importance flags', () => {
    const found: string[] = []
    for (const [file, source] of sources()) {
      const text = code(source)
      for (const word of ['TRASH', 'SPAM', 'SENT', 'DRAFT', 'CHAT', 'STARRED', 'IMPORTANT', 'CATEGORY_']) {
        if (new RegExp(`['"\`]${word}`).test(text)) found.push(`${file}: ${word}`)
      }
    }
    expect(found).toEqual([])
  })

  it('INBOX is named only in modify.ts, and removeLabelIds only once, with INBOX alone', () => {
    const outside = sources().filter(([file, source]) => file !== 'modify.ts' && /['"`]INBOX['"`]/.test(code(source))).map(([file]) => file)
    expect(outside).toEqual([])
    const modify = code(readFileSync(join(DIR, 'modify.ts'), 'utf8'))
    expect(modify.match(/removeLabelIds/g)).toHaveLength(1)
    expect(modify).toContain("removeLabelIds: ['INBOX']")
    // the other label list put on a message is the one resolved from the five names, or INBOX for the undo
    expect([...modify.matchAll(/addLabelIds:\s*(\[[^\]]*\])/g)].map((m) => m[1])).toEqual(['[labelId]', "['INBOX']"])
  })

  it('no module imports a Google or mail library: only its own files and node: modules', () => {
    const imports = sources().flatMap(([, s]) => [...stripComments(s).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!))
    // the control: the scan sees the imports it is about to judge
    expect(imports).toEqual(expect.arrayContaining(['./relay.js', './modify.js', 'node:crypto']))
    expect(imports.filter((i) => !i.startsWith('.') && !i.startsWith('node:'))).toEqual([])
  })

  it('only the entry points import relay.js: the leaf modules take Refusal and LogFields from errors.js (no import cycle)', () => {
    const importers = sources()
      .filter(([, s]) => /from\s+'\.\/relay\.js'/.test(stripComments(s)))
      .map(([name]) => name)
      .sort()
    // the control: the scan finds the three that legitimately do
    expect(importers).toEqual(['http.ts', 'main.ts'])
  })
})
