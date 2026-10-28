import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getPendingMessages } from '../db.js'

// Override MAIN_AGENT_ID before the route module loads so the notification
// targets the configured value, not a hardcoded agent id.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a' }
})

import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

function fakePost(path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

function fakePatch(id: string, body: unknown, auth?: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'PATCH', url, auth } as RouteContext, out }
}

describe('approvals notification target', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('sends the inter-agent notification to MAIN_AGENT_ID, not a hardcoded agent id', async () => {
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send weekly digest',
    })

    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)

    // The notification must go to the mocked MAIN_AGENT_ID value.
    const pending = getPendingMessages('agent-a')
    expect(pending.length).toBe(1)
    expect(pending[0].to_agent).toBe('agent-a')
    expect(pending[0].from_agent).toBe('system')
    expect(pending[0].content).toContain('[APPROVAL_REQUEST]')

    // Regression guard: no message may land on a different target.
    const wrongTarget = getPendingMessages('agent-b')
    expect(wrongTarget.length).toBe(0)
  })
})

describe('approvals bash_command routing', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('a sub-agent bash_command request still reaches the main agent in-band', async () => {
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'bash_command',
      action_description: 'cat /tmp/x',
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(201)
    const pending = getPendingMessages('agent-a')
    expect(pending.length).toBe(1)
    expect(pending[0].content).toContain('category=bash_command')
  })
})

describe('approvals self-approval guard', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('returns 403 when resolved_by matches the requesting agent_id', async () => {
    // Create an approval for agent-b
    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
    })
    await tryHandleApprovals(postCtx)
    expect(postOut.status).toBe(201)
    const id = postOut.body.id

    // agent-b attempts to approve its own request
    const { ctx: patchCtx, out: patchOut } = fakePatch(id, {
      status: 'approved',
      resolved_by: 'agent-b',
    })
    const handled = await tryHandleApprovals(patchCtx)
    expect(handled).toBe(true)
    expect(patchOut.status).toBe(403)
    expect(patchOut.body.error).toMatch(/cannot approve its own request/)
  })

  it('allows approval when resolved_by differs from the requesting agent_id', async () => {
    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
    })
    await tryHandleApprovals(postCtx)
    const id = postOut.body.id

    // A different caller (e.g. the owner via telegram_text) approves
    const { ctx: patchCtx, out: patchOut } = fakePatch(id, {
      status: 'approved',
      resolved_by: 'telegram_text',
    })
    const handled = await tryHandleApprovals(patchCtx)
    expect(handled).toBe(true)
    expect(patchOut.status).toBe(200)
    expect(patchOut.body.status).toBe('approved')
  })
})

// The permission-approval hook lets a sub-agent's command through when the row's
// resolved_by is the main agent, so that field must be the credential's word.
describe('approvals bash_command decider is the credential, not the body', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  async function bashRow(): Promise<string> {
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'bash_command',
      action_description: 'cat /tmp/x',
    })
    await tryHandleApprovals(ctx)
    return out.body.id
  }

  it('PEER-CLOSE: another sub-agent\'s token closes no peer\'s row, in any status; the row stays for the main agent (card 6378217b)', async () => {
    const id = await bashRow()
    for (const status of ['approved', 'rejected', 'timeout']) {
      // it claims the main agent in the body, too: the credential names it, and it is not the one who judges
      const { ctx, out } = fakePatch(id, { status, resolved_by: 'agent-a' }, { kind: 'token', actor: 'agent-c' } as RouteContext['auth'])
      await tryHandleApprovals(ctx)
      expect([status, out.status, out.body.error]).toEqual([status, 403, expect.stringMatching(/main agent or the owner's session/)])
    }
    const { ctx, out } = fakePatch(id, { status: 'approved' }, { kind: 'token', actor: 'agent-a' } as RouteContext['auth'])
    await tryHandleApprovals(ctx)
    expect([out.status, out.body.status, out.body.resolved_by]).toEqual([200, 'approved', 'agent-a'])
  })

  it('PEER-CLOSE: the owner\'s session decides a sub-agent\'s row; the main agent\'s own row only the session decides', async () => {
    const id = await bashRow()
    const { ctx, out } = fakePatch(id, { status: 'rejected' }, { kind: 'session', user: 'owner' } as RouteContext['auth'])
    await tryHandleApprovals(ctx)
    expect([out.status, out.body.resolved_by]).toEqual([200, 'owner'])

    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', { agent_id: 'agent-a', category: 'bash_command', action_description: 'ls /tmp' })
    await tryHandleApprovals(postCtx)
    const own = postOut.body.id
    for (const actor of ['agent-c', 'agent-a']) {
      const { ctx: c, out: o } = fakePatch(own, { status: 'approved' }, { kind: 'token', actor } as RouteContext['auth'])
      await tryHandleApprovals(c)
      expect([actor, o.status]).toEqual([actor, 403])
    }
    const { ctx: s, out: so } = fakePatch(own, { status: 'approved' }, { kind: 'session', user: 'owner' } as RouteContext['auth'])
    await tryHandleApprovals(s)
    expect(so.status).toBe(200)
  })

  it('the main agent\'s own token is recorded as the main agent, whatever the body says', async () => {
    const id = await bashRow()
    const { ctx, out } = fakePatch(id, { status: 'approved', resolved_by: 'somebody-else' }, { kind: 'token', actor: 'agent-a' } as RouteContext['auth'])
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(out.body.resolved_by).toBe('agent-a')
  })

  it('the shared token and a missing credential cannot decide it with a declared resolved_by, and the row stays pending', async () => {
    const id = await bashRow()
    for (const auth of [{ kind: 'token', actor: 'legacy' }, undefined] as RouteContext['auth'][]) {
      const { ctx, out } = fakePatch(id, { status: 'approved', resolved_by: 'agent-a' }, auth)
      await tryHandleApprovals(ctx)
      expect(out.status).toBe(403)
      expect(out.body.error).toMatch(/names its holder/)
    }
    const { ctx: get, out: got } = fakePatch(id, { status: 'timeout', resolved_by: 'x' }, { kind: 'token', actor: 'agent-a' } as RouteContext['auth'])
    await tryHandleApprovals(get)
    expect(got.status).toBe(200) // it was still pending: the refusals changed nothing
  })

  it('every other category still takes a declared resolved_by from the shared token', async () => {
    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', { agent_id: 'agent-b', category: 'email_send', action_description: 'x' })
    await tryHandleApprovals(postCtx)
    const { ctx, out } = fakePatch(postOut.body.id, { status: 'approved', resolved_by: 'telegram_text' }, { kind: 'token', actor: 'legacy' } as RouteContext['auth'])
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
  })
})
