import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
  scripts/vetites-figyelo.sh (card 2f0d7acd): one line, OK or RIASZT with the reason, from the OS
  /health doseProjection field. What turns these red: a stale or failing projection reported OK;
  a missing or null field, a non-JSON answer or an unreachable /health reported OK; more than one
  line; the exit code not following the verdict; the failure text (which /health never carries)
  invented into the line.
*/

const script = join(process.cwd(), 'scripts', 'vetites-figyelo.sh')
let server: Server
let base = ''
let answer: { status: number; body: string } = { status: 200, body: '{}' }

const health = (doseProjection: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ application: { status: 'ok' }, database: { status: 'ok' }, redis: { status: 'ok' }, ...extra, ...(doseProjection === undefined ? {} : { doseProjection }) })

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' })
    res.end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
})

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    )
  })
}

async function verdict(body: string, status = 200) {
  answer = { status, body }
  const r = await run([base])
  expect(r.out.trim().split('\n')).toHaveLength(1)
  return { code: r.code, line: r.out.trim() }
}

describe('vetites-figyelo.sh', () => {
  it('a fresh projection that is not failing: OK, exit 0', async () => {
    const r = await verdict(health({ stale: false, ageHours: 0.5, rowCount: 42, failingSinceLastSuccess: false }))
    expect(r).toEqual({ code: 0, line: `OK vetites (${base}): 0.5 oraja epult, 42 sor` })
  })

  it.each([
    ['stale', { stale: true, ageHours: 30, rowCount: 42, failingSinceLastSuccess: false }, /elavult: 30 oraja epult utoljara \(42 sor\)/],
    ['never built', { stale: true, ageHours: null, rowCount: 0, failingSinceLastSuccess: false }, /elavult: meg soha nem epult fel/],
    ['failing now', { stale: false, ageHours: 2, rowCount: 42, failingSinceLastSuccess: true }, /az ujraepites a legutobbi siker ota bukik/],
    ['both', { stale: true, ageHours: 40, rowCount: 1, failingSinceLastSuccess: true }, /bukik; elavult: 40 oraja/],
  ])('%s: RIASZT with the reason, exit 1', async (_label, projection, reason) => {
    const r = await verdict(health(projection))
    expect(r.code).toBe(1)
    expect(r.line).toMatch(/^RIASZT vetites /)
    expect(r.line).toMatch(reason)
  })

  it('the field missing (an older release), null (unreadable), not JSON, unreachable: RIASZT', async () => {
    expect(await verdict(health(undefined))).toMatchObject({ code: 1, line: expect.stringMatching(/nem ad doseProjection mezot.*regi kiadas/) })
    expect(await verdict(health(null))).toMatchObject({ code: 1, line: expect.stringMatching(/nem tudta olvasni.*doseProjection: null/) })
    expect(await verdict('<html>bad gateway</html>', 502)).toMatchObject({ code: 1, line: expect.stringMatching(/nem JSON \(http 502\)/) })
    const closed = await run(['http://127.0.0.1:1'])
    expect(closed).toMatchObject({ code: 1, out: expect.stringMatching(/^RIASZT vetites .*nem erheto el\n$/) })
  })

  it('a 503 health (database down) still says what the projection field says', async () => {
    const r = await verdict(health({ stale: false, ageHours: 1, rowCount: 3, failingSinceLastSuccess: false }, { database: { status: 'error' } }), 503)
    expect(r.code).toBe(0)
  })

  it('a wrong call is exit 2: two arguments, or a plain http address that is not local', async () => {
    expect((await run([base, 'extra'])).code).toBe(2)
    expect((await run(['http://api-staging.acropora.hu'])).code).toBe(2)
  })
})
