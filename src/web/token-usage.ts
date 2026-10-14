import { statSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { resolveAgentConfigDirForRead } from './claude-plans.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// The worker (MAIN_AGENT_ID-worker) runs with its own CLAUDE_CONFIG_DIR under
// ~/.acrobot-worker, so its transcripts are filed under the worker's cwd, which
// neither the `-agents-<name>` pattern nor the main project dir matches. Before
// 2026-09-27 the worker was simply absent from token_usage. Its projects dir is
// a symlink to PROJECTS_DIR today; both roots are scanned and deduped by
// realpath, so it keeps working if the symlink is ever replaced by a real dir.
const WORKER_HOMES = (process.env.MEASURE_WORKER_HOMES ?? join(homedir(), `.${MAIN_AGENT_ID}-worker`))
  .split(':').filter(Boolean)
const WORKER_AGENT = `${MAIN_AGENT_ID}-worker`

// Sub-agents run as their own OS users since 2026-09-22 and Claude Code writes
// their transcripts 0600, so the dashboard cannot read them. Each sub-agent's
// statusLine (scripts/measure-statusline.py --export-usage, running AS that
// user) copies the numbers of every API call into USAGE_EXPORT_DIR/<agent>/,
// group-readable, in transcript shape. See docs/measurement-layer-v1.md.
export const USAGE_EXPORT_DIR = process.env.MEASURE_USAGE_DIR
  ?? join(PROJECT_ROOT, 'store', 'measurements', 'usage')

// Claude Code encodes a project's absolute path into a directory name by
// replacing every non-alphanumeric/non-dash character with `-`. The main
// agent's transcripts live under that exact directory, regardless of what
// the agent calls itself.
function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, '-')
}

export interface AgentTranscriptSource {
  agent: string
  projectDir: string
}

/** Which agent a project dir under a projects root belongs to, or null. Pure; exported for tests. */
export function agentForProjectEntry(entry: string, mainDirName: string, workerDirNames: string[]): string | null {
  // sanitizeAgentName() allows [a-z0-9-], so the old /([a-z]+)$/ silently
  // skipped every agent with a digit or a hyphen in its name -- the whole
  // per-project worker fleet (davinci-ocura, vermeer-fressa, ...) never
  // appeared in the token monitor at all. Not zero usage: no rows.
  const agentMatch = entry.match(/-agents-([a-z0-9-]+)$/)
  if (agentMatch) return agentMatch[1]
  if (entry === mainDirName) return MAIN_AGENT_ID
  // The worker also runs from sibling dirs of its home (e.g. `<home>-fast`).
  for (const w of workerDirNames) {
    if (entry === w || entry.startsWith(`${w}-`)) return WORKER_AGENT
  }
  return null
}

// `projectRootOverride` exists for the tests, matching the convention
// resolveAgentConfigDirForRead() already uses: the isolated dir is found by
// probing the filesystem, so the probe root has to be redirectable to a
// fixture. Production callers pass nothing.
export function discoverAgentSources(opts: {
  roots?: string[]
  exportDir?: string
  workerHomes?: string[]
  projectRoot?: string
  /** Test hook for the isolated-config probe root (resolveAgentConfigDirForRead). */
  projectRootOverride?: string
} | string = {}): AgentTranscriptSource[] {
  // Older callers pass the probe-root override as a bare string.
  if (typeof opts === 'string') opts = { projectRootOverride: opts }
  const sources: AgentTranscriptSource[] = []
  const workerHomes = opts.workerHomes ?? WORKER_HOMES
  const roots = opts.roots ?? [PROJECTS_DIR, ...workerHomes.map(h => join(h, '.claude-config', 'projects'))]
  const mainDirName = encodeProjectPath(opts.projectRoot ?? PROJECT_ROOT)
  const workerDirNames = workerHomes.map(encodeProjectPath)
  const seen = new Set<string>()
  for (const root of roots) {
    let real: string
    try { real = realpathSync(root) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    let entries: string[]
    try { entries = readdirSync(real) } catch { continue }
    for (const entry of entries) {
      const full = join(real, entry)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (!stat.isDirectory()) continue
      const agent = agentForProjectEntry(entry, mainDirName, workerDirNames)
      if (agent) sources.push({ agent, projectDir: full })
    }
  }

  // A sub-agent that runs under its own OS user writes into an ISOLATED config
  // dir (agents/<name>/.claude-config/projects/...), not into ~/.claude. The
  // loop above only ever sees the shared root, so from the moment an agent is
  // migrated its token rows stop -- and they stop SILENTLY, because the old
  // directory still exists and still parses. It looks like an idle agent.
  //
  // MEASURED 2026-08-21 10:15: all four sub-agents' newest transcript under
  // ~/.claude/projects/-home-...-agents-<name>/ was frozen at 2026-08-18 17:44
  // (0.15-0.53 MB), while the live files under agents/<name>/.claude-config/
  // carried timestamps from minutes earlier and 3.9-7.2 MB. Three days of the
  // fleet's consumption were missing from the monitor that a model-assignment
  // decision was about to be based on.
  //
  // This is the same defect resolveAgentConfigDirForRead() was written for
  // (the dashboard's context counter, fixed the same morning); reusing it is
  // deliberate, so the two readers cannot drift apart again.
  //
  // Both roots are kept for a migrated agent, not swapped: the pre-migration
  // history is real and lives only in the shared root. Duplicate rows are
  // impossible anyway -- the UNIQUE INDEX on (agent, session_id, timestamp,
  // input, output) plus INSERT OR IGNORE absorbs any overlap.
  for (const name of listAgentNames()) {
    let configDir: string | null = null
    try { configDir = resolveAgentConfigDirForRead(name, opts.projectRootOverride) } catch { continue }
    if (!configDir) continue
    const isolatedProjects = join(configDir, 'projects')
    if (!existsSync(isolatedProjects)) continue
    let entries: string[]
    try { entries = readdirSync(isolatedProjects) } catch { continue }
    for (const entry of entries) {
      const full = join(isolatedProjects, entry)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (!stat.isDirectory()) continue
      // Attribution comes from WHOSE config dir this is, not from the encoded
      // project name: an agent's isolated dir holds only that agent's work.
      if (sources.some((s) => s.agent === name && s.projectDir === full)) continue
      sources.push({ agent: name, projectDir: full })
    }
  }

  // Exported sub-agent usage: one dir per agent, named by the agent itself.
  const exportDir = opts.exportDir ?? USAGE_EXPORT_DIR
  let exported: string[] = []
  try { exported = readdirSync(exportDir) } catch { /* not activated yet */ }
  for (const name of exported) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue
    const full = join(exportDir, name)
    try { if (!statSync(full).isDirectory()) continue } catch { continue }
    sources.push({ agent: name, projectDir: full })
  }
  return sources
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  function scanDir(d: string) {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      if (entry.endsWith('.jsonl')) {
        files.push(full)
      } else {
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) {
          scanDir(full)
        }
      }
    }
  }

  scanDir(dir)
  return files
}

interface ParsedCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Tokens in thinking content blocks (estimated from char length / 4). */
  thinkingTokens: number
  /** Model identifier from the API response, e.g. "claude-sonnet-5". */
  model: string | null
  contentPreview: string
  toolName: string | null
  /** The API message id (msg_...). One assistant turn that calls a tool is
   *  written to the transcript as SEVERAL `assistant` lines sharing this id --
   *  a text block (tool_name=null) plus one line per tool_use block -- and EACH
   *  carries the SAME cumulative `usage`. Counting each line would double (or
   *  triple) the turn's tokens, which is exactly the dashboard-inflation bug.
   *  Used only to collapse those lines back into one row; not persisted. */
  messageId?: string | null
}

/**
 * Collapse transcript rows that belong to the same assistant turn (same
 * message id) into a single row, so a tool-calling turn is counted ONCE.
 *
 * Usage is identical across a turn's lines, so we take the max per field
 * (defensive against a partial/streaming line) rather than summing. The tool
 * name and preview are filled from whichever line carries them. Rows without a
 * message id (older transcripts) pass through untouched. Pure + order-stable
 * for unit testing.
 */
export function collapseByMessageId(calls: ParsedCall[]): ParsedCall[] {
  const byId = new Map<string, ParsedCall>()
  const out: ParsedCall[] = []
  for (const c of calls) {
    if (!c.messageId) { out.push(c); continue }
    const ex = byId.get(c.messageId)
    if (!ex) {
      const copy = { ...c }
      byId.set(c.messageId, copy)
      out.push(copy)
      continue
    }
    ex.inputTokens = Math.max(ex.inputTokens, c.inputTokens)
    ex.outputTokens = Math.max(ex.outputTokens, c.outputTokens)
    ex.cacheReadTokens = Math.max(ex.cacheReadTokens, c.cacheReadTokens)
    ex.cacheCreationTokens = Math.max(ex.cacheCreationTokens, c.cacheCreationTokens)
    ex.thinkingTokens = Math.max(ex.thinkingTokens, c.thinkingTokens)
    if (!ex.model && c.model) ex.model = c.model
    if (!ex.toolName && c.toolName) ex.toolName = c.toolName
    if (!ex.contentPreview && c.contentPreview) ex.contentPreview = c.contentPreview
  }
  return out
}

async function parseJsonlFile(
  filePath: string,
  agent: string,
  fromLine: number,
): Promise<{ calls: ParsedCall[]; linesRead: number }> {
  const calls: ParsedCall[] = []
  let lineNum = 0
  let sessionId = ''

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    lineNum++
    if (lineNum <= fromLine) continue
    if (!line.trim()) continue

    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.sessionId) {
      sessionId = obj.sessionId
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue

    const u = obj.message.usage
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!ts) continue

    let preview = ''
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          preview = block.text.slice(0, 200)
          break
        }
      }
    } else if (typeof content === 'string') {
      preview = content.slice(0, 200)
    }

    let toolName: string | null = null
    let thinkingTokens = 0
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && !toolName) {
          toolName = block.name
        }
        // Estimate thinking tokens from char length (no per-block count in API)
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          thinkingTokens += Math.ceil(block.thinking.length / 4)
        }
      }
    }

    // An exported sub-agent line carries no thinking text, only the estimate
    // the exporter computed with the same chars/4 rule.
    const est = obj.message?.thinking_tokens_est
    if (typeof est === 'number' && est > 0) thinkingTokens += est

    calls.push({
      agent,
      sessionId: sessionId || basename(filePath, '.jsonl'),
      timestamp: Math.floor(ts / 1000),
      inputTokens: (u.input_tokens || 0),
      outputTokens: (u.output_tokens || 0),
      cacheReadTokens: (u.cache_read_input_tokens || 0),
      cacheCreationTokens: (u.cache_creation_input_tokens || 0),
      thinkingTokens,
      model: obj.message?.model || null,
      contentPreview: preview,
      toolName,
      messageId: obj.message?.id || null,
    })
  }

  // Collapse the multi-line tool-turn rows (same message id, repeated usage)
  // before they reach the DB -- this is the fix for the ~2x token inflation.
  return { calls: collapseByMessageId(calls), linesRead: lineNum }
}

// The collector's last finished run in THIS process (startup and the hourly poll, web.ts).
// token_usage only holds what it has read, so a task's usage read before the next run misses
// every later call and can say 0 (task task-usage-continue-res: 2026-10-14, 0 calls for a task
// that ran 100). The usage route shows it, so the reader knows how far the numbers go.
// `at` is the run's START: files are read one by one, so a call made after its file was read
// but before the run ended is not in; from the start on, "complete up to here" holds (barracuda,
// #135). The sub-agents' calls come through their statusLine export, which lags too; the
// reader's warning says the number may be incomplete, which covers both.
export interface TokenCollection { at: number; inserted: number; files: number }
let lastCollection: TokenCollection | null = null
export const lastTokenCollection = (): TokenCollection | null => lastCollection

export async function collectTokenUsage(): Promise<{ inserted: number; files: number }> {
  const startedAt = Math.floor(Date.now() / 1000)
  const db = getDb()
  const sources = discoverAgentSources()
  let totalInserted = 0
  let totalFiles = 0

  const getCursor = db.prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?')
  const setCursor = db.prepare('INSERT OR REPLACE INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)')
  const insertCall = db.prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
      model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
      thinking_tokens = CASE WHEN (token_usage.thinking_tokens IS NULL OR token_usage.thinking_tokens = 0) AND excluded.thinking_tokens > 0 THEN excluded.thinking_tokens ELSE token_usage.thinking_tokens END
  `)

  for (const source of sources) {
    const files = findJsonlFiles(source.projectDir)
    for (const file of files) {
      let fileSize: number
      try { fileSize = statSync(file).size } catch { continue }

      const cursor = getCursor.get(file) as { last_line: number; last_size: number } | undefined
      if (cursor && cursor.last_size === fileSize) continue

      const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0

      try {
        const { calls, linesRead } = await parseJsonlFile(file, source.agent, fromLine)

        if (calls.length > 0) {
          const tx = db.transaction(() => {
            for (const c of calls) {
              insertCall.run(
                c.agent, c.sessionId, c.timestamp,
                c.inputTokens, c.outputTokens,
                c.cacheReadTokens, c.cacheCreationTokens,
                c.thinkingTokens, c.model,
                c.contentPreview || null, c.toolName,
              )
            }
            setCursor.run(file, linesRead, fileSize)
          })
          tx()
          totalInserted += calls.length
        } else {
          setCursor.run(file, linesRead, fileSize)
        }
        totalFiles++
      } catch (err) {
        logger.warn({ err, file }, 'Token usage parse failed')
      }
    }
  }

  lastCollection = { at: startedAt, inserted: totalInserted, files: totalFiles }
  return { inserted: totalInserted, files: totalFiles }
}

export interface TokenSummaryModelRow {
  model: string | null
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export interface TokenSummary {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalSessions: number
  firstSeen: number
  lastSeen: number
  perModel: TokenSummaryModelRow[]
}

export function getTokenSummary(from?: number, to?: number): TokenSummary[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''

  const rows = db.prepare(`
    SELECT agent,
      COUNT(*) as totalCalls,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      COUNT(DISTINCT session_id) as totalSessions,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage
    ${where}
    GROUP BY agent ORDER BY totalInput DESC
  `).all(...params) as Omit<TokenSummary, 'perModel'>[]

  const modelRows = db.prepare(`
    SELECT agent, model,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    ${where}
    GROUP BY agent, model
  `).all(...params) as (TokenSummaryModelRow & { agent: string })[]

  const byAgent = new Map<string, TokenSummaryModelRow[]>()
  for (const mr of modelRows) {
    const { agent, ...rest } = mr as { agent: string } & TokenSummaryModelRow
    if (!byAgent.has(agent)) byAgent.set(agent, [])
    byAgent.get(agent)!.push(rest)
  }

  return rows.map(r => ({ ...r, perModel: byAgent.get(r.agent) ?? [] }))
}

export interface ModelDistEntry {
  model: string
  count: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export function getModelDistribution(from?: number, to?: number, agent?: string): ModelDistEntry[] {
  const db = getDb()
  const hasModelCol = db.prepare("SELECT COUNT(*) as n FROM pragma_table_info('token_usage') WHERE name='model'").get() as { n: number }
  if (!hasModelCol.n) return []

  let sql = `
    SELECT model,
      COUNT(*) as count,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
  `
  const conditions: string[] = [
    "model IS NOT NULL",
    "model != ''",
    "model != '<synthetic>'",
  ]
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY model ORDER BY count DESC'

  return db.prepare(sql).all(...params) as ModelDistEntry[]
}

export interface ToolStatEntry {
  tool_name: string
  model: string | null
  count: number
  agents: string
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export function getToolStats(from?: number, to?: number, agent?: string): ToolStatEntry[] {
  const db = getDb()
  let sql = `
    SELECT tool_name,
      model,
      COUNT(*) as count,
      GROUP_CONCAT(DISTINCT agent) as agents,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    WHERE tool_name IS NOT NULL
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' AND ' + conditions.join(' AND ')
  sql += ' GROUP BY tool_name, model ORDER BY count DESC'

  return db.prepare(sql).all(...params) as ToolStatEntry[]
}

export interface TimelineBucket {
  bucket: number
  agent: string
  calls: number
  inputTokens: number
  outputTokens: number
}

export function getTokenTimeline(
  bucketMinutes: number = 60,
  from?: number,
  to?: number,
  agent?: string,
): TimelineBucket[] {
  const db = getDb()
  const bucketSeconds = bucketMinutes * 60
  let sql = `
    SELECT
      (timestamp / ${bucketSeconds}) * ${bucketSeconds} as bucket,
      agent,
      COUNT(*) as calls,
      SUM(input_tokens + cache_read_tokens + cache_creation_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM token_usage
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY bucket, agent ORDER BY bucket ASC'

  return db.prepare(sql).all(...params) as TimelineBucket[]
}

export interface TokenDetail {
  id: number
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
  model: string | null
  contentPreview: string | null
  toolName: string | null
  taskTitle: string | null
  project: string | null
}

export function getTokenDetails(
  opts: { agent?: string; from?: number; to?: number; limit?: number; offset?: number; minTokens?: number; q?: string },
): TokenDetail[] {
  const db = getDb()
  let sql = `SELECT * FROM token_usage`
  const conditions: string[] = []
  const params: any[] = []
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.from) { conditions.push('timestamp >= ?'); params.push(opts.from) }
  if (opts.to) { conditions.push('timestamp <= ?'); params.push(opts.to) }
  if (opts.minTokens) {
    conditions.push('(input_tokens + cache_read_tokens + cache_creation_tokens) >= ?')
    params.push(opts.minTokens)
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    conditions.push('(agent LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)')
    params.push(like, like, like, like)
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY timestamp DESC'
  sql += ' LIMIT ? OFFSET ?'
  params.push(opts.limit || 100, opts.offset || 0)

  return db.prepare(sql).all(...params) as TokenDetail[]
}

export function correlateWithKanban(): void {
  const db = getDb()
  const uncorrelated = db.prepare(`
    SELECT DISTINCT agent, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
    FROM token_usage
    WHERE task_title IS NULL
    GROUP BY agent
  `).all() as { agent: string; minTs: number; maxTs: number }[]

  for (const row of uncorrelated) {
    const cards = db.prepare(`
      SELECT id, title, project, assignee, updated_at
      FROM kanban_cards
      WHERE (assignee = ? OR assignee LIKE '%' || ? || '%')
        AND updated_at BETWEEN ? AND ?
      ORDER BY updated_at ASC
    `).all(row.agent, row.agent, row.minTs, row.maxTs) as any[]

    for (const card of cards) {
      const nextCard = cards.find((c: any) => c.updated_at > card.updated_at)
      const endTs = nextCard ? nextCard.updated_at : row.maxTs

      db.prepare(`
        UPDATE token_usage
        SET task_title = ?, project = ?
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `).run(card.title, card.project || null, row.agent, card.updated_at, endTs)
    }
  }
}
