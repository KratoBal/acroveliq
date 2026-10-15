// The controller's side of the GPT runner's channel (src/gpt-runner-client.ts; task
// t-20261014-gpt-futtato-kontener). WHAT TURNS THIS RED:
//   - with the switch off, the controller calls the runner (one call is enough);
//   - with the switch on but WITHOUT the package and filters, the controller gets a runner;
//   - the wired controller (debateDeps) has a runner with the default (off) switch;
//   - a package the filter stops (GptBlocked), or a missing token, still reaches the runner, or the
//     thread is not told which piece stopped it;
//   - GPT's end mark is posted, or does not end the phase;
//   - an answer the output filter stops is posted to the thread;
//   - the address is anything but http://<IPv4>:<port>.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'
import { handleOwnerMessage, type DebateConfig, type DebateDeps } from '../debates.js'
import { makeRunGpt, readFinal, readRunnerToken, runnerEndpoint, type GptFilters, type RunnerClientOptions } from '../gpt-runner-client.js'
import { GptBlocked } from '../gpt-package.js'
import { debateDeps, debateFilters } from '../web/debates-discord.js'

const THREAD = '1559470238783770624'
const OWNER = '111'
const cfg: DebateConfig = { threads: [THREAD], ownerIds: [OWNER], turnTimeoutSeconds: 900, phaseTimeoutSeconds: 3600, gptDailyCap: 40 }
const TOKEN = 'futtato-token-0123456789abcdef'

let now = 1_792_000_000
let posts: string[]
let fetches: { url: string; init: RequestInit }[]
let logs: string[]
let dir: string

const fakeFetch = (answer: unknown = { text: 'GPT szerint igen.' }, status = 200) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

const filters = (o: Partial<GptFilters> = {}): GptFilters => ({
  buildPrompt: async (_d, ask) => ({ prompt: `CSOMAG: ${ask}` }),
  allowOutput: () => true,
  ...o,
})

function opts(o: Partial<RunnerClientOptions> = {}): RunnerClientOptions {
  return { enabled: true, url: 'http://10.0.2.1:8790', tokenFile: join(dir, 'token'), timeoutMs: 5000, filters: filters(), fetchImpl: fakeFetch(), log: (l) => logs.push(l), ...o }
}

function deps(runGpt: DebateDeps['runGpt']): DebateDeps {
  return { post: async (_t, text) => { posts.push(text); return String(9000 + posts.length) }, tellAcrobot: () => 1, runGpt, now: () => now }
}

/** Starts a debate and asks GPT once (`gpt: ...`), the way the owner does in the thread. */
async function askGpt(runGpt: DebateDeps['runGpt']) {
  await handleOwnerMessage(getDb(), deps(runGpt), cfg, THREAD, { id: String(++now), content: 'vita os gpt: Mi legyen?' }, OWNER)
  await handleOwnerMessage(getDb(), deps(runGpt), cfg, THREAD, { id: String(++now), content: 'gpt: mit gondolsz?' }, OWNER)
}

beforeEach(() => {
  initDatabase(':memory:')
  posts = []
  fetches = []
  logs = []
  dir = mkdtempSync(join(tmpdir(), 'gpt-kliens-'))
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 })
  return () => rmSync(dir, { recursive: true, force: true })
})

describe('the switch', () => {
  it('KLIENS-OFF: switched off, the controller calls the runner ZERO times, with the address, token and filters all there', async () => {
    const runGpt = makeRunGpt(opts({ enabled: false }))
    await askGpt(runGpt)
    expect([runGpt, fetches.length]).toEqual([null, 0])
    expect(posts.some((p) => /GPT-futtató nincs bekapcsolva/.test(p))).toBe(true)
  })

  it('KLIENS-NO-FILTERS: switched ON but without the package and filters (PR 2): still no runner, zero calls, one log line', async () => {
    const runGpt = makeRunGpt(opts({ filters: null }))
    await askGpt(runGpt)
    expect([runGpt, fetches.length, logs]).toEqual([null, 0, ['GPT-futtato: a kapcsolo be van kapcsolva, de nincs csomag-epito es szuro (2. PR): a GPT-oldal kikapcsolva marad']])
  })

  it('KLIENS-WIRED: the wired controller has no runner with the default (off) switch; its filters are the real package', () => {
    const wired = debateDeps({ send: async () => '1', read: async () => [] } as never)
    // and the step after a hand-in goes to the background there (the HTTP answer does not wait for GPT)
    expect([wired.runGpt, typeof wired.defer]).toEqual([null, 'function'])
    const f = debateFilters(getDb())
    expect([typeof f.buildPrompt, typeof f.allowOutput, makeRunGpt(opts({ filters: f })) != null]).toEqual(['function', 'function', true])
  })

  it('KLIENS-URL: only http://<IPv4>:<port>; a name, https, a path, a credential or a bad octet is no runner', () => {
    expect(runnerEndpoint('http://10.0.2.1:8790')).toBe('http://10.0.2.1:8790/futtat')
    for (const bad of ['', 'http://gpt-szolga:8790', 'https://10.0.2.1:8790', 'http://10.0.2.1:8790/x', 'http://u:p@10.0.2.1:8790', 'http://10.0.2.256:8790', 'http://10.0.2.1', 'http://10.0.2.1:99999']) {
      expect([bad, runnerEndpoint(bad), makeRunGpt(opts({ url: bad }))]).toEqual([bad, null, null])
    }
  })
})

describe('a call', () => {
  it('KLIENS-ON: switched on with filters: one POST to /futtat with the token from the file and ONLY the filtered package; the answer is posted', async () => {
    await askGpt(makeRunGpt(opts()))
    expect(fetches.length).toBe(1)
    const f = fetches[0]!
    const headers = f.init.headers as Record<string, string>
    expect([f.url, f.init.method, headers.authorization, JSON.parse(String(f.init.body))]).toEqual(['http://10.0.2.1:8790/futtat', 'POST', `Bearer ${TOKEN}`, { prompt: expect.stringMatching(/^CSOMAG: /) }])
    expect(posts.some((p) => p.includes('GPT szerint igen.'))).toBe(true)
  })

  it('KLIENS-FILTER-IN: a package the filter stops does not leave: zero calls, and the thread says which piece (not its content)', async () => {
    await askGpt(makeRunGpt(opts({ filters: filters({ buildPrompt: async () => { throw new GptBlocked('GPT most nem kapja meg a beszélgetést: Balázs 1. üzenete titok-alakot tartalmaz (GitHub token).', 'secret') } }) })))
    expect([fetches.length, posts.some((p) => p.includes('Balázs 1. üzenete titok-alakot tartalmaz')), posts.some((p) => /futtató hibát adott/.test(p))]).toEqual([0, true, false])
  })

  it('KLIENS-FINAL: an answer whose last line is the end mark ends the phase, and the mark is not posted', () => {
    expect([
      readFinal('Egyetértek.\n[VÉGE]'), readFinal('Egyetértek.\n[VÉGE]  \n'), readFinal('A [VÉGE] jel a szövegben\nnem zár.'), readFinal('[VÉGE]'),
    ]).toEqual([{ text: 'Egyetértek.', final: true }, { text: 'Egyetértek.', final: true }, { text: 'A [VÉGE] jel a szövegben\nnem zár.', final: false }, { text: '[VÉGE]', final: false }])
  })

  it('KLIENS-NOTICE: the package\'s note (older messages left out) is said in the thread before GPT\'s answer', async () => {
    await askGpt(makeRunGpt(opts({ filters: filters({ buildPrompt: async (_d, ask) => ({ prompt: ask, notice: 'A régebbi 3 üzenet kimaradt.' }) }) })))
    const n = posts.findIndex((p) => p.includes('A régebbi 3 üzenet kimaradt.'))
    const a = posts.findIndex((p) => p.includes('GPT szerint igen.'))
    expect([n >= 0, n < a]).toEqual([true, true])
  })

  it('KLIENS-FILTER-OUT: an answer the output filter stops is not posted', async () => {
    await askGpt(makeRunGpt(opts({ filters: filters({ allowOutput: () => false }), fetchImpl: fakeFetch({ text: 'TITKOS-VALASZ' }) })))
    expect([fetches.length, posts.some((p) => p.includes('TITKOS-VALASZ'))]).toEqual([1, false])
  })

  it('KLIENS-OUTPUT-BLOCKED: an answer the output filter stops is said as such in the thread, not as a runner failure (barracuda, #149)', async () => {
    await askGpt(makeRunGpt(opts({ filters: filters({ allowOutput: () => false }) })))
    expect([posts.some((p) => p.includes('GPT válasza a kimeneti titok-szűrőn fennakadt')), posts.some((p) => /futtató hibát adott/.test(p))]).toEqual([true, false])
  })

  it('KLIENS-UNAVAILABLE: the runner not reachable at all (refused, timed out): the thread says the service is likely not running and names the host command', async () => {
    const refused = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await askGpt(makeRunGpt(opts({ fetchImpl: refused })))
    expect([posts.some((p) => p.includes('a futtató nem érhető el') && p.includes('systemctl status gpt-szolga.service')), posts.some((p) => /futtató hibát adott/.test(p))]).toEqual([true, false])
  })

  it('KLIENS-TOKEN: the token is read at every call; missing or malformed: zero calls', async () => {
    rmSync(join(dir, 'token'))
    await askGpt(makeRunGpt(opts()))
    writeFileSync(join(dir, 'token'), 'rovid')
    expect([fetches.length, readRunnerToken(join(dir, 'token')), readRunnerToken(join(dir, 'nincs'))]).toEqual([0, null, null])
  })

  it('KLIENS-ERRORS: a non-2xx answer or one without text is an error, never an empty post', async () => {
    for (const f of [fakeFetch({ hiba: 'x' }, 502), fakeFetch({ nem: 'szoveg' }), fakeFetch({ text: '  ' })]) {
      posts = []
      initDatabase(':memory:')
      await askGpt(makeRunGpt(opts({ fetchImpl: f })))
      expect(posts.some((p) => /futtató hibát adott/.test(p))).toBe(true)
    }
  })
})
