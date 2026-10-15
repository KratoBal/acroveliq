// A failed trust lookup closes (barracuda's #192 review): when the trusted record cannot be read,
// an inter-agent message is delivered <untrusted>, never as a trusted peer, and the delivery does not
// throw. WHAT TURNS THIS RED: the lookup error propagating, or answering 'trusted-peer'.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'fo-agens-teszt',
}))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: () => true }))
vi.mock('../web/agent-team.js', () => ({
  readAgentTeam: () => { throw new Error('agent profile store unreadable') },
}))

import { classifyAgentMessage } from '../web/agent-message-wrap.js'

describe('the trust lookup fails closed', () => {
  it('TRUST-CLOSED: a throwing lookup gives untrusted; the main agent shortcut still holds', () => {
    expect([classifyAgentMessage('egyik', 'masik')?.category, classifyAgentMessage('egyik', 'fo-agens-teszt')?.category], 'TRUST-CLOSED')
      .toEqual(['untrusted', 'trusted-peer'])
  })
})
