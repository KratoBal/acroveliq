// B1 (task b1-bootstrap-jelzes): a failed fleet-bootstrap at container start becomes ONE urgent card.
// WHAT TURNS THIS RED: a HIBA line that opens no card, a card opened twice for the same start, a card
// for RENDBEN, a missing or malformed file that throws or opens a card, a card that carries a non-problem
// output line, or a problem line longer than the cap.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', () => ({ createKanbanCard: vi.fn() }))

import { checkBootstrapStatus, STATUS_FILE, REPORTED_FILE, type BootstrapSignalDeps } from '../web/bootstrap-signal.js'

function deps(files: Record<string, string>) {
  const cards: Parameters<BootstrapSignalDeps['createCard']>[0][] = []
  const d: BootstrapSignalDeps = {
    read: (p) => (p in files ? files[p]! : null),
    write: (p, t) => {
      files[p] = t
    },
    createCard: (c) => {
      cards.push(c)
    },
    newId: () => `id${cards.length + 1}`,
  }
  return { d, cards, files }
}

const HIBA = [
  '1792140000 HIBA',
  '== 4c. the fleet-pane broker',
  'ok: scripts/root/fleet-pane.py is the pinned version',
  'MISMATCH: scripts/root/fleet-github.py sha256 abc, pinned def: not installing it',
  'MISSING: agent-murena cannot be reached with tmux',
  'FLEET-PANE: step 4c reported a problem above',
  'CHECK FAILED, see the lines above.',
].join('\n')

describe('checkBootstrapStatus', () => {
  it('a HIBA opens one urgent card for the main agent, with the problem lines only', () => {
    const { d, cards, files } = deps({ [STATUS_FILE]: HIBA })
    expect(checkBootstrapStatus(d)).toBe('card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.priority).toBe('urgent')
    expect(cards[0]!.status).toBe('planned')
    expect(cards[0]!.title).toContain('fleet-bootstrap')
    expect(cards[0]!.description).toContain('- MISMATCH: scripts/root/fleet-github.py')
    expect(cards[0]!.description).toContain('- MISSING: agent-murena cannot be reached with tmux')
    expect(cards[0]!.description).toContain('- CHECK FAILED, see the lines above.')
    expect(cards[0]!.description).not.toContain('ok: scripts/root/fleet-pane.py')
    expect(cards[0]!.description).not.toContain('== 4c.')
    expect(files[REPORTED_FILE]).toBe('1792140000\n')
  })

  it('the same start is reported once, a later HIBA again', () => {
    const { d, cards, files } = deps({ [STATUS_FILE]: HIBA })
    checkBootstrapStatus(d)
    expect(checkBootstrapStatus(d)).toBe('already-reported')
    expect(cards).toHaveLength(1)
    files[STATUS_FILE] = HIBA.replace('1792140000', '1792150000')
    expect(checkBootstrapStatus(d)).toBe('card')
    expect(cards).toHaveLength(2)
  })

  it('RENDBEN, no file and an unreadable first line open nothing and do not throw', () => {
    for (const [files, want] of [
      [{ [STATUS_FILE]: '1792140000 RENDBEN\nok: all\n' }, 'ok'],
      [{}, 'no-file'],
      [{ [STATUS_FILE]: 'HIBA 1792140000\n' }, 'unreadable'],
      [{ [STATUS_FILE]: '' }, 'unreadable'],
    ] as const) {
      const { d, cards } = deps({ ...files })
      expect(checkBootstrapStatus(d)).toBe(want)
      expect(cards).toHaveLength(0)
    }
  })

  it('caps the number and the length of the problem lines', () => {
    const many = ['1792140000 HIBA', ...Array.from({ length: 50 }, (_, i) => `MISSING: x${i} ${'y'.repeat(400)}`)].join('\n')
    const { d, cards } = deps({ [STATUS_FILE]: many })
    checkBootstrapStatus(d)
    const items = cards[0]!.description.split('\n').filter((l) => l.startsWith('- '))
    expect(items).toHaveLength(30)
    expect(Math.max(...items.map((l) => l.length))).toBeLessThanOrEqual(2 + 300 + 1)
  })

  it('a card that cannot be created does not throw and is not marked reported', () => {
    const { d, files } = deps({ [STATUS_FILE]: HIBA })
    d.createCard = () => {
      throw new Error('db locked')
    }
    expect(checkBootstrapStatus(d)).toBe('unreadable')
    expect(files[REPORTED_FILE]).toBeUndefined()
  })
})
