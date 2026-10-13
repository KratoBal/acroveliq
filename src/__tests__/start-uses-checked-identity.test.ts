import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// the launch resolves the claude binary from PATH; a stub is enough, nothing runs it
const fakeBin = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'b45-inditas-bin-'))
  fs.writeFileSync(path.join(d, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  process.env.PATH = `${d}:${process.env.PATH ?? ''}`
  return d
})

// every tmux call goes through execFileSync: record them, and answer has-session with
// "no such session" so the start goes on to new-session
const calls: string[][] = []
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFileSync: vi.fn((file: string, args: string[] = []) => {
      calls.push([file, ...args])
      if (args.includes('has-session')) throw new Error("can't find session")
      return ''
    }),
  }
})

const AGENT = 'b45-inditas-proba'
const CHECKED = `agent-${AGENT}`
// the identity check passes with the agent's own user (as when agent-<name> exists in
// /etc/passwd and the config said so); the config the start could re-read now names
// ANOTHER user, as if it had been rewritten after the check (barracuda, review of #57)
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    readAgentRunIdentity: vi.fn(() => ({ ok: true, runAsUser: CHECKED })),
    // the remote check saw a local agent; the file may say otherwise by the launch
    readAgentRemoteConfig: vi.fn(() => ({ host: null, workdir: null })),
  }
})

import { agentDir } from '../web/agent-config.js'
import { startAgentProcess } from '../web/agent-process.js'

beforeAll(() => {
  mkdirSync(agentDir(AGENT), { recursive: true })
  writeFileSync(join(agentDir(AGENT), 'agent-config.json'), JSON.stringify({ runAsUser: 'agent-masik-agens' }))
})
afterAll(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(fakeBin, { recursive: true, force: true })
})
beforeEach(() => { calls.length = 0 })

describe('the start runs as the CHECKED identity, not a second read of the config', () => {
  it('new-session goes to the checked user, the rewritten config is not used', async () => {
    await startAgentProcess(AGENT)
    const ns = calls.filter((c) => c.includes('new-session'))
    expect(ns).toHaveLength(1)
    // the session NAME is agent-<name> too, so only the sudo form proves the user
    expect(ns[0].slice(0, 4)).toEqual(['sudo', '-n', '-u', CHECKED])
    expect(ns[0].join(' ')).not.toContain('agent-masik-agens')
    // the launch command itself: the per-user umask and the #62 git environment come
    // from the same checked value (both are empty for the router's user)
    const cmd = ns[0][ns[0].length - 1]
    expect(cmd.startsWith('umask 022 && ')).toBe(true)
    expect(cmd).toContain('export GIT_CEILING_DIRECTORIES=')
  })

  it('a remote host written into the config after the remote check: the launch stays local', async () => {
    writeFileSync(join(agentDir(AGENT), 'agent-config.json'),
      JSON.stringify({ runAsUser: CHECKED, remoteHost: 'tamado.example', remoteWorkdir: '/home/x/proj' }))
    await startAgentProcess(AGENT)
    // first: nothing at all went to the host the config names (over ssh the tmux
    // command is one joined argument, so a new-session filter alone would miss it)
    expect(calls.filter((c) => c.join(' ').includes('tamado.example'))).toEqual([])
    const ns = calls.filter((c) => c.includes('new-session'))
    expect(ns).toHaveLength(1)
    expect(ns[0].slice(0, 4)).toEqual(['sudo', '-n', '-u', CHECKED])
  })
})
