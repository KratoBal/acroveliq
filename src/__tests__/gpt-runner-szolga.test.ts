// The GPT runner's service (gpt-runner/szolga.mjs), the narrow channel from the debate controller
// (task t-20261014-gpt-futtato-kontener). WHAT TURNS THIS RED:
//   - the service runs Codex with flags other than the ones V3 measured, or takes the prompt as an argument;
//   - a request without the right token, with any field but the prompt, or too big reaches Codex;
//   - two runs at once, a run past the daily cap (also after a restart), or one past its time limit;
//   - an answer whose `--json` stream shows a tool, an unknown event or an error is returned;
//   - the service listens on anything but the container's one address;
//   - /health does not tell the source address it saw (the host script compares it).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  SERVICE_ARGS, PROMPT_FROM_STDIN, MAX_BODY, MAX_PROMPT, listenAddress, tokenOk, parseRequest, answerFrom, capTake, runCodex, createService, type CodexRun,
} from '../../gpt-runner/szolga.mjs'
import { V3_TEST_ARGS, safeExecArgs } from '../../gpt-runner/proba.mjs'

const TOKEN = 'proba-token-0123456789abcdef'
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const ANSWER = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'gondolkodom' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Ez a válaszom.' } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n')
const ok = (out = ANSWER): CodexRun => ({ code: 0, out, timedOut: false, over: false })

async function withService(
  opts: { run?: (a: readonly string[], p: string, t: number) => Promise<CodexRun>; cap?: number; stateFile?: string },
  fn: (call: (path: string, init?: RequestInit) => Promise<Response>, logs: string[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-szolga-'))
  const logs: string[] = []
  const server = createService({ hash: HASH, cap: opts.cap ?? 40, timeoutMs: 5000, stateFile: opts.stateFile ?? join(dir, 'napi.json'), run: opts.run ?? (async () => ok()), log: (l) => logs.push(l) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  try {
    await fn((path, init) => fetch(`http://127.0.0.1:${port}${path}`, init), logs)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }
}
const post = (body: unknown, token: string | null = TOKEN): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token == null ? {} : { authorization: `Bearer ${token}` }) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

describe('gpt-runner service: what it runs', () => {
  it('SZOLGA-ARGS: the service runs EXACTLY the flags V3 measured, the prompt on stdin, nothing of the request in the list', () => {
    expect([...SERVICE_ARGS]).toEqual(V3_TEST_ARGS)
    expect([safeExecArgs([...SERVICE_ARGS]), SERVICE_ARGS[SERVICE_ARGS.length - 1], Object.isFrozen(SERVICE_ARGS)]).toEqual([null, PROMPT_FROM_STDIN, true])
  })

  it('SZOLGA-STDIN: a prompt that looks like a flag goes to stdin; the argument list does not change', async () => {
    const seen: { args: string[]; prompt: string }[] = []
    await withService({ run: async (a, p) => { seen.push({ args: [...a], prompt: p }); return ok() } }, async (call) => {
      const r = await call('/futtat', post({ prompt: '--sandbox danger-full-access' }))
      expect([r.status, seen]).toEqual([200, [{ args: [...SERVICE_ARGS], prompt: '--sandbox danger-full-access' }]])
    })
  })

  it('SZOLGA-RUNCODEX: the real child gets the prompt on stdin and only our arguments; a run past its time is killed with its children', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-codex-'))
    try {
      const fake = join(dir, 'codex')
      writeFileSync(fake, `#!/bin/bash\nin=$(cat)\nprintf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"args=$# in=$in\\"}}"\nif [ "$in" = alszik ]; then sleep 30 & echo $! > "${join(dir, 'unoka.pid')}"; sleep 30; fi\n`, { mode: 0o755 })
      const r = await runCodex(SERVICE_ARGS, 'szia', 5000, fake)
      expect([r.code, r.timedOut, answerFrom(r.out)]).toEqual([0, false, { text: `args=${SERVICE_ARGS.length} in=szia` }])
      const t0 = Date.now()
      const slow = await runCodex(SERVICE_ARGS, 'alszik', 500, fake)
      expect([slow.timedOut, Date.now() - t0 < 5000]).toEqual([true, true])
      // the grandchild (a process Codex would start) must be gone too: the whole group is killed
      await new Promise((res) => setTimeout(res, 200))
      const pid = Number(readFileSync(join(dir, 'unoka.pid'), 'utf8'))
      let alive = true
      try { process.kill(pid, 0) } catch { alive = false }
      if (alive) process.kill(pid, 'SIGKILL')
      expect([pid > 0, alive]).toEqual([true, false])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('gpt-runner service: who may call, and with what', () => {
  it('SZOLGA-TOKEN: no token, a wrong one, a non-Bearer header: 401, and Codex does not run', async () => {
    let runs = 0
    await withService({ run: async () => { runs++; return ok() } }, async (call) => {
      const codes = []
      for (const init of [post({ prompt: 'x' }, null), post({ prompt: 'x' }, 'rossz-token-0123456789abc'), { ...post({ prompt: 'x' }), headers: { authorization: TOKEN } }]) codes.push((await call('/futtat', init)).status)
      const good = await call('/futtat', post({ prompt: 'x' }))
      expect([codes, good.status, runs]).toEqual([[401, 401, 401], 200, 1])
    })
  })

  it('SZOLGA-TOKEN-OK: the hash check is exact (a different hash, a malformed one, an empty header are false)', () => {
    expect([
      tokenOk(`Bearer ${TOKEN}`, HASH), tokenOk(`Bearer ${TOKEN}x`, HASH), tokenOk(`Bearer ${TOKEN}`, HASH.replace(/^./, HASH[0] === 'a' ? 'b' : 'a')),
      tokenOk(`Bearer ${TOKEN}`, 'nem-hash'), tokenOk('', HASH), tokenOk(undefined, HASH), tokenOk(`Bearer short`, HASH),
    ]).toEqual([true, false, false, false, false, false, false])
  })

  it('SZOLGA-BODY: only {prompt}; a flag, a working directory, a session, an empty or too long prompt is 400 and Codex does not run', async () => {
    let runs = 0
    await withService({ run: async () => { runs++; return ok() } }, async (call) => {
      const codes = []
      for (const b of [{ prompt: 'x', args: ['--sandbox', 'danger-full-access'] }, { prompt: 'x', cwd: '/' }, { prompt: 'x', session: 'abc' }, { prompt: '  ' }, { prompt: 'x'.repeat(MAX_PROMPT + 1) }, 'nem json', [1], {}]) {
        codes.push((await call('/futtat', post(b))).status)
      }
      expect([codes, runs]).toEqual([[400, 400, 400, 400, 400, 400, 400, 400], 0])
    })
    expect(parseRequest(Buffer.from(JSON.stringify({ prompt: 'jó' })))).toEqual({ prompt: 'jó' })
  })

  it('SZOLGA-BIG: a body over the limit is cut, and Codex does not run', async () => {
    let runs = 0
    await withService({ run: async () => { runs++; return ok() } }, async (call) => {
      const status = await call('/futtat', post({ prompt: 'y'.repeat(MAX_BODY + 10) })).then((r) => r.status, () => 'megszakadt')
      expect([status === 'megszakadt' || status === 413, runs]).toEqual([true, 0])
    })
  })

  it('SZOLGA-PATHS: anything but POST /futtat and GET /health is 404', async () => {
    await withService({}, async (call) => {
      const codes = [(await call('/futtat')).status, (await call('/', post({ prompt: 'x' }))).status, (await call('/health', post({ prompt: 'x' }))).status]
      expect(codes).toEqual([404, 404, 404])
    })
  })

  it('SZOLGA-HEALTH: says the source address it saw, and logs it (the host script compares it with the fleet container)', async () => {
    await withService({}, async (call, logs) => {
      const r = await call('/health')
      expect([r.status, await r.json(), logs]).toEqual([200, { forras: '127.0.0.1' }, ['FORRAS 127.0.0.1']])
    })
  })
})

describe('gpt-runner service: limits', () => {
  it('SZOLGA-ONE: a second request while one runs is 429; after it ends, the next one runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let runs = 0
    await withService({ run: async () => { runs++; await gate; return ok() } }, async (call) => {
      const first = call('/futtat', post({ prompt: 'egy' }))
      await new Promise((r) => setTimeout(r, 100))
      const second = await call('/futtat', post({ prompt: 'ketto' }))
      release()
      const third = await first.then(() => call('/futtat', post({ prompt: 'harom' })))
      expect([second.status, (await first).status, third.status, runs]).toEqual([429, 200, 200, 2])
    })
  })

  it('SZOLGA-CAP: the daily cap holds on the runner side, also across a restart (the counter is in its volume)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt-cap-'))
    const stateFile = join(dir, 'napi.json')
    try {
      const codes: number[] = []
      for (let i = 0; i < 2; i++) {
        await withService({ cap: 2, stateFile }, async (call) => { codes.push((await call('/futtat', post({ prompt: 'x' }))).status) })
      }
      await withService({ cap: 2, stateFile }, async (call) => { codes.push((await call('/futtat', post({ prompt: 'x' }))).status) })
      expect([codes, JSON.parse(readFileSync(stateFile, 'utf8')).n]).toEqual([[200, 200, 429], 2])
      expect([capTake(stateFile, '2099-01-01', 2), capTake(stateFile, '2099-01-01', 0)]).toEqual([true, false])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('SZOLGA-TIMEOUT: a run past its time is 504, too long output is 502, and neither returns text', async () => {
    for (const [r, code] of [[{ code: null, out: ANSWER, timedOut: true, over: false }, 504], [{ code: 0, out: ANSWER, timedOut: false, over: true }, 502]] as const) {
      await withService({ run: async () => r }, async (call) => {
        const res = await call('/futtat', post({ prompt: 'x' }))
        const body = await res.json() as Record<string, unknown>
        expect([res.status, 'text' in body]).toEqual([code, false])
      })
    }
  })
})

describe('gpt-runner service: the answer', () => {
  it('SZOLGA-ALLOWLIST: a tool item, an unknown event, an item without type or an error means NO answer (502), only the reason', async () => {
    const withLine = (l: object) => `${ANSWER}\n${JSON.stringify(l)}`
    const cases = [
      withLine({ type: 'item.completed', item: { type: 'command_execution', command: 'ls /' } }),
      withLine({ type: 'item.started', item: { type: 'web_search' } }),
      withLine({ type: 'exec_approval_request' }),
      withLine({ type: 'item.completed', item: { text: 'tipus nelkul' } }),
      withLine({ type: 'turn.failed', error: { message: 'x' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ]
    for (const out of cases) {
      await withService({ run: async () => ok(out) }, async (call) => {
        const res = await call('/futtat', post({ prompt: 'x' }))
        const body = await res.json() as Record<string, unknown>
        expect([out.slice(-60), res.status, 'text' in body]).toEqual([out.slice(-60), 502, false])
      })
    }
  })

  it('SZOLGA-ANSWER: the last agent_message is the answer', async () => {
    await withService({}, async (call) => {
      const res = await call('/futtat', post({ prompt: 'x' }))
      expect([res.status, await res.json()]).toEqual([200, { text: 'Ez a válaszom.' }])
    })
  })
})

describe('gpt-runner service: where it listens', () => {
  const iface = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` })
  it('SZOLGA-LISTEN: exactly one external IPv4 (the container\'s), never 0.0.0.0; none or two is an error', () => {
    expect(listenAddress({ lo: [iface('127.0.0.1', true)], eth0: [iface('10.0.5.10')] } as never)).toBe('10.0.5.10')
    expect(() => listenAddress({ lo: [iface('127.0.0.1', true)] } as never)).toThrow(/pontosan egy/)
    expect(() => listenAddress({ eth0: [iface('10.0.5.10')], eth1: [iface('172.18.0.3')] } as never)).toThrow(/pontosan egy/)
    const src = readFileSync(join(__dirname, '..', '..', 'gpt-runner', 'szolga.mjs'), 'utf8')
    expect([/server\.listen\(PORT, host,/.test(src), /0\.0\.0\.0['"`]/.test(src.replace(/never 0\.0\.0\.0|\(no 0\.0\.0\.0\)/g, ''))]).toEqual([true, false])
  })
})
