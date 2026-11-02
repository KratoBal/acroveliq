import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/*
  THE MERGER READS THE VERDICT ITSELF, NOT THE GITHUB REVIEW (card 31e495e0). On #194 the machine review's commit_id
  followed the PR to its new head while barracuda's verdict on the timeline was for the old one (barracuda 40282,
  40290). What turns these red: verdict-fej-ellenor.py passing a verdict on an older head, a CHANGES, a short head, a
  verdict by someone else or on another PR, or picking an earlier verdict over the latest; a failed timeline read looking
  like "no verdict"; and pr-beolvaszt.sh merging (or only looking, --nez) without the gate, or going on after a refusal.
*/

const REPO_ROOT = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'verdict-fej-'))
const checker = join(root, 'scripts', 'verdict-fej-ellenor.py')

type Item = { source: string; kind?: string; actor?: string; ref?: string | null; at?: number; id?: number }
let timelines: Record<string, Item[]> = {}
let status = 200
let server: Server
let port = 0

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
let n = 0
const verdict = (ref: string, actor = 'barracuda', at = 1000 + ++n): Item => ({ source: 'event', kind: 'verdict', actor, ref, at, id: n })

beforeAll(async () => {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store', 'tokens'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts', 'verdict-fej-ellenor.py'), checker)
  cpSync(join(REPO_ROOT, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(root, 'store', '.dashboard-token'), 'dash-token\n')
  writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=proba-fo\n')
  writeFileSync(join(root, 'store', 'tokens', 'proba-fo.token'), 'dash-token\n')
  server = createServer((req, res) => {
    const m = (req.url ?? '').match(/^\/api\/tasks\/([^/]+)\/timeline$/)
    const id = m ? decodeURIComponent(m[1]!) : ''
    const [code, body] = m && id in timelines ? [status, { task: id, items: timelines[id] }] : [404, { error: 'not found' }]
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  status = 200
  timelines = {}
})

function check(task: string, repo: string, pr: string, head: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('python3', ['-B', checker, '--task', task, '--repo', repo, '--pr', pr, '--head', head], { env: { ...process.env, MARVEEN_WEB_PORT: String(port) } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })
}

describe('verdict-fej-ellenor.py', () => {
  it('the calibration acrobot asked for: a verdict on an older head refuses and names both heads; the same head passes', async () => {
    timelines = { t: [verdict(`APPROVE KratoBal/caparium-napplo#194 pr-cap194 fej ${OLD}`)] }
    const old = await check('t', 'KratoBal/caparium-napplo', '194', NEW)
    expect(old.code).toBe(1)
    expect(old.out).toContain(`a verdict fej: ${OLD}`)
    expect(old.out).toContain(`a PR fej:      ${NEW}`)
    expect(old.out).toContain('MASIK fejre szol')
    const same = await check('t', 'KratoBal/caparium-napplo', '194', OLD)
    expect([same.code, same.out.includes('rendben')]).toEqual([0, true])
  })

  it('the LATEST verdict counts: an APPROVE after a CHANGES passes, a CHANGES after an APPROVE refuses; one second, the higher id', async () => {
    timelines = { t: [verdict(`CHANGES KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`), verdict(`APPROVE KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`)] }
    expect((await check('t', 'KratoBal/acroveliq', '5', NEW)).code).toBe(0)
    timelines = { t: [verdict(`APPROVE KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`), verdict(`CHANGES KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`)] }
    const changes = await check('t', 'KratoBal/acroveliq', '5', NEW)
    expect([changes.code, changes.out.includes('legutolso verdict CHANGES')]).toEqual([1, true])
    // the same second: the event written later (the higher id) is the latest, whatever the order of the list
    const a = { ...verdict(`CHANGES KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`), at: 5000, id: 70 }
    const b = { ...verdict(`APPROVE KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`), at: 5000, id: 71 }
    timelines = { t: [b, a] }
    expect((await check('t', 'KratoBal/acroveliq', '5', NEW)).code).toBe(0)
  })

  it('no verdict refuses: none at all, only a review request, one by another actor, on another PR or another repo', async () => {
    const ask: Item = { source: 'event', kind: 'review_requested', actor: 'nautilus', ref: `KratoBal/acroveliq#5 fej ${NEW}`, at: 1, id: 1 }
    timelines = {
      t: [
        ask,
        verdict(`APPROVE KratoBal/acroveliq#5 pr-marveen5 fej ${NEW}`, 'nautilus'),
        verdict(`APPROVE KratoBal/acroveliq#55 pr-marveen55 fej ${NEW}`),
        verdict(`APPROVE KratoBal/acropora-os#5 pr-5 fej ${NEW}`),
      ],
    }
    const r = await check('t', 'KratoBal/acroveliq', '5', NEW)
    expect([r.code, r.out.includes('nincs verdict')]).toEqual([1, true])
  })

  it('a short head names no commit: refused even when it is the PR head\'s prefix; a verdict without a head too', async () => {
    timelines = { t: [verdict(`APPROVE KratoBal/acroveliq#5 pr-marveen5 fej ${NEW.slice(0, 7)}`)] }
    const short = await check('t', 'KratoBal/acroveliq', '5', NEW)
    expect([short.code, short.out.includes('nem 40 jegyu')]).toEqual([1, true])
    timelines = { t: [verdict('APPROVE KratoBal/acroveliq#5 pr-marveen5')] }
    expect((await check('t', 'KratoBal/acroveliq', '5', NEW)).code).toBe(1)
  })

  it('the renamed fleet repo: a verdict naming KratoBal/marveen counts for KratoBal/acroveliq', async () => {
    timelines = { t: [verdict(`APPROVE KratoBal/marveen#5 pr-marveen5 fej ${NEW}`)] }
    expect((await check('t', 'KratoBal/acroveliq', '5', NEW)).code).toBe(0)
  })

  it('a timeline that cannot be read is exit 3, not "no verdict"; a wrong call is exit 2', async () => {
    timelines = { t: [] }
    status = 500
    const r = await check('t', 'KratoBal/acroveliq', '5', NEW)
    expect([r.code, r.out.includes('nem olvashato')]).toEqual([3, true])
    expect((await check('t', 'KratoBal/acroveliq', '5', 'abc1234')).code).toBe(2)
  })
})

describe('pr-beolvaszt.sh asks it before every merge, and stops on its no', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'pr-beolvaszt.sh'), 'utf8')
  const gate = src.indexOf('# === A LEGUTOLSO VERDICT A PR MOSTANI FEJERE SZOL')
  const call = src.indexOf("_vf = subprocess.run(['python3', '-B', verdict_szkript, '--task', task, '--repo', repo, '--pr', str(pr), '--head', sha]")
  const nez = src.indexOf("print('CSAK NEZEM (--nez): minden feltetel teljesul, de NEM olvasztok be.')")
  // the machine-review gate comes right after it: the GitHub review is checked only once the verdict is
  const gepi = src.indexOf('# === A GEPI REVIEW A JOVAHAGYOTT FEJEN (b25-gepi-review) ===')
  const put = src.indexOf("text, code = api('PUT', f'/pulls/{pr}/merge'")

  it('the gate stands before the --nez answer and the merge PUT, and runs in every mode', () => {
    expect(gate).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(gate)
    expect(gepi).toBeGreaterThan(call)
    expect(nez).toBeGreaterThan(gepi)
    expect(put).toBeGreaterThan(nez)
    // not under the machine-review switch's naplo mode: the gate's own block knows no gepi_kenyszerit
    expect(src.slice(gate, gepi)).not.toContain('gepi_kenyszerit')
  })

  it('a no stops the run unless the stated reason lifts it; no task is a no as well', () => {
    const block = src.slice(gate, gepi)
    expect(block).toContain("if not task:\n    _vf_szoveg, _vf_kod = 'nincs feladat (--task)")
    expect(block).toMatch(/elif verdict_ok:[\s\S]*else:\n    print\('NEM OLVASZTOK: a legutolso verdict nem a PR mostani fejet hagyja jova\.'\)[\s\S]*sys\.exit\(1\)/)
    expect(src).toContain('VERDICT_OK="${1:?a --verdict-fej-rendben INDOKOT var')
    expect(src).toMatch(/"\$VERDICT_FEJ" "\$\{VERDICT_OK:-\}" << 'PYEOF'/)
  })
})
