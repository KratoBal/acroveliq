import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Each profile is a JSON file under templates/profiles/ with an allow/deny
// list that Claude Code's native permissions engine understands. Choosing a
// strict profile also drops --dangerously-skip-permissions, so Claude Code
// enforces the allow/deny list rather than bypassing it. Channels plugin
// permission prompts (the Telegram Allow/Deny inline buttons) still fire
// because they live on a different notification channel.
export interface ProfileTemplate {
  id: string
  label: string
  description: string
  permissionMode: 'strict' | 'permissive'
  // `directories` is NOT a third allow-list: it moves the WORKING-DIRECTORY
  // boundary, which is a separate check from allow/deny. Measured 2026-09-04:
  // a live `Read(${HOME}/marveen/**)` allow rule still prompted on every read,
  // because the file sat outside the agent's working directories. The runtime
  // calls this `permissions.additionalDirectories` (the `--add-dir` flag is the
  // launch-time form). deny still wins over it, so denied paths stay denied.
  filesystem: { allow: string[]; deny: string[]; directories?: string[] }
}

export const PROFILES_DIR = join(PROJECT_ROOT, 'templates', 'profiles')

export const HARDCODED_DEFAULT_PROFILE: ProfileTemplate = {
  id: 'default',
  label: 'Alapértelmezett',
  description: 'Permissive fallback.',
  permissionMode: 'permissive',
  filesystem: { allow: [], deny: ['mcp__claude_ai_Supabase__*'] },
}

// THE CLOSED FAILURE MODE OF THE TRUSTED PROFILE STORE (agent-profile-store.ts, LOCKED_PROFILE_ID):
// a damaged or unwritable store, or a seed the gate refused, answers this. It is defined in code and
// checked BEFORE the template files, so no file under templates/profiles/ can redefine it, and an
// unknown id never reaches it through the permissive 'default' fallback below. Strict mode (no
// --dangerously-skip-permissions), the agent's own directory readable, nothing else allowed.
export const LOCKED_PROFILE: ProfileTemplate = {
  id: 'locked',
  label: 'Zárolt (hibás vagy hiányzó megbízható profil)',
  description: 'Fail-closed: the trusted profile record could not be used. Set the profile through the dashboard.',
  permissionMode: 'strict',
  filesystem: {
    allow: ['Read(${AGENT_DIR}/**)'],
    deny: [
      'Read(${HOME}/marveen/store/**)', 'Read(${HOME}/.ssh/**)', 'Read(${HOME}/.aws/**)', 'Read(${HOME}/.gnupg/**)',
      'Read(**/.env)', 'Bash(sudo:*)', 'Bash(/bin/sudo:*)', 'Bash(/usr/bin/sudo:*)', 'WebFetch(*)', 'WebSearch(*)',
    ],
  },
}

export function listProfileTemplates(): ProfileTemplate[] {
  if (!existsSync(PROFILES_DIR)) return [HARDCODED_DEFAULT_PROFILE]
  const out: ProfileTemplate[] = []
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8')) as ProfileTemplate
      if (p.id) out.push(p)
    } catch { /* skip malformed */ }
  }
  return out.length ? out : [HARDCODED_DEFAULT_PROFILE]
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  if (id === LOCKED_PROFILE.id) return LOCKED_PROFILE
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate } catch { /* fall through */ }
  }
  if (id !== 'default') return loadProfileTemplate('default')
  return HARDCODED_DEFAULT_PROFILE
}

export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  return value
    .replace(/\$\{HOME\}/g, ctx.HOME)
    .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR)
}
