// B29 step 2: the daily counts of the main agent's shadow hook (scripts/hooks/b29-arnyek.py).
// "Would have asked" per day is the number B29 step 3 drives under 1. The counts are an
// ESTIMATE of the engine (the hook's own reading of the fo-agens profile), and the answer says so.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

export const B29_ARNYEK_DIR = join(STORE_DIR, 'b29-arnyek')

export interface B29Day {
  day: string
  total: number
  allow: number
  ask: number
  deny: number
  /** what asked most: "<tool> <first two words or reason>" -> count, the 10 largest */
  topAsk: { key: string; count: number }[]
}

export function summarizeB29(dir: string = B29_ARNYEK_DIR, days = 7): B29Day[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-Math.max(1, Math.min(days, 60)))
  return files.map((f) => {
    const day: B29Day = { day: f.slice(0, 10), total: 0, allow: 0, ask: 0, deny: 0, topAsk: [] }
    const asks = new Map<string, number>()
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue
      let r: { tool?: string; verdict?: string; head?: string; reason?: string }
      try { r = JSON.parse(line) } catch { continue }
      day.total += 1
      if (r.verdict === 'allow') day.allow += 1
      else if (r.verdict === 'deny') day.deny += 1
      else if (r.verdict === 'ask') {
        day.ask += 1
        const key = `${r.tool ?? '?'} ${r.tool === 'Bash' ? r.head ?? '' : r.reason ?? ''}`.trim()
        asks.set(key, (asks.get(key) ?? 0) + 1)
      }
    }
    day.topAsk = [...asks].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count }))
    return day
  })
}
