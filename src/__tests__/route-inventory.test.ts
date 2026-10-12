// The route inventory (acrovelIQ P0-1, PR 1). The access matrix can only be
// complete if every route the dashboard answers has a rule. WHAT TURNS THIS RED:
//   - a matcher in a route module (or the inline one in src/web.ts) that no
//     rule in src/web/route-rules.ts answers: a new, unruled route;
//   - a rule no matcher answers anymore: a removed or renamed route;
//   - a rule whose module is not in the dispatcher's chain;
//   - a rule with a class outside the four.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROUTE_RULES, type RouteRule } from '../web/route-rules.js'
import { matcherCovers, scanRouteMatchers, scanSuspects, type RouteMatcher } from './fixtures/route-matchers.js'

const ROUTES_DIR = join(process.cwd(), 'src', 'web', 'routes')
const WEB_TS = join(process.cwd(), 'src', 'web.ts')

/** Route files that hold no route: shared types. */
const NOT_ROUTES = new Set(['types.ts'])

/**
 * Matchers that test `path` but are not routes, each with its reason. A line
 * number is not the key: a matcher is identified by module, kind and value.
 */
const NOT_A_ROUTE: Array<{ module: string; kind: RouteMatcher['kind']; value: string; why: string }> = []

const ROUTE_FILES = readdirSync(ROUTES_DIR)
  .filter((file) => file.endsWith('.ts') && !NOT_ROUTES.has(file))
  .map((file) => join(ROUTES_DIR, file))

/** Route-like comparisons on something other than `path`, each with its reason. */
const SUSPECTS_EXPLAINED: Array<{ module: string; text: string; why: string }> = [
  {
    module: 'agents',
    text: 'path.match(newPattern)',
    why: 'matchChannelRoute builds its regexes at run time; the scanner rebuilds both forms at every call site (channelRouteSources)',
  },
  { module: 'agents', text: 'path.match(legacyPattern)', why: 'the legacy form of the same channel regexes, rebuilt at every call site' },
]

const matchers: RouteMatcher[] = [
  ...ROUTE_FILES.flatMap((file) => scanRouteMatchers(file)),
  ...scanRouteMatchers(WEB_TS),
].filter((m) => !NOT_A_ROUTE.some((n) => n.module === m.module && n.kind === m.kind && n.value === m.value))

const methodFits = (rule: RouteRule, matcher: RouteMatcher) =>
  matcher.methods === null || matcher.methods.includes(rule.method) || rule.method === 'ANY'

const describeMatcher = (m: RouteMatcher) => `${m.module}.ts:${m.line} ${m.kind} ${m.value}${m.methods ? ` [${m.methods.join(',')}]` : ''}`
const describeRule = (r: RouteRule) => `${r.method} ${r.path} (${r.module})`

describe('the route inventory', () => {
  it('ROUTE-INVENTORY-COVERED: every matcher in the code has a rule, for every method it handles', () => {
    const ruled = (m: RouteMatcher, method: string | null) =>
      ROUTE_RULES.some(
        (r) => r.module === m.module && (method === null || r.method === method || r.method === 'ANY') && matcherCovers(m, r.path),
      )
    const unruled = matchers.flatMap((m) => {
      // the methods in its condition, else the methods its block handles, else any one
      const methods = m.methods ?? (m.blockMethods.length ? m.blockMethods : [null])
      return methods.filter((method) => !ruled(m, method)).map((method) => `${describeMatcher(m)}${method ? ` needs ${method}` : ''}`)
    })
    expect(unruled, 'ROUTE-INVENTORY-COVERED: these routes have no rule in src/web/route-rules.ts').toEqual([])
  })

  it('ROUTE-INVENTORY-LIVE: every rule is still answered by a matcher of its module', () => {
    const stale = ROUTE_RULES.filter(
      (r) => !matchers.some((m) => m.module === r.module && methodFits(r, m) && matcherCovers(m, r.path)),
    ).map(describeRule)
    expect(stale, 'ROUTE-INVENTORY-LIVE: these rules match no route in the code').toEqual([])
  })

  it('ROUTE-INVENTORY-SCANNED: every route module yields matchers, and no route-like test bypasses `path`', () => {
    const silent = ROUTE_FILES.filter((file) => scanRouteMatchers(file).length === 0)
    const suspects = [...ROUTE_FILES, WEB_TS]
      .flatMap((file) => scanSuspects(file))
      .filter((s) => !SUSPECTS_EXPLAINED.some((e) => e.module === s.module && s.text.startsWith(e.text)))
      .map((s) => `${s.module}.ts:${s.line} ${s.text}`)
    expect([silent, suspects], 'ROUTE-INVENTORY-SCANNED').toEqual([[], []])
  })

  it('ROUTE-INVENTORY-CHAIN: every rule\'s module is in the dispatcher\'s chain, and every class is one of the four', () => {
    const web = readFileSync(WEB_TS, 'utf-8')
    const chained = new Set([...web.matchAll(/from '\.\/web\/routes\/([\w-]+)\.js'/g)].map((m) => m[1]!).concat('web'))
    expect(
      [
        [...new Set(ROUTE_RULES.map((r) => r.module))].filter((m) => !chained.has(m)),
        ROUTE_RULES.filter((r) => !['KRITIKUS', 'ERZEKENY', 'OLVASO', 'NYILVANOS'].includes(r.class)).map(describeRule),
      ],
      'ROUTE-INVENTORY-CHAIN',
    ).toEqual([[], []])
  })
})
