// The mail relay's named operations (task level-kozvetito, plan v2). A closed list: what is not here is not
// written. The READ verbs are here (list, read, attachment, calendar); the balazs@ label and archive
// verbs are in `modify.ts`, the one file allowed to name a Gmail write.
//
// The caller is a model that reads untrusted text, so everything that leaves is shaped for that reader:
//   - every text of the mailbox comes inside an `<untrusted>` envelope (the same wrapper the fleet uses);
//   - an excluded sender's text and attachments do not come out at all;
//   - numbers and links that look like codes and reset URLs are taken out of the rest;
//   - the log names who asked for what and which mail, never what the mail said.
import { createHash, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { cleanMessageText, wrapUntrusted } from '../prompt-safety.js'
import { ACCOUNTS, type AccountId, type RelayConfig } from './config.js'
import { Refusal, type LogFields } from './errors.js'
import { GoogleError, type GoogleApi } from './google.js'
import { memoryLedger, type ArchiveLedger } from './ledger.js'
import { MailboxWriter } from './modify.js'
import { excludedSender, redactBody, senderDomain } from './redact.js'

export { Refusal, type LogFields }

export interface RelayDeps {
  config: RelayConfig
  google: GoogleApi
  log: (fields: LogFields) => void
  nowMs?: () => number
  /** what the relay archived and when; the daily cap and `inbox-vissza` read it (default: in memory) */
  ledger?: ArchiveLedger
}

const READ_VERBS = ['lista', 'olvas', 'csatolmany'] as const
/** The write verbs exist on balazs@ only, and are all in modify.ts. */
const WRITE_VERBS = ['cimke-letrehoz', 'cimkez', 'archival', 'inbox-vissza'] as const
/** The closed verb list per account. A verb that is not in an account's list answers 404, whoever asks. */
export const VERBS: Readonly<Record<AccountId, readonly string[]>> = {
  info: [...READ_VERBS, 'naptar'],
  balazs: [...READ_VERBS, ...WRITE_VERBS],
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const MESSAGE_ID = /^[0-9a-f]{8,32}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/
const BODY_MAX = 20_000
const FIELD_MAX = 500
const DESCRIPTION_MAX = 2_000
const MAX_CALENDAR_DAYS = 31

interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
  headers?: { name?: string; value?: string }[]
}

interface GmailMessage {
  id?: string
  payload?: GmailPart
}

export interface AttachmentInfo {
  n: number
  filename: string
  mimeType: string
  size: number
  attachmentId: string
}

function headerOf(part: GmailPart | undefined, name: string): string {
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return typeof found?.value === 'string' ? found.value : ''
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** The readable text of a message: the plain-text parts, or the HTML ones with the markup taken off. */
export function messageText(payload: GmailPart | undefined): string {
  const plain: string[] = []
  const html: string[] = []
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return
    if (!part.filename && part.body?.data) {
      if (part.mimeType === 'text/plain') plain.push(decode(part.body.data))
      else if (part.mimeType === 'text/html') html.push(stripHtml(decode(part.body.data)))
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return (plain.length > 0 ? plain : html).join('\n').trim()
}

export function attachmentsOf(payload: GmailPart | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = []
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      out.push({
        n: out.length,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: typeof part.body.size === 'number' ? part.body.size : 0,
        attachmentId: part.body.attachmentId,
      })
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return out
}

/** A file name safe to put under the quarantine folder: no separator, no leading dot, a short plain charset. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80)
  return cleaned === '' ? 'melleklet' : cleaned
}

function text(value: unknown, path: string, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Refusal(400, `${path}: invalid`)
  }
  return value
}

function intIn(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Refusal(400, `${path}: invalid`)
  return value
}

function messageIdOf(value: unknown): string {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) throw new Refusal(400, 'id: invalid')
  return value
}

export class MailRelay {
  private readonly byHash = new Map<string, string>()
  private readonly windows = new Map<string, { minute: number; count: number }>()
  private readonly now: () => number
  private readonly writer: MailboxWriter

  constructor(private readonly deps: RelayDeps) {
    for (const c of deps.config.callers) this.byHash.set(c.tokenSha256, c.name)
    this.now = deps.nowMs ?? Date.now
    this.writer = new MailboxWriter({ config: deps.config, google: deps.google, ledger: deps.ledger ?? memoryLedger(), nowMs: this.now })
  }

  /** The caller a token belongs to, or null. Compared as hashes, in constant time, against every entry. */
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

  private throttle(caller: string): void {
    const minute = Math.floor(this.now() / 60_000)
    const w = this.windows.get(caller)
    if (!w || w.minute !== minute) {
      this.windows.set(caller, { minute, count: 1 })
      return
    }
    w.count += 1
    if (w.count > this.deps.config.limits.callsPerMinute) throw new Refusal(429, 'rate-limit')
  }

  async handle(token: string | undefined, account: string, verb: string, body: Record<string, unknown>): Promise<unknown> {
    const at = new Date(this.now()).toISOString()
    const caller = this.authenticate(token)
    // an unknown caller is logged by what it asked, never by the token it presented
    if (!caller) {
      this.deps.log({ at, caller: 'ismeretlen', account: safeWord(account), verb: safeWord(verb), result: 'refused', reason: 'caller' })
      throw new Refusal(403, 'caller')
    }
    const entry = { at, caller, account: safeWord(account), verb: safeWord(verb) }
    try {
      this.throttle(caller)
      if (!(ACCOUNTS as readonly string[]).includes(account) || !VERBS[account as AccountId].includes(verb)) {
        throw new Refusal(404, 'no such verb')
      }
      const result = await this.dispatch(account as AccountId, verb, body)
      this.deps.log({ ...entry, ...result.logged, result: 'ok' })
      return result.answer
    } catch (err) {
      if (err instanceof Refusal) {
        this.deps.log({ ...entry, result: 'refused', reason: err.reason, status: err.status })
      } else if (err instanceof GoogleError) {
        this.deps.log({ ...entry, result: 'error', kind: err.kind, status: err.status })
      } else {
        this.deps.log({ ...entry, result: 'error', kind: 'internal' })
      }
      throw err
    }
  }

  private async dispatch(account: AccountId, verb: string, body: Record<string, unknown>): Promise<{ answer: unknown; logged: LogFields }> {
    switch (verb) {
      case 'lista':
        return this.lista(account, body)
      case 'olvas':
        return this.olvas(account, body)
      case 'csatolmany':
        return this.csatolmany(account, body)
      case 'naptar':
        return this.naptar(account, body)
      case 'cimke-letrehoz':
        return this.writer.cimkeLetrehoz(account, body)
      case 'cimkez':
        return this.writer.cimkez(account, body)
      case 'archival':
        return this.writer.archival(account, body)
      case 'inbox-vissza':
        return this.writer.inboxVissza(account, body)
      default:
        throw new Refusal(404, 'no such verb')
    }
  }

  private field(value: string): string {
    return wrapUntrusted('gmail', cleanMessageText(value).slice(0, FIELD_MAX))
  }

  private async getJson<T>(account: AccountId, url: string): Promise<T> {
    return (await this.deps.google.getJson(account, url)) as T
  }

  private async lista(account: AccountId, body: Record<string, unknown>) {
    const q = text(body['q'], 'q', 200)
    const max = intIn(body['max'], 'max', 1, 50, 20)
    const mode = this.deps.config.accounts[account].redaction
    const listed = await this.getJson<{ messages?: { id?: string }[] }>(
      account,
      `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`,
    )
    const ids = (listed.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && MESSAGE_ID.test(id))
    const items: unknown[] = []
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = await Promise.all(
        ids.slice(i, i + 10).map(async (id) => {
          const m = await this.getJson<GmailMessage>(
            account,
            `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          )
          const from = headerOf(m.payload, 'From')
          const date = headerOf(m.payload, 'Date')
          // an excluded sender: who and when, nothing of what the subject says (a subject can carry a code)
          if (excludedSender(from, this.deps.config.excludedSenders)) {
            return { id, date: this.field(date), fromDomain: senderDomain(from), excluded: true }
          }
          return {
            id,
            date: this.field(date),
            from: this.field(from),
            subject: this.field(redactBody(headerOf(m.payload, 'Subject'), mode)),
            excluded: false,
          }
        }),
      )
      items.push(...chunk)
    }
    return { answer: { items }, logged: { count: items.length, queryLength: q.length } }
  }

  private async olvas(account: AccountId, body: Record<string, unknown>) {
    const id = messageIdOf(body['id'])
    const mode = this.deps.config.accounts[account].redaction
    const m = await this.getJson<GmailMessage>(account, `${GMAIL}/messages/${id}?format=full`)
    const from = headerOf(m.payload, 'From')
    const date = headerOf(m.payload, 'Date')
    if (excludedSender(from, this.deps.config.excludedSenders)) {
      return {
        answer: { id, date: this.field(date), fromDomain: senderDomain(from), excluded: true },
        logged: { id, excluded: true },
      }
    }
    const redacted = redactBody(cleanMessageText(messageText(m.payload)), mode).slice(0, BODY_MAX)
    return {
      answer: {
        id,
        date: this.field(date),
        from: this.field(from),
        subject: this.field(redactBody(headerOf(m.payload, 'Subject'), mode)),
        body: wrapUntrusted('gmail', redacted),
        attachments: attachmentsOf(m.payload).map((a) => ({
          n: a.n,
          filename: this.field(a.filename),
          mimeType: a.mimeType,
          size: a.size,
        })),
        excluded: false,
      },
      logged: { id, excluded: false },
    }
  }

  private async csatolmany(account: AccountId, body: Record<string, unknown>) {
    const id = messageIdOf(body['id'])
    const n = intIn(body['n'], 'n', 0, 49, -1)
    if (n < 0) throw new Refusal(400, 'n: required')
    const limits = this.deps.config.limits
    const m = await this.getJson<GmailMessage>(account, `${GMAIL}/messages/${id}?format=full`)
    // the attachment of an excluded sender does not come out either (barracuda, plan v2 review)
    if (excludedSender(headerOf(m.payload, 'From'), this.deps.config.excludedSenders)) throw new Refusal(403, 'excluded-sender')
    const attachment = attachmentsOf(m.payload)[n]
    if (!attachment) throw new Refusal(404, 'no such attachment')
    if (attachment.size > limits.maxAttachmentBytes) throw new Refusal(413, 'too-large')
    const data = await this.getJson<{ data?: string }>(account, `${GMAIL}/messages/${id}/attachments/${encodeURIComponent(attachment.attachmentId)}`)
    const bytes = Buffer.from(data.data ?? '', 'base64url')
    if (bytes.length === 0 || bytes.length > limits.maxAttachmentBytes) throw new Refusal(413, 'too-large')

    const fileName = `${n}-${safeFileName(attachment.filename)}`
    const relative = join(account, id, fileName)
    const dir = join(this.deps.config.quarantineDir, account, id)
    const path = join(dir, fileName)
    // the name was cleaned above; this is the check that it stayed under the folder anyway
    if (!path.startsWith(this.deps.config.quarantineDir + sep)) throw new Refusal(400, 'path')
    // one level at a time, each checked BEFORE the next is made: mkdir(recursive) walks through a link that is
    // already there (and would create a folder at the link's target), and O_NOFOLLOW below covers only the last
    // component (barracuda, #246 review). A link someone placed first is refused, nothing is made behind it.
    await ensureOwnDirectory(join(this.deps.config.quarantineDir, account))
    await ensureOwnDirectory(dir)
    // O_NOFOLLOW: a link planted at the target is not followed
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o640)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return { answer: { path: relative, bytes: bytes.length, mimeType: attachment.mimeType }, logged: { id, bytes: bytes.length } }
  }

  private async naptar(account: AccountId, body: Record<string, unknown>) {
    if (!this.deps.config.accounts[account].calendar) throw new Refusal(404, 'no such verb')
    const tol = body['tol']
    const ig = body['ig']
    if (typeof tol !== 'string' || typeof ig !== 'string' || !ISO_TIME.test(tol) || !ISO_TIME.test(ig)) throw new Refusal(400, 'tol/ig: invalid')
    const from = Date.parse(tol)
    const to = Date.parse(ig)
    if (!(to > from) || to - from > MAX_CALENDAR_DAYS * 86_400_000) throw new Refusal(400, 'tol/ig: range')
    const mode = this.deps.config.accounts[account].redaction
    const res = await this.getJson<{ items?: { start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; summary?: string; location?: string; description?: string }[] }>(
      account,
      `${CALENDAR}?${new URLSearchParams({ timeMin: tol, timeMax: ig, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' })}`,
    )
    const gcal = (value: string | undefined, max: number) => wrapUntrusted('gcal', cleanMessageText(redactBody(value ?? '', mode)).slice(0, max))
    const items = (res.items ?? []).map((e) => ({
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      summary: gcal(e.summary, FIELD_MAX),
      location: gcal(e.location, FIELD_MAX),
      description: gcal(e.description, DESCRIPTION_MAX),
    }))
    return { answer: { items }, logged: { count: items.length } }
  }
}

/** A real directory of this process's user at `path`: made if missing, refused if it is a link, a file or someone else's. */
async function ensureOwnDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o750 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const st = await lstat(path)
  const me = process.getuid?.()
  if (!st.isDirectory() || (me !== undefined && st.uid !== me)) throw new Refusal(409, 'quarantine-folder')
}

/** A word safe to put in the log whatever a caller sent in the URL. */
function safeWord(value: string): string {
  return /^[a-z0-9-]{1,32}$/.test(value) ? value : 'ervenytelen'
}
