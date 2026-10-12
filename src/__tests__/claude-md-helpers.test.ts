import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// acrovelIQ P0-1, plan 5.2 (step 2, the documentation part): the text an agent
// learns from (the CLAUDE.md template and the generated agent CLAUDE.md) calls
// the helpers, which present the calling agent's own token, instead of reading
// the shared token itself. What turns these red: a curl that reads
// store/.dashboard-token coming back into the template or the generator; the
// template calling a helper by a relative path (the permission list matches
// the full path only); the generated autonomy block losing its helper calls.

const ROOT = join(__dirname, '..', '..')
const TEMPLATE = readFileSync(join(ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')

const fn = (start: string, end: string) => {
  const i = SCAFFOLD.indexOf(start)
  const j = SCAFFOLD.indexOf(end, i)
  expect(i, start).toBeGreaterThan(0)
  expect(j, end).toBeGreaterThan(i)
  return SCAFFOLD.slice(i, j)
}

describe('the CLAUDE.md template calls the helpers, not the token', () => {
  it('only the agent-list line still reads the token (no helper for it yet)', () => {
    const lines = TEMPLATE.split('\n').filter((l) => l.includes('.dashboard-token'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/api/agents')
  })

  it('every helper call uses the full install path', () => {
    for (const helper of ['fleet-api.sh', 'agent-msg.sh']) {
      const calls = TEMPLATE.split('\n').filter((l) => l.startsWith('bash ') && l.includes(helper))
      expect(calls.length, helper).toBeGreaterThan(0)
      for (const call of calls) expect(call, call).toContain(`{{INSTALL_DIR}}/scripts/${helper}`)
    }
  })

  it('memory, daily log, search, schedule and message each have their helper', () => {
    for (const cmd of [
      'fleet-api.sh memory {{MAIN_AGENT_ID}}',
      'fleet-api.sh daily-log-now {{MAIN_AGENT_ID}}',
      'fleet-api.sh memory-search {{MAIN_AGENT_ID}}',
      'fleet-api.sh schedule-new',
      'agent-msg.sh {{MAIN_AGENT_ID}} TARGET_AGENT - <',
    ])
      expect(TEMPLATE, cmd).toContain(cmd)
  })
})

// barracuda #36: a real schedule prompt is full of quotes and dollar signs, so
// its example must take the prompt from a file, as the template's own rule says.
describe('the schedule example takes its prompt from a file', () => {
  it('in the template and in the creation prompt', () => {
    const lines = [TEMPLATE, SCAFFOLD].flatMap((t) =>
      t.split('\n').filter((l) => l.includes('fleet-api.sh schedule-new') || l.includes('${fleetApi} schedule-new')),
    )
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line, line).toMatch(/schedule-new "[^"]+" "[^"]+" - .*< prompt\.txt/)
  })
})

describe('the generated agent text calls the helpers', () => {
  const autonomy = fn('function buildAutonomyBody', '\n}\n')
  const created = fn('export async function generateClaudeMd', 'export async function generateSoulMd')

  it('no generated text reads the token', () => {
    for (const body of [autonomy, created]) {
      expect(body).not.toContain('Authorization: Bearer')
      expect(body).not.toContain('tokenPath')
    }
  })

  it('the autonomy block (rewritten on every start) uses the helpers for all three calls', () => {
    expect(autonomy).toContain('bash ${agentMsg} ${name} ${MAIN_AGENT_ID} - <')
    expect(autonomy).toContain('bash ${fleetApi} approval-new ${name} CATEGORY_KEY - <')
    expect(autonomy).toContain('bash ${fleetApi} approval-get <id>')
  })

  it('the helper paths are the install root scripts', () => {
    expect(SCAFFOLD).toContain("const fleetApi = join(PROJECT_ROOT, 'scripts', 'fleet-api.sh')")
    expect(SCAFFOLD).toContain("const agentMsg = join(PROJECT_ROOT, 'scripts', 'agent-msg.sh')")
  })
})
