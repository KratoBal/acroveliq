import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { summarizeB29 } from '../web/b29-arnyek.js'
import { B29_SHADOW_CMD, ensureB29ShadowHook, setB29ShadowHook } from '../web/agent-scaffold.js'

/*
  THE B29 SHADOW HOOK (task b29-arnyek-hook). What turns these red: the hook printing anything or
  exiting non-zero (it would block or talk to the main agent), a verdict that does not follow the
  fo-agens profile, the whole command or a secret landing in the log, the switch not wiring or not
  removing the entry, or the wiring reaching any agent but the main one.
*/

const HOOK = join(PROJECT_ROOT, 'scripts', 'hooks', 'b29-arnyek.py')
const HOME = '/home/marveen'
let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function run(event: unknown, raw?: string) {
  dir = dir || mkdtempSync(join(tmpdir(), 'b29-arnyek-'))
  const r = spawnSync('python3', [HOOK], {
    input: raw ?? JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, B29_ARNYEK_DIR: dir, HOME },
  })
  const files = readdirSync(dir)
  const lines = files.length ? readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').filter(Boolean) : []
  return { code: r.status, stdout: r.stdout, records: lines.map((l) => JSON.parse(l)), rawLog: lines.join('\n') }
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: `${HOME}/marveen` })

describe('b29-arnyek.py: never blocks, never talks', () => {
  it('prints nothing and exits 0, also on broken input', () => {
    for (const r of [run(bash('cat /etc/passwd')), run(null, 'not json')]) {
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
})

describe('b29-arnyek.py: the verdict follows the fo-agens profile (an estimate)', () => {
  it.each([
    ['bash /home/marveen/marveen/scripts/agent-msg.sh acrobot nautilus - < uzenet.txt', 'allow'],
    ['bash scripts/local-now.sh full && bash scripts/fleet-api.sh kanban-list', 'allow'],
    ['cat /etc/hosts', 'deny'],
    ['cd /home/marveen/marveen && git status', 'deny'],
    ['python3 -c "print(1)"', 'deny'],
    ['echo $HOME', 'ask'],
    ['ls -la > lista.txt', 'ask'],
    ['sedx --help', 'ask'],
    ['bash scripts/nincs-ilyen.sh', 'ask'],
  ])('%s -> %s', (command, verdict) => {
    expect(run(bash(command)).records[0].verdict).toBe(verdict)
  })

  it('file tools: the secret paths denied, the tree readable, writes only where allowed', () => {
    const v = (tool_name: string, file_path: string) => run({ tool_name, tool_input: { file_path }, cwd: `${HOME}/marveen` }).records.at(-1).verdict
    expect(v('Read', `${HOME}/marveen/store/.dashboard-token`)).toBe('deny')
    expect(v('Read', `${HOME}/marveen/CLAUDE.md`)).toBe('allow')
    expect(v('Edit', `${HOME}/marveen/src/web.ts`)).toBe('ask')
    expect(v('Write', `${HOME}/marveen/exchange/jegyzet.md`)).toBe('allow')
  })

  it('other tools: by name', () => {
    const v = (tool_name: string) => run({ tool_name, tool_input: {}, cwd: '/' }).records.at(-1).verdict
    expect(v('WebFetch')).toBe('deny')
    expect(v('mcp__plugin_discord_discord__reply')).toBe('allow')
    expect(v('TodoWrite')).toBe('allow')
    expect(v('SomethingNew')).toBe('ask')
  })
})

describe('b29-arnyek.py: the log never holds the command', () => {
  it('keeps two words, the length and a hash; a secret-shaped command keeps not even the words', () => {
    const plain = run(bash('bash scripts/nincs-ilyen.sh --kapcsolo titkos-ertek-nelkul'))
    expect(plain.records[0]).toMatchObject({ tool: 'Bash', verdict: 'ask', head: 'bash scripts/nincs-ilyen.sh' })
    expect(plain.rawLog).not.toContain('titkos-ertek-nelkul')
    const secret = 'ghp_' + 'a'.repeat(36)
    const r = run(bash(`curl -H "Authorization: token ${secret}" https://api.github.com`))
    expect(r.rawLog).not.toContain(secret)
    expect(r.records.at(-1).head).toBe('[titok-minta]')
  })
})

describe('the switch (B29_ARNYEK_HOOK=1) wires and removes one entry, main agent only', () => {
  it('on adds a PreToolUse entry for every tool, idempotently, keeping the others; off removes it', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 other.py' }] }
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    expect(setB29ShadowHook(s, true)).toBe(true)
    expect(setB29ShadowHook(s, true)).toBe(false)
    const ptu = (s.hooks as { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }).PreToolUse
    expect(ptu).toHaveLength(2)
    expect(ptu[1]).toMatchObject({ matcher: '*', hooks: [{ command: B29_SHADOW_CMD }] })
    expect(setB29ShadowHook(s, false)).toBe(true)
    expect((s.hooks as { PreToolUse: unknown[] }).PreToolUse).toEqual([other])
    expect(setB29ShadowHook(s, false)).toBe(false)
  })

  it('never wires a sub-agent', () => {
    expect(ensureB29ShadowHook('nautilus', true)).toBe(false)
    expect(MAIN_AGENT_ID).not.toBe('nautilus')
  })
})

describe('summarizeB29: the daily counts for the dashboard', () => {
  it('counts the verdicts per day and lists what asked most', () => {
    dir = mkdtempSync(join(tmpdir(), 'b29-sum-'))
    const recs = [
      { tool: 'Bash', verdict: 'allow' },
      { tool: 'Bash', verdict: 'ask', head: 'echo $HOME' },
      { tool: 'Bash', verdict: 'ask', head: 'echo $HOME' },
      { tool: 'Edit', verdict: 'ask', reason: 'nincs szabaly erre az utra' },
      { tool: 'Bash', verdict: 'deny', head: 'cat x' },
    ]
    writeFileSync(join(dir, '2026-10-19.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n')
    const [d] = summarizeB29(dir, 7)
    expect(d).toMatchObject({ day: '2026-10-19', total: 5, allow: 1, ask: 3, deny: 1 })
    expect(d.topAsk[0]).toEqual({ key: 'Bash echo $HOME', count: 2 })
  })
})
