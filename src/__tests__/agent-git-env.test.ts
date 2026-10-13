import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentGitEnv } from '../web/agent-process.js'

// B45 follow-up: the prefix is checked by RUNNING git under it, not by its text.
// The layout mirrors the fleet: a router repo at the root, agents/ inside it
// (gitignored there), an agent directory that is not a repo, a clone in it, a
// symlink to that clone, and a plain directory.
describe('agentGitEnv', () => {
  let root: string
  let agents: string
  let own: string
  let clone: string
  const isolated = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const uid = process.getuid!()

  const git = (prefix: string, args: string) =>
    spawnSync('sh', ['-c', `${prefix}git ${args}`], { env: isolated, encoding: 'utf-8' })

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'b45-git-')))
    agents = join(root, 'agents')
    own = join(agents, 'barracuda')
    clone = join(own, 'commerce-olvaso')
    mkdirSync(join(clone, 'apps'), { recursive: true })
    mkdirSync(join(own, 'plain'))
    execFileSync('git', ['init', '-q', root], { env: isolated })
    execFileSync('git', ['init', '-q', clone], { env: isolated })
    symlinkSync(clone, join(own, 'link'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('the agent directory no longer resolves to the router repo above agents/', () => {
    // control: without the prefix git walks up and finds the router repo
    expect(git('', `-C '${own}' rev-parse --show-toplevel`).stdout.trim()).toBe(root)
    const r = git(agentGitEnv('agent-barracuda', own, agents, uid), `-C '${own}' rev-parse --show-toplevel`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not a git repository')
  })

  it('a repo inside the agent tree is still found from its subdirectory', () => {
    const r = git(agentGitEnv('agent-barracuda', own, agents, uid), `-C '${join(clone, 'apps')}' rev-parse --show-toplevel`)
    expect(r.stdout.trim()).toBe(clone)
  })

  it('a router-owned direct child clone is trusted by its exact path, nothing else', () => {
    const r = git(agentGitEnv('agent-barracuda', own, agents, uid), 'config --get-all safe.directory')
    expect(r.stdout.trim().split('\n')).toEqual([clone])
  })

  it('a clone owned by anyone but the router is not trusted', () => {
    const prefix = agentGitEnv('agent-barracuda', own, agents, uid + 1)
    expect(prefix).not.toContain('safe.directory')
    expect(git(prefix, 'config --get-all safe.directory').stdout.trim()).toBe('')
  })

  it('agent running as the router user: no prefix', () => {
    expect(agentGitEnv(null, own, agents, uid)).toBe('')
    expect(agentGitEnv(undefined, own, agents, uid)).toBe('')
  })
})
