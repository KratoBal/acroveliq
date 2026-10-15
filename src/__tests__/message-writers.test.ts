// Every writer of a message row stores the cleaned text (barracuda, #177 review: two wrote
// around createAgentMessage). WHAT TURNS THIS RED:
//   - an `INSERT INTO agent_messages` in src/ or scripts/ outside the three known writers, or one
//     of them without a cleanMessageText call (a new writer must clean, or go through
//     createAgentMessage);
//   - the copy in scripts/guard-alert.mjs drifting from src/prompt-safety.ts;
//   - the channel handoff, the guard alert or an agent's written-back result stored raw.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createAgentMessage, getAgentMessage, getPendingMessages, initDatabase, markMessageDone } from '../db.js'
import { createHandoffMessage, initIngestDb } from '../channel-coordinator/ingest.js'

const ROOT = process.cwd()
const RAW = 'a@SEP1b@SEP2c@CR@LFd@ESC[0me'
const CLEAN = 'a@LFb@LFc@LFd [0me'
const dec = (s: string) => s.replace(/@SEP1/g, '\u2028').replace(/@SEP2/g, '\u2029').replace(/@CR/g, '\r').replace(/@LF/g, '\n').replace(/@ESC/g, '\x1b')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(ts|mjs|js|py|sh)$/.test(name)) out.push(p)
  }
  return out
}

describe('the writers of agent_messages', () => {
  it('MSG-WRITERS: only the three known writers insert a message row, and each cleans the text', () => {
    const writers = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((f) => /INSERT INTO agent_messages/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(ROOT, f))
      .sort()
    const cleaning = writers.map((f) => /cleanMessageText\(/.test(readFileSync(join(ROOT, f), 'utf-8')))
    expect([writers, cleaning], 'MSG-WRITERS').toEqual([
      ['scripts/guard-alert.mjs', 'src/channel-coordinator/ingest.ts', 'src/db.ts'],
      [true, true, true],
    ])
  })

  it('MSG-WRITERS-COPY: the guard alert\'s copy of cleanMessageText is the same two replacements', () => {
    const regexes = (file: string) => [...readFileSync(join(ROOT, file), 'utf-8').matchAll(/\.replace\((\/[^/]+\/g), '([^']*)'\)/g)]
      .map((m) => `${m[1]} -> ${m[2]}`)
    const fromTs = regexes('src/prompt-safety.ts').filter((r) => r.includes('u2028') || r.includes('x86-'))
    expect(regexes('scripts/guard-alert.mjs'), 'MSG-WRITERS-COPY').toEqual(fromTs)
    expect(fromTs.length, 'both replacements found in prompt-safety.ts').toBe(2)
  })

  it('MSG-WRITERS-STORED: the channel handoff, the guard alert and a written-back result are stored cleaned', () => {
    const ingest = initIngestDb(':memory:')
    const handoffId = createHandoffMessage(dec(RAW))
    const handoff = (ingest.prepare('SELECT content FROM agent_messages WHERE id = ?').get(handoffId) as { content: string } | undefined)?.content

    const dir = mkdtempSync(join(tmpdir(), 'msg-writers-'))
    const dbFile = join(dir, 'test.db')
    initDatabase(dbFile)
    const alert = spawnSync('node', [join(ROOT, 'scripts', 'guard-alert.mjs'), 'acrobot'], {
      input: dec(RAW), encoding: 'utf-8', env: { ...process.env, GUARD_ALERT_DB_PATH: dbFile },
    })
    const stored = getPendingMessages('acrobot').map((m) => m.content)

    const msg = createAgentMessage('barracuda', 'nautilus', 'kerdes')
    markMessageDone(msg.id, dec(RAW))
    const result = getAgentMessage(msg.id)?.result

    expect([handoff, alert.status, stored, result], 'MSG-WRITERS-STORED').toEqual([dec(CLEAN), 0, [dec(CLEAN)], dec(CLEAN)])
  })
})
