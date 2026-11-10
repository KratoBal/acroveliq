import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/*
  pr-beolvaszt.sh: A BINARY FILE IN THE PR MUST NOT CRASH THE OVERLAP CHECK (card 4192ab39; a removed woff2 in acroveliq/acropora-os
  #2076, 2026-11-03: UnicodeDecodeError, the merge aborted). The overlap check fetches the BASE version of each changed file with curl and
  compares the added names with it; a binary base is not text and must come back readable, not raise. What turns this red: the fetch
  decoding the bytes strictly (a `text=True` without `errors='replace'`); the fetch function missing from the script.

  The embedded Python is extracted from the script (the `_nyers` function), run with a stand-in for `subprocess.run` that swaps the curl
  command for one that writes the given bytes, and every other argument (the decoding options, the input) passes to the real
  `subprocess.run` untouched: so the test measures the script's OWN call arguments, not a copy of them.
*/
const script = readFileSync(join(process.cwd(), 'scripts', 'pr-beolvaszt.sh'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'pr-beolvaszt-binary-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function extractNyers(): string {
  const start = script.indexOf('def _nyers(path):')
  expect(start, 'the _nyers function is in the script').toBeGreaterThan(-1)
  const end = script.indexOf('\n_base = ', start)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end)
}

function runNyers(bytes: number[]): string {
  const harness = `
import subprocess as _real, sys, json
repo = 'KratoBal/proba'
tok = 'nem-valodi'

class _Stub:
    @staticmethod
    def run(cmd, **kw):
        # the curl command is swapped for one that writes the bytes; every other argument is the script's own
        assert cmd[0] == 'curl', cmd
        writer = ['python3', '-c', 'import sys; sys.stdout.buffer.write(bytes(' + json.dumps(${JSON.stringify(bytes)}) + '))']
        return _real.run(writer, **kw)

subprocess = _Stub
${extractNyers()}
out = _nyers('/contents/fonts/proba.woff2?ref=abc')
sys.stdout.write(json.dumps({'type': type(out).__name__, 'len': len(out), 'text': out}))
`
  const file = join(dir, `harness-${Math.random().toString(36).slice(2)}.py`)
  writeFileSync(file, harness)
  return execFileSync('python3', ['-B', file], { encoding: 'utf8' })
}

describe('pr-beolvaszt.sh: the base-content fetch', () => {
  it('a binary base (invalid UTF-8) comes back as text, it does not raise', () => {
    // a woff2 magic number and bytes that are not valid UTF-8
    const out = JSON.parse(runNyers([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80]))
    expect(out.type).toBe('str')
    expect(out.len).toBeGreaterThan(0)
  })

  it('a text base is returned as it is', () => {
    const bytes = Array.from(Buffer.from('export function canMove() {}\n', 'utf8'))
    const out = JSON.parse(runNyers(bytes))
    expect(out.text).toBe('export function canMove() {}\n')
  })

  it('an empty answer is an empty text', () => {
    expect(JSON.parse(runNyers([])).text).toBe('')
  })
})
