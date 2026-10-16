import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, backfillEmbeddings, clearMemoryCache,
  searchMemories, getMemoriesForChat, getDb, touchMemoriesAccessed,
  type Memory,
} from '../../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Canonical memory categories. Kept in sync with the DB CHECK constraint in
// src/db.ts so the API rejects bad values before they even reach SQLite.
const MEMORY_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

// Each pattern carries a LABEL, and the label is returned to the caller when a
// save is rejected. Measured 2026-09-01: an agent's memory was refused because
// an explanatory sentence about the CI mentioned `rm -rf`. The rejection said
// only "Content rejected by security filter", so the writer had to guess which
// of ten patterns had matched -- and guessed right only because the text was
// fresh in mind. A filter that cannot say what it caught turns every rejection
// into a hunt, and the next agent will report "the memory API is down".
//
// Naming the matched label leaks nothing that is not already in this file: this
// is hygiene against an agent pasting a command or an injected instruction into
// its own long-term memory, not a boundary against an attacker who can read the
// repository.
const SUSPICIOUS_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'curl-url', pattern: /\bcurl\s+(-[a-zA-Z]\s+)*https?:\/\//i },
  { label: 'bash-c', pattern: /\bbash\s+-c\b/i },
  { label: 'eval-call', pattern: /\beval\s*\(/i },
  { label: 'exec-call', pattern: /\bexec\s*\(/i },
  { label: 'import-subprocess', pattern: /\bimport\s+subprocess\b/i },
  { label: 'ignore-previous-instructions', pattern: /ignore\s+(all\s+)?previous\s+instructions/i },
  { label: 'override-your-instructions', pattern: /override\s+your\s+(instructions|rules|safety|guidelines)/i },
  { label: 'forget-your-instructions', pattern: /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i },
  { label: 'new-persona', pattern: /new\s+persona/i },
  { label: 'rm-rf', pattern: /\brm\s+-rf\b/i },
]

// Returns the label of the first pattern that matched, or null when the content
// is clean. Returning the label rather than a boolean is the whole point.
function suspiciousContentLabel(content: string): string | null {
  const hit = SUSPICIOUS_PATTERNS.find((entry) => entry.pattern.test(content))
  return hit ? hit.label : null
}

export async function tryHandleMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/memories' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string; tier?: string; category?: string; keywords?: string }
    if (!data.content?.trim()) { json(res, { error: 'Content is required' }, 400); return true }
    const suspicious = suspiciousContentLabel(data.content)
    if (suspicious) {
      logger.warn({ agent: data.agent_id, pattern: suspicious }, 'Memory content rejected: suspicious pattern')
      json(res, {
        error: 'Content rejected by security filter',
        pattern: suspicious,
        hint: `A tartalom "${suspicious}" mintara illeszkedik. Ha ez magyarazo szoveg volt, ird korul, es a mentes atmegy.`,
      }, 400)
      return true
    }
    if (data.tier && !data.category) {
      logger.warn({ agent: data.agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
    }
    const category = (data.category || data.tier || 'warm').toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) {
      json(res, { error: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    const result = saveAgentMemory(
      data.agent_id || MAIN_AGENT_ID,
      data.content.trim(),
      category,
      data.keywords || undefined,
      true
    )
    json(res, { ok: true, id: result.id })
    return true
  }

  if (path === '/api/memories' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim() || ''
    const agentIdAlias = url.searchParams.get('agent_id')
    if (agentIdAlias && !url.searchParams.get('agent')) {
      logger.warn({ agent_id: agentIdAlias }, '[DEPRECATED] GET /api/memories: use "agent" instead of "agent_id"')
    }
    const agentId = url.searchParams.get('agent') || agentIdAlias || ''
    const tier = url.searchParams.get('tier') || url.searchParams.get('category') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const mode = url.searchParams.get('mode') || 'fts'

    let results: Memory[]
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
          .all(agentId, `%${q}%`, `%${q}%`, limit) as Memory[]
      }
    } else if (q) {
      results = searchMemories(q, ALLOWED_CHAT_ID, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, limit) as Memory[]
      }
    } else if (agentId) {
      // Category goes into the query, not a post-filter: see getAgentMemories.
      results = getAgentMemories(agentId, limit, tier || undefined)
    } else {
      results = getMemoriesForChat(ALLOWED_CHAT_ID, limit)
    }

    // Still needed for the search branches above, which rank by relevance and
    // cannot push the category down into their own LIMIT. A no-op for the
    // plain agent listing, which already filtered in SQL.
    if (tier) results = results.filter(m => m.category === tier)

    // A search query (q) is a genuine recall: stamp the surfaced memories as
    // just-accessed so accessed_at reflects real usage. Plain listing (no q,
    // e.g. the dashboard browsing all memories) is NOT a recall and must not
    // refresh accessed_at -- otherwise every poll would keep everything "fresh"
    // and defeat staleness detection.
    if (q && results.length) touchMemoriesAccessed(results.map(m => m.id))

    const formatted = results.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
    }))
    jsonMaybeGzip(req, res, formatted)
    return true
  }

  if (path === '/api/memories/import' && method === 'POST') {
    const body = await readBody(req)
    const { agent_id, chunks } = JSON.parse(body.toString()) as { agent_id: string; chunks: string[] }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      json(res, { error: 'No chunks to import' }, 400)
      return true
    }

    const agentId = agent_id || MAIN_AGENT_ID
    const stats = { hot: 0, warm: 0, cold: 0, shared: 0 }
    let imported = 0

    let categorizeModel: string | null = null
    try {
      const ollamaModels = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then((d: any) => (d.models || []).filter((m: any) => !m.name.includes('embed')).map((m: any) => m.name))
        .catch(() => [] as string[])
      categorizeModel = ollamaModels.find((m: string) => m.includes('gemma4')) || ollamaModels[0] || null
    } catch {
      categorizeModel = null
    }

    if (categorizeModel) {
      logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell kiválasztva')
    } else {
      logger.info('Migráció: nincs elérhető Ollama modell, alapértelmezett warm besorolás')
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      if (!categorizeModel) {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
        continue
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90000)

        const catResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: categorizeModel,
            prompt: `Categorize this memory into exactly one tier and generate keywords.

Memory: "${chunk.slice(0, 500)}"

Tiers:
- hot: active tasks, pending decisions, things happening NOW
- warm: preferences, config, project context, stable knowledge
- cold: long-term lessons, historical decisions, archive
- shared: information relevant to multiple agents

Respond ONLY with JSON, nothing else:
{"tier": "warm", "keywords": "keyword1, keyword2, keyword3"}`,
            stream: false,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const catData = await catResponse.json() as { response?: string }

        let tier = 'warm'
        let keywords = ''

        try {
          const jsonMatch = (catData.response || '').match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            tier = ['hot', 'warm', 'cold', 'shared'].includes(parsed.tier) ? parsed.tier : 'warm'
            keywords = parsed.keywords || ''
          }
        } catch {
          // Default to warm if parsing fails
        }

        saveAgentMemory(agentId, chunk, tier, keywords, true)
        stats[tier as keyof typeof stats]++
        imported++

        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 200))
        }
      } catch {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
      }
    }

    logger.info({ agentId, imported, stats }, 'Migráció befejezve')
    json(res, { ok: true, imported, stats })
    return true
  }

  if (path === '/api/memories/backfill' && method === 'POST') {
    try {
      const count = await backfillEmbeddings()
      json(res, { ok: true, count })
    } catch (err) {
      logger.error({ err }, 'Backfill failed')
      json(res, { error: 'Backfill failed' }, 500)
    }
    return true
  }

  if (path === '/api/memories/stats' && method === 'GET') {
    json(res, getMemoryStats())
    return true
  }

  const memUpdateMatch = path.match(/^\/api\/memories\/(\d+)$/)
  // One memory by id (P0-1, task p0-1-harom-javitas): the same scope as the list (class OLVASO);
  // a read, not a recall, so accessed_at is not touched.
  if (memUpdateMatch && method === 'GET') {
    const id = parseInt(memUpdateMatch[1], 10)
    const m = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined
    if (!m) { json(res, { error: 'Not found' }, 404); return true }
    json(res, {
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
    })
    return true
  }
  if (memUpdateMatch && method === 'PUT') {
    const id = parseInt(memUpdateMatch[1], 10)
    const body = await readBody(req)
    const { content, category, tier, agent_id, keywords } = JSON.parse(body.toString()) as { content: string; category?: string; tier?: string; agent_id?: string; keywords?: string }
    if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  if (memUpdateMatch && method === 'DELETE') {
    const id = parseInt(memUpdateMatch[1], 10)
    const db2 = getDb()
    const changes = db2.prepare('DELETE FROM memories WHERE id = ?').run(id).changes
    // Invalidate the in-process TTL cache so a deleted memory does not
    // resurface in the agent-filtered list for the cache lifetime.
    if (changes > 0) clearMemoryCache()
    if (changes > 0) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  return false
}
