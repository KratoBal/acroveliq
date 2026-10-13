// fleet-api.sh open-matters (koord-munkamenet, plan item 1), run for real against a
// throwaway HTTP server. WHAT TURNS THIS RED: the command asking for anything other than
// the text form; the text changing on the way; a failed answer printed as if it were
// the summary (a 401 page read as "nothing open"); an extra argument passing silently.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

const root = mkdtempSync(join(tmpdir(), 'fleet-api-open-matters-'))
const script = join(root, 'scripts', 'fleet-api.sh')
let server: Server
let port = 0
let receivedPath = ''
let answer: [number, string] = [200, '']

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'fleet-api.sh'), script)
  writeFileSync(join(root, 'store', '.dashboard-token'), 'test-token')
  server = createServer((req, res) => {
    receivedPath = req.url ?? ''
    res.writeHead(answer[0], { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(answer[1])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[]): Promise<{ code: number; out: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr, stdout }),
    )
  })
}

describe('fleet-api.sh open-matters', () => {
  it('asks for the text form and prints it unchanged', async () => {
    const text = '# Nyitott ugyek\n- [t1] `cim` $HOME | var: barracuda\n## Kimaradt a keretbol (0)\n- semmi'
    answer = [200, text]
    const r = await run(['open-matters'])
    expect(receivedPath).toBe('/api/open-matters?format=text')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${text}\n`)
  })
  it('a failed answer is a FAIL with exit 1, not a summary', async () => {
    answer = [401, '{"error":"unauthorized"}']
    const r = await run(['open-matters'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL http=401/)
  })
  it('an extra argument stops the command', async () => {
    answer = [200, 'x']
    const r = await run(['open-matters', 'acrobot'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('legfeljebb 0')
  })
})
