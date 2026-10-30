// The auto-mode trial's switch: which agent starts with --permission-mode auto (kanban c47f5846, task auto-mode-proba).
//
// WHERE IT LIVES, AND WHY NOT IN THE AGENT'S CONFIG. barracuda's review of #321 (2026-10-30): the first version read
// `permissionModeOverride` from the agent's own config file, one the agent can write (rw-rw-r--+ marveen:fleet,
// `test -w` true as the agent), so a strict agent could have switched it on for itself. The security profile has had
// the same lesson since 2026-10-15 (agent-profile-store.ts): the trusted value comes from store/, which no agent can
// write. This file is the same kind: store/agent-permission-overrides.json, {"<agent>": "auto"}, written by the host
// operator by hand. It is not in the PUT /api/agents fields, and nothing in the dashboard writes it.
//
// The read is defence in depth on top of the directory: the file must be a regular file (not a link), owned by the user
// the server runs as, and without group or world write. A file that is not is ignored, loudly, and the answer is "no
// override". A missing or damaged file is "no override" too: the only default is the strict profile's own.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import type { PermissionModeOverride } from './agent-config.js'

export const PERMISSION_OVERRIDES_FILE = join(STORE_DIR, 'agent-permission-overrides.json')

/** The agents that carry the override: own keys with the exact string "auto". Anything else is ignored. */
export function parsePermissionOverrides(raw: string): Map<string, PermissionModeOverride> {
  const out = new Map<string, PermissionModeOverride>()
  let data: unknown
  try { data = JSON.parse(raw) } catch { return out }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === 'auto') out.set(name, 'auto')
  }
  return out
}

/** Why a file is not trusted, or null when it is: a regular file, ours, no group or world write. */
export function untrustedReason(st: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }, uid: number | undefined): string | null {
  if (st.isSymbolicLink()) return 'a symbolic link'
  if (!st.isFile()) return 'not a regular file'
  if (uid !== undefined && st.uid !== uid) return `owned by uid ${st.uid}, not by the server (${uid})`
  if ((st.mode & 0o022) !== 0) return 'writable by group or others'
  return null
}

export function readPermissionOverrideFrom(path: string, name: string, uid: number | undefined = process.getuid?.()): PermissionModeOverride | null {
  let st
  try { st = lstatSync(path) } catch { return null } // no file: no override
  const why = untrustedReason(st, uid)
  if (why) {
    logger.warn({ path, why }, 'permission override file ignored: not trusted')
    return null
  }
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return null }
  return parsePermissionOverrides(raw).get(name) ?? null
}

/** The override of one agent: "auto" when the host file lists it, else null. */
export function readAgentPermissionModeOverride(name: string): PermissionModeOverride | null {
  return readPermissionOverrideFrom(PERMISSION_OVERRIDES_FILE, name)
}
