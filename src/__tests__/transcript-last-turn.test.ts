import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectsDirFor, readTranscriptLastTurnAtFromProjectDir, readTranscriptMtimeFromProjectDir } from '../web/active-model.js'

// acrobot, 2026-10-17: msg 32305 (12:35) and 32307. The transcript was written while the session
// was idle by lines that carry no time (api-request-blob), so its mtime looked like work.
describe('readTranscriptLastTurnAtFromProjectDir', () => {
  it('TRANSCRIPT-LAST-TURN: the newest user/assistant timestamp, not the mtime and not a timeless or other-type line', () => {
    const config = mkdtempSync(join(tmpdir(), 'last-turn-'))
    const dir = projectsDirFor('/work/x', config)
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 's.jsonl')
    writeFileSync(f, [
      '{"type":"user","timestamp":"2026-10-17T10:13:01.000Z"}',
      '{"type":"assistant","timestamp":"2026-10-17T10:13:39.000Z"}',
      '{"type":"system","subtype":"turn_duration","timestamp":"2026-10-17T10:14:00.000Z"}',
      '{"type":"api-request-blob","hash":"x"}',
      '{"type":"last-prompt","lastPrompt":"p"}',
      '',
    ].join('\n'))
    const idleWrite = new Date('2026-10-17T10:35:19.000Z')
    utimesSync(f, idleWrite, idleWrite)
    const empty = mkdtempSync(join(tmpdir(), 'last-turn-'))
    expect([
      readTranscriptLastTurnAtFromProjectDir('/work/x', config),
      readTranscriptMtimeFromProjectDir('/work/x', config),
      readTranscriptLastTurnAtFromProjectDir('/work/x', empty),
    ], 'TRANSCRIPT-LAST-TURN').toEqual([Date.parse('2026-10-17T10:13:39.000Z'), idleWrite.getTime(), null])
  })
})
