import { writeFileSync, chmodSync, renameSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, relative, dirname, join, sep, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

// Atomic write: write to a sibling tmp file and rename over the target, so a
// crash/kill mid-write can never leave a zero-byte or half-written state file.
// Use this for anything the dashboard depends on surviving a restart
// (dashboard-token, agent CLAUDE.md / SOUL.md, telegram env + access.json).
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const root = agentTreeRootOf(path)
  if (root) {
    atomicWriteInTree(root, path, data, opts)
    return
  }
  rawAtomicWrite(path, data, opts)
}

function rawAtomicWrite(path: string, data: string | Buffer, opts: { mode?: number }): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  // Create the tmp file at the requested mode from the FIRST byte. Writing it
  // mode-less and chmod-ing afterwards leaves a short-lived tmp that already
  // holds the full (possibly credential) content at the umask default (0644)
  // in the same directory as the protected target -- a world-readable window
  // (VAULTMODE818). The chmod stays as a belt-and-suspenders: writeFileSync's
  // mode is still reduced by the umask, so for modes with bits the umask would
  // strip the explicit chmod enforces the exact value.
  writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
  if (opts.mode !== undefined) {
    try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, path)
}


// B45 B2-3 (Security Baseline, 2026-10-13): a write by the router INTO an agent's
// tree must land inside THAT tree. The agent owns its tree, so it can replace a
// file or a whole directory (`.claude`, `.claude/agents`, `.claude-config`) with a
// symlink into ANOTHER agent's tree, which the router can still write after the
// B45 ACL fix (it keeps a named entry everywhere). Both a plain write and a
// tmp+rename then land in the other tree (barracuda review of #47: a symlinked
// `.claude` redirects every settings.json write, atomic or not).
// Rule: the real path of the parent directory must be inside the real path of the
// agent's tree root, and the write goes to that resolved directory. A symlink
// that stays inside the tree (`.claude/skills -> ../skills`) is fine; a symlink
// as the FINAL component is replaced by the rename, never written through.
// Limit: a swap between the realpath and the rename is narrowed, not closed.
// Every write to a path under <PROJECT_ROOT>/agents/<name>/ goes through this
// automatically (atomicWriteFileSync), so a new call site cannot forget it.
// The project root is derived HERE, not imported from config.js: env.ts imports this
// module, and config.js imports env.ts, so importing config would close a cycle in
// which readEnvFile is still undefined (measured: env.test.ts, 5 failures). Same
// rule as config.ts (PROJECT_ROOT = the parent of the compiled src/ or dist/ dir):
// this file sits one level deeper, in web/.
const PROJECT_ROOT_HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function agentTreeRootOf(path: string, base: string = join(PROJECT_ROOT_HERE, 'agents')): string | null {
  const rel = relative(base, resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  if (parts.length < 2) return null // agents/<name> itself, or the base
  return join(base, parts[0])
}

export function atomicWriteInTree(
  root: string,
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const r = resolve(root)
  const p = resolve(path)
  const rel = relative(r, p)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`atomicWriteInTree: ${p} is not inside ${r}`)
  }
  if (lstatSync(r).isSymbolicLink()) {
    throw new Error(`atomicWriteInTree: the tree root ${r} is a symlink`)
  }
  const rootReal = realpathSync(r)
  const parentReal = realpathSync(dirname(p))
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new Error(`atomicWriteInTree: ${dirname(p)} resolves to ${parentReal}, outside ${rootReal}`)
  }
  rawAtomicWrite(join(parentReal, basename(p)), data, opts)
}
