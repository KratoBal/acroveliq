// Structured task handoff (acrovelIQ token brief, item 3, 2026-10-12).
//
// When a task is closed or set aside, the agent writes ONE record that a fresh
// session can start from: what the task was, what was decided and by whom,
// what is forbidden and why, where the code stands, what comes next. A new
// session's first step is to load the latest record AND re-measure the code
// state; on any mismatch it stops instead of building on a stale picture.
//
// Pure SQL + validation + a probe interface. `db`, `now` and the probe are
// passed in, so every function is testable against an in-memory database and
// a fake GitHub. The table is append-only: every write is a new row, a read
// returns the latest one for the task.

import type Database from 'better-sqlite3'

/** A decision, with who made it and where it can be found. */
export interface HandoffDecision {
  what: string
  who: string
  /** Message id, comment id or PR comment: where the decision is recorded. */
  where: string
}

/** A prohibition, with its source. Forgetting one is the costliest loss. */
export interface HandoffProhibition {
  what: string
  source: string
}

export interface HandoffCodeState {
  /** `owner/name` on GitHub. */
  repo: string
  branch: string
  /** The branch head the record was written against (full sha or >= 7 chars). */
  head: string
  /** The PR number, or null when no PR was opened. */
  pr: number | null
  /** Whether the PR had merged when the record was written. */
  merged: boolean
}

export interface HandoffRecord {
  task: { id: string; goal: string; brief: string }
  status: string
  decisions: HandoffDecision[]
  prohibitions: HandoffProhibition[]
  /** null only when the task touched no code at all. */
  code: HandoffCodeState | null
  files: string[]
  next_step: string
  open_questions: string[]
  /** Multi-project from day one; `acropora` when absent. */
  project: string
}

export const HANDOFF_STATUSES = ['done', 'in_progress', 'blocked', 'abandoned'] as const

export const DEFAULT_PROJECT = 'acropora'

export function ensureTaskHandoffSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT}',
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      repo TEXT,
      branch TEXT,
      head_sha TEXT,
      pr_number INTEGER,
      record TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_handoffs_task ON task_handoffs(task_id, created_at)`)
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

// owner/name; no `..` anywhere and neither part a lone `.`, because the URL
// would resolve either into another API path
const REPO_PATTERN = /^(?!\.\/)(?!.*\.\.)(?!.*\/\.$)[\w.-]+\/[\w.-]+$/
const BRANCH_PATTERN = /^(?!.*\.\.)[\w.\/-]+$/

/**
 * Validates a record. Every required field must be PRESENT; a list may be
 * empty (a task can honestly have no prohibitions), but it has to be said,
 * not left out. Each list item needs all of its own fields. The answer names
 * every missing path, so one round fixes all of them.
 */
export function validateHandoffRecord(
  input: unknown,
): { ok: true; record: HandoffRecord } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>

  const task = raw.task && typeof raw.task === 'object' ? raw.task : null
  if (!task) missing.push('task')
  else for (const key of ['id', 'goal', 'brief']) if (!isText(task[key])) missing.push(`task.${key}`)

  if (!isText(raw.status)) missing.push('status')
  else if (!(HANDOFF_STATUSES as readonly string[]).includes(raw.status))
    missing.push(`status (one of: ${HANDOFF_STATUSES.join(', ')})`)

  const list = (name: string, fields: string[]) => {
    if (!Array.isArray(raw[name])) { missing.push(name); return }
    raw[name].forEach((item: any, index: number) => {
      for (const field of fields)
        if (!item || !isText(item[field])) missing.push(`${name}[${index}].${field}`)
    })
  }
  list('decisions', ['what', 'who', 'where'])
  list('prohibitions', ['what', 'source'])

  if (!('code' in raw)) missing.push('code (null if the task touched no code)')
  else if (raw.code !== null) {
    const code = raw.code
    if (typeof code !== 'object') missing.push('code')
    else {
      for (const key of ['repo', 'branch', 'head']) if (!isText(code[key])) missing.push(`code.${key}`)
      // the repo and the branch end up in a GitHub API path called with the
      // fleet's token (barracuda, #16): `owner/name`, and no `..` in the branch
      if (isText(code.repo) && !REPO_PATTERN.test(code.repo)) missing.push('code.repo (owner/name)')
      if (isText(code.branch) && !BRANCH_PATTERN.test(code.branch)) missing.push('code.branch (a branch name, without ..)')
      if (isText(code.head) && !/^[0-9a-f]{7,40}$/i.test(code.head)) missing.push('code.head (a sha, at least 7 hex digits)')
      if (!(code.pr === null || (Number.isInteger(code.pr) && code.pr > 0))) missing.push('code.pr (a number, or null)')
      if (typeof code.merged !== 'boolean') missing.push('code.merged')
      // a merge is only measurable through its PR: without one, "merged" is a
      // claim nobody can check (barracuda, #16)
      else if (code.merged && code.pr === null) missing.push('code.pr (a merged record needs its PR number)')
    }
  }

  if (!Array.isArray(raw.files) || raw.files.some((file: unknown) => !isText(file))) missing.push('files')
  if (!isText(raw.next_step)) missing.push('next_step')
  if (!Array.isArray(raw.open_questions) || raw.open_questions.some((q: unknown) => !isText(q)))
    missing.push('open_questions')

  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    record: {
      task: { id: task.id.trim(), goal: task.goal.trim(), brief: task.brief.trim() },
      status: raw.status,
      decisions: raw.decisions,
      prohibitions: raw.prohibitions,
      code: raw.code,
      files: raw.files,
      next_step: raw.next_step.trim(),
      open_questions: raw.open_questions,
      project: isText(raw.project) ? raw.project.trim() : DEFAULT_PROJECT,
    },
  }
}

export interface StoredHandoff {
  id: number
  agent: string
  created_at: number
  record: HandoffRecord
}

export function insertTaskHandoff(
  db: Database.Database,
  agent: string,
  record: HandoffRecord,
  now: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO task_handoffs
         (task_id, project, agent, status, repo, branch, head_sha, pr_number, record, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.task.id,
      record.project,
      agent,
      record.status,
      record.code?.repo ?? null,
      record.code?.branch ?? null,
      record.code?.head ?? null,
      record.code?.pr ?? null,
      JSON.stringify(record),
      now,
    )
  return Number(result.lastInsertRowid)
}

/** The latest record for a task (ties broken by id), or null. */
export function latestTaskHandoff(db: Database.Database, taskId: string): StoredHandoff | null {
  const row = db
    .prepare(
      `SELECT id, agent, created_at, record FROM task_handoffs
       WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(taskId) as { id: number; agent: string; created_at: number; record: string } | undefined
  return row ? { id: row.id, agent: row.agent, created_at: row.created_at, record: JSON.parse(row.record) } : null
}

/**
 * What the code state looks like NOW. Each method answers `undefined` when it
 * could not measure (no credential, network error): that is reported as its
 * own outcome, never as agreement.
 */
export interface CodeStateProbe {
  /** The branch head sha, `null` if the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<string | null | undefined>
  pullRequest(repo: string, number: number): Promise<{ state: string; merged: boolean; headSha: string } | null | undefined>
}

export interface CodeStateCheck {
  ok: boolean
  /** One sentence each; the reader stops on any of them. */
  mismatches: string[]
  measured: { branchHead: string | null | undefined; pr: { state: string; merged: boolean; headSha: string } | null | undefined }
}

const sameSha = (recorded: string, actual: string) => actual.toLowerCase().startsWith(recorded.toLowerCase())

/**
 * Re-measures the recorded code state. A merged PR may have its branch
 * deleted, so for a merged record only the PR is checked; otherwise the branch
 * head must still be the recorded one, and an open PR must point at it.
 */
export async function verifyCodeState(code: HandoffCodeState | null, probe: CodeStateProbe): Promise<CodeStateCheck> {
  const measured: CodeStateCheck['measured'] = { branchHead: null, pr: null }
  if (!code) return { ok: true, mismatches: [], measured }
  const mismatches: string[] = []

  // the validator refuses this pair; the check refuses it too, so an older
  // or hand-written row cannot pass unmeasured
  if (code.merged && code.pr === null)
    mismatches.push('A rekord beolvadtnak írja a munkát, de PR nélkül: a beolvadás nem mérhető.')

  if (code.pr !== null) {
    measured.pr = await probe.pullRequest(code.repo, code.pr)
    if (measured.pr === undefined) mismatches.push(`A #${code.pr} PR állapota nem mérhető most; ellenőrzés nélkül nem haladunk tovább.`)
    else if (measured.pr === null) mismatches.push(`A #${code.pr} PR nem található a ${code.repo} repóban.`)
    else if (measured.pr.merged !== code.merged)
      mismatches.push(
        measured.pr.merged
          ? `A #${code.pr} PR azóta beolvadt; a rekord még beolvadatlannak írja.`
          : `A #${code.pr} PR nincs beolvasztva, a rekord beolvadtnak írja.`,
      )
    // closed without a merge: the work the record builds on was dropped
    else if (!code.merged && measured.pr.state !== 'open')
      mismatches.push(`A #${code.pr} PR lezárva, beolvasztás nélkül.`)
    // merged with another head than recorded: work landed that the record does not know
    else if (code.merged && !sameSha(code.head, measured.pr.headSha))
      mismatches.push(
        `A #${code.pr} PR ${measured.pr.headSha.slice(0, 8)} fejjel olvadt be, a rekord ${code.head.slice(0, 8)} fejjel íródott.`,
      )
  }

  if (!code.merged) {
    measured.branchHead = await probe.branchHead(code.repo, code.branch)
    if (measured.branchHead === undefined)
      mismatches.push(`A ${code.branch} ág feje nem mérhető most; ellenőrzés nélkül nem haladunk tovább.`)
    else if (measured.branchHead === null) mismatches.push(`A ${code.branch} ág nem létezik a ${code.repo} repóban.`)
    else if (!sameSha(code.head, measured.branchHead))
      mismatches.push(
        `A ${code.branch} ág feje ${measured.branchHead.slice(0, 8)}, a rekordé ${code.head.slice(0, 8)}: azóta került rá munka, amit a rekord nem ismer.`,
      )
    if (measured.pr && !measured.pr.merged && !sameSha(code.head, measured.pr.headSha))
      mismatches.push(`A #${code.pr} PR feje ${measured.pr.headSha.slice(0, 8)}, a rekordé ${code.head.slice(0, 8)}.`)
  }

  return { ok: mismatches.length === 0, mismatches, measured }
}

/**
 * The real probe: GitHub's REST API with the fleet's token. Any failure
 * (no token, network, a non-200 other than 404) answers `undefined`, which
 * the check reports as "not measurable".
 */
export function githubProbe(token: string | null, fetchImpl: typeof fetch = fetch): CodeStateProbe {
  const call = async (path: string): Promise<any | null | undefined> => {
    if (!token) return undefined
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        // a hanging GitHub must not hang the read: a timeout is "not measurable"
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 404) return null
      if (!response.ok) return undefined
      return await response.json()
    } catch {
      return undefined
    }
  }
  return {
    async branchHead(repo, branch) {
      const body = await call(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`)
      return body === undefined || body === null ? body : (body.object?.sha ?? undefined)
    },
    async pullRequest(repo, number) {
      const body = await call(`/repos/${repo}/pulls/${number}`)
      return body === undefined || body === null
        ? body
        : { state: String(body.state), merged: Boolean(body.merged), headSha: String(body.head?.sha ?? '') }
    },
  }
}
