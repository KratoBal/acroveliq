import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// every tmux call of agent-process (local or over ssh) goes through execFileSync:
// recording it is recording where the router's tmux and ssh calls go
const calls: string[][] = []
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFileSync: vi.fn((file: string, args: string[] = []) => {
      calls.push([file, ...args])
      return ''
    }),
  }
})

import {
  agentDir,
  checkAgentRunIdentity,
  readAgentRemoteHost,
  resolveRemoteRegistryEntry,
  setAgentRemoteHostsFileForTests,
  writeAgentRemoteConfig,
} from '../web/agent-config.js'
import { agentRunState, agentTmuxTarget } from '../web/agent-process.js'

/*
  b77e2688: THE ROUTER'S SSH DESTINATION COMES FROM ITS OWN REGISTRY, NOT FROM THE
  AGENT'S CONFIG. agent-config.json is in the agent's own (fleet-writable) tree; a
  remoteHost written there used to send every panel and lifecycle call (send-keys,
  capture, list-sessions, kill-session) over ssh, with the router's key, to that
  host. What turns these red: a remoteHost in agent-config.json reaching any tmux
  call or the panel target again (the foreign host), or the registry entry no
  longer being honoured (the legitimate host).
*/

const AGENT = 'b77-remote-proba'
const FOREIGN = 'tamado.example'
const REG_DIR = mkdtempSync(join(tmpdir(), 'b77-remote-reg-'))
const REG = join(REG_DIR, 'agent-remote-hosts.json')

const sshTo = (host: string) => calls.filter((c) => c[0] === 'ssh' && c.includes(host))

beforeAll(() => {
  setAgentRemoteHostsFileForTests(REG)
  mkdirSync(agentDir(AGENT), { recursive: true })
})
afterAll(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(REG_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  calls.length = 0
  rmSync(REG, { force: true })
  writeFileSync(join(agentDir(AGENT), 'agent-config.json'),
    JSON.stringify({ remoteHost: FOREIGN, remoteWorkdir: '/home/x/proj' }))
})

describe('a remoteHost the agent wrote into its own config', () => {
  it('is not the panel target: no host, and no tmux call goes over ssh to it', () => {
    expect(readAgentRemoteHost(AGENT)).toBeNull()
    expect(agentTmuxTarget(AGENT).host).toBeNull()
    agentRunState(AGENT)
    // the probe ran (so the empty ssh list below is about the destination, not a
    // call that never happened) and it ran on the local tmux binary
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.join(' ').includes(FOREIGN))).toEqual([])
    expect(calls.filter((c) => c[0] === 'ssh')).toEqual([])
  })
})

describe('a remote host set through the router (PUT /remote)', () => {
  it('is honoured: the same probe goes over ssh to the registered host', () => {
    expect(writeAgentRemoteConfig(AGENT, 'devbox', '/home/user/proj').ok).toBe(true)
    expect(readAgentRemoteHost(AGENT)).toBe('devbox')
    expect(agentTmuxTarget(AGENT).host).toBe('devbox')
    agentRunState(AGENT)
    expect(sshTo('devbox').length).toBeGreaterThan(0)
    // the config's own value still plays no part
    expect(calls.filter((c) => c.join(' ').includes(FOREIGN))).toEqual([])
  })

  it('is written to the registry, and the agent config is left as it was', () => {
    writeAgentRemoteConfig(AGENT, 'devbox', '/home/user/proj')
    expect(JSON.parse(readFileSync(REG, 'utf-8'))).toEqual({
      [AGENT]: { remoteHost: 'devbox', remoteWorkdir: '/home/user/proj' },
    })
    expect(JSON.parse(readFileSync(join(agentDir(AGENT), 'agent-config.json'), 'utf-8')).remoteHost).toBe(FOREIGN)
  })

  it('clearing removes the entry and the agent is local again', () => {
    writeAgentRemoteConfig(AGENT, 'devbox', '/home/user/proj')
    expect(writeAgentRemoteConfig(AGENT, '', '').ok).toBe(true)
    expect(readAgentRemoteHost(AGENT)).toBeNull()
    expect(AGENT in JSON.parse(readFileSync(REG, 'utf-8'))).toBe(false)
  })
})

describe('resolveRemoteRegistryEntry', () => {
  it('validates the entry like the old config keys', () => {
    const reg = (e: unknown) => JSON.stringify({ a: e })
    expect(resolveRemoteRegistryEntry(reg({ remoteHost: 'devbox', remoteWorkdir: '/p' }), 'a')).toEqual({ host: 'devbox', workdir: '/p' })
    expect(resolveRemoteRegistryEntry(reg({ remoteHost: 'a b;x', remoteWorkdir: '/p' }), 'a')).toEqual({ host: null, workdir: null })
    expect(resolveRemoteRegistryEntry(reg({ remoteHost: 'devbox' }), 'a')).toEqual({ host: null, workdir: null })
  })

  it('another agent, a missing file, broken JSON or a prototype name resolve to local', () => {
    const raw = JSON.stringify({ a: { remoteHost: 'devbox', remoteWorkdir: '/p' } })
    expect(resolveRemoteRegistryEntry(raw, 'b').host).toBeNull()
    expect(resolveRemoteRegistryEntry('{}', 'a').host).toBeNull()
    expect(resolveRemoteRegistryEntry('{not json', 'a').host).toBeNull()
    expect(resolveRemoteRegistryEntry('[]', 'a').host).toBeNull()
    expect(resolveRemoteRegistryEntry(raw, 'constructor').host).toBeNull()
  })
})

describe('the start identity check takes the remote host from the registry', () => {
  const exists = () => true
  const cfg = (o: Record<string, unknown>) => JSON.stringify(o)

  it('a config remoteHost no longer refuses the start of an own-user agent', () => {
    expect(checkAgentRunIdentity('x', cfg({ runAsUser: 'agent-x', remoteHost: FOREIGN }), exists, null).ok).toBe(true)
  })

  it('a registry host for an own-user agent is still refused', () => {
    expect(checkAgentRunIdentity('x', cfg({ runAsUser: 'agent-x' }), exists, 'devbox').ok).toBe(false)
  })
})
