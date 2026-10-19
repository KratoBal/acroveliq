// The fleet_ro grant plan, read from the gate's `terv` output and put into the one line the owner approves
// (task parancssor-a-fleet-ro-grant, design sheet v1 sections 3 and 4, barracuda's APPROVE conditions).
//
// The gate (scripts/host/fleet-gate.sh, `fleet-ro-grant <key> <db> <commit> terv|alkalmaz`) prints one head line
// and one line per changed column, `GRANT SELECT (col) ON tab TO fleet_ro` or `REVOKE SELECT (col) ON tab FROM
// fleet_ro` (a psql NOTICE, with or without its prefix). This module accepts exactly those lines and nothing else:
// the first real run of the SQL is the first real Postgres run, so an unknown line is a refusal, never a guess.
//
// The approval text is COMPACT, and it must be unambiguous (barracuda, conditions a and b):
//   - a name is only [A-Za-z0-9_]: a quoted identifier can hold a comma, a semicolon or a space, and then
//     `+T a,b; +U c` would have two readings; any other character refuses the plan;
//   - the order is canonical (tables and columns sorted), so the text is rebuilt the same way every time;
//   - #33's description neutraliser turns `_`, `*`, `~`, `|`, `>`, `#` and a backtick into a space, so an underscore
//     in a name is shown as a `.` (a name never holds one), and the text says so.
import { createHash } from 'node:crypto'

export interface PlanOp {
  sign: '+' | '-'
  table: string
  column: string
}

export interface GatePlan {
  mode: 'terv' | 'alkalmaz'
  commit: string
  /** the list's full sha256, as the gate printed it */
  listSha256: string
  /** the Budapest date the gate used for the expiries */
  today: string
  /** canonical order: grants before revokes, then table, then column */
  ops: PlanOp[]
  /** the FULL sha256 of the plan: the check at execution compares this, never the 16 digits of the line */
  planSha256: string
}

export class PlanError extends Error {}

const HEAD =
  /^fleet-ro-grant (terv|alkalmaz): commit ([0-9a-f]{40}), lista sha256 ([0-9a-f]{64}), ma (\d{4}-\d{2}-\d{2}) \(Europe\/Budapest\)$/
const NAME = '(?:"[A-Za-z0-9_]+"|[A-Za-z_][A-Za-z0-9_]*)'
// psql may print the notice bare, or with its file prefix when it reads a script from stdin
const OP = new RegExp(`^(?:(?:psql:[^ :]+:\\d+: )?NOTICE: {2})?(GRANT|REVOKE) SELECT \\((${NAME})\\) ON (${NAME}) (TO|FROM) fleet_ro$`)
const BARE = /^[A-Za-z0-9_]+$/

function unquote(name: string): string {
  const bare = name.startsWith('"') ? name.slice(1, -1) : name
  if (!BARE.test(bare)) throw new PlanError('a name has a character outside [A-Za-z0-9_]')
  return bare
}

const byOrder = (a: PlanOp, b: PlanOp): number => {
  if (a.sign !== b.sign) return a.sign === '+' ? -1 : 1
  if (a.table !== b.table) return a.table < b.table ? -1 : 1
  return a.column < b.column ? -1 : a.column > b.column ? 1 : 0
}

export function sortOps(ops: readonly PlanOp[]): PlanOp[] {
  return [...ops].sort(byOrder)
}

/** The plan's lenyomat: the commit, the list's sha256 and every op in canonical order. */
export function planDigest(commit: string, listSha256: string, ops: readonly PlanOp[]): string {
  const lines = sortOps(ops).map((o) => `${o.sign} ${o.table} ${o.column}`)
  return createHash('sha256')
    .update([commit, listSha256, ...lines].join('\n'))
    .digest('hex')
}

/**
 * Reads the gate's whole output (stdout and stderr together). Strict: one head line for the mode and commit asked,
 * every other non-empty line an op in the two accepted shapes; a duplicate, or one column both granted and revoked,
 * refuses. The caller handles the gate's exit code before it gets here.
 */
export function parseGateOutput(output: string, want: { mode: 'terv' | 'alkalmaz'; commit: string }): GatePlan {
  let head: RegExpExecArray | null = null
  const ops: PlanOp[] = []
  const seen = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const h = HEAD.exec(line)
    if (h) {
      if (head) throw new PlanError('the gate printed two head lines')
      head = h
      continue
    }
    const m = OP.exec(line)
    if (!m) throw new PlanError('the gate output has a line that is not a grant or a revoke')
    const verb = m[1]!
    if ((verb === 'GRANT') !== (m[4] === 'TO')) throw new PlanError('a GRANT must say TO and a REVOKE FROM')
    const op: PlanOp = { sign: verb === 'GRANT' ? '+' : '-', table: unquote(m[3]!), column: unquote(m[2]!) }
    const pair = `${op.table} ${op.column}`
    if (seen.has(pair)) throw new PlanError('a column appears twice in the plan')
    seen.add(pair)
    ops.push(op)
  }
  if (!head) throw new PlanError('the gate output has no head line')
  if (head[1] !== want.mode) throw new PlanError('the head line names another mode')
  if (head[2] !== want.commit) throw new PlanError('the head line names another commit')
  const sorted = sortOps(ops)
  return {
    mode: want.mode,
    commit: head[2]!,
    listSha256: head[3]!,
    today: head[4]!,
    ops: sorted,
    planSha256: planDigest(head[2]!, head[3]!, sorted),
  }
}

// an underscore is shown as a dot: #33 would turn it into a space
const shown = (name: string): string => name.replaceAll('_', '.')

function section(label: string, sign: '+' | '-', ops: readonly PlanOp[]): string | null {
  const mine = ops.filter((o) => o.sign === sign)
  if (mine.length === 0) return null
  const byTable = new Map<string, string[]>()
  for (const o of mine) byTable.set(o.table, [...(byTable.get(o.table) ?? []), o.column])
  const parts = [...byTable.entries()].map(([t, cols]) => `${sign}${shown(t)} ${cols.map(shown).join(',')}`)
  return `${label}: ${parts.join('; ')}`
}

/** The part of the approval line that lists the changes; every `+` is one GRANT SELECT (cols) ON table TO fleet_ro. */
export function planText(ops: readonly PlanOp[]): string {
  const sorted = sortOps(ops)
  return [
    'a nevekben a pont az alahuzas jele',
    section('GRANT SELECT TO fleet-ro', '+', sorted),
    section('REVOKE SELECT FROM fleet-ro', '-', sorted),
  ]
    .filter((s): s is string => s !== null)
    .join(' / ')
}

/** The reverse of planText, for the test and for any reader that wants to prove the text names every op once. */
export function opsFromText(text: string): PlanOp[] {
  const out: PlanOp[] = []
  for (const part of text.split(' / ')) {
    const m = /^(GRANT SELECT TO fleet-ro|REVOKE SELECT FROM fleet-ro): (.*)$/.exec(part)
    if (!m) continue
    const sign = m[1]!.startsWith('GRANT') ? '+' : '-'
    for (const item of m[2]!.split('; ')) {
      const t = /^[+-](\S+) (\S+)$/.exec(item)
      if (!t || t[0]![0] !== sign) throw new PlanError('the text is not a plan text')
      for (const c of t[2]!.split(',')) out.push({ sign, table: t[1]!.replaceAll('.', '_'), column: c.replaceAll('.', '_') })
    }
  }
  return out
}
