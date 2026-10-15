// The pane samples shared with the root broker (scripts/__tests__/fixtures/pane-samples.json).
// The broker (scripts/root/fleet-pane.py) carries a Python copy of these pane rules, because its
// gate must not live in code `marveen` can write. A change here that the copy does not follow
// would stall delivery live (the broker refuses what the router thinks is ready): barracuda, #182.
// scripts/__tests__/fleet-pane.test.py runs the SAME rows against the broker.
//
// WHAT TURNS THIS RED: a pane-state.ts change that moves any sample's idle or queued answer.
// Then: update the Python copy in the same PR, and the row here only if the new answer is right.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { idleConsideringDimGhost, liveInputRefusal, queuedPromptRefusal, stripAllAnsi, stripGhostSuggestion } from '../pane-state.js'

const file = join(__dirname, '..', '..', 'scripts', '__tests__', 'fixtures', 'pane-samples.json')
const samples = (JSON.parse(readFileSync(file, 'utf8')) as { samples: Array<{ name: string; pane: string; idle: boolean; queued: boolean }> }).samples

describe('the shared pane samples', () => {
  it('PANE-SHARED: the router\'s pane rules agree with every row the broker is tested on', () => {
    const got = samples.map((s) => {
      const plain = stripAllAnsi(s.pane)
      const dimless = stripGhostSuggestion(s.pane)
      return [s.name, idleConsideringDimGhost(plain, dimless) && liveInputRefusal(plain) === null, queuedPromptRefusal(plain, dimless) === null]
    })
    expect([samples.length >= 15, got]).toEqual([true, samples.map((s) => [s.name, s.idle, s.queued])])
  })
})
