import { describe, it, expect } from 'vitest'
import { checkAgentRunIdentity, osUserExistsFromPasswd, checkAgentRunIdentityWithPasswd, runAsUserForPanel } from '../web/agent-config.js'

// B45 B2-2: the run identity comes from the OS, not from the agent's own
// agent-config.json (the agent owns that file's directory, so it can always
// replace it). barracuda review: the empty value and ANOTHER agent's user are
// two separate cases and are tested separately.
const passwd = [
  'root:x:0:0:root:/root:/bin/bash',
  'marveen:x:1000:1000::/home/marveen:/bin/bash',
  'agent-barracuda:x:1003:1001::/home/agent-barracuda:/bin/bash',
  'agent-murena:x:1004:1001::/home/agent-murena:/bin/bash',
].join('\n')
const exists = osUserExistsFromPasswd(passwd)
const cfg = (o: Record<string, unknown>) => JSON.stringify(o)

describe('checkAgentRunIdentity: an agent WITH its own OS user', () => {
  it('correct runAsUser: starts', () => {
    expect(checkAgentRunIdentity('barracuda', cfg({ runAsUser: 'agent-barracuda' }), exists).ok).toBe(true)
  })
  it('empty or missing runAsUser: refused (would start as the router, marveen)', () => {
    expect(checkAgentRunIdentity('barracuda', cfg({ runAsUser: '' }), exists).ok).toBe(false)
    expect(checkAgentRunIdentity('barracuda', cfg({}), exists).ok).toBe(false)
  })
  it("ANOTHER agent's user: refused (would start with murena's groups)", () => {
    const r = checkAgentRunIdentity('barracuda', cfg({ runAsUser: 'agent-murena' }), exists)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toContain('agent-murena')
  })
  it('the router or root as runAsUser: refused', () => {
    expect(checkAgentRunIdentity('barracuda', cfg({ runAsUser: 'marveen' }), exists).ok).toBe(false)
    expect(checkAgentRunIdentity('barracuda', cfg({ runAsUser: 'root' }), exists).ok).toBe(false)
  })
  it('a remoteHost: refused (the router would launch it over ssh, outside the uid)', () => {
    expect(checkAgentRunIdentity('barracuda', cfg({ runAsUser: 'agent-barracuda', remoteHost: 'h.example' }), exists).ok).toBe(false)
  })
  it('unparseable config: refused, not defaulted', () => {
    expect(checkAgentRunIdentity('barracuda', '{not json', exists).ok).toBe(false)
  })
})

describe('checkAgentRunIdentity: an agent WITHOUT its own OS user', () => {
  it('no runAsUser: starts as the router, as before', () => {
    expect(checkAgentRunIdentity('acrobot', cfg({}), exists).ok).toBe(true)
  })
  it("another agent's user: refused", () => {
    expect(checkAgentRunIdentity('acrobot', cfg({ runAsUser: 'agent-murena' }), exists).ok).toBe(false)
  })
})

describe('osUserExistsFromPasswd', () => {
  it('matches whole names only', () => {
    expect(exists('agent-murena')).toBe(true)
    expect(exists('agent-mur')).toBe(false)
    expect(exists('')).toBe(false)
  })
})

// B45 B2-2 follow-up (barracuda): an unreadable passwd and the panel's tmux calls.
describe('follow-up: unknown identity and the panel resolver', () => {
  it('empty /etc/passwd: refused, even with a correct runAsUser', () => {
    expect(checkAgentRunIdentityWithPasswd('barracuda', cfg({ runAsUser: 'agent-barracuda' }), '').ok).toBe(false)
    expect(checkAgentRunIdentityWithPasswd('barracuda', cfg({}), '  \n').ok).toBe(false)
    expect(checkAgentRunIdentityWithPasswd('barracuda', cfg({ runAsUser: 'agent-barracuda' }), passwd).ok).toBe(true)
  })
  it('panel: only the agent\'s own user is honoured, anything else is the router\'s server', () => {
    expect(runAsUserForPanel('barracuda', 'agent-barracuda')).toBe('agent-barracuda')
    expect(runAsUserForPanel('barracuda', 'agent-murena')).toBeNull()
    expect(runAsUserForPanel('barracuda', 'root')).toBeNull()
    expect(runAsUserForPanel('barracuda', null)).toBeNull()
  })
})
