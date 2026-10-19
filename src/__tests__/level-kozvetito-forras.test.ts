// WHAT THE RELAY'S SOURCE MAY NOT CONTAIN (plan v2, point D, barracuda's wording). The `gmail.modify` scope
// does not only allow moving a mail to the trash: it allows SENDING mail in Balázs's name, and inserting and
// importing mail. The protection is therefore not the scope, it is this code and the container around it, and
// the code is checked here by reading its source: any Gmail endpoint that sends, trashes, deletes, imports,
// inserts or changes settings turns this red. Slice 2 adds exactly one write file (modify.ts: label and
// archive); until then `/modify` is forbidden too.
//
// The patterns are measured on samples first: a pattern that matched nothing would let everything through.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'src', 'level-kozvetito')

/** The code without its comments: a comment may say "send" without calling it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

export const FORBIDDEN: readonly [string, RegExp][] = [
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
  'a watch endpoint': 'post(`${GMAIL}/watch`)',
  'the client-library form of a write': 'gmail.users.messages.send({})',
  'a write HTTP method other than the token refresh': "{ method: 'PATCH' }",
  'a send or compose scope': "scope: 'https://www.googleapis.com/auth/gmail.send'",
}

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

  it('contains no endpoint, method or scope that sends, trashes, deletes, imports, inserts, changes settings or modifies', () => {
    const found: string[] = []
    for (const [file, source] of sources()) {
      const text = code(source)
      for (const [name, pattern] of FORBIDDEN) if (pattern.test(text)) found.push(`${file}: ${name}`)
    }
    expect(found).toEqual([])
  })

  it('the only POST of the transport is the token refresh', () => {
    const google = code(readFileSync(join(DIR, 'google.ts'), 'utf8'))
    expect(google.match(/method:\s*['"`]POST['"`]/g)).toHaveLength(1)
    expect(google).toContain("const TOKEN_URL = 'https://oauth2.googleapis.com/token'")
  })

  it('no module imports a write-capable Google or mail library', () => {
    const imports = sources().flatMap(([, s]) => [...code(s).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!))
    expect(imports.filter((i) => !i.startsWith('.') && !i.startsWith('node:'))).toEqual([])
  })
})
