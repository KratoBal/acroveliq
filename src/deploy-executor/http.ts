// The executor's only door: a small HTTP API on the internal docker network
// (SB1 three-changes 1, "hívás"). The caller is not authenticated by a secret:
// a secret the fleet keeps would not protect anything, and the right to deploy
// comes from the owner's Discord answer or from the rule path's evidence on
// GitHub (rules.ts), so a false caller gets a refusal.
//
//   POST /requests    {env, app, action, sha, requester}  -> 201 the R
//   POST /executions  {r, requestMessageId}               -> 200 the R, used
//   POST /executions/by-rule  {r}                         -> 200 the R, used (rules.ts: the evidence on GitHub)
//   GET  /requests/R                                      -> 200 the R
//   GET  /healthz                                         -> 200
//
// Answers carry only what publicView lets out (ids, shas, states); a failure
// of an outside system answers 502 with a fixed text, not its message.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { RateLimited, Refusal, type DeployExecutor } from './executor.js'

export const MAX_BODY_BYTES = 8 * 1024

class BadRequest extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new BadRequest('content-type must be application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new BadRequest('body too large')
    chunks.push(chunk as Buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadRequest('body is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadRequest('body must be a JSON object')
  return parsed as Record<string, unknown>
}

function logLine(fields: Record<string, string | number>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`)
}

export function createExecutorServer(executor: DeployExecutor, log: (f: Record<string, string | number>) => void = logLine): Server {
  return createServer((req, res) => {
    const method = req.method ?? ''
    const path = (req.url ?? '').split('?')[0] ?? ''
    const done = (status: number, body: unknown, reason?: string) => {
      send(res, status, body)
      log({ method, path: path.replace(/^\/requests\/[^/]+$/, '/requests/:r'), status, ...(reason ? { reason } : {}) })
    }
    void (async () => {
      try {
        if (method === 'GET' && path === '/healthz') return done(200, { ok: true })
        if (method === 'POST' && path === '/requests') return done(201, await executor.request(await readJson(req)))
        if (method === 'POST' && path === '/executions') return done(200, await executor.execute(await readJson(req)))
        if (method === 'POST' && path === '/executions/by-rule') return done(200, await executor.executeByRule(await readJson(req)))
        const m = /^\/requests\/([A-Z0-9]{1,16})$/.exec(path)
        if (method === 'GET' && m) {
          const rec = executor.status(m[1])
          return rec ? done(200, rec) : done(404, { error: 'unknown R' })
        }
        return done(404, { error: 'not found' })
      } catch (err) {
        if (err instanceof RateLimited) return done(429, { error: err.reason }, err.reason)
        if (err instanceof Refusal) return done(403, { error: err.reason }, err.reason)
        if (err instanceof BadRequest) return done(400, { error: err.message })
        return done(502, { error: 'an outside system failed; nothing was deployed by this call unless its R shows used' }, err instanceof Error ? err.message : 'unknown')
      }
    })()
  })
}
