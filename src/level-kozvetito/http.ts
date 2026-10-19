// The relay's only door: a small HTTP API on the internal docker network (plan v2, "Hol fut").
//
//   POST /<account>/<verb>   JSON body, `Authorization: Bearer <caller token>`   -> 200 the answer
//   GET  /healthz                                                                 -> 200
//   POST /titok/<target>/<verb>   the secret door (titok.ts), only when the settings name secret writers
//
// The network keeps strangers out; the caller token keeps the other agents out (every agent of the fleet is
// on that network). An answer carries only what the verb returns; a failure of Google answers 502 with a fixed
// text, never Google's own words.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { GoogleError } from './google.js'
import { MailRelay, Refusal } from './relay.js'
import type { SecretService } from './titok.js'

export const MAX_BODY_BYTES = 4 * 1024

class BadRequest extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
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
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadRequest('body is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadRequest('body must be a JSON object')
  return parsed as Record<string, unknown>
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  const m = /^Bearer ([^\s]{1,200})$/.exec(value ?? '')
  return m ? m[1] : undefined
}

export function createRelayServer(relay: MailRelay, secrets?: SecretService): Server {
  return createServer((req, res) => {
    const method = req.method ?? ''
    const path = (req.url ?? '').split('?')[0] ?? ''
    void (async () => {
      try {
        if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true })
        const door = /^\/titok\/([a-z-]{1,32})\/([a-z]{1,16})$/.exec(path)
        if (method === 'POST' && door && secrets) {
          const body = await readJson(req)
          return send(res, 200, await secrets.handle(bearer(req), door[1]!, door[2]!, body))
        }
        const m = /^\/([a-z]{1,16})\/([a-z-]{1,32})$/.exec(path)
        if (method === 'POST' && m) {
          const body = await readJson(req)
          return send(res, 200, await relay.handle(bearer(req), m[1]!, m[2]!, body))
        }
        return send(res, 404, { error: 'not found' })
      } catch (err) {
        if (err instanceof Refusal) return send(res, err.status, { error: err.reason })
        if (err instanceof BadRequest) return send(res, 400, { error: err.message })
        if (err instanceof GoogleError) return send(res, 502, { error: 'google failed; nothing was changed by this call' })
        return send(res, 500, { error: 'internal' })
      }
    })()
  })
}
