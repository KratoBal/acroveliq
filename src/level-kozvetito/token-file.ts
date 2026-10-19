// Replacing a refresh-token file as the consent command's root, WITHOUT the capability to override file permissions.
//
// The token file is `10003:10003 0400` (the relay's user reads it at start), in the `titkok` directory, which is `root:root 0700`.
// The consent container is uid 0 with `cap_drop: ALL` and `cap_add: CHOWN, DAC_READ_SEARCH` (compose.yaml). Root without
// DAC_OVERRIDE cannot OPEN a file of another uid for writing, so the file is never written in place. It can, as the owner of the
// directory, create a file there, delete a file there (no sticky bit) and rename over it. So: a temp file in the same directory
// (created 0400, root's), the value written and synced, handed to the relay's user (CAP_CHOWN), then renamed over the target.
// The target is never half written: it is the old file or the new one.
//
// The new file is a new inode. The relay holds the token in memory from its start and its compose secret is a single-file bind mount
// that `docker restart` resolves again by path, so the README's `docker compose restart levelkozvetito` after the consent is what
// makes it read the new value (a running relay is not affected either way; it keeps the old value until restarted).
import { chownSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface TokenFileOps {
  /** the ownership change; the default is the real one (a test records the order instead of being root) */
  chown?: (path: string, uid: number, gid: number) => void
}

export function replaceTokenFile(target: string, token: string, uid: number, ops: TokenFileOps = {}): void {
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.neu-${randomBytes(6).toString('hex')}`)
  const chown = ops.chown ?? chownSync
  let fd: number | null = openSync(temp, 'wx', 0o400)
  try {
    writeSync(fd, token)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    chown(temp, uid, uid)
    renameSync(temp, target)
  } catch (err) {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // nothing left to remove
    }
    throw err
  }
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}
