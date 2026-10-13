import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, statSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteGroupPrivate } from '../web/atomic-write.js'
import { gidFromGroupFile, agentConfigGroupName } from '../web/agent-config.js'
import { writeAgentPrivateConfig } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

// B45 B2-6: an agent's .claude.json may carry tokens (user-scope mcpServers env).
// The old "group-shared" write made it 0660 with the inherited group `fleet`, the
// primary group of all six agents (measured 2026-10-13: picasso's and polip's).
// Now: the agent's PRIVATE group, staged outside the tree so no default-ACL entry
// is inherited, and no write at all when that group does not exist.
let T: string
let tree: string
let stage: string
const myGid = process.getgid ? process.getgid() : 0
// A SUPPLEMENTARY group of this process, if any: the tmp file is born with the
// primary gid anyway, so only a different group shows that the chown happened.
const otherGid = (process.getgroups ? process.getgroups() : []).find(g => g !== myGid) ?? myGid
beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), 'b45-priv-'))
  tree = join(T, 'agents', 'polip')
  mkdirSync(join(tree, '.claude-config'), { recursive: true })
  mkdirSync(join(T, 'agents', 'murena', '.claude-config'), { recursive: true })
  stage = join(T, 'store', '.agent-cfg-stage')
})
afterEach(() => rmSync(T, { recursive: true, force: true }))

describe('atomicWriteGroupPrivate', () => {
  it('writes 0660 with the given group, and leaves nothing in the stage dir', () => {
    const p = join(tree, '.claude-config', '.claude.json')
    atomicWriteGroupPrivate(tree, p, '{"a":1}', otherGid, stage)
    const st = statSync(p)
    expect(st.mode & 0o777).toBe(0o660)
    expect(st.gid).toBe(otherGid)
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}')
    expect(readdirSync(stage)).toEqual([])
    expect(statSync(stage).mode & 0o777).toBe(0o700)
  })

  it('a symlink as the final component is replaced, not written through', () => {
    const victim = join(T, 'agents', 'murena', '.claude-config', '.claude.json')
    writeFileSync(victim, 'MURENA')
    const p = join(tree, '.claude-config', '.claude.json')
    symlinkSync(victim, p)
    atomicWriteGroupPrivate(tree, p, 'POLIP', myGid, stage)
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
    expect(readFileSync(victim, 'utf-8')).toBe('MURENA')
  })

  it('a symlinked .claude-config into another tree: refused, nothing staged left behind', () => {
    rmSync(join(tree, '.claude-config'), { recursive: true })
    symlinkSync(join(T, 'agents', 'murena', '.claude-config'), join(tree, '.claude-config'))
    expect(() => atomicWriteGroupPrivate(tree, join(tree, '.claude-config', '.claude.json'), 'X', myGid, stage)).toThrow(/outside/)
    expect(readdirSync(join(T, 'agents', 'murena', '.claude-config'))).toEqual([])
  })

  it('a group the process may not use: the write fails and the tmp is removed', () => {
    const p = join(tree, '.claude-config', '.claude.json')
    // gid 0 is not ours unless the test runs as root; then this case proves nothing.
    if (myGid === 0) return
    expect(() => atomicWriteGroupPrivate(tree, p, 'X', 0, stage)).toThrow()
    expect(readdirSync(stage)).toEqual([])
    expect(() => statSync(p)).toThrow()
  })
})

describe('the private group lookup', () => {
  const group = [
    'fleet:x:1001:marveen',
    'agent-polip-cfg:x:1102:agent-polip,marveen',
    'agent-polip-cfgx:x:1199:',
  ].join('\n')
  it('finds agent-<name>-cfg by exact name', () => {
    expect(agentConfigGroupName('polip')).toBe('agent-polip-cfg')
    expect(gidFromGroupFile(group, 'agent-polip-cfg')).toBe(1102)
    expect(gidFromGroupFile(group, 'agent-murena-cfg')).toBeNull()
  })
})

describe('writeAgentPrivateConfig: fail closed without the private group', () => {
  it('refuses (no file written) when agent-<name>-cfg does not exist', () => {
    const base = join(PROJECT_ROOT, 'agents')
    const name = `b45test${process.pid}${Date.now()}`
    const own = join(base, name)
    mkdirSync(join(own, '.claude-config'), { recursive: true })
    try {
      const p = join(own, '.claude-config', '.claude.json')
      expect(() => writeAgentPrivateConfig(p, '{}', name)).toThrow(/no private config group agent-.*-cfg/)
      expect(() => statSync(p)).toThrow()
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })
})
