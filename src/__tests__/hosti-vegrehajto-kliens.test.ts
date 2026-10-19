import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/*
  scripts/hosti-vegrehajto.sh, the fleet's side of the host executor (the no-command-line plan, point C). A fake dashboard
  and a fake `ssh` (the gate) stand behind it. WHAT TURNS THESE RED: an approval put up without the executor's line as its
  whole description, in another category, or with an expiry past the R's window; a vegrehajt sent for a pending, rejected,
  Discord-less, wrong-category or another R's approval; a short commit or a verb off the list reaching the gate at all; the
  executor's refusal (busy included) reported as anything but its own word; a remote word other than the three hosti ops.
*/

const SHA = `${'1'.repeat(8)}${'a'.repeat(32)}`
const R = 'deadbeef'
const LINE = `HOSTI R=${R} / levelkozvetito / telepit / ${SHA} / elo ${'1'.repeat(12)} / elozo nincs`

interface Row {
  id: string
  agent_id: string
  category: string
  action_description: string
  timeout_at: number
  status: string
  discord_message_id: string | null
}

let dir: string
let script: string
let servers: Server[]
let rows: Map<string, Row>
let dashPort: number
let dashboard: { recordAs?: string }

async function listen(s: Server): Promise<number> {
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res))
  servers.push(s)
  return (s.address() as AddressInfo).port
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hosti-kliens-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  script = join(dir, 'scripts', 'hosti-vegrehajto.sh')
  copyFileSync(join(process.cwd(), 'scripts', 'hosti-vegrehajto.sh'), script)
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token')
  // the gate: logs the remote command it was given (the last argument) and answers from a file, with the exit code of another
  writeFileSync(
    join(dir, 'bin', 'ssh'),
    `#!/bin/bash\n# like ssh: everything after the host is joined by spaces into the remote command\nwhile [ "$1" != "--" ]; do shift; done; shift; shift\nop="$*"; echo "$op" >> "${dir}/gate.log"\nname="\${op%% *}"\n[ -f "${dir}/reply-$name" ] && cat "${dir}/reply-$name"\nrc=0; [ -f "${dir}/rc-$name" ] && rc=$(cat "${dir}/rc-$name")\nexit $rc\n`,
  )
  chmodSync(join(dir, 'bin', 'ssh'), 0o755)
  writeFileSync(
    join(dir, 'reply-hosti-kerj'),
    JSON.stringify({ ok: true, r: R, canonicalLine: LINE, expiresAt: Math.floor(Date.now() / 1000) + 30 * 60 }),
  )
  writeFileSync(join(dir, 'reply-hosti-vegrehajt'), JSON.stringify({ ok: true, r: R, allapot: 'elfogadva' }))
  servers = []
  rows = new Map()
  dashboard = {}
  const dash = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'no' })
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/approvals') {
        const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        const row: Row = {
          id: `apr-${rows.size + 1}`,
          agent_id: dashboard.recordAs ?? String(b.agent_id),
          category: String(b.category),
          action_description: String(b.action_description).trim(),
          timeout_at: Math.floor(Date.now() / 1000) + (b.timeout_seconds as number),
          status: 'pending',
          discord_message_id: null,
        }
        rows.set(row.id, row)
        return send(201, row)
      }
      const m = /^\/api\/approvals\/([\w-]+)$/.exec(req.url ?? '')
      if (req.method === 'GET' && m) return rows.has(m[1]!) ? send(200, rows.get(m[1]!)) : send(404, { error: 'not found' })
      send(404, { error: 'not found' })
    })
  })
  dashPort = await listen(dash)
})

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))))
  rmSync(dir, { recursive: true, force: true })
})

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      {
        env: {
          ...process.env,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          MARVEEN_WEB_PORT: String(dashPort),
          ELES_KEY: '/nonexistent/key',
        },
      },
      (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout }),
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
const ask = () => run(['kerj', 'murena', 'levelkozvetito', 'telepit', SHA])
const idsOf = (out: string) => {
  const m = /^R=([0-9a-f]+) approval=([\w-]+) lejar=(\d+)$/m.exec(out)
  if (!m) throw new Error(`no R line in: ${out}`)
  return { r: m[1]!, apr: m[2]!, expires: Number(m[3]) }
}
const decide = (row: Row, status = 'approved', discord: string | null = '1559919876543210987') => {
  row.status = status
  row.discord_message_id = discord
}

describe('hosti-vegrehajto.sh kerj', () => {
  it("asks the gate for the R and puts the executor's line up as the whole description, in its own category, inside the R window", async () => {
    const { code, out } = await ask()
    expect(code).toBe(0)
    const { apr, expires } = idsOf(out)
    expect(gateCalls()).toEqual([`hosti-kerj levelkozvetito telepit ${SHA} murena`])
    const row = rows.get(apr)!
    expect([row.category, row.action_description, row.agent_id]).toEqual(['hosti_vegrehajt', LINE, 'murena'])
    expect(row.timeout_at).toBeLessThanOrEqual(expires)
    expect(row.timeout_at).toBeGreaterThan(expires - 5 * 60)
  })

  it('an up and a visszaallit take no commit: `-`, and a commit on them is refused before the gate', async () => {
    expect((await run(['kerj', 'murena', 'levelkozvetito', 'up', '-'])).code).toBe(0)
    expect(gateCalls()).toEqual(['hosti-kerj levelkozvetito up - murena'])
    const before = gateCalls().length
    expect((await run(['kerj', 'murena', 'levelkozvetito', 'up', SHA])).code).toBe(1)
    expect(gateCalls().length).toBe(before)
  })

  it.each([
    ['a short commit', ['kerj', 'murena', 'levelkozvetito', 'telepit', 'abc123']],
    ['a verb off the list', ['kerj', 'murena', 'levelkozvetito', 'prune', SHA]],
    ['an agent with an underscore', ['kerj', 'mu_rena', 'levelkozvetito', 'telepit', SHA]],
    ['an upper-case project', ['kerj', 'murena', 'Levelkozvetito', 'telepit', SHA]],
  ])('%s never reaches the gate, and no approval goes up', async (_n, args) => {
    expect((await run(args)).code).toBe(1)
    expect(gateCalls()).toEqual([])
    expect(rows.size).toBe(0)
  })

  it('the executor refusing (a project off its list, say) is reported as its word, exit 5, and no approval goes up', async () => {
    writeFileSync(join(dir, 'reply-hosti-kerj'), JSON.stringify({ ok: false, hiba: 'a projekt nincs a listan' }))
    writeFileSync(join(dir, 'rc-hosti-kerj'), '10')
    const r = await ask()
    expect([r.code, r.out]).toEqual([5, 'MEGTAGADVA (R kerese): a projekt nincs a listan\n'])
    expect(rows.size).toBe(0)
  })

  it('a gate or socket that does not answer is not a refusal of the executor', async () => {
    writeFileSync(join(dir, 'reply-hosti-kerj'), '')
    writeFileSync(join(dir, 'rc-hosti-kerj'), '14')
    const r = await ask()
    expect(r.code).toBe(5)
    expect(r.out).toContain('NEM ERHETO EL')
  })

  it('the dashboard recording another requester stops kerj: the executor would refuse the Discord text later', async () => {
    dashboard.recordAs = 'acrobot'
    const r = await ask()
    expect(r.code).toBe(1)
    expect(r.out).toContain('a dashboard acrobot-kent rogzitette')
  })
})

describe('hosti-vegrehajto.sh vegrehajt', () => {
  async function approved() {
    const { apr } = idsOf((await ask()).out)
    return { apr, row: rows.get(apr)! }
  }
  const calls = () => gateCalls().filter((c) => c.startsWith('hosti-vegrehajt'))

  it('an approved, Discord-answered approval of this R goes to the gate once, and the answer is `elfogadva`', async () => {
    const { apr, row } = await approved()
    decide(row)
    const r = await run(['vegrehajt', R, apr])
    expect(r.code).toBe(0)
    expect(r.out).toContain('allapot=elfogadva')
    expect(r.out).toContain('allapot ' + R)
    expect(calls()).toEqual([`hosti-vegrehajt ${R} 1559919876543210987`])
  })

  it('a pending approval sends nothing (exit 3); a rejected one sends nothing (exit 4)', async () => {
    const a = await approved()
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(3)
    decide(a.row, 'rejected')
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(4)
    decide(a.row, 'timeout')
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(4)
    expect(calls()).toEqual([])
  })

  it('an approval decided off Discord (no message id) sends nothing: the executor reads only Discord', async () => {
    const a = await approved()
    decide(a.row, 'approved', null)
    const r = await run(['vegrehajt', R, a.apr])
    expect(r.code).toBe(1)
    expect(r.out).toContain('nincs Discord-uzenete')
    expect(calls()).toEqual([])
  })

  it('an approval in another category, or one that describes another R, sends nothing', async () => {
    const a = await approved()
    decide(a.row)
    a.row.category = 'coolify_deploy'
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(1)
    a.row.category = 'hosti_vegrehajt'
    a.row.action_description = LINE.replace(R, 'cafe0001')
    const r = await run(['vegrehajt', R, a.apr])
    expect(r.code).toBe(1)
    expect(r.out).toContain('nem ezt az R-t')
    expect(calls()).toEqual([])
  })

  it("a busy project is the executor's word with a hint that the R stayed open (exit 5)", async () => {
    const a = await approved()
    decide(a.row)
    writeFileSync(
      join(dir, 'reply-hosti-vegrehajt'),
      JSON.stringify({ ok: false, hiba: 'foglalt: ezen a projekten mar fut egy muvelet', foglalt: true }),
    )
    writeFileSync(join(dir, 'rc-hosti-vegrehajt'), '10')
    const r = await run(['vegrehajt', R, a.apr])
    expect(r.code).toBe(5)
    expect(r.out).toContain('MEGTAGADVA (vegrehajtas): foglalt')
    expect(r.out).toContain('az R nyitva maradt')
  })

  it('the executor saying no decision yet / rejected maps to 3 / 4', async () => {
    const a = await approved()
    decide(a.row)
    writeFileSync(join(dir, 'rc-hosti-vegrehajt'), '11')
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(3)
    writeFileSync(join(dir, 'rc-hosti-vegrehajt'), '12')
    expect((await run(['vegrehajt', R, a.apr])).code).toBe(4)
  })
})

describe('hosti-vegrehajto.sh allapot', () => {
  it('asks the gate for the overview, or for one R, and prints the answer', async () => {
    writeFileSync(join(dir, 'reply-hosti-allapot'), '{"ok":true,"projektek":{}}')
    const r = await run(['allapot'])
    expect([r.code, r.out.trim()]).toEqual([0, '{"ok":true,"projektek":{}}'])
    expect((await run(['allapot', R])).code).toBe(0)
    expect(gateCalls()).toEqual(['hosti-allapot', `hosti-allapot ${R}`])
  })

  it('an R that is not 8 hex digits never reaches the gate; a wrong argument count is usage (2)', async () => {
    expect((await run(['allapot', 'XYZ'])).code).toBe(1)
    expect((await run(['allapot', R, R])).code).toBe(2)
    expect((await run(['nincs-ilyen'])).code).toBe(2)
    expect(gateCalls()).toEqual([])
  })
})
