// A kanban card's re-measurement against the main branch (T6.5 PR2, card b3d8174e): the rules, over a fake fetch.
//
// What turns this red: a missing file or a missing name read as OK; an UNKNOWN (could not look) read as OK; a DIVERGED
// outweighed by an UNKNOWN; a free-text-only basis read as OK; a path that climbs out of the repository fetched; an unknown
// alias treated as a reference; a name found inside a longer word; the note unbounded.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const lib = join(process.cwd(), 'scripts', 'lib')

/** Runs `measure`/`parse_basis` in Python with a table of fake files: path -> [status, text]. */
function py(code: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(lib)})\nfrom kartya_visszameres import *\n${code}`], (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || String(error)))
      resolve(JSON.parse(stdout))
    })
  })
}

const measure = (basis: string, files: Record<string, [number | null, string | null]>) =>
  py(`
files = json.loads(${JSON.stringify(JSON.stringify(files))})
calls = []
def fetch(repo, path):
    calls.append(repo + ':' + path)
    status, text = files.get(repo + ':' + path, [404, None])
    return status, text
out = measure(${JSON.stringify(basis)}, fetch)
print(json.dumps({'out': out, 'calls': calls}))
`) as Promise<{ out: [string, string] | null; calls: string[] }>

const OS = 'KratoBal/acropora-os'
const FILE = `${OS}:apps/api/src/a.ts`

describe('parse_basis', () => {
  it('aliases and owner/repo resolve; free text and unknown aliases are free; unsafe paths are invalid', async () => {
    const parsed = (await py(`
r, f, i = parse_basis("os:apps/a.ts#canMove\\ncommerce:b.ts\\nKratoBal/acroveliq:c.py\\nnincs:x.ts\\nA gomb tiltott\\nos:../etc/passwd\\nos:/abs.ts\\n\\n")
print(json.dumps({'r': r, 'f': f, 'i': i}))
`)) as { r: [string, string, string, string | null][]; f: string[]; i: string[] }
    expect(parsed.r).toEqual([
      ['os', 'KratoBal/acropora-os', 'apps/a.ts', 'canMove'],
      ['commerce', 'KratoBal/acropora-commerce', 'b.ts', null],
      ['KratoBal/acroveliq', 'KratoBal/acroveliq', 'c.py', null],
    ])
    expect(parsed.f).toEqual(['nincs:x.ts', 'A gomb tiltott'])
    expect(parsed.i).toEqual(['os:../etc/passwd', 'os:/abs.ts'])
  })
})

describe('measure', () => {
  it('no basis at all is null: nothing to measure', async () => {
    expect((await measure('', {})).out).toBeNull()
    expect((await measure('  \n \n', {})).out).toBeNull()
  })

  it('the file and the name are there: OK', async () => {
    const r = await measure('os:apps/api/src/a.ts#canMove', { [FILE]: [200, 'export function canMove() {}'] })
    expect(r.out).toEqual(['OK', '1 hivatkozás igaz a main ágon'])
  })

  it('the file is gone (404): DIVERGED, named', async () => {
    const r = await measure('os:apps/api/src/a.ts', {})
    expect(r.out![0]).toBe('DIVERGED')
    expect(r.out![1]).toContain('os:apps/api/src/a.ts nincs a main ágon')
  })

  it('the file is there but the name is gone: DIVERGED; a name only inside a longer word does not count', async () => {
    const gone = await measure('os:apps/api/src/a.ts#canMove', { [FILE]: [200, 'export function other() {}'] })
    expect(gone.out![0]).toBe('DIVERGED')
    expect(gone.out![1]).toContain('canMove nincs a fájlban')
    const longer = await measure('os:apps/api/src/a.ts#canMove', { [FILE]: [200, 'function canMoveSomewhere() {} const xcanMove = 1'] })
    expect(longer.out![0]).toBe('DIVERGED')
  })

  it('a check that could not look is UNKNOWN, never OK (500, a refused token, no network)', async () => {
    for (const status of [500, 403, null]) {
      const r = await measure('os:apps/api/src/a.ts', { [FILE]: [status, null] })
      expect(r.out![0], String(status)).toBe('UNKNOWN')
    }
  })

  it('one certain divergence wins over an UNKNOWN; an UNKNOWN beats the OK ones', async () => {
    const files = { [FILE]: [200, 'x'], [`${OS}:b.ts`]: [500, null] } as Record<string, [number | null, string | null]>
    const unknown = await measure('os:apps/api/src/a.ts\nos:b.ts', files)
    expect(unknown.out![0]).toBe('UNKNOWN')
    const diverged = await measure('os:apps/api/src/a.ts\nos:b.ts\nos:c.ts', files)
    expect(diverged.out![0]).toBe('DIVERGED')
    expect(diverged.out![1]).toContain('os:c.ts')
  })

  it('a basis of only free text is UNKNOWN with that reason: a machine did not check it', async () => {
    const r = await measure('A gomb tiltott a kiallitasnal', {})
    expect(r.out).toEqual(['UNKNOWN', 'nincs gépi sor: csak szabad szöveg, azt gép nem méri'])
    expect(r.calls).toEqual([])
  })

  it('free text beside references is said, and does not turn an OK into anything else', async () => {
    const r = await measure('os:apps/api/src/a.ts\nszabad sor', { [FILE]: [200, 'x'] })
    expect(r.out![0]).toBe('OK')
    expect(r.out![1]).toContain('1 szabad szöveges sort gép nem mért')
  })

  it('an unsafe path is never fetched and is UNKNOWN', async () => {
    const r = await measure('os:../secret.ts', {})
    expect(r.calls).toEqual([])
    expect(r.out![0]).toBe('UNKNOWN')
  })

  it('the note is bounded', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `os:apps/api/src/gone-number-${i}.ts`).join('\n')
    const r = await measure(lines, {})
    expect(r.out![0]).toBe('DIVERGED')
    expect(r.out![1].length).toBeLessThanOrEqual(480)
  })
})
