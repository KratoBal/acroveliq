// Which route rule a request is (acrovelIQ P0-1). The rules in route-rules.ts
// are the route inventory: the route-inventory test keeps them complete. This
// module finds the rule a concrete (method, path) answers to, at run time:
// the actor log records the rule's pattern instead of the raw path (no value
// from a path reaches the log), and the access matrix decides by it.
//
// Pattern syntax (route-rules.ts): `:param` is one segment, `(a|b)` one of the
// alternatives, a trailing `*` any rest.

import { ROUTE_RULES, type RouteRule } from './route-rules.js'

interface Compiled {
  rule: RouteRule
  regex: RegExp
  /** Literal characters outside parameters: the more, the more specific. */
  literal: number
  params: number
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The regex of a rule pattern; with `capture`, each `:param` is a group, in order. */
export function compileRulePath(path: string, capture = false): RegExp {
  let out = ''
  let rest = path
  while (rest.length) {
    const param = /^:[A-Za-z_]+/.exec(rest)
    const alternatives = /^\(([^)]*)\)/.exec(rest)
    if (param) {
      out += capture ? '([^/]+)' : '[^/]+'
      rest = rest.slice(param[0].length)
    } else if (alternatives) {
      out += `(?:${alternatives[1]!.split('|').map(escape).join('|')})`
      rest = rest.slice(alternatives[0].length)
    } else if (rest === '*') {
      out += '.*'
      rest = ''
    } else {
      out += escape(rest[0]!)
      rest = rest.slice(1)
    }
  }
  return new RegExp(`^${out}$`)
}

const compiled: Compiled[] = ROUTE_RULES.map((rule) => ({
  rule,
  regex: compileRulePath(rule.path),
  literal: rule.path.replace(/:[A-Za-z_]+|\([^)]*\)|\*/g, '').length,
  params: (rule.path.match(/:[A-Za-z_]+|\([^)]*\)|\*/g) ?? []).length,
}))

/**
 * The rule a request answers to: the one whose pattern matches and whose
 * method fits (or ANY), the most specific first (the most literal characters,
 * then the fewest parameters), so `/api/agents/activity` is not taken for
 * `/api/agents/:name`. Null when no rule matches.
 */
export function matchRouteRule(method: string, path: string): RouteRule | null {
  let best: Compiled | null = null
  for (const entry of compiled) {
    if (entry.rule.method !== method && entry.rule.method !== 'ANY') continue
    if (!entry.regex.test(path)) continue
    if (
      !best ||
      entry.literal > best.literal ||
      (entry.literal === best.literal && entry.params < best.params) ||
      (entry.literal === best.literal && entry.params === best.params && best.rule.method === 'ANY' && entry.rule.method !== 'ANY')
    )
      best = entry
  }
  return best?.rule ?? null
}

/** The route families the rules know: the first segment under /api of a rule's literal start (`/api/kanban`). */
const RULE_FAMILIES: ReadonlySet<string> = new Set(
  ROUTE_RULES.map((rule) => rule.path.split('/').slice(0, 3).join('/')).filter((family) => /^\/api\/[a-z0-9-]+$/.test(family)),
)

/** The key a request no rule answers is logged under, bare or with its family (unknownRouteKey). */
export const UNKNOWN_ROUTE = ':ismeretlen'

/**
 * How a log keeps a request no rule answers: `:ismeretlen`, with its family
 * (`:ismeretlen /api/kanban`) when its first segment under /api is one the
 * rules know. The family is then one of our own constants, never a value from
 * the path (barracuda, #20); any other path stays bare `:ismeretlen`. Without
 * the family a preflight row could not be traced to a caller (2026-10-16:
 * acrobot 4x, murena 1x, path unknown).
 */
export function unknownRouteKey(path: string): string {
  const family = path.split('/').slice(0, 3).join('/')
  return RULE_FAMILIES.has(family) ? `${UNKNOWN_ROUTE} ${family}` : UNKNOWN_ROUTE
}

/** True for a logged path that is unknownRouteKey's, not a rule's pattern (no rule pattern starts with `:`). */
export const isUnknownRouteKey = (key: string): boolean => key === UNKNOWN_ROUTE || key.startsWith(`${UNKNOWN_ROUTE} `)

/**
 * The `:param` values of a concrete path under a rule pattern, decoded; null
 * when the path does not match it. Alternatives and a trailing `*` are not
 * named, so they are not returned.
 */
export function ruleParams(rulePath: string, path: string): Record<string, string> | null {
  const names = [...rulePath.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!)
  const match = compileRulePath(rulePath, true).exec(path)
  if (!match) return null
  const out: Record<string, string> = {}
  names.forEach((name, i) => {
    try {
      out[name] = decodeURIComponent(match[i + 1]!)
    } catch {
      out[name] = match[i + 1]!
    }
  })
  return out
}
