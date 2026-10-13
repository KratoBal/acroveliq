import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentUmaskPrefix } from '../web/agent-process.js'

// B45: a per-user agent's new files must not be group-writable, because every
// agent's primary group is `fleet` (all six agents). The prefix is checked by
// RUNNING it, not by its text: a shell creates a file the way most tools do
// (0666 requested) and the resulting mode is what the other agents would get.
describe('agentUmaskPrefix', () => {
  it('per-user agent: a new file is not group- or world-writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b45-umask-'))
    try {
      const f = join(dir, 'f')
      execFileSync('sh', ['-c', `umask 002 && ${agentUmaskPrefix('agent-murena')}: > "${f}"`])
      expect(statSync(f).mode & 0o022).toBe(0)
      expect(statSync(f).mode & 0o644).toBe(0o644)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('agent running as the router user: no prefix (its umask is the router\'s own)', () => {
    expect(agentUmaskPrefix(null)).toBe('')
    expect(agentUmaskPrefix(undefined)).toBe('')
  })
})
