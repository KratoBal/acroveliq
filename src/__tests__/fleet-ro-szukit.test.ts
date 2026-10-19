import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/fleet-ro-szukit.sh, the scheduled take-back of expired fleet_ro lines (task parancssor-a-fleet-ro-grant).
  What turns these red: the script running any mode but `szukit` (it must never be able to apply); the first line not
  saying the verdict; a gate failure reported as success; a missing list or no expired line reported as work done.
  A fake `ssh` stands in for the gate and writes the call it got into a file.
*/

let dir: string
const script = join(process.cwd(), 'scripts', 'fleet-ro-szukit.sh')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-ro-szukit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeSsh(output: string, code: number): void {
  const body = `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat <<'EOF_OUT'\n${output}\nEOF_OUT\nexit ${code}\n`
  writeFileSync(join(dir, 'ssh'), body)
  chmodSync(join(dir, 'ssh'), 0o755)
}

function run(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script], { env: { PATH: `${dir}:/usr/bin:/bin`, ELES_KEY: '/nonexistent/key' } }, (err, stdout) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout }),
    )
  })
}

const args = () => readFileSync(join(dir, 'args'), 'utf8').split('\n').filter(Boolean)

describe('fleet-ro-szukit.sh', () => {
  it("asks the gate for `szukit` and for nothing else: the mode is fixed in the command, the pair is the gate's target", async () => {
    fakeSsh('fleet-ro-grant szukit: nincs lejárt sor (2026-10-19)', 0)
    await run()
    const a = args()
    expect(a.at(-1)).toBe('fleet-ro-grant iwm34jaqp9xmwb72qkrqkwhy acropora szukit')
    expect(a.slice(-3, -1)).toEqual(['--', 'fleet@162.55.216.28'])
    expect(a.join(' ')).toContain('BatchMode=yes')
    expect(a.join(' ')).not.toMatch(/alkalmaz|terv/)
  })

  it('nothing expired, or no list applied yet: the verdict is nincs-teendo, exit 0', async () => {
    fakeSsh('fleet-ro-grant szukit: nincs lejárt sor (2026-10-19)', 0)
    expect(await run()).toMatchObject({ code: 0 })
    expect((await run()).out.split('\n')[0]).toBe('SZUKIT nincs-teendo')
    fakeSsh('fleet-ro-grant szukit: nincs alkalmazott lista, nincs mit visszavenni', 0)
    expect((await run()).out.split('\n')[0]).toBe('SZUKIT nincs-teendo')
  })

  it('lines taken back: the verdict counts the REVOKE lines', async () => {
    fakeSsh(
      'NOTICE:  REVOKE SELECT ("amount") ON "BankTransaction" FROM fleet_ro\nNOTICE:  REVOKE SELECT (id) ON "BankAccount" FROM fleet_ro',
      0,
    )
    const r = await run()
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('SZUKIT visszavett 2')
  })

  it('the gate refusing (the 40-column limit, say) is an error with its first line, exit 1', async () => {
    fakeSsh("fleet-gate: 'fleet-ro-grant szukit': 41 lejárt oszlop egy futásra (a határ 40): emberi döntés kell", 2)
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out.split('\n')[0]).toMatch(/^SZUKIT HIBA rc=2: .*41/)
  })

  it('no ssh answer at all is an error, not "nothing to do"', async () => {
    fakeSsh('ssh: connect to host 162.55.216.28 port 22: Connection timed out', 255)
    const r = await run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('SZUKIT HIBA rc=255')
    expect(r.out).not.toContain('nincs-teendo')
  })
})
