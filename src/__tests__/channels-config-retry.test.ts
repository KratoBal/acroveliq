// channels.sh: the main agent's config resolution retries an empty answer (task kvota-kapu-bemenet).
// 2026-10-15 07:30:44 one boot got an empty answer, fell to the shared ~/.claude (no statusLine, so
// the quota gate went blind; the rotating shared login), and the same helper answered minutes later.
// WHAT TURNS THIS RED:
//   - an install that ran isolated before (.channels-config exists) falls to the shared root on the
//     first empty answer instead of asking again;
//   - a fresh install (no such dir) waits and asks again (every boot would be slower for nothing);
//   - the retries are not said in store/channels-failures.log, or they go on past three answers.
import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHANNELS = join(process.cwd(), 'scripts', 'channels.sh')

/** A throwaway install whose helper answers empty `emptyFirst` times, then with the isolated dir. */
function install(emptyFirst: number, isolatedBefore: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'channels-cfg-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'dist', 'web'), { recursive: true })
  copyFileSync(CHANNELS, join(root, 'scripts', 'channels.sh'))
  writeFileSync(join(root, 'dist', 'web', 'agent-process.js'), '// present\n')
  if (isolatedBefore) mkdirSync(join(root, '.channels-config'))
  writeFileSync(join(root, 'scripts', 'main-agent-isolated-config.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs'
const f = ${JSON.stringify(join(root, 'calls'))}
let n = 0
try { n = Number(readFileSync(f, 'utf-8')) } catch {}
writeFileSync(f, String(n + 1))
if (n >= ${emptyFirst}) process.stdout.write('isolated\\t${join(root, '.channels-config')}\\n')
`)
  const r = spawnSync('bash', [join(root, 'scripts', 'channels.sh'), '--resolve-main-config'], {
    encoding: 'utf-8', env: { ...process.env, CHANNELS_CFG_RETRY_SLEEP: '0', CHANNEL_PROVIDER: 'discord' },
  })
  const log = join(root, 'store', 'channels-failures.log')
  return {
    out: r.stdout.trim(),
    calls: existsSync(join(root, 'calls')) ? Number(readFileSync(join(root, 'calls'), 'utf-8')) : 0,
    retries: existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('came back empty (try')).length : 0,
    isolated: `isolated\t${join(root, '.channels-config')}`,
  }
}

describe('channels.sh main-agent config resolution', () => {
  it('CFG-RETRY: ran isolated before, two empty answers: asked again, the third answer is used, each retry said', () => {
    const r = install(2, true)
    expect([r.out, r.calls, r.retries], 'CFG-RETRY').toEqual([r.isolated, 3, 2])
  })

  it('CFG-RETRY-GIVES-UP: always empty: three answers at most, then empty (the boot warns and goes on as before)', () => {
    const r = install(99, true)
    expect([r.out, r.calls, r.retries], 'CFG-RETRY-GIVES-UP').toEqual(['', 3, 2])
  })

  it('CFG-FRESH: a fresh install (no .channels-config) is asked once: empty is its normal answer', () => {
    const r = install(99, false)
    expect([r.out, r.calls, r.retries], 'CFG-FRESH').toEqual(['', 1, 0])
  })

  it('CFG-FIRST: an answer at once is used at once', () => {
    const r = install(0, true)
    expect([r.out, r.calls, r.retries], 'CFG-FIRST').toEqual([r.isolated, 1, 0])
  })
})
