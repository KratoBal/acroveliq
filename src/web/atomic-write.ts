import { writeFileSync, chmodSync, renameSync, lstatSync } from 'node:fs'
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path'
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
// tree must not follow a symlink the agent planted there. The agent owns its tree,
// so it can replace `.mcp.json`, `.claude/settings.json` or a whole `.claude/agents`
// directory with a symlink into ANOTHER agent's tree, which the router can still
// write after the B45 ACL fix (it keeps a named entry everywhere). A plain
// writeFileSync/copyFileSync then writes through the link.
//  - a symlink as the FINAL component: the rename replaces the link itself, never
//    its target (atomicWriteFileSync), so it is race-free;
//  - a symlink as an INTERMEDIATE directory: the rename would follow it too, so every
//    directory from `root` down to the parent is lstat-ed and must be a plain
//    directory. This narrows, but does not close, a swap between the check and the
//    rename (node has no openat); the B45 regression check reports such a tree.
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
  let cur = r
  for (const part of ['', ...relative(r, dirname(p)).split(sep).filter(Boolean)]) {
    cur = part ? join(cur, part) : cur
    const st = lstatSync(cur)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`atomicWriteInTree: ${cur} is not a plain directory (symlink or file)`)
    }
  }
  atomicWriteFileSync(p, data, opts)
}
