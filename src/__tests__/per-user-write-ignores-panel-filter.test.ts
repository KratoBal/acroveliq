import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { stampProjectTrustForDir } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

// #57 (B45 B2-2 follow-up) made readAgentRunAsUser honour only the agent's OWN user,
// for the panel's tmux calls. #54 (B2-6) decides from the same configured value
// whether a .claude.json in an agent's tree goes through the private group. If the
// write path took the FILTERED value, an agent that writes another user into its own
// agent-config.json would turn its tree's .claude.json back into a plain write (the
// B2-6 leak #54 closed). The write path reads the configured value; the panel filters.
// With no agent-<name>-cfg group in the test environment the private path fails
// closed, so "no file" is the private path and "a file" is the plain one.
function agentTree(runAsUser: string | null): { root: string; dot: string } {
  const name = `b45panel${process.pid}${Date.now()}${Math.floor(Math.random() * 1e6)}`
  const root = join(PROJECT_ROOT, 'agents', name)
  mkdirSync(join(root, '.claude-config'), { recursive: true })
  writeFileSync(join(root, 'agent-config.json'), JSON.stringify(runAsUser ? { runAsUser } : {}))
  return { root, dot: join(root, '.claude-config', '.claude.json') }
}

describe('a per-user tree write follows the configured runAsUser, not the panel filter', () => {
  it('another user in the config: still the private path (fails closed here, no plain write)', () => {
    const { root, dot } = agentTree('agent-someone-else')
    try {
      expect(stampProjectTrustForDir(dot, root)).toBe(false)
      expect(existsSync(dot)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('no runAsUser (a router-user agent): the plain write, as before', () => {
    const { root, dot } = agentTree(null)
    try {
      expect(stampProjectTrustForDir(dot, root)).toBe(true)
      expect(existsSync(dot)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
