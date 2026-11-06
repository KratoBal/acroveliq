// scripts/hooks/heavy-run-gate.py, the heavy-run gate (task flotta-memoria-or; NOT WIRED until a profile template
// registers it). WHAT TURNS THIS RED: a tsc, a full vitest, a turbo or pnpm/npm test/build/typecheck outside futtat let
// through, also behind `cd &&`, `env`, `bash -c`, `npx`, `corepack`, `pnpm --filter`, or `node .../tsc`; a run inside
// futtat, a targeted vitest, a `node --test` of one spec, `tsc --version` or an ordinary command denied; a deny without
// the futtat form in its reason; anything but exit 0.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts', 'hooks', 'heavy-run-gate.py')

function decide(command: string) {
  const r = spawnSync('python3', [SCRIPT], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf-8' })
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return { code: r.status, deny: out?.hookSpecificOutput?.permissionDecision === 'deny', reason: String(out?.hookSpecificOutput?.permissionDecisionReason ?? '') }
}

const DENIED = [
  'npx tsc -p tsconfig.json --noEmit',
  'cd apps/api && NODE_OPTIONS=--max-old-space-size=3072 npx tsc -p tsconfig.test.json',
  'node --max-old-space-size=3072 node_modules/.bin/tsc -p .',
  "bash -c 'npx tsc -p .'",
  'pnpm --filter @acropora/api test',
  'corepack pnpm typecheck',
  'npm run build',
  'npm test',
  'pnpm test:integration',
  'npx turbo run test --filter=@acropora/api',
  'turbo build',
  'npx vitest run',
  'echo ok && pnpm build',
]
const ALLOWED = [
  'tsc --version',
  'npx vitest run src/__tests__/tetlen-or.test.ts',
  'bash /home/marveen/marveen/scripts/futtat.sh run --projekt acropora --feladat x --fajta test -- env PATH=/x npx turbo run test',
  'node --test test-dist/game/x.spec.js',
  'git status',
  'pnpm install',
  'npx prettier --check src',
  "echo 'unterminated",
]

describe('heavy-run-gate', () => {
  it('HEAVY-RUN-GATE: heavy runs outside futtat are denied with the futtat form; the rest passes; always exit 0', () => {
    const denied = DENIED.map(decide)
    const allowed = ALLOWED.map(decide)
    expect(
      {
        missed: DENIED.filter((_, i) => !denied[i]!.deny),
        blocked: ALLOWED.filter((_, i) => allowed[i]!.deny),
        codes: [...denied, ...allowed].every((d) => d.code === 0),
        form: denied.every((d) => d.reason.includes('futtat.sh run --projekt')),
      },
      'HEAVY-RUN-GATE',
    ).toEqual({ missed: [], blocked: [], codes: true, form: true })
  })
})
