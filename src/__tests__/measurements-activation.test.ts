import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { agentForProjectEntry, discoverAgentSources } from '../web/token-usage.js'
import { injectMeasureStatusLine, measureStatusLineCommand } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

const TMP = join(tmpdir(), `measure-activation-${process.pid}`)
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'measure-statusline.py')

beforeAll(() => mkdirSync(TMP, { recursive: true }))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('collector sources', () => {
  const main = '-home-x-marveen'
  const worker = ['-home-x--acrobot-worker']

  it('maps the worker dir and its -fast sibling to the worker agent', () => {
    expect(agentForProjectEntry('-home-x--acrobot-worker', main, worker)).toBe(`${MAIN_AGENT_ID}-worker`)
    expect(agentForProjectEntry('-home-x--acrobot-worker-fast', main, worker)).toBe(`${MAIN_AGENT_ID}-worker`)
    expect(agentForProjectEntry(main, main, worker)).toBe(MAIN_AGENT_ID)
    expect(agentForProjectEntry('-home-x-marveen-agents-murena', main, worker)).toBe('murena')
    // a scratchpad project dir belongs to nobody
    expect(agentForProjectEntry('-tmp-claude-1000--home-x-scratchpad', main, worker)).toBeNull()
  })

  it('scans the worker projects root once when it is a symlink to the main root, and adds export dirs', () => {
    const root = join(TMP, 'projects')
    const whome = join(TMP, 'wh')
    mkdirSync(join(root, '-home-x-marveen'), { recursive: true })
    mkdirSync(join(root, `${whome.replace(/[^a-zA-Z0-9-]/g, '-')}`), { recursive: true })
    mkdirSync(join(whome, '.claude-config'), { recursive: true })
    symlinkSync(root, join(whome, '.claude-config', 'projects'))
    const exp = join(TMP, 'usage')
    mkdirSync(join(exp, 'murena'), { recursive: true })
    writeFileSync(join(exp, '.stray'), '')
    const s = discoverAgentSources({ roots: [root, join(whome, '.claude-config', 'projects')], exportDir: exp, workerHomes: [whome], projectRoot: '/home/x/marveen' })
    const agents = s.map(x => x.agent).sort()
    expect(agents).toEqual([MAIN_AGENT_ID, `${MAIN_AGENT_ID}-worker`, 'murena'].sort())
  })
})

describe('sub-agent statusLine injection', () => {
  it('adds the exporter to a settings object without one, idempotently', () => {
    const s: Record<string, unknown> = {}
    expect(injectMeasureStatusLine(s, 'murena', true)).toBe(true)
    expect((s.statusLine as { command: string }).command).toBe(measureStatusLineCommand('murena', true))
    expect((s.statusLine as { command: string }).command).toContain('MEASURE_AGENT=murena')
    expect((s.statusLine as { command: string }).command).toContain('--export-usage')
    expect(injectMeasureStatusLine(s, 'murena', true)).toBe(false)
  })
  it('never overwrites a statusLine someone set on purpose', () => {
    const s: Record<string, unknown> = { statusLine: { type: 'command', command: 'my-own-line.sh' } }
    expect(injectMeasureStatusLine(s, 'murena', true)).toBe(false)
    expect((s.statusLine as { command: string }).command).toBe('my-own-line.sh')
  })
})

// End-to-end through the real script: statusline JSON on stdin, a transcript
// with text, thinking and a tool call; the export must carry the numbers and
// nothing else, and the quota log must get one sample.
describe('measure-statusline.py --export-usage', () => {
  it('exports numbers only, backfills sibling transcripts, and samples quota', async () => {
    const proj = join(TMP, 'agentproj')
    mkdirSync(join(proj, 'sess1', 'subagents'), { recursive: true })
    const SECRET = 'PROMPT-TEXT-THAT-MUST-NOT-LEAK'
    const t1 = [
      JSON.stringify({ type: 'user', sessionId: 'sess1', timestamp: '2026-09-27T15:00:00Z', message: { content: SECRET } }),
      JSON.stringify({ type: 'assistant', sessionId: 'sess1', timestamp: '2026-09-27T15:00:05Z',
        message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 120, cache_read_input_tokens: 5000, cache_creation_input_tokens: 40 },
          content: [{ type: 'thinking', thinking: 'x'.repeat(40) }, { type: 'text', text: SECRET }, { type: 'tool_use', name: 'Bash', input: { command: SECRET } }] } }),
    ].join('\n') + '\n' + '{"type":"assistant","torn'
    writeFileSync(join(proj, 'sess1.jsonl'), t1)
    writeFileSync(join(proj, 'sess1', 'subagents', 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'sess1', timestamp: '2026-09-26T10:00:00Z',
      message: { id: 'msg_2', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 7 }, content: [] } }) + '\n')

    const mdir = join(TMP, 'measurements')
    const input = JSON.stringify({ model: { id: 'claude-opus-5-5' }, transcript_path: join(proj, 'sess1.jsonl'),
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790534400 }, seven_day: { used_percentage: 90, resets_at: 1790578800 } } })
    const r = spawnSync('python3', [SCRIPT, '--export-usage'], { input, encoding: 'utf-8',
      env: { ...process.env, MEASURE_AGENT: 'murena', MEASURE_DIR: mdir, MEASURE_QUOTA_FILE: join(mdir, 'quota-samples.jsonl'), MEASURE_USAGE_DIR: join(mdir, 'usage'),
        // Never the live store/: run as the router user it would plant a fake 90% for the quota gate.
        MEASURE_GATE_FILE: join(TMP, 'quota-gate-sample.json') } })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('claude-opus-5-5 | 5h 12% | 7d 90%')

    // The exporter is detached; wait for its cursor file.
    const cursors = join(mdir, 'usage', 'murena', '.cursors.json')
    for (let i = 0; i < 50 && !existsSync(cursors); i++) await new Promise(res => setTimeout(res, 100))
    expect(existsSync(cursors)).toBe(true)

    const main = readFileSync(join(mdir, 'usage', 'murena', 'sess1.jsonl'), 'utf-8')
    const sub = readFileSync(join(mdir, 'usage', 'murena', 'sess1__subagents__agent-a.jsonl'), 'utf-8')
    expect(main + sub).not.toContain(SECRET)
    const lines = main.trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)                       // user line skipped, torn line not yet
    expect(lines[0].message.usage).toEqual({ input_tokens: 3, output_tokens: 120, cache_read_input_tokens: 5000, cache_creation_input_tokens: 40 })
    expect(lines[0].message.content).toEqual([{ type: 'tool_use', name: 'Bash' }])
    expect(lines[0].message.thinking_tokens_est).toBe(10)
    expect(lines[0].sessionId).toBe('sess1')
    expect(JSON.parse(sub.trim()).message.model).toBe('claude-sonnet-5')
    expect(statSync(join(mdir, 'usage', 'murena', 'sess1.jsonl')).mode & 0o777).toBe(0o640)

    const q = readFileSync(join(mdir, 'quota-samples.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ agent: 'murena', five_hour_pct: 12, seven_day_pct: 90 })
    expect(statSync(join(mdir, 'quota-samples.jsonl')).mode & 0o777).toBe(0o664)
  })
})

// Worker provisioning: the measurement statusLine is part of ensureWorkerCwd,
// so a fresh install / fresh worker gets it without a hand edit. Run in an
// isolated HOME so nothing touches the live ~/.claude or worker dirs.
describe('worker provisioning installs the measurement statusLine', () => {
  const run = async (prep?: (settingsPath: string) => void) => {
    const fakeHome = join(TMP, `home-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    const prevHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const { ensureWorkerCwd, makeWorkerCtx } = await import('../web/agent-worker.js')
      const ctx = makeWorkerCtx('test-worker', join(fakeHome, `.${MAIN_AGENT_ID}-worker`))
      const settingsPath = join(ctx.configDir, 'settings.json')
      if (prep) { mkdirSync(ctx.configDir, { recursive: true }); prep(settingsPath) }
      ensureWorkerCwd(ctx)
      const first = readFileSync(settingsPath, 'utf-8')
      ensureWorkerCwd(ctx)
      const second = readFileSync(settingsPath, 'utf-8')
      return { first: JSON.parse(first), idempotent: first === second }
    } finally {
      process.env.HOME = prevHome
    }
  }

  it('a fresh worker config gets the sampler tagged <main>-worker, without --export-usage', async () => {
    const { first, idempotent } = await run()
    expect(first.statusLine).toEqual({ type: 'command', command: measureStatusLineCommand(`${MAIN_AGENT_ID}-worker`, false), padding: 0 })
    expect(first.statusLine.command).not.toContain('--export-usage')
    expect(first.statusLine.command).toContain('exit 0')          // fail-open
    expect(first.skipDangerousModePermissionPrompt).toBe(true)     // existing provisioning kept
    expect(idempotent).toBe(true)
  })

  it('keeps a statusLine someone set on purpose', async () => {
    const own = { type: 'command', command: 'my-own-bar.sh' }
    const { first } = await run((p) => writeFileSync(p, JSON.stringify({ statusLine: own })))
    expect(first.statusLine).toEqual(own)
  })

  it('upgrades an older measurement statusLine in place (the hand-set one)', async () => {
    const old = { type: 'command', command: 'python3 /x/scripts/measure-statusline.py' }
    const { first } = await run((p) => writeFileSync(p, JSON.stringify({ statusLine: old, model: 'keep-me' })))
    expect(first.statusLine.command).toBe(measureStatusLineCommand(`${MAIN_AGENT_ID}-worker`, false))
    expect(first.model).toBe('keep-me')                            // no other key touched
  })
})
