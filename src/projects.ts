// Projektek V1 (task t-20261014-acroveliiq-projektkezeles-d3f1; survey:
// agents/nautilus/FELMERES-projektek-v1-2026-10-14.md, barracuda review; Balázs's approval,
// variant A, 2026-10-14 13:11:32 UTC, Acroveliq thread, message_id 1559916572984737814).
//
// A small project registry, and the free `project` fields tied to it on the server. Before
// this, `tasks.project` and `task_handoffs.project` were free text: 123 tasks carried seven
// values, two of them spelling the same project twice, and a later `task-new` silently
// rewrote a task's project (acrobot's measured case, msg 30539).
//
// What is held here, and what is not:
//   - four starting projects; the old `acropora` rows stay as they are and are shown as
//     "Flotta és közös", which also holds older, mixed tasks (a flag for the page);
//   - aliases map today's free values onto a project WHEN READ: no row is rewritten;
//   - each project names its repos; `acropora` covers every registered repo (today every
//     task is `acropora`, OS work included, and a narrow list would stop it), the repo rule
//     bites only on `os`, `commerce` and `reefclub` (barracuda, 30541);
//   - ReefClub uses the Commerce repo until it has its own;
//   - the token's `project` (principal_tokens) is NOT this: that is the installation, the
//     tenant, and a token of another project is a foreign caller. Two namespaces, one word.

import type Database from 'better-sqlite3'

export interface Project {
  id: string
  name: string
  /** `owner/name` repos; `*` = every repo registered on any project. */
  repos: string[]
  /** Free values of old rows that count as this project when read. */
  aliases: string[]
  /** The page says this project also holds older, mixed tasks. */
  legacyMixed: boolean
}

export const DEFAULT_PROJECT_ID = 'acropora'

const SEED: readonly Project[] = [
  {
    id: 'acropora', name: 'Flotta és közös', repos: ['*'], legacyMixed: true,
    aliases: ['marveen', 'token-proba', 'acroveliq', 'seo', 'seo-p1'],
  },
  { id: 'os', name: 'Acropora OS', repos: ['KratoBal/acropora-os'], aliases: ['acropora-os'], legacyMixed: false },
  { id: 'commerce', name: 'Acropora Commerce', repos: ['KratoBal/acropora-commerce'], aliases: [], legacyMixed: false },
  // until it has a repo of its own (Balázs's approval)
  { id: 'reefclub', name: 'ReefClub', repos: ['KratoBal/acropora-commerce'], aliases: [], legacyMixed: false },
]

/** The repos the wide project covers besides the ones the others name. */
const FLEET_REPOS = ['KratoBal/marveen', 'KratoBal/acropora-ai-agent', 'KratoBal/Acrobot']

export function ensureProjectsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repos TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      legacy_mixed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `)
  const insert = db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, repos, aliases, legacy_mixed, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const now = Math.floor(Date.now() / 1000)
  for (const p of SEED) insert.run(p.id, p.name, JSON.stringify(p.repos), JSON.stringify(p.aliases), p.legacyMixed ? 1 : 0, now)
}

const parseList = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function listProjects(db: Database.Database): Project[] {
  return (db.prepare('SELECT id, name, repos, aliases, legacy_mixed FROM projects ORDER BY created_at, rowid').all() as {
    id: string; name: string; repos: string; aliases: string; legacy_mixed: number
  }[]).map((r) => ({ id: r.id, name: r.name, repos: parseList(r.repos), aliases: parseList(r.aliases), legacyMixed: r.legacy_mixed === 1 }))
}

/** The registry id a stored or given value means, or null when it means none. */
export function resolveProject(db: Database.Database, value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  for (const p of listProjects(db)) if (p.id === v || p.aliases.includes(v)) return p.id
  return null
}

/** A resolver built once (one registry read for a whole list). */
export function projectResolver(db: Database.Database): (value: string | null | undefined) => string | null {
  const all = listProjects(db)
  return (value) => {
    const v = (value ?? '').trim()
    if (!v) return null
    for (const p of all) if (p.id === v || p.aliases.includes(v)) return p.id
    return null
  }
}

/** Every stored value that counts as this project: its id and its aliases. */
export function projectValues(db: Database.Database, id: string): string[] {
  const p = listProjects(db).find((x) => x.id === id)
  return p ? [p.id, ...p.aliases] : []
}

/** The repos a project allows, `*` expanded to every registered repo and the fleet's. */
export function projectRepos(db: Database.Database, id: string): string[] {
  const all = listProjects(db)
  const p = all.find((x) => x.id === id)
  if (!p) return []
  if (!p.repos.includes('*')) return p.repos
  return [...new Set([...FLEET_REPOS, ...all.flatMap((x) => x.repos.filter((r) => r !== '*'))])]
}

/**
 * Whether a repo fits a task's project. A task whose stored project means none (an unknown
 * free value) is not judged here: the project rule names that, the repo rule does not double it.
 */
export function repoFits(db: Database.Database, storedProject: string | null | undefined, repo: string): string | null {
  const id = resolveProject(db, storedProject)
  if (!id) return null
  const repos = projectRepos(db, id)
  return repos.includes(repo) ? null : `a ${repo} repó nem a(z) ${id} projekté (${repos.join(', ')})`
}
