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
  /** The decider's words, verbatim; mandatory for every decision in a coordination handoff. */
  quote?: string
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
  /**
   * Where the merged change RUNS, when that is not the main branch: the commit on a live
   * branch that carries it (a cherry-pick onto tc-release). `head` stays the PR's head;
   * this names the live commit. The check measures that it is on the branch and that its
   * change equals the PR's merge commit (acrobot, koord-proba #57, msg 29913).
   */
  deployed?: { branch: string; head: string }
}

/**
 * A COORDINATION unit's handoff (koord-munkamenet, plan item 2): the four fields a short
 * coordination session hands over are mandatory, and the server refuses the record when
 * one is missing (acrobot 2026-10-13, msg 29863; Balazs 18:45:34 UTC, msg
 * 1559638247641194638).
 */
export const COORDINATION_PHASES = ['kesz', 'reszben', 'blokkolt'] as const

export interface CoordinationState {
  /** kesz / reszben / blokkolt */
  phase: (typeof COORDINATION_PHASES)[number]
  /** One sentence: where the unit stands. */
  summary: string
}

/** A next step, in order, with whose step it is. */
export interface CoordinationStep {
  what: string
  who: string
}

/** An open question: whom we wait on, and for what. */
export interface CoordinationQuestion {
  from: string
  what: string
}

export interface HandoffRecord {
  task: { id: string; goal: string; brief: string }
  /** 'coordination' makes the four fields below mandatory; absent for a development handoff. */
  kind?: 'coordination'
  status: string
  /** coordination only */
  state?: CoordinationState
  /** coordination only; next_step then carries the first step, for the readers that know only that field */
  next_steps?: CoordinationStep[]
  decisions: HandoffDecision[]
  prohibitions: HandoffProhibition[]
  /** null only when the task touched no code at all. */
  code: HandoffCodeState | null
  files: string[]
  next_step: string
  /** strings in a development handoff, {from, what} in a coordination one */
  open_questions: string[] | CoordinationQuestion[]
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
  opts: { coordinationTask?: boolean } = {},
): { ok: true; record: HandoffRecord } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  // The four fields are bound to the TASK, not to the writer: a handoff on a task whose
  // type is `coordination` is held to them whether or not the record says so, so a
  // forgotten `kind` is refused instead of passing as a development handoff
  // (barracuda, review of #72; acrobot, msg 29886).
  if (opts.coordinationTask && raw.kind !== 'coordination')
    missing.push(`kind (this is a coordination task: the record must say kind: 'coordination' and carry its four fields)`)

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
      if ('deployed' in code && code.deployed !== undefined && code.deployed !== null) {
        const d = code.deployed
        if (typeof d !== 'object') missing.push('code.deployed ({branch, head})')
        else {
          if (!isText(d.branch) || !BRANCH_PATTERN.test(d.branch)) missing.push('code.deployed.branch (a branch name, without ..)')
          if (!isText(d.head) || !/^[0-9a-f]{7,40}$/i.test(d.head)) missing.push('code.deployed.head (a sha, at least 7 hex digits)')
          if (code.merged !== true) missing.push('code.deployed (only for a merged record: the live commit of a merged change)')
        }
      }
    }
  }

  if (!Array.isArray(raw.files) || raw.files.some((file: unknown) => !isText(file))) missing.push('files')

  const coordination = raw.kind === 'coordination' || !!opts.coordinationTask
  if ('kind' in raw && raw.kind !== 'coordination') missing.push("kind (only 'coordination', or leave it out)")
  if (!coordination) {
    if (!isText(raw.next_step)) missing.push('next_step')
    if (!Array.isArray(raw.open_questions) || raw.open_questions.some((q: unknown) => !isText(q)))
      missing.push('open_questions')
  } else {
    // 1. the state: a phase and one sentence, not one word
    const st = raw.state && typeof raw.state === 'object' ? raw.state : null
    if (!st) missing.push('state')
    else {
      if (!(COORDINATION_PHASES as readonly string[]).includes(st.phase))
        missing.push(`state.phase (one of: ${COORDINATION_PHASES.join(', ')})`)
      if (!isText(st.summary)) missing.push('state.summary')
      else if (st.summary.trim().split(/\s+/).length < 4) missing.push('state.summary (a sentence, not a word)')
    }
    // 2. the decisions: `where` must be a message id (or a comment or PR number) that
    // can be looked up, and each decision carries the decider's words verbatim
    if (Array.isArray(raw.decisions))
      raw.decisions.forEach((d: any, i: number) => {
        if (d && isText(d.where) && !/\d{3,}/.test(d.where)) missing.push(`decisions[${i}].where (a message id)`)
        // every decision, not only one whose `who` spells Balazs: a decision written as
        // "the owner" or "gazda" would otherwise pass without his words (barracuda, #72)
        if (d && !isText(d.quote)) missing.push(`decisions[${i}].quote (the decider's words, verbatim)`)
      })
    // 3. the next steps, in order, each with whose step it is; none only when done
    if (!Array.isArray(raw.next_steps)) missing.push('next_steps')
    else {
      raw.next_steps.forEach((x: any, i: number) => {
        for (const f of ['what', 'who']) if (!x || !isText(x[f])) missing.push(`next_steps[${i}].${f}`)
      })
      if (raw.next_steps.length === 0 && st?.phase !== 'kesz') missing.push('next_steps (empty only when state.phase is kesz)')
    }
    // 4. the open questions: whom we wait on and for what; an empty list is valid, a missing field is not
    if (!Array.isArray(raw.open_questions)) missing.push('open_questions')
    else raw.open_questions.forEach((q: any, i: number) => {
      for (const f of ['from', 'what']) if (!q || !isText(q[f])) missing.push(`open_questions[${i}].${f}`)
    })
  }

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
      next_step: coordination
        ? (raw.next_steps.length ? `${raw.next_steps[0].who}: ${raw.next_steps[0].what}`.trim() : 'nincs (kesz)')
        : raw.next_step.trim(),
      open_questions: raw.open_questions,
      project: isText(raw.project) ? raw.project.trim() : DEFAULT_PROJECT,
      ...(coordination
        ? { kind: 'coordination' as const, state: { phase: raw.state.phase, summary: raw.state.summary.trim() }, next_steps: raw.next_steps }
        : {}),
    },
  }
}

/**
 * Every required field of a record, named up front, so a writer fixes the whole record in
 * one round instead of meeting the next missing field after each try (the first write of
 * the koord-proba fresh session failed on task, status and code.branch; acrobot, msg 29913).
 */
export function handoffRequiredFields(coordination: boolean): string[] {
  const common = [
    'task {id, goal, brief}',
    `status (${HANDOFF_STATUSES.join('|')})`,
    'decisions [{what, who, where' + (coordination ? ', quote' : '') + '}]',
    'prohibitions [{what, source}]',
    'code {repo, branch, head, pr, merged[, deployed {branch, head}]} vagy null',
    'files [szoveg]',
  ]
  return coordination
    ? [...common, "kind: 'coordination'", `state {phase (${COORDINATION_PHASES.join('|')}), summary}`,
        'next_steps [{what, who}]', 'open_questions [{from, what}]']
    : [...common, 'next_step', 'open_questions [szoveg]']
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
  pullRequest(repo: string, number: number): Promise<{ state: string; merged: boolean; headSha: string; mergeSha?: string | null } | null | undefined>
  /** A fingerprint of the commit's change, line numbers left out (git patch-id's idea); null: no such commit. */
  changeOf?(repo: string, sha: string): Promise<string | null | undefined>
  /** Whether the commit is on the branch (the branch head or behind it); null: no such commit or branch. */
  onBranch?(repo: string, sha: string, branch: string): Promise<boolean | null | undefined>
}

export interface CodeStateCheck {
  ok: boolean
  /** One sentence each; the reader stops on any of them. */
  mismatches: string[]
  measured: { branchHead: string | null | undefined; pr: { state: string; merged: boolean; headSha: string; mergeSha?: string | null } | null | undefined }
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
        `A #${code.pr} PR ${measured.pr.headSha.slice(0, 8)} fejjel olvadt be, a rekord ${code.head.slice(0, 8)} fejjel íródott.` +
          ' Ha ez az élő fa commitja, a code.deployed mezőbe való ({branch, head}), a code.head pedig a PR feje.',
      )
    else if (code.merged && code.deployed) await checkDeployed(code, measured.pr.mergeSha ?? null, probe, mismatches)
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
 * The live commit of a merged change: on its branch, and carrying the same change as the
 * PR's merge commit. Each part not measurable is its own sentence, never agreement.
 */
async function checkDeployed(
  code: HandoffCodeState,
  mergeSha: string | null,
  probe: CodeStateProbe,
  mismatches: string[],
): Promise<void> {
  const d = code.deployed!
  const label = `Az élő commit (${d.head.slice(0, 8)}, ${d.branch})`
  if (!probe.onBranch || !probe.changeOf) { mismatches.push(`${label} nem mérhető: a mérő nem ismeri.`); return }
  const on = await probe.onBranch(code.repo, d.head, d.branch)
  if (on === undefined) mismatches.push(`${label} helye nem mérhető most.`)
  else if (on === null) mismatches.push(`${label} vagy az ága nem található a ${code.repo} repóban.`)
  else if (!on) mismatches.push(`${label} nincs rajta a ${d.branch} ágon.`)
  if (!mergeSha) { mismatches.push(`A #${code.pr} PR beolvasztó commitja nem ismert, a változás nem vethető össze.`); return }
  const [mine, theirs] = await Promise.all([probe.changeOf(code.repo, d.head), probe.changeOf(code.repo, mergeSha)])
  if (mine === undefined || theirs === undefined) mismatches.push(`${label} változása nem vethető össze most.`)
  else if (mine === null || theirs === null) mismatches.push(`${label} vagy a beolvasztó commit nem található.`)
  else if (mine !== theirs)
    mismatches.push(`${label} nem ugyanazt a változást hordozza, mint a #${code.pr} PR beolvasztó commitja (${mergeSha.slice(0, 8)}).`)
}

/**
 * The change on GitHub's file list, per file: only the removed and added lines, in order.
 * It does not measure the POSITION or the SURROUNDINGS: the hunk headers and the context
 * lines are left out, so the same change on a branch whose neighbouring lines differ (a
 * cherry-pick onto tc-release next to an import main does not have) gives the same value.
 * Measured on the real case (handoff-read-kontextus): e81d9bd and 3288ec59 differ in one
 * context line of src/web.ts only; with the context they gave two values.
 */
export function changeFingerprint(files: { filename: string; status: string; patch?: string; sha?: string; previous_filename?: string }[]): string {
  return JSON.stringify(
    [...files]
      .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
      .map((f) => [f.filename, f.status, f.previous_filename ?? null,
        // a binary or very large file has no patch: its blob sha is the identity of the
        // file's NEW content, not of the change (a cherry-pick onto a branch with other
        // changes in that file then differs: the safe direction)
        f.patch !== undefined ? changedLines(f.patch) : `blob:${f.sha ?? '?'}`]),
  )
}

function changedLines(patch: string): string[] {
  const kept: string[] = []
  let afterChange = false
  for (const line of patch.split('\n')) {
    const mark = line[0]
    if (mark === '+' || mark === '-') { kept.push(line); afterChange = true }
    // "\ No newline at end of file" belongs to the line before it: kept only after a
    // changed line, since after a context line it is the surroundings again
    else if (mark === '\\') { if (afterChange) kept.push(line); afterChange = false }
    else afterChange = false
  }
  return kept
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
        : { state: String(body.state), merged: Boolean(body.merged), headSha: String(body.head?.sha ?? ''),
            mergeSha: typeof body.merge_commit_sha === 'string' ? body.merge_commit_sha : null }
    },
    async changeOf(repo, sha) {
      const body = await call(`/repos/${repo}/commits/${encodeURIComponent(sha)}`)
      if (body === undefined || body === null) return body
      const files = Array.isArray(body.files) ? body.files : null
      // not measurable, never "the same": GitHub lists at most 300 files; an empty list
      // would make any two empty commits equal; a merge commit (two parents) carries the
      // COMBINED diff, typically empty, not its change (barracuda, review of #75)
      if (!files || files.length === 0 || files.length >= 300) return undefined
      if (Array.isArray(body.parents) && body.parents.length > 1) return undefined
      return changeFingerprint(files)
    },
    async onBranch(repo, sha, branch) {
      const body = await call(`/repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch).replace(/%2F/g, '/')}`)
      if (body === undefined || body === null) return body
      return body.status === 'identical' || body.status === 'ahead'
    },
  }
}
