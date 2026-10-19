// The relay's WRITE half, and the only file allowed to name a Gmail write (the source test enforces it):
// four verbs on the balazs@ mailbox and nothing else (plan v2, points A and D).
//
//   cimke-letrehoz  one of FIVE fixed label names; nothing else can be created
//   cimkez          put one of those five labels on a message
//   archival        take INBOX off a message that ALREADY carries `Acrobot/Hírlevél`, 100 a day at most
//   inbox-vissza    put INBOX back on a message this relay archived in the last 7 days
//
// What cannot be written, by construction: a label id other than one of the five and `INBOX` ever goes into
// a request (so no TRASH, no SPAM, no SENT), and no request carries a message body, so nothing is sent or
// inserted. The `gmail.modify` scope would allow all of that; this code does not (barracuda, plan v2 D).
import { GoogleError, type GoogleApi } from './google.js'
import type { AccountId, RelayConfig } from './config.js'
import type { ArchiveLedger } from './ledger.js'
import { Refusal, type LogFields } from './relay.js'

export const LABEL_NAMES = ['Acrobot/Számla', 'Acrobot/Beszállító', 'Acrobot/Ügyfél', 'Acrobot/Hírlevél', 'Acrobot/Tennivaló'] as const
export type LabelName = (typeof LABEL_NAMES)[number]
export const NEWSLETTER: LabelName = 'Acrobot/Hírlevél'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MESSAGE_ID = /^[0-9a-f]{8,32}$/
const UNDO_WINDOW_MS = 7 * 86_400_000

/** The only URLs a POST may go to; `main.ts` hands exactly these to the transport. */
export const WRITE_URL_SHAPES: readonly RegExp[] = [
  /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[0-9a-f]{8,32}\/modify$/,
  /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/labels$/,
]

export interface WriteDeps {
  config: RelayConfig
  google: GoogleApi
  ledger: ArchiveLedger
  nowMs: () => number
}

type Answer = { answer: unknown; logged: LogFields }

/** The Budapest calendar day of a moment, YYYY-MM-DD: "a day" for the cap is the owner's day, not UTC's. */
export function budapestDay(ms: number): string {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' })
}

function labelNameOf(value: unknown): LabelName {
  if (typeof value !== 'string' || !(LABEL_NAMES as readonly string[]).includes(value)) throw new Refusal(400, 'cimke: not one of the five')
  return value as LabelName
}

function messageIdOf(value: unknown): string {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) throw new Refusal(400, 'id: invalid')
  return value
}

export class MailboxWriter {
  /** archival runs one at a time: the cap check, the change and the ledger line are one step */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: WriteDeps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async labelIds(account: AccountId): Promise<Map<string, string>> {
    const res = (await this.deps.google.getJson(account, `${GMAIL}/labels`)) as { labels?: { id?: string; name?: string }[] }
    const out = new Map<string, string>()
    for (const l of res.labels ?? []) if (typeof l.id === 'string' && typeof l.name === 'string') out.set(l.name, l.id)
    return out
  }

  async cimkeLetrehoz(account: AccountId, body: Record<string, unknown>): Promise<Answer> {
    const name = labelNameOf(body['nev'])
    const existing = (await this.labelIds(account)).get(name)
    if (existing) return { answer: { cimke: name, id: existing, created: false }, logged: { cimke: name, created: false } }
    try {
      const made = (await this.deps.google.postJson(account, `${GMAIL}/labels`, {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      })) as { id?: string }
      if (typeof made.id !== 'string') throw new GoogleError(0, 'request')
      return { answer: { cimke: name, id: made.id, created: true }, logged: { cimke: name, created: true } }
    } catch (err) {
      // two callers creating it at once: the second finds it made
      if (err instanceof GoogleError && err.status === 409) {
        const id = (await this.labelIds(account)).get(name)
        if (id) return { answer: { cimke: name, id, created: false }, logged: { cimke: name, created: false } }
      }
      throw err
    }
  }

  async cimkez(account: AccountId, body: Record<string, unknown>): Promise<Answer> {
    const id = messageIdOf(body['id'])
    const name = labelNameOf(body['cimke'])
    const labelId = (await this.labelIds(account)).get(name)
    if (!labelId) throw new Refusal(404, 'label-missing')
    await this.deps.google.postJson(account, `${GMAIL}/messages/${id}/modify`, { addLabelIds: [labelId] })
    return { answer: { id, cimke: name }, logged: { id, cimke: name } }
  }

  async archival(account: AccountId, body: Record<string, unknown>): Promise<Answer> {
    const id = messageIdOf(body['id'])
    return this.serial(async () => {
      const newsletter = (await this.labelIds(account)).get(NEWSLETTER)
      // read from Gmail at this moment: the caller's word about a label counts for nothing
      const message = (await this.deps.google.getJson(account, `${GMAIL}/messages/${id}?format=minimal`)) as { labelIds?: string[] }
      const labels = message.labelIds ?? []
      if (!newsletter || !labels.includes(newsletter)) throw new Refusal(403, 'archival-szukitett')
      if (!labels.includes('INBOX')) throw new Refusal(409, 'not-in-inbox')
      const today = budapestDay(this.deps.nowMs())
      const archivedToday = this.deps.ledger.entries().filter((e) => e.account === account && budapestDay(e.at) === today).length
      if (archivedToday >= this.deps.config.limits.archivePerDay) throw new Refusal(429, 'archival-napi-hatar')
      await this.deps.google.postJson(account, `${GMAIL}/messages/${id}/modify`, { removeLabelIds: ['INBOX'] })
      this.deps.ledger.record({ at: this.deps.nowMs(), account, id })
      return { answer: { id, archived: true, today: archivedToday + 1 }, logged: { id, archived: true, today: archivedToday + 1 } }
    })
  }

  async inboxVissza(account: AccountId, body: Record<string, unknown>): Promise<Answer> {
    const id = messageIdOf(body['id'])
    const since = this.deps.nowMs() - UNDO_WINDOW_MS
    // only a mail THIS relay archived, and recently: it is an undo, not a way to touch any mail
    if (!this.deps.ledger.entries().some((e) => e.account === account && e.id === id && e.at >= since)) {
      throw new Refusal(403, 'nem-a-kozvetito-archivalta')
    }
    await this.deps.google.postJson(account, `${GMAIL}/messages/${id}/modify`, { addLabelIds: ['INBOX'] })
    return { answer: { id, restored: true }, logged: { id, restored: true } }
  }
}
