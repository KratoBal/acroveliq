// scripts/futtat.py, the structured command runner (acrovelIQ token brief,
// item 2), run for real in a temp log root. WHAT TURNS THIS RED:
//   - a planted secret or a secret-shaped value reaches the log or the summary;
//   - a false positive (an e-mail in a test name) spoils the excerpt, or a git
//     sha is taken for a secret;
//   - the summary loses a failed test, its first error, an error location, the
//     diff statistics, the exit code, the log path or the omitted-line count;
//   - a failure comes without its first error line and the lines before it;
//   - the log cannot be read back by range or by search;
//   - a log is readable beyond its owner and the project group;
//   - an old log survives retention, or the summary is deleted with it;
//   - a run goes on, or writes a log, without its required hash list; the
//     switch that lets it go on is taken by any value but "1", or is silent.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'

const SCRIPT = join(process.cwd(), 'scripts', 'futtat.py')

/*
  SECRET-SHAPED TEST VALUES ARE BUILT AT RUN TIME. The repo's secret gate
  (scripts/secret-gate.ts) scans the source and must not see a token shape
  here: no exception, no looser pattern. Joined from pieces, the source holds
  no such shape, while the runner's filter sees the whole value when it runs.
  All values are invented.
*/
const GITHUB_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
const STRIPE_KEY = ['sk', 'live', 'abcdefghijklmnop1234'].join('_')
const STRIPE_WEBHOOK = ['whsec', 'abcdefghijklmnop1234'].join('_')
const GOOGLE_KEY = ['AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')
const KEY_BEGIN = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
const KEY_END = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
const root = mkdtempSync(join(tmpdir(), 'futtat-'))
let env: NodeJS.ProcessEnv

beforeEach(() => {
  const dir = mkdtempSync(join(root, 'case-'))
  env = { ...process.env, FUTTAT_LOG_ROOT: join(dir, 'logs'), FUTTAT_SECRET_HASHES: join(dir, 'hashes.txt'), FUTTAT_GROUP: 'nincs-ilyen-csoport' }
  delete env.FUTTAT_LENYOMAT_NEM_KOTELEZO
  writeFileSync(env.FUTTAT_SECRET_HASHES!, '') // the list is required: an empty one is a list
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Runs `futtat.py run` on a shell snippet; returns the summary, the code and the log. */
function run(script: string, extra: string[] = []) {
  const result = spawnSync('python3', [SCRIPT, 'run', '--feladat', 'proba', ...extra, '--', 'bash', '-c', script], { env, encoding: 'utf-8' })
  const taskDir = join(env.FUTTAT_LOG_ROOT!, 'acropora', 'proba')
  const logs = readdirSync(taskDir).filter((f) => f.endsWith('.log')).sort()
  const log = join(taskDir, logs.at(-1)!)
  return { code: result.status, out: result.stdout, log, text: readFileSync(log, 'utf-8'), summary: JSON.parse(readFileSync(log.replace(/\.log$/, '.summary.json'), 'utf-8')) }
}

const TAP = [
  'TAP version 13',
  '# Subtest: osszeg',
  'ok 1 - osszeg',
  '# Subtest: CONTRACT-X: a rossz',
  'not ok 2 - CONTRACT-X: a rossz',
  '  ---',
  '  error: |-',
  '    Expected values to be strictly deep-equal:',
  '  ...',
  '# tests 2',
  '# fail 1',
].map((l) => `echo '${l}'`).join('; ')

describe('futtat: masking', () => {
  it('FUTTAT-SECRET: a planted secret and secret-shaped values never reach the log or the summary; the excerpt survives a false positive', () => {
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'beultetett-tesztitok-42\n' })
    const sha = '3cf56e7a1b2c3d4e5f60718293a4b5c6d7e8f901'
    const r = run([
      `echo 'not ok 1 - kuldes a balazs@example.com cimre'`,
      `echo '  error: kulcs beultetett-tesztitok-42 es ${GITHUB_TOKEN}'`,
      `echo 'DATABASE_URL=postgresql://app:jelszo123@db.local:5432/x token=abcdef123456'`,
      `echo 'commit ${sha}'`,
      `echo '# fail 1'`,
      'exit 1',
    ].join('; '), ['--fajta', 'test'])
    const everything = r.text + r.out + JSON.stringify(r.summary)
    expect([
      ['beultetett-tesztitok-42', GITHUB_TOKEN, 'jelszo123', 'abcdef123456', 'balazs@example.com'].filter((s) => everything.includes(s)),
      r.text.includes(sha),
      r.summary.cserek,
      r.text.split('\n')[1]!.includes(`cserek=${r.summary.cserek}`),
      r.summary.kivonat[0],
      readFileSync(env.FUTTAT_SECRET_HASHES!, 'utf-8').includes('beultetett'),
    ], 'FUTTAT-SECRET').toEqual([
      [],
      true,
      10, // five in the output, and the same five in the masked command line of the header
      true,
      'BUKOTT: kuldes a [EMAIL] cimre\n    error: kulcs [TITOK] es [TITOK]',
      false,
    ])
  })

  it('FUTTAT-PERSONAL: phone, tax number and IBAN are masked', () => {
    const r = run(`echo 'tel +36 30 123 4567, adoszam 12345678-2-42, iban HU42 1177 3016 1111 1018 0000 0000'`)
    expect(r.text.split('\n').at(-2), 'FUTTAT-PERSONAL').toBe('tel [TELEFON], adoszam [ADOSZAM], iban [IBAN]')
  })

  // barracuda, #17
  it('FUTTAT-PEM: a multi-line private key is masked from its BEGIN line to its END line', () => {
    const r = run([
      `echo 'elotte'`,
      `echo '${KEY_BEGIN}'`,
      `echo 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'`,
      `echo 'QyNTUxOQAAACBkaXRhbGFsdC1rdWxjcy1jc2FrLXRlc3p0aGV6LWtpdGFsYWx0AAAA'`,
      `echo '${KEY_END}'`,
      `echo 'utana'`,
    ].join('; '))
    expect(r.text.split('\n').slice(2, 8), 'FUTTAT-PEM').toEqual(['elotte', '[TITOK]', '[TITOK]', '[TITOK]', '[TITOK]', 'utana'])
  })

  it('FUTTAT-KEYVALUE: environment-variable, YAML and JSON key forms, Stripe, Google and Basic credentials', () => {
    const r = run([
      `echo 'DASHBOARD_TOKEN=abc123def456ghi'`,
      `echo 'DB_PASSWORD: "jelszo-hosszu-1"'`,
      `echo '{"stripe_secret": "titok-ertek-99"}'`,
      `echo 'kulcs ${STRIPE_KEY} es ${STRIPE_WEBHOOK}'`,
      `echo 'google ${GOOGLE_KEY}'`,
      `echo 'Authorization: Basic dXNlcjpqZWxzem8xMjM0NTY='`,
      `echo 'input_tokens: 123456 marad'`,
    ].join('; '))
    expect(r.text.split('\n').slice(2, 9), 'FUTTAT-KEYVALUE').toEqual([
      'DASHBOARD_TOKEN=[TITOK]',
      'DB_PASSWORD: "[TITOK]"',
      '{"stripe_secret": "[TITOK]"}',
      'kulcs [TITOK] es [TITOK]',
      'google [TITOK]',
      'Authorization: Basic [TITOK]',
      'input_tokens: 123456 marad',
    ])
  })

  it('FUTTAT-HASH-SPANS: a known secret with a colon, with base64 padding, or glued into a path is still found', () => {
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: '123456789:ABCdefGhIJKlmnoPQRstu\nYWJjZGVmZ2hpams==\n' })
    const r = run([
      `echo 'POST /bot123456789:ABCdefGhIJKlmnoPQRstu/sendMessage'`,
      `echo 'TELEGRAM_KEY=YWJjZGVmZ2hpams=='`,
    ].join('; '))
    expect(r.text.split('\n').slice(2, 4), 'FUTTAT-HASH-SPANS').toEqual(['POST /bot[TITOK]/sendMessage', 'TELEGRAM_KEY=[TITOK]'])
  })

  // Balázs, 2026-10-12: no run with reduced protection
  it('FUTTAT-HASHLIST-REQUIRED: a missing or unreadable list stops the run before the command runs or a log is written', () => {
    const marker = join(env.FUTTAT_LOG_ROOT!, '..', 'futott')
    const attempt = (extra: NodeJS.ProcessEnv = {}) => {
      const r = spawnSync('python3', [SCRIPT, 'run', '--feladat', 'proba', '--', 'bash', '-c', `touch '${marker}'`], { env: { ...env, ...extra }, encoding: 'utf-8' })
      return [r.status, r.stderr.includes('nem fut csökkentett védelemmel'), existsSync(marker), existsSync(env.FUTTAT_LOG_ROOT!)]
    }
    const stopped = [3, true, false, false]
    rmSync(env.FUTTAT_SECRET_HASHES!)
    const missing = attempt()
    const switchNotOne = attempt({ FUTTAT_LENYOMAT_NEM_KOTELEZO: '0' })
    const results = [missing, switchNotOne]
    if (userInfo().uid !== 0) {
      // root reads a 000 file
      writeFileSync(env.FUTTAT_SECRET_HASHES!, 'abc 12\n')
      chmodSync(env.FUTTAT_SECRET_HASHES!, 0o000)
      results.push(attempt())
      chmodSync(env.FUTTAT_SECRET_HASHES!, 0o600)
    }
    expect(results, 'FUTTAT-HASHLIST-REQUIRED').toEqual(results.map(() => stopped))
  })

  it('FUTTAT-HASHLIST-OPTIONAL: with the switch on, the run goes on with the patterns and says so on screen, in the log and in the summary', () => {
    env.FUTTAT_LENYOMAT_NEM_KOTELEZO = '1'
    rmSync(env.FUTTAT_SECRET_HASHES!)
    const r = run(`echo 'kulcs ${GITHUB_TOKEN}'; exit 5`)
    const shown = [
      r.code,
      r.out.includes('kötelezősége kikapcsolva (FUTTAT_LENYOMAT_NEM_KOTELEZO=1)'),
      r.text.split('\n')[2]!.startsWith('# figyelem: a lenyomat-lista kötelezősége kikapcsolva'),
      r.summary.figyelmeztetes?.includes('a lenyomat-lista hiányzik'),
      r.text.includes('kulcs [TITOK]'),
    ]
    const results = [shown]
    if (userInfo().uid !== 0) {
      writeFileSync(env.FUTTAT_SECRET_HASHES!, 'abc 12\n')
      chmodSync(env.FUTTAT_SECRET_HASHES!, 0o000)
      const u = run(`echo 'kulcs ${GITHUB_TOKEN}'; exit 5`)
      chmodSync(env.FUTTAT_SECRET_HASHES!, 0o600)
      results.push([
        u.code,
        u.out.includes('kötelezősége kikapcsolva'),
        u.out.includes('a lenyomat-lista nem olvasható'),
        u.summary.figyelmeztetes?.includes('csak a minták szűrtek'),
        u.text.includes('kulcs [TITOK]'),
      ])
    }
    expect(results, 'FUTTAT-HASHLIST-OPTIONAL').toEqual(results.map(() => [5, true, true, true, true]))
  })

  it('FUTTAT-LONG-RUN: a run over 4096 characters is not windowed, a secret at its delimiters is still found', () => {
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'hosszu-futam-titka-77\n' })
    const filler = 'a'.repeat(5000)
    const r = run(`echo '${filler}/hosszu-futam-titka-77/${filler}'`)
    expect(r.text.split('\n')[2], 'FUTTAT-LONG-RUN').toBe(`${filler}/[TITOK]/${filler}`)
  })

  it('FUTTAT-LONG-RUN-LINEAR: a 200 000-character run full of delimiters finishes fast, its secret found', () => {
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'suru-futam-titka-88\n' })
    // a length-less legacy line too, which must not make the run quadratic either
    writeFileSync(env.FUTTAT_SECRET_HASHES!, readFileSync(env.FUTTAT_SECRET_HASHES!, 'utf-8') + 'a'.repeat(64) + '\n')
    // built inside bash: one argument may not exceed 128 KB (MAX_ARG_STRLEN)
    const started = Date.now()
    const r = run(`h=$(printf 'ab/%.0s' $(seq 1 33333)); printf '%s' "\${h}suru-futam-titka-88/\${h}"; echo`)
    expect([Date.now() - started < 3_000, r.text.split('\n')[2]!.includes('/[TITOK]/')], 'FUTTAT-LONG-RUN-LINEAR').toEqual([true, true])
  })

  // acrobot's live run: the list lost the deployment's 0640 on every add
  it('FUTTAT-HASHLIST-MODE: an existing list keeps its mode; a new one is 0640 with the group, 0600 without it', () => {
    writeFileSync(env.FUTTAT_SECRET_HASHES!, '')
    chmodSync(env.FUTTAT_SECRET_HASHES!, 0o640)
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'meglevo-lista-titka-11\n' })
    const kept = (statSync(env.FUTTAT_SECRET_HASHES!).mode & 0o777).toString(8)
    rmSync(env.FUTTAT_SECRET_HASHES!)
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'uj-lista-titka-csoport-nelkul\n' })
    const alone = (statSync(env.FUTTAT_SECRET_HASHES!).mode & 0o777).toString(8)
    rmSync(env.FUTTAT_SECRET_HASHES!)
    const group = execFileSync('id', ['-gn'], { encoding: 'utf-8' }).trim()
    execFileSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env: { ...env, FUTTAT_GROUP: group }, input: 'uj-lista-titka-csoporttal\n' })
    const grouped = (statSync(env.FUTTAT_SECRET_HASHES!).mode & 0o777).toString(8)
    expect([kept, alone, grouped], 'FUTTAT-HASHLIST-MODE').toEqual(['640', '600', '640'])
  })

  it('refuses a secret value too short to search for, and stores only its hash', () => {
    const short = spawnSync('python3', [SCRIPT, 'lenyomat-hozzaad'], { env, input: 'rovid\n', encoding: 'utf-8' })
    expect(short.status).toBe(2)
  })
})

describe('futtat: the summary', () => {
  it('FUTTAT-TEST: failed tests by name with their first error, the totals, the exit code passed through', () => {
    const tap = run(`${TAP}; exit 1`, ['--fajta', 'test'])
    const vitest = run([
      `echo ' FAIL  src/a.test.ts > csoport > WEB-X: rossz'`,
      `echo 'AssertionError: expected 1 to be 2'`,
      `echo '      Tests  1 failed | 3 passed (4)'`,
      'exit 1',
    ].join('; '), ['--fajta', 'test'])
    expect([tap.code, tap.summary.kivonat.slice(0, 3), vitest.summary.kivonat.slice(0, 2)], 'FUTTAT-TEST').toEqual([
      1,
      ['BUKOTT: CONTRACT-X: a rossz\n    Expected values to be strictly deep-equal:', '# tests 2', '# fail 1'],
      ['BUKOTT: src/a.test.ts > csoport > WEB-X: rossz\n    AssertionError: expected 1 to be 2', 'Tests  1 failed | 3 passed (4)'],
    ])
  })

  it('FUTTAT-COMPILE: tsc error locations in both formats, behind a turbo prefix', () => {
    const r = run([
      `echo '@acropora/types:typecheck: src/a.ts(44,14): error TS2322: Type string is not number.'`,
      `echo 'src/b.ts:3:7 - error TS2304: Cannot find name x.'`,
      'exit 2',
    ].join('; '), ['--fajta', 'typecheck'])
    expect([r.code, r.summary.kivonat.slice(0, 2)], 'FUTTAT-COMPILE').toEqual([
      2,
      ['src/a.ts:44:14 TS2322 Type string is not number.', 'src/b.ts:3:7 TS2304 Cannot find name x.'],
    ])
  })

  it('FUTTAT-DIFF: per-file and total line statistics', () => {
    const r = run([
      `echo 'diff --git a/x.ts b/x.ts'`, `echo '--- a/x.ts'`, `echo '+++ b/x.ts'`, `echo '+uj'`, `echo '+uj2'`, `echo '-regi'`,
      `echo 'diff --git a/y.md b/y.md'`, `echo '+sor'`,
    ].join('; '), ['--fajta', 'diff'])
    expect(r.summary.kivonat, 'FUTTAT-DIFF').toEqual(['x.ts: +2 -1', 'y.md: +1 -0', '2 fájl, +3 -1'])
  })

  it('FUTTAT-FIRST-ERROR: a failure always carries its first error line and the lines before it, the log path and the omitted count', () => {
    const r = run(`for i in 1 2 3 4 5 6; do echo "elotte $i"; done; echo 'ERR! valami elromlott'; echo 'utana'; exit 3`, ['--kontextus', '2'])
    const tail = r.summary.kivonat.slice(r.summary.kivonat.indexOf('első hiba (és ami előtte állt):'))
    expect([r.code, tail, r.out.includes(`napló: ${r.log}`), r.summary.sorok, typeof r.summary.kihagyott_sorok], 'FUTTAT-FIRST-ERROR').toEqual([
      3,
      ['első hiba (és ami előtte állt):', '5: elotte 5', '6: elotte 6', '7: ERR! valami elromlott'],
      true,
      8,
      'number',
    ])
  })
})

describe('futtat: the log', () => {
  it('FUTTAT-READBACK: a line range and a search, not the whole log', () => {
    const r = run(`for i in $(seq 1 50); do echo "sor $i"; done; echo 'KERESETT sor'`)
    const range = execFileSync('python3', [SCRIPT, 'olvas', r.log, '--sorok', '10-12'], { env, encoding: 'utf-8' })
    const found = execFileSync('python3', [SCRIPT, 'keres', r.log, 'KERESETT', '--kontextus', '1'], { env, encoding: 'utf-8' })
    // the log starts with two header lines, so "sor 8" is line 10
    expect([range, found], 'FUTTAT-READBACK').toEqual([
      '10: sor 8\n11: sor 9\n12: sor 10\n',
      '52- sor 50\n53: KERESETT sor\n--\n1 találat\n',
    ])
  })

  it('FUTTAT-PERMS: without the project group owner-only; with it group-readable, never world-readable', () => {
    const alone = run('echo egyedul')
    const mode = (path: string) => (statSync(path).mode & 0o7777).toString(8)
    const dir = (path: string) => join(path, '..')
    const aloneModes = [mode(alone.log), mode(dir(alone.log))] // before the second run re-sets the shared task dir
    env.FUTTAT_GROUP = userInfo().username === 'root' ? 'root' : execFileSync('id', ['-gn'], { encoding: 'utf-8' }).trim()
    const grouped = run('echo csoporttal')
    // 2770: several agents of a project (different OS users) create task directories here
    expect([...aloneModes, mode(grouped.log), mode(dir(grouped.log))], 'FUTTAT-PERMS').toEqual(['600', '700', '640', '2770'])
  })

  it('FUTTAT-GROUP-DENIED: a group the agent is not in falls back to owner-only, and the run still reports', () => {
    if (userInfo().uid === 0) return // root may set any group
    env.FUTTAT_GROUP = 'root' // exists, and an agent is not a member
    const r = run('echo valami; exit 4')
    expect([r.code, (statSync(r.log).mode & 0o777).toString(8), r.out.includes('nem állítható be')], 'FUTTAT-GROUP-DENIED').toEqual([4, '600', true])
  })

  it('FUTTAT-RETENTION: a log older than 30 days goes, its summary and a fresh log stay', () => {
    const old = run('echo regi')
    const fresh = run('echo friss')
    const past = (Date.now() - 31 * 86400 * 1000) / 1000
    // the log and its summary are written together, so both are old
    utimesSync(old.log, past, past)
    utimesSync(old.log.replace(/\.log$/, '.summary.json'), past, past)
    execFileSync('python3', [SCRIPT, 'takarit'], { env })
    const exists = (p: string) => { try { statSync(p); return true } catch { return false } }
    expect([exists(old.log), exists(old.log.replace(/\.log$/, '.summary.json')), exists(fresh.log)], 'FUTTAT-RETENTION').toEqual([false, true, true])
  })
})
