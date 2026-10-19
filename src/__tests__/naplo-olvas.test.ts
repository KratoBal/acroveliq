import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/naplo-olvas.sh, the fleet's way to read a log (the no-command-line plan, point G). A fake `ssh` (the gate) and a
  stand-in for scripts/karanten-olvas.sh sit behind it. WHAT TURNS THESE RED: a log going anywhere but a private file and the
  quarantine reader (the terminal included); the temporary file left behind on ANY path (done, a reader failure, a gate refusal,
  an empty answer); the reader's refusal (2, 3) reported as a success; a key or a number of lines the gate would refuse
  reaching the gate; a `kep` going through the reader (it is fixed fields, not free text) or a log skipping it.
*/

const FILTERED = '2026-10-19T10:00:00Z start ok\n2026-10-19T10:00:01Z password=[TITOK] seen\n# szurve: 1 elem\n'
const KEY = 't9gxx94ecwekwruxngps5i6v'

let dir: string
let tmp: string
let script: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'naplo-olvas-'))
  tmp = join(dir, 'tmp')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(tmp)
  script = join(dir, 'scripts', 'naplo-olvas.sh')
  copyFileSync(join(process.cwd(), 'scripts', 'naplo-olvas.sh'), script)
  // the gate: logs the remote command (everything after the host, joined by spaces, as ssh does), answers from a file
  writeFileSync(
    join(dir, 'bin', 'ssh'),
    `#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done; shift; shift\nop="$*"; echo "$op" >> "${dir}/gate.log"\nname="\${op%% *}"\n[ -f "${dir}/reply-$name" ] && cat "${dir}/reply-$name"\nrc=0; [ -f "${dir}/rc-$name" ] && rc=$(cat "${dir}/rc-$name")\nexit $rc\n`,
  )
  chmodSync(join(dir, 'bin', 'ssh'), 0o755)
  // the quarantine reader: records what it was given and how the file and its directory are protected, prints a fixed envelope
  writeFileSync(
    join(dir, 'scripts', 'karanten-olvas.sh'),
    `#!/bin/bash\nf="$1"; cp "$f" "${dir}/reader-input"; stat -c '%a' "$f" > "${dir}/reader-file-mode"; stat -c '%a' "$(dirname "$f")" > "${dir}/reader-dir-mode"; echo "$f" > "${dir}/reader-path"\necho '<untrusted source="naplo">osszefoglalo</untrusted>'\nrc=0; [ -f "${dir}/rc-reader" ] && rc=$(cat "${dir}/rc-reader")\nexit $rc\n`,
  )
  chmodSync(join(dir, 'scripts', 'karanten-olvas.sh'), 0o755)
  writeFileSync(join(dir, 'reply-app-log'), FILTERED)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      { env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMPDIR: tmp, ELES_KEY: '/nonexistent/key' } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    )
  })
}
const gateCalls = () => {
  try {
    return readFileSync(join(dir, 'gate.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const tmpLeft = () => readdirSync(tmp)
const readerInput = () => readFileSync(join(dir, 'reader-input'), 'utf8')

describe('naplo-olvas.sh app', () => {
  it('the filtered log goes to a private file, the quarantine reader reads it, only its envelope comes out, and the file is gone', async () => {
    const r = await run(['app', KEY])
    expect([r.code, r.out]).toEqual([0, '<untrusted source="naplo">osszefoglalo</untrusted>\n'])
    expect(gateCalls()).toEqual([`app-log ${KEY} 500`])
    expect(readerInput()).toBe(FILTERED)
    expect([readFileSync(join(dir, 'reader-file-mode'), 'utf8').trim(), readFileSync(join(dir, 'reader-dir-mode'), 'utf8').trim()]).toEqual(
      ['600', '700'],
    )
    expect(tmpLeft()).toEqual([])
    // nothing of the log on the terminal
    expect(r.out + r.err).not.toContain('start ok')
  })

  it('a number of lines is passed to the gate as it is', async () => {
    await run(['app', KEY, '5000'])
    expect(gateCalls()).toEqual([`app-log ${KEY} 5000`])
  })

  it.each([
    ['a reader that gave nothing (2)', '2', 2],
    ['a reader that found a secret shape (3)', '3', 3],
  ])('%s is passed on as it is, and the file is still removed', async (_n, readerCode, code) => {
    writeFileSync(join(dir, 'rc-reader'), readerCode)
    const r = await run(['app', KEY])
    expect(r.code).toBe(code)
    expect(tmpLeft()).toEqual([])
  })

  it('a gate refusal (or no answer) is 4, the reader is never run, and nothing is left', async () => {
    writeFileSync(join(dir, 'rc-app-log'), '2')
    const r = await run(['app', KEY])
    expect(r.code).toBe(4)
    expect(readdirSync(dir)).not.toContain('reader-input')
    expect(tmpLeft()).toEqual([])
  })

  it('an EMPTY answer is not handed to the reader', async () => {
    writeFileSync(join(dir, 'reply-app-log'), '')
    const r = await run(['app', KEY])
    expect(r.code).toBe(4)
    expect(readdirSync(dir)).not.toContain('reader-input')
    expect(tmpLeft()).toEqual([])
  })

  it.each([
    ['a short key', ['app', 'abc']],
    ['a key with an upper-case letter', ['app', 'T9gxx94ecwekwruxngps5i6v']],
    ['no key', ['app']],
    ['0 lines', ['app', KEY, '0']],
    ['5001 lines', ['app', KEY, '5001']],
    ['a leading zero', ['app', KEY, '01']],
    ['a flag as the lines', ['app', KEY, '--follow']],
    ['a third argument', ['app', KEY, '10', 'x']],
  ])('%s never reaches the gate', async (_n, args) => {
    const r = await run(args)
    expect([r.code === 5, gateCalls()]).toEqual([true, []])
    expect(tmpLeft()).toEqual([])
  })
})

describe('naplo-olvas.sh hosti', () => {
  it("takes the log out of the executor's JSON into the private file, and only the envelope comes out", async () => {
    writeFileSync(
      join(dir, 'reply-hosti-naplo'),
      JSON.stringify({ ok: true, projekt: 'levelkozvetito', sorok: 200, szurve: 1, naplo: FILTERED }),
    )
    const r = await run(['hosti', 'levelkozvetito'])
    expect([r.code, r.out]).toEqual([0, '<untrusted source="naplo">osszefoglalo</untrusted>\n'])
    expect(gateCalls()).toEqual(['hosti-naplo levelkozvetito 200'])
    expect(readerInput()).toBe(FILTERED)
    expect(tmpLeft()).toEqual([])
  })

  it('an executor answer that is not a log (a refusal, not JSON) is 4 and no reader runs', async () => {
    writeFileSync(join(dir, 'reply-hosti-naplo'), JSON.stringify({ ok: false, hiba: 'a projekt nincs a listan' }))
    expect((await run(['hosti', 'levelkozvetito'])).code).toBe(4)
    writeFileSync(join(dir, 'reply-hosti-naplo'), 'nem json')
    expect((await run(['hosti', 'levelkozvetito'])).code).toBe(4)
    expect(readdirSync(dir)).not.toContain('reader-input')
    expect(tmpLeft()).toEqual([])
  })

  it.each([
    ['an upper-case project', ['hosti', 'Levelkozvetito']],
    ['1001 lines', ['hosti', 'levelkozvetito', '1001']],
    ['no project', ['hosti']],
  ])('%s never reaches the gate', async (_n, args) => {
    const r = await run(args)
    expect([r.code === 5, gateCalls()]).toEqual([true, []])
  })
})

describe('naplo-olvas.sh kep and hosti-kep', () => {
  it('print the fixed fields as they are, and no reader runs', async () => {
    writeFileSync(join(dir, 'reply-kep'), '/api-1|api:abcdef0|sha256:0123|2026-10-14T05:00:00Z|2026-10-14T05:01:00Z|running|0|-\n')
    const r = await run(['kep', KEY])
    expect([r.code, r.out]).toEqual([0, '/api-1|api:abcdef0|sha256:0123|2026-10-14T05:00:00Z|2026-10-14T05:01:00Z|running|0|-\n'])
    writeFileSync(join(dir, 'reply-hosti-kep'), '{"ok":true,"projekt":"levelkozvetito"}\n')
    expect((await run(['hosti-kep', 'levelkozvetito'])).out).toBe('{"ok":true,"projekt":"levelkozvetito"}\n')
    expect(gateCalls()).toEqual([`kep ${KEY}`, 'hosti-kep levelkozvetito'])
    expect(readdirSync(dir)).not.toContain('reader-input')
  })

  it('a refusal of the gate is 4', async () => {
    writeFileSync(join(dir, 'rc-kep'), '2')
    expect((await run(['kep', KEY])).code).toBe(4)
  })

  it('a wrong word is usage (5)', async () => {
    expect((await run(['nincs-ilyen'])).code).toBe(5)
    expect(gateCalls()).toEqual([])
  })
})
