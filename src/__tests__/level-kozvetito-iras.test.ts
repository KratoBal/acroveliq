// The relay's WRITE half on balazs@ (plan v2 points A and D): four verbs, each narrowed in the relay's code and not
// on the caller's discipline. WHAT TURNS THIS RED: an archive of a mail that does not carry `Acrobot/Hírlevél` in
// Gmail's own answer (whatever the caller claims); a 101st archive in a Budapest day (the day, not UTC's); an undo of a
// mail the relay did not archive, or of one archived over seven days ago; a label outside the five being created or
// put on; any request that is not a modify of one message or a label creation, or any body that names a label
// other than INBOX or one of the five (TRASH would be a trash); two archives at once passing a cap of one;
// the ledger forgetting after a restart.
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { parseRelayConfig, type RelayConfig } from '../level-kozvetito/config.js'
import { GoogleError, type GoogleApi } from '../level-kozvetito/google.js'
import { fileLedger, memoryLedger, type ArchiveLedger } from '../level-kozvetito/ledger.js'
import { budapestDay, LABEL_NAMES, WRITE_URL_SHAPES } from '../level-kozvetito/modify.js'
import { MailRelay, type LogFields } from '../level-kozvetito/relay.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const TOKEN = 'token-acrobot'
const MSG = (n: number) => `18c0ffee0000000${n}`

function config(archivePerDay = 100): RelayConfig {
  return parseRelayConfig({
    stateDir: '/tmp/x',
    quarantineDir: '/tmp/x/k',
    oauthClientIdFile: '/run/secrets/a',
    oauthClientSecretFile: '/run/secrets/b',
    callers: [{ name: 'acrobot', tokenSha256: sha(TOKEN) }],
    accounts: {
      info: { address: 'info@acropora.example', refreshTokenFile: '/run/secrets/i', calendar: true, redaction: 'all-short-numbers' },
      balazs: { address: 'balazs@acropora.example', refreshTokenFile: '/run/secrets/b', calendar: false, redaction: 'all-short-numbers' },
    },
    excludedSenders: { domains: [], addresses: [] },
    limits: { callsPerMinute: 600, maxAttachmentBytes: 1000, archivePerDay },
  })
}

interface Post {
  url: string
  body: Record<string, unknown>
}

/** A stateful fake Gmail: labels and the label ids of messages; POSTs change them and are recorded. */
function fakeGmail(opts: { labels?: Record<string, string>; messages?: Record<string, string[]>; createConflict?: boolean } = {}) {
  const labels = new Map(Object.entries(opts.labels ?? { 'Acrobot/Hírlevél': 'Label_news' }))
  const messages = new Map(Object.entries(opts.messages ?? {}))
  const posts: Post[] = []
  const asked: string[] = []
  const api: GoogleApi = {
    async getJson(_account, url) {
      asked.push(url)
      if (url.endsWith('/labels')) return { labels: [{ id: 'INBOX', name: 'INBOX' }, ...[...labels].map(([name, id]) => ({ id, name }))] }
      const m = /\/messages\/([0-9a-f]+)\?format=minimal$/.exec(url)
      if (m) {
        const ids = messages.get(m[1]!)
        if (!ids) throw new GoogleError(404, 'request')
        return { id: m[1], labelIds: [...ids] }
      }
      throw new GoogleError(0, 'request')
    },
    async postJson(_account, url, body) {
      // the transport's own guard, repeated here: the fake refuses what the real one would
      if (!WRITE_URL_SHAPES.some((shape) => shape.test(url))) throw new GoogleError(0, 'request')
      posts.push({ url, body: body as Record<string, unknown> })
      if (url.endsWith('/labels')) {
        if (opts.createConflict) {
          // somebody else made it in between
          labels.set((body as { name: string }).name, 'Label_raced')
          throw new GoogleError(409, 'request')
        }
        const id = `Label_${labels.size + 1}`
        labels.set((body as { name: string }).name, id)
        return { id }
      }
      const m = /\/messages\/([0-9a-f]+)\/modify$/.exec(url)!
      const ids = new Set(messages.get(m[1]!) ?? [])
      for (const id of ((body as { addLabelIds?: string[] }).addLabelIds ?? [])) ids.add(id)
      for (const id of ((body as { removeLabelIds?: string[] }).removeLabelIds ?? [])) ids.delete(id)
      messages.set(m[1]!, [...ids])
      return { id: m[1] }
    },
  }
  return { api, posts, asked, messages, labels }
}

const T0 = Date.parse('2026-10-19T10:00:00Z')

function relay(gmail: ReturnType<typeof fakeGmail>, over: { ledger?: ArchiveLedger; now?: () => number; perDay?: number } = {}) {
  const lines: LogFields[] = []
  const r = new MailRelay({ config: config(over.perDay), google: gmail.api, log: (f) => lines.push(f), nowMs: over.now ?? (() => T0), ledger: over.ledger ?? memoryLedger() })
  return { r, lines, call: (verb: string, body: Record<string, unknown>) => r.handle(TOKEN, 'balazs', verb, body) }
}

describe('cimke-letrehoz', () => {
  it('creates one of the five, with exactly the fields a label needs', async () => {
    const g = fakeGmail({ labels: {} })
    const { call } = relay(g)
    const a = await call('cimke-letrehoz', { nev: 'Acrobot/Számla' })
    expect(a).toEqual({ cimke: 'Acrobot/Számla', id: 'Label_1', created: true })
    expect(g.posts).toEqual([
      { url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels', body: { name: 'Acrobot/Számla', labelListVisibility: 'labelShow', messageListVisibility: 'show' } },
    ])
  })

  it('finds an existing one without posting, and survives a creation race', async () => {
    const existing = fakeGmail()
    expect(await relay(existing).call('cimke-letrehoz', { nev: 'Acrobot/Hírlevél' })).toEqual({ cimke: 'Acrobot/Hírlevél', id: 'Label_news', created: false })
    expect(existing.posts).toEqual([])
    const raced = fakeGmail({ labels: {}, createConflict: true })
    expect(await relay(raced).call('cimke-letrehoz', { nev: 'Acrobot/Ügyfél' })).toEqual({ cimke: 'Acrobot/Ügyfél', id: 'Label_raced', created: false })
  })

  it.each([['Acrobot/Számla '], ['acrobot/számla'], ['TRASH'], ['INBOX'], ['Valami/Más'], [''], [5]])('refuses the name %j, nothing asked of Gmail', async (nev) => {
    const g = fakeGmail()
    await expect(relay(g).call('cimke-letrehoz', { nev })).rejects.toMatchObject({ status: 400 })
    expect(g.asked).toEqual([])
    expect(g.posts).toEqual([])
  })
})

describe('cimkez', () => {
  it('puts the label id of one of the five on one message, and sends nothing else', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX'] } })
    expect(await relay(g).call('cimkez', { id: MSG(1), cimke: 'Acrobot/Hírlevél' })).toEqual({ id: MSG(1), cimke: 'Acrobot/Hírlevél' })
    expect(g.posts).toEqual([{ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${MSG(1)}/modify`, body: { addLabelIds: ['Label_news'] } }])
  })

  it('a label that has not been created yet is a 404, not an invented id', async () => {
    const g = fakeGmail({ labels: {}, messages: { [MSG(1)]: ['INBOX'] } })
    await expect(relay(g).call('cimkez', { id: MSG(1), cimke: 'Acrobot/Számla' })).rejects.toMatchObject({ status: 404, reason: 'label-missing' })
    expect(g.posts).toEqual([])
  })

  it.each([
    [{ id: MSG(1), cimke: 'TRASH' }],
    [{ id: MSG(1), cimke: 'INBOX' }],
    [{ id: MSG(1), cimke: 'SPAM' }],
    [{ id: MSG(1), cimke: 'Label_news' }],
    [{ id: MSG(1) }],
    [{ id: '../x', cimke: 'Acrobot/Hírlevél' }],
    [{ cimke: 'Acrobot/Hírlevél' }],
  ])('refuses %j without a call', async (body) => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX'] } })
    await expect(relay(g).call('cimkez', body)).rejects.toMatchObject({ status: 400 })
    expect(g.posts).toEqual([])
    expect(g.asked).toEqual([])
  })
})

describe('archival', () => {
  it('takes INBOX off a mail Gmail says carries the newsletter label, and only INBOX', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news', 'UNREAD'] } })
    const { call } = relay(g)
    expect(await call('archival', { id: MSG(1) })).toEqual({ id: MSG(1), archived: true, today: 1 })
    expect(g.posts).toEqual([{ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${MSG(1)}/modify`, body: { removeLabelIds: ['INBOX'] } }])
    expect(g.messages.get(MSG(1))).toEqual(['Label_news', 'UNREAD'])
  })

  it('refuses a mail without the label, whatever the caller says about it', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX'], [MSG(2)]: ['INBOX', 'Label_other'] } })
    const { call } = relay(g)
    await expect(call('archival', { id: MSG(1) })).rejects.toMatchObject({ status: 403, reason: 'archival-szukitett' })
    // the caller claims the label in the body: it counts for nothing
    await expect(call('archival', { id: MSG(2), cimke: 'Acrobot/Hírlevél', labelIds: ['Label_news'] })).rejects.toMatchObject({ status: 403, reason: 'archival-szukitett' })
    expect(g.posts).toEqual([])
  })

  it('refuses when the label does not even exist in the mailbox', async () => {
    const g = fakeGmail({ labels: {}, messages: { [MSG(1)]: ['INBOX', 'Label_news'] } })
    await expect(relay(g).call('archival', { id: MSG(1) })).rejects.toMatchObject({ status: 403, reason: 'archival-szukitett' })
    expect(g.posts).toEqual([])
  })

  it('a mail that is not in the inbox any more: 409, nothing to do', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['Label_news'] } })
    await expect(relay(g).call('archival', { id: MSG(1) })).rejects.toMatchObject({ status: 409, reason: 'not-in-inbox' })
    expect(g.posts).toEqual([])
  })

  it('stops at the daily cap, counted per Budapest day and not per UTC day', async () => {
    const messages = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [MSG(n), ['INBOX', 'Label_news']]))
    const g = fakeGmail({ messages })
    let now = Date.parse('2026-10-19T21:30:00Z') // 23:30 in Budapest
    const { call } = relay(g, { perDay: 3, now: () => now })
    for (const n of [1, 2, 3]) await call('archival', { id: MSG(n) })
    await expect(call('archival', { id: MSG(4) })).rejects.toMatchObject({ status: 429, reason: 'archival-napi-hatar' })
    now = Date.parse('2026-10-19T21:50:00Z') // still the same Budapest day
    await expect(call('archival', { id: MSG(4) })).rejects.toMatchObject({ status: 429 })
    now = Date.parse('2026-10-19T22:30:00Z') // 00:30 in Budapest: a new day, though not a new UTC day
    expect(await call('archival', { id: MSG(4) })).toMatchObject({ archived: true, today: 1 })
    expect(budapestDay(Date.parse('2026-10-19T22:30:00Z'))).toBe('2026-10-20')
  })

  it('two archives at once cannot both pass a cap of one', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news'], [MSG(2)]: ['INBOX', 'Label_news'] } })
    const { call } = relay(g, { perDay: 1 })
    const results = await Promise.allSettled([call('archival', { id: MSG(1) }), call('archival', { id: MSG(2) })])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(g.posts).toHaveLength(1)
  })

  it('the count survives a restart (the file ledger)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'archivalt.jsonl')
    const messages = { [MSG(1)]: ['INBOX', 'Label_news'], [MSG(2)]: ['INBOX', 'Label_news'] }
    await relay(fakeGmail({ messages }), { perDay: 1, ledger: fileLedger(path) }).call('archival', { id: MSG(1) })
    const after = relay(fakeGmail({ messages }), { perDay: 1, ledger: fileLedger(path) })
    await expect(after.call('archival', { id: MSG(2) })).rejects.toMatchObject({ status: 429 })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

describe('inbox-vissza', () => {
  it('puts INBOX back on a mail this relay archived, within seven days', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news'] } })
    let now = T0
    const { call } = relay(g, { now: () => now })
    await call('archival', { id: MSG(1) })
    now += 6 * 86_400_000
    expect(await call('inbox-vissza', { id: MSG(1) })).toEqual({ id: MSG(1), restored: true })
    expect(g.posts[1]).toEqual({ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${MSG(1)}/modify`, body: { addLabelIds: ['INBOX'] } })
  })

  it('refuses a mail the relay did not archive, one archived over seven days ago, and one more than that', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news'], [MSG(2)]: ['Label_other'] } })
    let now = T0
    const { call } = relay(g, { now: () => now })
    await call('archival', { id: MSG(1) })
    await expect(call('inbox-vissza', { id: MSG(2) })).rejects.toMatchObject({ status: 403, reason: 'nem-a-kozvetito-archivalta' })
    now += 8 * 86_400_000
    await expect(call('inbox-vissza', { id: MSG(1) })).rejects.toMatchObject({ status: 403, reason: 'nem-a-kozvetito-archivalta' })
    expect(g.posts).toHaveLength(1)
  })
})

describe('what can ever be written', () => {
  it('every POST of a mixed run goes to a modify of one message or the labels, and names only INBOX or one of the five', async () => {
    const g = fakeGmail({ labels: {}, messages: { [MSG(1)]: ['INBOX'], [MSG(2)]: ['INBOX'] } })
    const { call } = relay(g)
    for (const nev of LABEL_NAMES) await call('cimke-letrehoz', { nev })
    await call('cimkez', { id: MSG(1), cimke: 'Acrobot/Hírlevél' })
    await call('cimkez', { id: MSG(2), cimke: 'Acrobot/Tennivaló' })
    await call('archival', { id: MSG(1) })
    await call('inbox-vissza', { id: MSG(1) })
    const fiveIds = new Set(g.labels.values())
    const bodyKeys = new Set(g.posts.flatMap((p) => Object.keys(p.body)))
    const ids = g.posts.flatMap((p) => [...((p.body['addLabelIds'] as string[]) ?? []), ...((p.body['removeLabelIds'] as string[]) ?? [])])
    expect([...bodyKeys].sort()).toEqual(['addLabelIds', 'labelListVisibility', 'messageListVisibility', 'name', 'removeLabelIds'])
    expect(ids.every((id) => id === 'INBOX' || fiveIds.has(id))).toBe(true)
    expect(g.posts.every((p) => WRITE_URL_SHAPES.some((shape) => shape.test(p.url)))).toBe(true)
  })

  it('the write verbs exist on balazs@ only', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news'] } })
    const r = relay(g).r
    for (const verb of ['cimke-letrehoz', 'cimkez', 'archival', 'inbox-vissza']) {
      await expect(r.handle(TOKEN, 'info', verb, { id: MSG(1), nev: 'Acrobot/Számla', cimke: 'Acrobot/Számla' })).rejects.toMatchObject({ status: 404 })
    }
    expect(g.posts).toEqual([])
  })

  it('the log names the verb, the mail and the fixed label, never a body or a subject', async () => {
    const g = fakeGmail({ messages: { [MSG(1)]: ['INBOX', 'Label_news'] } })
    const { call, lines } = relay(g)
    await call('cimkez', { id: MSG(1), cimke: 'Acrobot/Hírlevél' })
    await call('archival', { id: MSG(1) })
    expect(lines.map((l) => [l['verb'], l['id'], l['cimke'] ?? null, l['archived'] ?? null, l['result']])).toEqual([
      ['cimkez', MSG(1), 'Acrobot/Hírlevél', null, 'ok'],
      ['archival', MSG(1), null, true, 'ok'],
    ])
    // the keys are exact: a field that carried the request body or a mail's text would be a key nobody listed here
    expect(lines.map((l) => Object.keys(l).sort())).toEqual([
      ['account', 'at', 'caller', 'cimke', 'id', 'result', 'verb'],
      ['account', 'archived', 'at', 'caller', 'id', 'result', 'today', 'verb'],
    ])
  })
})

describe('the URL shapes a POST may take', () => {
  const accepts = (url: string) => WRITE_URL_SHAPES.some((shape) => shape.test(url))
  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

  it('accepts exactly a modify of one message and the label creation', () => {
    expect([accepts(`${BASE}/messages/${MSG(1)}/modify`), accepts(`${BASE}/labels`)]).toEqual([true, true])
  })

  it.each([
    ['send', `${BASE}/messages/${MSG(1)}/send`],
    ['trash', `${BASE}/messages/${MSG(1)}/trash`],
    ['untrash', `${BASE}/messages/${MSG(1)}/untrash`],
    ['delete as a path', `${BASE}/messages/${MSG(1)}/delete`],
    ['batchModify', `${BASE}/messages/batchModify`],
    ['batchDelete', `${BASE}/messages/batchDelete`],
    ['import', `${BASE}/messages/import`],
    ['insert', `${BASE}/messages/insert`],
    ['send a draft', `${BASE}/drafts/send`],
    ['a message path with a slash in the id', `${BASE}/messages/${MSG(1)}/x/modify`],
    ['a modify with a query', `${BASE}/messages/${MSG(1)}/modify?alt=json`],
    ['a modify of another user', 'https://gmail.googleapis.com/gmail/v1/users/other/messages/' + MSG(1) + '/modify'],
    ['settings', `${BASE}/settings/filters`],
    ['one label by id', `${BASE}/labels/Label_1`],
    ['another host', `https://evil.example/gmail/v1/users/me/messages/${MSG(1)}/modify`],
    ['http', `http://gmail.googleapis.com/gmail/v1/users/me/messages/${MSG(1)}/modify`],
  ])('refuses %s', (_name, url) => {
    expect(accepts(url)).toBe(false)
  })
})

describe('the file ledger', () => {
  it('skips a torn last line after a crash and a line that is not an entry', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'l.jsonl')
    writeFileSync(path, `${JSON.stringify({ at: 1, account: 'balazs', id: MSG(1) })}\n{"at":2,"acc`)
    appendFileSync(path, '\nnem json\n')
    expect(fileLedger(path).entries()).toEqual([{ at: 1, account: 'balazs', id: MSG(1) }])
  })
})
