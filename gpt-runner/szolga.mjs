// The GPT runner's service: the narrow channel from the debate controller (task
// t-20261014-gpt-futtato-kontener; acrobot 30864/30868, barracuda 30866/30873).
//
// Runs in the runner's own container (uid 10002, read-only root, no capability), started only by
// the host script; nothing restarts it. It answers ONE thing: a prompt from the controller, run
// through Codex with the SAME fixed flags the probe's V3 measured (read-only sandbox, approval
// never, both shell tools off). The caller gives a prompt and nothing else: no Codex flag, no
// working directory, no sandbox. The prompt goes in on stdin, never as an argument, so no text
// can be read as a flag.
//
// The binding rules (barracuda 30866, acrobot 30868):
//   - it listens on the container's ONE address (never 0.0.0.0); the host publishes that port on
//     one host address, and the host firewall lets only the fleet container's address in;
//   - a Bearer token, compared by its SHA-256 in constant time; the runner keeps only the hash;
//   - one run at a time (a parallel request is 429), a per-request time limit, and a daily cap
//     HERE too (the runner spends the owner's ChatGPT plan, the controller's cap is not enough);
//   - the answer is returned only if the `--json` stream shows nothing but the answer and the
//     reasoning (the V3 allowlist): any tool, unknown event or error, and there is no answer;
//   - GET /health tells the caller the source address the service SAW: the host script compares
//     it with the fleet container's address (a docker-proxy in the way would show the gateway).
//
// The conversation package and the secret filters are the controller's side (PR 2): the
// controller cannot switch this channel on without them.
import http from 'node:http'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROMPT_FROM_STDIN, RUN_COMMON, RUN_TOOLS_OFF, toolUses } from './proba.mjs'

export const PORT = 8790
export const MAX_BODY = 64 * 1024
export const MAX_PROMPT = 48 * 1024
export const MAX_OUTPUT = 2 * 1024 * 1024

/** The exact Codex arguments of a service run: the V3-measured flags, then stdin as the prompt.
 *  Nothing of the request goes into this list. */
export { PROMPT_FROM_STDIN }
export const SERVICE_ARGS = Object.freeze([...RUN_COMMON, ...RUN_TOOLS_OFF, PROMPT_FROM_STDIN])

/** The one non-internal IPv4 address of the container; anything else is an error (no 0.0.0.0). */
export function listenAddress(ifaces = os.networkInterfaces()) {
  const found = []
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) found.push(a.address)
  }
  if (found.length !== 1) throw new Error(`pontosan egy kulso IPv4-cim kell, ennyi van: ${found.length} (${found.join(', ')})`)
  return found[0]
}

/** `Authorization: Bearer <token>` against the stored SHA-256 (hex), in constant time. */
export function tokenOk(header, hashHex) {
  if (typeof hashHex !== 'string' || !/^[0-9a-f]{64}$/.test(hashHex)) return false
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(typeof header === 'string' ? header : '')
  if (!m) return false
  const got = createHash('sha256').update(m[1]).digest()
  return timingSafeEqual(got, Buffer.from(hashHex, 'hex'))
}

/** The request body: exactly `{ "prompt": "<text>" }`. */
export function parseRequest(buf) {
  let body
  try { body = JSON.parse(buf.toString('utf8')) } catch { return { error: 'nem JSON' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'nem objektum' }
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'prompt') return { error: `csak a prompt mezo engedett, jott: ${keys.join(',') || 'semmi'}` }
  const { prompt } = body
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'ures prompt' }
  if (Buffer.byteLength(prompt) > MAX_PROMPT) return { error: `a prompt tobb, mint ${MAX_PROMPT} bajt` }
  return { prompt }
}

/** The answer of one `--json` run, or why there is none. */
export function answerFrom(jsonl) {
  const u = toolUses(jsonl)
  if (u.tools.length || u.unknown.length) return { refused: `eszkozhasznalat vagy ismeretlen esemeny: eszkoz=${u.tools.join(',') || 'nincs'}, ismeretlen=${u.unknown.join(',') || 'nincs'}` }
  if (u.errors.length) return { refused: `a futas hibat adott: ${u.errors.join(',')}` }
  let text = null
  for (const line of jsonl.split('\n')) {
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text
  }
  return text && text.trim() ? { text } : { refused: 'nincs valasz a futasban' }
}

/** The daily counter, kept in the runner's own volume so a restart does not reset it. UTC day. */
export function capTake(file, day, cap) {
  let state = { day, n: 0 }
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    if (s && s.day === day && Number.isInteger(s.n) && s.n >= 0) state = s
  } catch { /* none yet, or unreadable: a new day */ }
  if (state.n >= cap) return false
  writeFileSync(`${file}.uj`, JSON.stringify({ day, n: state.n + 1 }), { mode: 0o600 })
  renameSync(`${file}.uj`, file)
  return true
}

/** Codex as a child: stdin is the prompt, a minimal environment, killed with its group on time. */
export function runCodex(args, prompt, timeoutMs, bin = 'codex') {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: '/tmp',
      env: { HOME: process.env.HOME ?? '/home/gpt', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let out = ''
    let over = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }, timeoutMs)
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; else over = true })
    child.stderr.resume()
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, timedOut, over }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut, over }) })
    child.stdin.end(prompt)
  })
}

/** The HTTP service; `run` is runCodex unless a test gives a fake. */
export function createService({ hash, cap, timeoutMs, stateFile, run = runCodex, now = () => new Date(), log = (l) => console.log(l) }) {
  let busy = false
  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return http.createServer((req, res) => {
    const from = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (req.method === 'GET' && req.url === '/health') {
      log(`FORRAS ${from}`)
      return send(res, 200, { forras: from })
    }
    if (req.method !== 'POST' || req.url !== '/futtat') return send(res, 404, { hiba: 'nincs ilyen' })
    if (!tokenOk(req.headers.authorization, hash)) { log(`ELUTASITVA ${from} token`); return send(res, 401, { hiba: 'hitelesites' }) }
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { tooBig = true; req.destroy() } else chunks.push(c) })
    req.on('end', async () => {
      if (tooBig) return
      const parsed = parseRequest(Buffer.concat(chunks))
      if (parsed.error) return send(res, 400, { hiba: parsed.error })
      if (busy) return send(res, 429, { hiba: 'egy futas mar fut' })
      busy = true
      try {
        if (!capTake(stateFile, now().toISOString().slice(0, 10), cap)) return send(res, 429, { hiba: `elerte a napi ${cap} futast` })
        const r = await run(SERVICE_ARGS, parsed.prompt, timeoutMs)
        if (r.timedOut) { log(`IDOTULLEPES ${from}`); return send(res, 504, { hiba: 'idotullepes' }) }
        if (r.over) { log(`TUL-HOSSZU ${from}`); return send(res, 502, { hiba: 'a kimenet tul hosszu' }) }
        const a = answerFrom(r.out)
        if (a.refused) { log(`NINCS-VALASZ ${from} ${a.refused}`); return send(res, 502, { hiba: a.refused }) }
        log(`VALASZ ${from} ${Buffer.byteLength(a.text)} bajt`)
        return send(res, 200, { text: a.text })
      } finally {
        busy = false
      }
    })
    req.on('error', () => {})
  })
}

export async function main() {
  const hash = process.env.SZOLGA_TOKEN_SHA256 ?? ''
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('SZOLGA_TOKEN_SHA256: 64 hexa jegy kell')
  const cap = Number(process.env.SZOLGA_NAPI_PLAFON ?? '40')
  const timeoutMs = 1000 * Number(process.env.SZOLGA_IDOKORLAT_MP ?? '180')
  if (!Number.isInteger(cap) || cap < 0 || !(timeoutMs > 0)) throw new Error('SZOLGA_NAPI_PLAFON vagy SZOLGA_IDOKORLAT_MP hibas')
  const host = listenAddress()
  const server = createService({ hash, cap, timeoutMs, stateFile: join(process.env.HOME ?? '/home/gpt', 'szolga-napi.json') })
  server.headersTimeout = 10_000
  server.requestTimeout = timeoutMs + 30_000
  server.maxConnections = 4
  server.listen(PORT, host, () => console.log(`SZOLGA figyel ${host}:${PORT}`))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
