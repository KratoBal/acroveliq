import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { writeAgentSecurityProfile } from '../web/agent-config.js'
import { removeTrustedRecord } from '../web/agent-profile-store.js'
import {
  ensurePermissionApprovalHook,
  injectPermissionApprovalHook,
  PERMISSION_APPROVAL_TIMEOUT_SECONDS,
} from '../web/agent-scaffold.js'
import { buildDiscordApprovalText, neutralDescription } from '../web/approval-discord-core.js'

/*
  THE PERMISSION-APPROVAL HOOK'S WIRING (B48 pótlás). What turns these red: the
  hook landing under any event but PermissionRequest, or for a permissive or
  the main agent; a timeout at or under the hook's own approval window (it
  would be killed instead of denying); the wiring not settling; and, across
  the language border, a description the Python hook builds that #33's own
  neutralDescription would change: the owner would approve a text that is
  not the command that runs.
*/

const TEST_AGENT = 'permission-approval-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)
const HOOK = join(PROJECT_ROOT, 'scripts', 'hooks', 'permission-approval.py')

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
  removeTrustedRecord(TEST_AGENT)
})

type Entry = { matcher: string; hooks: { command: string; timeout: number }[] }
const entries = (s: Record<string, unknown>, event: string) =>
  (((s.hooks as Record<string, unknown> | undefined)?.[event] ?? []) as Entry[])

describe('injectPermissionApprovalHook', () => {
  it('a PermissionRequest Bash entry, fail-open wrapper, timeout above the 14-minute window', () => {
    const s: Record<string, unknown> = {}
    injectPermissionApprovalHook(s)
    injectPermissionApprovalHook(s)
    const pr = entries(s, 'PermissionRequest')
    expect(pr).toHaveLength(1)
    expect(pr[0]!.matcher).toBe('Bash')
    expect(pr[0]!.hooks[0]!.command).toMatch(/^bash -c '\[ -f .*permission-approval\.py ] && exec python3 .*permission-approval\.py; exit 0'$/)
    expect(pr[0]!.hooks[0]!.timeout).toBe(PERMISSION_APPROVAL_TIMEOUT_SECONDS)
    expect(PERMISSION_APPROVAL_TIMEOUT_SECONDS).toBeGreaterThan(14 * 60 + 5)
    expect(entries(s, 'PreToolUse')).toHaveLength(0)
  })
})

describe('ensurePermissionApprovalHook', () => {
  it('wires a strict-profile agent once, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeAgentSecurityProfile(TEST_AGENT, 'reviewer')
    expect(ensurePermissionApprovalHook(TEST_AGENT)).toBe(true)
    expect(ensurePermissionApprovalHook(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(entries(written, 'PermissionRequest').some((e) => e.hooks.some((h) => h.command.includes('permission-approval.py')))).toBe(true)
  })

  it('leaves a permissive-profile agent and the main agent alone', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeAgentSecurityProfile(TEST_AGENT, 'default')
    expect(ensurePermissionApprovalHook(TEST_AGENT)).toBe(false)
    const p = join(testAgentDir, '.claude', 'settings.json')
    if (existsSync(p)) expect(entries(JSON.parse(readFileSync(p, 'utf-8')), 'PermissionRequest')).toHaveLength(0)
    expect(ensurePermissionApprovalHook(MAIN_AGENT_ID)).toBe(false)
  })
})

describe("the hook's description through #33's own functions", () => {
  const commands = [
    'ip -4 -o addr show | grep inet > /tmp/claude-1/x_y.txt',
    "cat <<'EOF' > /tmp/x\nhello # *bold* ~x~ `y`\nEOF",
    'git log --oneline -5 && echo  done',
    'find . -name "*.ts" -newer a_b\t| wc -l',
  ]
  it.each(commands)('%s is shown unchanged', (cmd) => {
    const text = execFileSync('python3', ['-B', '-c', [
      'import importlib.util, sys',
      `s = importlib.util.spec_from_file_location("pa", ${JSON.stringify(HOOK)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'print(m.description(sys.argv[1], "/home/agent-x/work")[0])',
    ].join('\n'), cmd], { encoding: 'utf8' }).replace(/\n$/, '')
    expect(text).toMatch(/^PARANCS cwd=\/home\/agent-x\/work :: /)
    expect(neutralDescription(text)).toBe(`> ${text}`)
    const message = buildDiscordApprovalText(
      { agent_id: 'barracuda', category: 'bash_command', action_description: text, timeout_at: 1_800_000_000 },
      'K7QZ',
      { yes: 'igen', no: 'nem', requireReply: true },
    )
    expect(message.split('\n').at(-1)).toBe(`> ${text}`)
  })
})
