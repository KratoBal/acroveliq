// The access matrix (acrovelIQ P0-1, PR 3a). WHAT TURNS THIS RED:
//   - a rule without a grant for a column, or an `own` grant with no owner source;
//   - a request no rule answers passing with any token (default-deny);
//   - a decision in the table below changing: the brief's cases among them
//     (a schedule on the main agent with another agent's token, an approval
//     decided with any token, the shared token on a critical route);
//   - the shared token, another agent or a device getting a critical route
//     outside the named exceptions;
//   - docs/access-matrix.md drifting from the code.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROUTE_RULES } from '../web/route-rules.js'
import { matchRouteRule } from '../web/route-match.js'
import { accessOf, COLUMNS, decide, renderAccessMatrix, type Caller, type Column } from '../web/route-access.js'

const S: Caller = { column: 'S', name: 'session:balazs' }
const A: Caller = { column: 'A', name: 'acrobot' }
const G: Caller = { column: 'G', name: 'murena' }
const L: Caller = { column: 'L', name: 'legacy' }
const D: Caller = { column: 'D', name: 'device:iphone' }
const F: Caller = { column: 'F', name: 'masik-flotta' }

/** The decision for a concrete request: the rule from the route matcher, then decide(). */
const allowed = (method: string, path: string, caller: Caller, owner?: string | null, shared = false) =>
  decide(matchRouteRule(method, path), caller, owner, shared).allowed

describe('the access matrix', () => {
  it('ACCESS-COMPLETE: every rule has a grant for every column, and every `own` grant knows where its owner is', () => {
    const gaps = ROUTE_RULES.flatMap((rule) => {
      const access = accessOf(rule)
      const missing = COLUMNS.filter((column) => !['yes', 'no', 'own'].includes(access.grants[column]))
      const ownerless = COLUMNS.some((column) => access.grants[column] === 'own') && !access.owner
      return missing.length || ownerless ? [`${rule.method} ${rule.path}: ${missing.join(',')}${ownerless ? ' own without owner' : ''}`] : []
    })
    expect(gaps, 'ACCESS-COMPLETE').toEqual([])
  })

  // barracuda, #20: a route no rule answers (HEAD, OPTIONS, a trailing slash) must not stay open
  it('ACCESS-DEFAULT-DENY: a request no rule answers passes only from the session', () => {
    const unruled = [
      ['GET', '/api/nincs-ilyen'],
      ['HEAD', '/api/agents'],
      ['GET', '/api/agents/'],
    ] as const
    expect(
      unruled.map(([method, path]) => [matchRouteRule(method, path), ...[S, A, G, L, D].map((caller) => allowed(method, path, caller))]),
      'ACCESS-DEFAULT-DENY',
    ).toEqual(unruled.map(() => [null, true, false, false, false, false]))
  })

  it('ACCESS-TABLE: route by route and caller by caller, the expected allow or 403', () => {
    // [method, path, caller, owner (for `own`), shared?, expected]
    const table: Array<[string, string, Caller, string | null | undefined, boolean, boolean]> = [
      // the brief's cases
      ['POST', '/api/schedules', G, 'acrobot', false, false], // a schedule on the main agent with an agent token
      ['POST', '/api/schedules', G, 'murena', false, true], // its own schedule
      ['POST', '/api/schedules', S, 'acrobot', false, true], // the session schedules for anyone
      ['POST', '/api/schedules', L, 'murena', false, false], // the shared token: no scheduling
      ['PATCH', '/api/approvals/42', A, undefined, false, false], // approval decided with the main agent's token
      ['PATCH', '/api/approvals/42', G, 'murena', false, false], // even its own request
      ['PATCH', '/api/approvals/42', L, undefined, false, false],
      ['PATCH', '/api/approvals/42', D, undefined, false, false],
      ['PATCH', '/api/approvals/42', S, undefined, false, true],
      ['POST', '/api/agents/murena/start', L, undefined, false, false], // the shared token on a critical route
      ['POST', '/api/settings', L, undefined, false, false],
      ['GET', '/api/vault/github-token', L, undefined, false, false],
      // messages: anyone sends (the sender is set from the token in 3b); reading is own
      ['POST', '/api/messages', G, undefined, false, true],
      ['POST', '/api/messages', L, undefined, false, true],
      ['GET', '/api/messages', G, 'nautilus', false, false],
      ['GET', '/api/messages', G, 'murena', false, true],
      ['PUT', '/api/messages/17', G, 'nautilus', false, false],
      // memory: own and shared, not another agent's, not the main agent's by default
      ['POST', '/api/memories', G, 'murena', false, true],
      ['POST', '/api/memories', G, 'acrobot', true, true],
      ['POST', '/api/memories', G, 'acrobot', false, false],
      // kanban: create and comment open; a card change only on its own card
      ['POST', '/api/kanban', G, undefined, false, true],
      ['POST', '/api/kanban/0a1b2c3d/comments', G, undefined, false, true],
      ['POST', '/api/kanban/0a1b2c3d/move', G, 'nautilus', false, false],
      ['POST', '/api/kanban/0a1b2c3d/move', G, 'murena', false, true],
      // sessions: the supervisor, the agent itself and a device read; not the shared token
      ['GET', '/api/agents/nautilus/pane/stream', G, 'nautilus', false, false],
      ['GET', '/api/agents/murena/pane/stream', G, 'murena', false, true],
      ['GET', '/api/agents/murena/pane/stream', A, undefined, false, true],
      ['GET', '/api/agents/murena/pane/stream', D, undefined, false, true],
      ['GET', '/api/agents/murena/pane/stream', L, undefined, false, false],
      ['POST', '/api/agents/murena/keys', A, undefined, false, false], // writing into a pane: the session only
      // lifecycle: the session and the main agent
      ['POST', '/api/agents/murena/restart', A, undefined, false, true],
      ['POST', '/api/agents/murena/restart', G, 'murena', false, false],
      // the shared-token handout: the session only
      ['GET', '/api/voice/directive', A, undefined, false, false],
      // reads and telemetry: everyone
      ['GET', '/api/agents/activity', G, undefined, false, true],
      ['POST', '/api/token-usage/collect', G, undefined, false, true],
      // devices: usual writes yes, administration no
      ['POST', '/api/memories', D, undefined, false, true],
      ['POST', '/api/settings', D, undefined, false, false],
      ['POST', '/api/autonomy', D, undefined, false, false],
      // federation peers: the wire endpoints only
      ['POST', '/api/federation/inbox', F, undefined, false, true],
      ['GET', '/api/federation/manifest', F, undefined, false, true],
      ['GET', '/api/agents', F, undefined, false, false],
    ]
    const wrong = table
      .filter(([method, path, caller, owner, shared, expected]) => allowed(method, path, caller, owner, shared) !== expected)
      .map(([method, path, caller, owner, , expected]) => `${method} ${path} ${caller.column}${owner ? ` owner ${owner}` : ''}: expected ${expected ? 'allow' : '403'}`)
    expect(wrong, 'ACCESS-TABLE').toEqual([])
  })

  it('ACCESS-INVARIANTS: the shared token, another agent and a device get a critical route only through a named exception', () => {
    const exceptions: Record<Column, Set<string>> = {
      S: new Set(),
      A: new Set(),
      // a message may be sent by anyone; its sender is set from the token
      // the plan lets the shared token write cards during the transition (plan 3: "kártya írása ✓ átmenetileg")
      L: new Set(['message-send', 'message-state', 'approval-request', 'kanban-card-change']),
      G: new Set(['message-send', 'message-state', 'approval-request', 'schedule-create', 'schedule-change', 'session-read', 'agent-taskstate', 'kanban-card-change']),
      D: new Set(['message-send', 'message-state', 'approval-request', 'session-read', 'kanban-card-change']),
    }
    const open = (['L', 'G', 'D'] as const).flatMap((column) =>
      ROUTE_RULES.filter((rule) => rule.class === 'KRITIKUS')
        .map((rule) => ({ rule, access: accessOf(rule) }))
        .filter(({ access }) => access.grants[column] !== 'no' && !exceptions[column].has(access.group))
        .map(({ rule, access }) => `${column} ${rule.method} ${rule.path} (${access.group})`),
    )
    const deviceAdmin = ROUTE_RULES.map((rule) => accessOf(rule))
      .filter((a) => ['administration', 'approval-decide', 'terminal-write', 'shared-token-handout', 'agent-lifecycle'].includes(a.group))
      .filter((a) => a.grants.D !== 'no' || a.grants.L !== 'no' || a.grants.G !== 'no')
      .map((a) => a.group)
    expect([open, deviceAdmin], 'ACCESS-INVARIANTS').toEqual([[], []])
  })

  it('ACCESS-DOC: docs/access-matrix.md is the code\'s matrix', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'access-matrix.md'), 'utf-8')
    expect(doc === renderAccessMatrix(), 'ACCESS-DOC: regenerate with `npx tsx scripts/access-matrix.ts > docs/access-matrix.md`').toBe(true)
  })
})
