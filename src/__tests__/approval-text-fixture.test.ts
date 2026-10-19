// The #33 Discord text and expiry, as scripts/root/root-telepito.py reproduces them in Python. The root
// installer reads the owner's Discord answer back itself and compares the WHOLE request message letter for
// letter, so its Python copy of buildDiscordApprovalText and formatApprovalExpiry must not drift from this
// code. Both sides check the same fixture: this file holds the TypeScript side to it, root-telepito.test.py
// the Python side. A change here that changes the text turns this red; then regenerate the fixture AND
// update the Python copy in the same PR.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildDiscordApprovalText,
  DESCRIPTION_MAX,
  descriptionMaxFor,
  formatApprovalExpiry,
  neutralDescription,
} from '../web/approval-discord-core.js'

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

  it('allows the installer\'s category a longer description and every other category 500', () => {
    expect([
      descriptionMaxFor('root_telepites'),
      descriptionMaxFor('coolify_deploy'),
      descriptionMaxFor('anything_else'),
      // the category as the message prints it decides, so a look-alike spelling gets no extra room
      descriptionMaxFor('root-telepites!'),
    ]).toEqual([1500, DESCRIPTION_MAX, DESCRIPTION_MAX, DESCRIPTION_MAX])
  })

  it('keeps even the longest allowed request under Discord\'s 2000 characters', () => {
    const text = buildDiscordApprovalText(
      // the longest agent id the dashboard accepts is far shorter than this; the margin is the point
      { agent_id: 'a'.repeat(40), category: 'root_telepites', action_description: 'x '.repeat(2000), timeout_at: 1792375200 },
      'K7MP',
      { yes: 'igen', no: 'nem', requireReply: true },
    )
    expect(text.length).toBeLessThan(2000)
    expect(text.endsWith('...')).toBe(true)
  })

  it('neutralises a description as the fixture says', () => {
    expect(neutralDescription(fixture.neutral.in)).toBe(fixture.neutral.want)
  })
})
