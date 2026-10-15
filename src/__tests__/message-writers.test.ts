// Every writer of a message row stores the cleaned text (barracuda, #177 review: two wrote
// around createAgentMessage). WHAT TURNS THIS RED:
//   - an insert into agent_messages in src/ or scripts/ outside the three known writers, or one
//     of them without a cleanMessageText call (a new writer must clean, or go through
//     createAgentMessage). Any case, `INSERT OR IGNORE|REPLACE`, a quoted table name;
//   - any UPDATE of agent_messages that sets `content` (none today; barracuda, #177 review);
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

// barracuda, #177 review: the exact `INSERT INTO agent_messages` missed `INSERT OR IGNORE`, a
// lower-case insert and a quoted table name, and an UPDATE of the content was not watched at all
const INSERT_RX = /insert\s+(?:or\s+\w+\s+)?into\s+["`\[]?agent_messages\b/i
// the SET list within one statement: no `;`, and at most 300 characters, so it cannot run on into
// unrelated code that happens to assign a `content`
const UPDATE_CONTENT_RX = /update\s+["`\[]?agent_messages["`\]]?\s+set\b[^;]{0,300}?\bcontent\s*=/i

describe('the writers of agent_messages', () => {
  it('MSG-WRITERS: only the three known writers insert a message row, and each cleans the text', () => {
    const writers = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((f) => INSERT_RX.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(ROOT, f))
      .sort()
    const cleaning = writers.map((f) => /cleanMessageText\(/.test(readFileSync(join(ROOT, f), 'utf-8')))
    expect([writers, cleaning], 'MSG-WRITERS').toEqual([
      ['scripts/guard-alert.mjs', 'src/channel-coordinator/ingest.ts', 'src/db.ts'],
      [true, true, true],
    ])
  })

  it('MSG-WRITERS-PATTERNS: the watch sees every spelling of an insert, and an UPDATE of the content', () => {
    const inserts = [
      'INSERT INTO agent_messages (a) VALUES (?)',
      'insert into agent_messages (a)',
      'INSERT OR IGNORE INTO agent_messages (a)',
      'INSERT OR REPLACE INTO "agent_messages" (a)',
      'INSERT\n  INTO `agent_messages`',
    ]
    const notInserts = ['INSERT INTO agent_messages_archive (a)', 'SELECT * FROM agent_messages']
    const updates = ["UPDATE agent_messages SET content = ? WHERE id = ?", "update \"agent_messages\"\n SET status = 'x', content = ?"]
    const notUpdates = ["UPDATE agent_messages SET status = 'done', result = ? WHERE id = ?"]
    const contentWriters = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((f) => UPDATE_CONTENT_RX.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(ROOT, f))
    expect([
      inserts.map((t) => INSERT_RX.test(t)), notInserts.map((t) => INSERT_RX.test(t)),
      updates.map((t) => UPDATE_CONTENT_RX.test(t)), notUpdates.map((t) => UPDATE_CONTENT_RX.test(t)),
      contentWriters,
    ], 'MSG-WRITERS-PATTERNS').toEqual([[true, true, true, true, true], [false, false], [true, true], [false], []])
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
