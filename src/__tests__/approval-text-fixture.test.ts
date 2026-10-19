// The #33 Discord text and expiry, as scripts/root/root-telepito.py reproduces them in Python. The root
// installer reads the owner's Discord answer back itself and compares the WHOLE request message letter for
// letter, so its Python copy of buildDiscordApprovalText and formatApprovalExpiry must not drift from this
// code. Both sides check the same fixture: this file holds the TypeScript side to it, root-telepito.test.py
// the Python side. A change here that changes the text turns this red; then regenerate the fixture AND
// update the Python copy in the same PR.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildDiscordApprovalText, formatApprovalExpiry, neutralDescription } from '../web/approval-discord-core.js'

interface Fixture {
  expiry: { t: number; text: string }[]
  text: { agent_id: string; category: string; description: string; timeout_at: number; code: string; want: string }[]
  neutral: { in: string; want: string }
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'scripts', '__tests__', 'fixtures', 'approval-text.json'), 'utf8'),
) as Fixture

describe('the #33 text fixture shared with root-telepito.py', () => {
  it('has cases at all', () => {
    expect(fixture.expiry.length).toBeGreaterThan(5)
    expect(fixture.text.length).toBeGreaterThan(1)
  })

  it.each(fixture.expiry)('renders the expiry $t as the fixture says', ({ t, text }) => {
    expect(formatApprovalExpiry(t)).toBe(text)
  })

  it.each(fixture.text)('builds the request text for $agent_id as the fixture says', (c) => {
    expect(
      buildDiscordApprovalText(
        { agent_id: c.agent_id, category: c.category, action_description: c.description, timeout_at: c.timeout_at },
        c.code,
        { yes: 'igen', no: 'nem', requireReply: true },
      ),
    ).toBe(c.want)
  })

  it('neutralises a description as the fixture says', () => {
    expect(neutralDescription(fixture.neutral.in)).toBe(fixture.neutral.want)
  })
})
