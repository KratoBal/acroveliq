// Every route matcher in the dashboard's source, found by the TypeScript AST
// (acrovelIQ P0-1, PR 1). There is no central route registry: a route is an
// inline condition in a module's tryHandle* function. So the inventory test
// reads the conditions themselves, the way the dispatcher sees them:
//
//   path === '/api/x'                 an exact path (also `!==` in a guard,
//                                     `if (path !== X || method !== 'GET') return false`,
//                                     and a const string in place of the literal)
//   path.startsWith('/x/')            a prefix (a literal or a const string)
//   path.match(RE), RE.exec(path),    a regex (a literal, or a const regex in the file)
//   RE.test(path)
//   matchChannelRoute(path, '/sfx')   the channel routes, whose regexes agents.ts
//                                     builds at run time: both forms, rebuilt here
//   'GET /sutyerak/x' in a Set        sutyerak's allowlist
//
// A method in the SAME condition (`&& method === 'POST'`) is kept with the
// matcher; a matcher without one stands for every method its block handles.

import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export interface RouteMatcher {
  module: string
  line: number
  kind: 'eq' | 'prefix' | 'regex'
  /** The literal path, the prefix, or the regex source. */
  value: string
  /** Methods named in the same condition; null when the condition names none. */
  methods: string[] | null
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** The channel-route regexes, exactly as agents.ts matchChannelRoute builds them. */
export function channelRouteSources(suffix: string): string[] {
  return [
    `^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`,
    `^/api/agents/([^/]+)/telegram${suffix}$`,
  ]
}

export function scanRouteMatchers(file: string): RouteMatcher[] {
  const text = readFileSync(file, 'utf-8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const module = basename(file).replace(/\.ts$/, '')
  const consts = new Map<string, ts.Expression>()
  const found: RouteMatcher[] = []

  // const NAME = 'x' | /re/: anywhere in the file (module or function scope)
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) consts.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(source)

  const resolve = (expr: ts.Expression): ts.Expression => (ts.isIdentifier(expr) && consts.has(expr.text) ? consts.get(expr.text)! : expr)
  const isPath = (expr: ts.Expression) => ts.isIdentifier(expr) && expr.text === 'path'
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1

  /** The methods named in the condition this matcher belongs to. */
  const methodsOf = (node: ts.Node): string[] | null => {
    let condition: ts.Node = node
    while (
      condition.parent &&
      (ts.isBinaryExpression(condition.parent) || ts.isParenthesizedExpression(condition.parent) || ts.isPrefixUnaryExpression(condition.parent))
    )
      condition = condition.parent
    const names: string[] = []
    const look = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        const sides = [n.left, n.right]
        const isMethod = sides.some((s) => (ts.isIdentifier(s) && s.text === 'method') || (ts.isPropertyAccessExpression(s) && s.name.text === 'method'))
        const literal = sides.find(ts.isStringLiteral)
        if (isMethod && literal && METHODS.has(literal.text)) names.push(literal.text)
      }
      ts.forEachChild(n, look)
    }
    look(condition)
    return names.length ? names : null
  }

  const add = (node: ts.Node, kind: RouteMatcher['kind'], value: string) =>
    found.push({ module, line: line(node), kind, value, methods: methodsOf(node) })

  const regexSource = (expr: ts.Expression): string | null => {
    const target = resolve(expr)
    return ts.isRegularExpressionLiteral(target) ? target.text.slice(1, target.text.lastIndexOf('/')) : null
  }

  const visit = (node: ts.Node) => {
    // path === 'x', path !== 'x' (a guard), with a literal or a const string
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const side = isPath(node.left) ? node.right : isPath(node.right) ? node.left : null
      const other = side ? resolve(side) : null
      if (other && ts.isStringLiteral(other)) add(node, 'eq', other.text)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name } = node.expression
      const [first] = node.arguments
      // path.startsWith('x' | CONST)
      if (isPath(target) && name.text === 'startsWith' && first) {
        const value = resolve(first)
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) add(node, 'prefix', value.text)
      }
      // path.match(RE)
      if (isPath(target) && name.text === 'match' && first) {
        const re = regexSource(first)
        if (re !== null) add(node, 'regex', re)
      }
      // RE.exec(path), RE.test(path)
      if ((name.text === 'exec' || name.text === 'test') && first && isPath(first)) {
        const re = regexSource(target)
        if (re !== null) add(node, 'regex', re)
      }
    }
    // matchChannelRoute(path, '/sfx')
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'matchChannelRoute' &&
      node.arguments.length === 2 &&
      isPath(node.arguments[0]!) &&
      ts.isStringLiteral(node.arguments[1]!)
    )
      for (const re of channelRouteSources(node.arguments[1].text)) add(node, 'regex', re)
    // 'GET /sutyerak/x' entries of an allowlist Set
    if (ts.isStringLiteral(node) && /^(GET|POST|PUT|DELETE|PATCH) \/\S*$/.test(node.text) && ts.isArrayLiteralExpression(node.parent)) {
      const [method, value] = node.text.split(' ')
      found.push({ module, line: line(node), kind: 'eq', value: value!, methods: [method!] })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** A concrete path for a rule: `:param` and `(a|b)` filled in, a `*` rest given a sample. */
/** A parameter whose matcher accepts only certain values gets a real one. */
const PARAM_SAMPLES: Record<string, string> = { provider: 'telegram' }

export function examplePaths(path: string): string[] {
  const samples = ['agent1', '42', 'ABCDEF12']
  return samples.map((sample) =>
    path
      .replace(/\(([^)|]+)(\|[^)]*)?\)/g, '$1')
      .replace(/:([A-Za-z_]+)/g, (_, name: string) => PARAM_SAMPLES[name] ?? sample)
      .replace(/\*$/, 'x.json'),
  )
}

/** Whether a matcher answers a rule's path (for some example of it). */
export function matcherCovers(matcher: RouteMatcher, rulePath: string): boolean {
  const examples = examplePaths(rulePath)
  if (matcher.kind === 'eq') return examples.includes(matcher.value) || rulePath === matcher.value
  if (matcher.kind === 'prefix') return examples.some((p) => p.startsWith(matcher.value))
  const re = new RegExp(matcher.value)
  return examples.some((p) => re.test(p))
}

/**
 * What looks like a route but is not on `path`: a comparison, a prefix or a
 * regex call against a "/..." string on any other receiver (`p`, `ctx.path`,
 * `url.pathname`). A route written that way would slip past scanRouteMatchers,
 * so the inventory test wants this list empty, or each entry explained.
 */
export function scanSuspects(file: string): Array<{ module: string; line: number; text: string }> {
  const text = readFileSync(file, 'utf-8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const module = basename(file).replace(/\.ts$/, '')
  const out: Array<{ module: string; line: number; text: string }> = []
  const isPath = (expr: ts.Expression) => ts.isIdentifier(expr) && expr.text === 'path'
  const routeLike = (expr: ts.Node) => (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && /^\/(api|sutyerak|\.well-known)\b/.test(expr.text)
  const flag = (node: ts.Node) =>
    out.push({ module, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().slice(0, 120) })
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      ((routeLike(node.left) && !isPath(node.right)) || (routeLike(node.right) && !isPath(node.left)))
    )
      flag(node)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name } = node.expression
      if (['startsWith', 'endsWith', 'includes'].includes(name.text) && !isPath(target) && node.arguments[0] && routeLike(node.arguments[0])) flag(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}
