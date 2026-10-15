// The channels.sh guard alert, server-side (task channels-guard-riasztas). On 2026-10-15 the alert
// never arrived: it posted /api/messages with the shared token and from=channels-sh-guard, and the
// route refused it as an unknown agent (messages-post-sender-guards.test.ts GUARD-403).
// WHAT TURNS THIS RED:
//   - scripts/guard-alert.mjs writes a row the message reader does not see, or under another sender;
//   - it takes a bad addressee, an empty text, or a missing database without failing;
//   - channels.sh does not pass the text and the addressee, swallows a failure, or still POSTs the route.
import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPendingMessages, initDatabase } from '../db.js'

const SCRIPT = join(process.cwd(), 'scripts', 'guard-alert.mjs')
const CHANNELS = join(process.cwd(), 'scripts', 'channels.sh')

describe('scripts/guard-alert.mjs', () => {
  it('GUARD-ALERT-ROW: the alert is one pending message from channels-sh-guard to the addressee, as the message reader sees it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-alert-'))
    const db = join(dir, 'test.db')
    initDatabase(db) // the real schema
    const run = (args: string[], input: string, env: Record<string, string> = {}) =>
      spawnSync('node', [SCRIPT, ...args], { input, encoding: 'utf-8', env: { ...process.env, GUARD_ALERT_DB_PATH: db, ...env } })
    const ok = run(['acrobot'], '[GUARD] proba szoveg')
    const pending = getPendingMessages('acrobot')
    const badTo = run(['acro bot'], 'x')
    const empty = run(['acrobot'], '   ')
    const noDb = run(['acrobot'], 'x', { GUARD_ALERT_DB_PATH: join(dir, 'nincs.db') })
    expect([ok.status, /^OK id=\d+$/.test(ok.stdout.trim()), pending.map((m) => [m.from_agent, m.to_agent, m.content, m.status]),
      badTo.status, empty.status, noDb.status, getPendingMessages('acrobot').length], 'GUARD-ALERT-ROW').toEqual([
      0, true, [['channels-sh-guard', 'acrobot', '[GUARD] proba szoveg', 'pending']], 2, 2, 1, 1,
    ])
  })
})

describe('channels.sh guard_alert', () => {
  /** A throwaway install whose guard-alert.mjs records what it got and answers as told. */
  function install(answer: string, code: number) {
    const root = mkdtempSync(join(tmpdir(), 'channels-guard-'))
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(CHANNELS, join(root, 'scripts', 'channels.sh'))
    writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=acrobot\n')
    writeFileSync(join(root, 'scripts', 'guard-alert.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(root, 'got.json'))}, JSON.stringify({ to: process.argv[2], text: readFileSync(0, 'utf-8') }))
process.stdout.write(${JSON.stringify(answer)})
process.exit(${code})
`)
    const r = spawnSync('bash', [join(root, 'scripts', 'channels.sh'), '--guard-alert'], { input: '[GUARD] szoveg ide', encoding: 'utf-8' })
    const log = join(root, 'store', 'channels-failures.log')
    return {
      code: r.status,
      got: existsSync(join(root, 'got.json')) ? JSON.parse(readFileSync(join(root, 'got.json'), 'utf-8')) : null,
      warn: existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('WARN guard alert failed')) : [],
    }
  }

  it('GUARD-ALERT-SH: the text and the main agent go to the helper; OK is quiet, a failure is logged with the helper\'s words', () => {
    const ok = install('OK id=7\n', 0)
    const bad = install('guard-alert: SQLITE_BUSY: database is locked\n', 1)
    expect([ok.code, ok.got, ok.warn.length, bad.code, bad.warn.length, /SQLITE_BUSY: database is locked/.test(bad.warn[0] ?? '')], 'GUARD-ALERT-SH').toEqual([
      0, { to: 'acrobot', text: '[GUARD] szoveg ide' }, 0, 0, 1, true,
    ])
  })

  it('GUARD-ALERT-WIRED: both WARN triggers call guard_alert, and nothing posts the messages route as channels-sh-guard', () => {
    const src = readFileSync(CHANNELS, 'utf-8')
    expect([(src.match(/^ {4}guard_alert "\[GUARD\] /gm) ?? []).length, src.includes('\\"from\\":\\"channels-sh-guard\\"'), src.includes('.channels-guard-http')],
      'GUARD-ALERT-WIRED').toEqual([2, false, false])
  })
})
