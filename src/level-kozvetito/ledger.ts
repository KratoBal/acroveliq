// What the relay itself archived, and when (plan v2 point A). Two jobs: the daily cap counts it, and
// `inbox-vissza` may put back only a mail that is in it. It carries ids and times, never mail content.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import type { AccountId } from './config.js'

export interface ArchiveEntry {
  at: number
  account: AccountId
  id: string
}

export interface ArchiveLedger {
  record(entry: ArchiveEntry): void
  entries(): readonly ArchiveEntry[]
}

export function memoryLedger(): ArchiveLedger {
  const all: ArchiveEntry[] = []
  return { record: (e) => void all.push(e), entries: () => all }
}

/** One JSON line per archived mail, in the state volume, so a restart does not reset the day's count. */
export function fileLedger(path: string): ArchiveLedger {
  return {
    record(entry) {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    },
    entries() {
      if (!existsSync(path)) return []
      const out: ArchiveEntry[] = []
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const e = JSON.parse(line) as ArchiveEntry
          if (typeof e.at === 'number' && typeof e.id === 'string' && (e.account === 'info' || e.account === 'balazs')) out.push(e)
        } catch {
          // a torn last line after a crash is skipped; it never counts for or against a mail
        }
      }
      return out
    },
  }
}
