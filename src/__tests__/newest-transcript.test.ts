import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
  THE STARTED BINDING READS THE AGENT'S OWN TRANSCRIPTS (measured 2026-10-24 on the live
  #302: nautilus' own started got "no readable session", because an agent under its own OS
  user writes into agents/<name>/.claude-config, and the transcript finder asked
  resolveAgentConfigDir, which names no such dir). The finder now asks the reader's resolver.
  A sub-agent's transcript lives under <session>/subagents/ and is never the session.
*/
const isolated = mkdtempSync(join(tmpdir(), 'newest-transcript-'))
vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDirForRead: (name: string) => (name === 'iso' ? isolated : null),
}))

const { newestTranscript } = await import('../web/routes/agent-conversation.js')
const { projectsDirFor } = await import('../web/active-model.js')
const { agentDir } = await import('../web/agent-config.js')

afterAll(() => rmSync(isolated, { recursive: true, force: true }))

describe('newestTranscript', () => {
  it("NEWEST-ISOLATED: finds the agent's transcript in its isolated config dir, never a sub-agent's", () => {
    const dir = projectsDirFor(agentDir('iso'), isolated)
    mkdirSync(join(dir, 'sess-a', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'sess-a.jsonl'), '{}\n')
    writeFileSync(join(dir, 'sess-a', 'subagents', 'agent-1.jsonl'), '{}\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'sess-a.jsonl'), old, old)
    expect(newestTranscript('iso')).toBe(join(dir, 'sess-a.jsonl'))
  })
})
