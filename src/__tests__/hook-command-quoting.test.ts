import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  HOOK_NODE_BIN,
  hookCommand,
  hookCommandWired,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  ensureEgressGate,
  ensureGovernanceGateCommands,
  emailGateMatcherStale,
  EMAIL_GATE_MATCHER,
  injectReadonlyCommandGate,
  ensureReadonlyCommandGate,
  agentGetsReadonlyCommandGate,
  injectDenyNormalizingGate,
  ensureDenyNormalizingGate,
  ensureAgentStalenessHook,
  ensureAgentProvenanceHook,
  ensurePermissionApprovalHook,
  injectPermissionApprovalHook,
  measureStatusLineCommand,
  injectMeasureStatusLine,
  upgradeLegacyHookCommands,
  resolveTemplatePlaceholders,
  ensureMeasureStatusLineUpgrade,
} from '../web/agent-scaffold.js'
import { writeAgentSecurityProfile } from '../web/agent-config.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { removeTrustedRecord } from '../web/agent-profile-store.js'

// Review feedback on PR #803, pinned as tests:
//  1. every injector must write a QUOTED absolute interpreter path -- an
//     unquoted execPath with a space in it is split by `sh -c`, exit 127,
//     silently non-enforcing: the exact failure the PR closes, reintroduced;
//  2. the wired-already comparison must be the JSON-escaped one everywhere,
//     otherwise a backslash (Windows) path never settles and every boot
//     rewrites settings.json;
//  3. the ensure* migrations must be idempotent: second call returns false.

const TEST_AGENT = 'hookquoting-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
  // the trusted profile goes with the agent, as on a real delete (agent-profile-store.ts)
  removeTrustedRecord(TEST_AGENT)
})

function ptuCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown>
  const ptu = hooks.PreToolUse as { hooks: { command: string }[] }[]
  return ptu.flatMap((e) => e.hooks.map((h) => h.command))
}

describe('hookCommand builder', () => {
  it('quotes BOTH the interpreter and the script path', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toContain(`"${HOOK_NODE_BIN}" "/some/dir/gate.mjs"`)
  })

  // A missing interpreter must BLOCK, not fall through with 127. process.execPath
  // is a version-pinned path on brew, so a node upgrade can dangle it; without
  // this guard the gate goes silent again on a different route.
  it('blocks with a message when the interpreter is gone, instead of exiting 127', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toMatch(/^test -x /)
    expect(cmd).toContain('exit 2')
    // the three things the operator needs: what is missing, that this blocks,
    // and the way out
    expect(cmd).toContain(HOOK_NODE_BIN)
    expect(cmd).toContain('BLOKKOL')
    expect(cmd).toContain('inditsd ujra a dashboardot')
  })
})

// A parancs nem a quoted interpreterrel KEZDODIK, hanem tartalmazza azt: elotte all
// egy `test -x <BIN> || { echo ...; exit 2; }` or, hogy egy elmozdult interpreter
// BLOKKOLJON, ne 127-tel csendben atengedjen. Az allitas ezert includes(), es a
// vedett tulajdonsag valtozatlan: abszolut, idezojelezett interpreter, soha nem
// csupasz `node`.
describe('injectors write a quoted absolute interpreter, never a bare node', () => {
  for (const [label, inject] of [
    ['injectEmailSendGate', injectEmailSendGate],
    ['injectSelfPaceGate', injectSelfPaceGate],
    ['injectEgressGate', injectEgressGate],
  ] as const) {
    it(label, () => {
      const s: Record<string, unknown> = {}
      inject(s)
      const commands = ptuCommands(s)
      expect(commands.length).toBeGreaterThan(0)
      for (const cmd of commands) {
        expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
        expect(cmd).not.toMatch(/^node /)
      }
    })
  }
})

describe('hookCommandWired', () => {
  it('finds a freshly injected command (posix path)', () => {
    const s: Record<string, unknown> = {}
    injectEgressGate(s)
    const cmd = hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'))
    const ptuJson = JSON.stringify((s.hooks as Record<string, unknown>).PreToolUse)
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)
  })

  it('settles on a backslash (Windows-style) path where the raw compare does not', () => {
    // Reproduces review point 1: the raw includes() disagrees with the
    // serialized form exactly where the escaped form matches.
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\marveen\\scripts\\hooks\\egress-gate.mjs"'
    const ptuJson = JSON.stringify([{ matcher: 'WebFetch', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }])
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)   // escaped compare: settles
    expect(ptuJson.includes(cmd)).toBe(false)           // raw compare: never settles
  })
})

describe('ensure* migrations are idempotent (true, then false)', () => {
  it('ensureEgressGate', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    expect(ensureEgressGate(TEST_AGENT)).toBe(true)
    expect(ensureEgressGate(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    for (const cmd of ptuCommands(written)) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
    }
  })

  it('ensureGovernanceGateCommands upgrades a legacy bare-node entry, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const legacy = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')}`, timeout: 10 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')}`, timeout: 10 }] },
        ],
      },
    }
    const settingsPath = join(testAgentDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(legacy, null, 2))

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)

    expect(existsSync(settingsPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('email-send-gate.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('self-pace-gate.mjs'))).toBe(true)
    for (const cmd of commands) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
      expect(cmd).not.toMatch(/^node /)
    }
  })

  // 2026-08-10: the second silently-non-enforcing shape. Here the command is
  // already correct (absolute, quoted interpreter), so the wiring check reports
  // the gate healthy -- but the matcher is the pre-fix bare one, which never
  // matches `mcp__<server>__manage_email`, so the hook never runs. The migration
  // must repair the matcher too, or every install scaffolded before the fix
  // keeps a gate that passes every check and blocks nothing.
  it('ensureGovernanceGateCommands repairs a stale matcher on a correctly-wired command', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const settingsPath = join(testAgentDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|send_email|manage_email',
            hooks: [{ type: 'command', command: hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')), timeout: 10 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand(join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')), timeout: 10 }],
          },
        ],
      },
    }, null, 2))

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const ptu = (written.hooks as Record<string, unknown>).PreToolUse as { matcher: string, hooks: { command: string }[] }[]
    const gate = ptu.find((e) => e.hooks.some((h) => h.command.includes('email-send-gate.mjs')))
    expect(gate?.matcher).toBe(EMAIL_GATE_MATCHER)
    // Repaired in place, not duplicated.
    expect(ptu.filter((e) => e.hooks.some((h) => h.command.includes('email-send-gate.mjs')))).toHaveLength(1)
    // The unrelated self-pace entry survives untouched.
    expect(ptu.some((e) => e.hooks.some((h) => h.command.includes('self-pace-gate.mjs')))).toBe(true)
  })
})

describe('emailGateMatcherStale', () => {
  const cmd = { type: 'command', command: hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')), timeout: 10 }

  it('flags a pre-fix matcher', () => {
    expect(emailGateMatcherStale([{ matcher: 'Bash|send_email|manage_email', hooks: [cmd] }])).toBe(true)
    expect(emailGateMatcherStale([{ matcher: 'Bash|send_email', hooks: [cmd] }])).toBe(true)
  })

  it('accepts the current matcher and ignores unrelated entries', () => {
    expect(emailGateMatcherStale([{ matcher: EMAIL_GATE_MATCHER, hooks: [cmd] }])).toBe(false)
    expect(emailGateMatcherStale([{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'x egress-gate.mjs' }] }])).toBe(false)
    expect(emailGateMatcherStale([])).toBe(false)
    expect(emailGateMatcherStale(undefined)).toBe(false)
  })
})

describe('agentGetsReadonlyCommandGate', () => {
  it('true for a strict profile', () => {
    expect(agentGetsReadonlyCommandGate({ permissionMode: 'strict' })).toBe(true)
  })

  it('false for a permissive profile', () => {
    expect(agentGetsReadonlyCommandGate({ permissionMode: 'permissive' })).toBe(false)
  })
})

describe('injectReadonlyCommandGate', () => {
  it('writes a Bash-matcher PreToolUse entry referencing the script, wrapped fail-open', () => {
    const s: Record<string, unknown> = {}
    injectReadonlyCommandGate(s)
    const hooks = (s.hooks as Record<string, unknown>)
    const ptu = hooks.PreToolUse as { matcher: string, hooks: { command: string }[] }[]
    expect(ptu.length).toBeGreaterThan(0)
    const entry = ptu.find((e) => e.hooks.some((h) => h.command.includes('readonly-command-gate.py')))
    expect(entry).toBeTruthy()
    expect(entry!.matcher).toBe('Bash')
    const cmd = entry!.hooks[0].command
    // fail-open wrapper: a missing OR unreadable script must exit 0, never block a prompt. No `exec`
    // (python's own exit status must not become the hook's), readability not existence, closing `exit 0`
    // (barracuda, #306).
    expect(cmd).toMatch(/^bash -c '\[ -r .*readonly-command-gate\.py ] && python3 .*readonly-command-gate\.py; exit 0'$/)
    expect(cmd).not.toContain('exec')
  })

  it('an existing script this user cannot read ends in exit 0, never in the 2 that blocks every Bash call', () => {
    const dir = join(testAgentDir, 'unreadable-readonly-hook')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'readonly-command-gate.py')
    writeFileSync(script, 'print("x")\n')
    chmodSync(script, 0)
    try {
      const s: Record<string, unknown> = {}
      injectReadonlyCommandGate(s)
      const cmd = ptuCommands(s).find((c) => c.includes('readonly-command-gate.py'))!
      const real = join(PROJECT_ROOT, 'scripts', 'hooks', 'readonly-command-gate.py')
      const r = spawnSync('bash', ['-c', cmd.replace(/^bash -c '/, '').replace(/'$/, '').split(real).join(script)], { encoding: 'utf-8' })
      // a root user reads everything, so the unreadable case cannot be built there
      if (process.getuid && process.getuid() !== 0) {
        expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
      }
    } finally {
      chmodSync(script, 0o600)
    }
  })

  it('replaces an existing entry in place, never duplicates (idempotent merge shape)', () => {
    const s: Record<string, unknown> = {}
    injectReadonlyCommandGate(s)
    injectReadonlyCommandGate(s)
    const ptu = ptuCommands(s)
    expect(ptu.filter((c) => c.includes('readonly-command-gate.py'))).toHaveLength(1)
  })
})

describe('ensureReadonlyCommandGate', () => {
  it('wires the gate for a STRICT-profile agent, then settles (idempotent)', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeAgentSecurityProfile(TEST_AGENT, 'researcher-reader')
    expect(ensureReadonlyCommandGate(TEST_AGENT)).toBe(true)
    expect(ensureReadonlyCommandGate(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('readonly-command-gate.py'))).toBe(true)
  })

  it('upgrades an agent wired with the older `[ -f ] && exec` launcher, in place, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeAgentSecurityProfile(TEST_AGENT, 'researcher-reader')
    const script = join(PROJECT_ROOT, 'scripts', 'hooks', 'readonly-command-gate.py')
    const old = `bash -c '[ -f ${script} ] && exec python3 ${script}; exit 0'`
    writeFileSync(
      join(testAgentDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old, timeout: 10 }] }] } }),
    )
    expect(ensureReadonlyCommandGate(TEST_AGENT)).toBe(true)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    const gate = ptuCommands(written).filter((c) => c.includes('readonly-command-gate.py'))
    expect(gate).toHaveLength(1)
    expect(gate[0]).not.toContain('exec')
    expect(ensureReadonlyCommandGate(TEST_AGENT)).toBe(false)
  })

  it('does NOT wire the gate for a permissive-profile agent', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    // a permissive profile set through the dashboard (a seed never gives one: an agent with no
    // record is seeded 'locked', which is strict, agent-profile-store.ts)
    writeAgentSecurityProfile(TEST_AGENT, 'default')
    expect(ensureReadonlyCommandGate(TEST_AGENT)).toBe(false)
    const settingsPath = join(testAgentDir, '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(ptuCommands(written).some((c) => c.includes('readonly-command-gate.py'))).toBe(false)
    }
  })

  it('never wires the gate for MAIN_AGENT_ID', () => {
    // MAIN_AGENT_ID is not profile-managed (resolveAgentSecurityProfile must
    // never be called for it) -- the early return must fire before any
    // profile resolution is attempted, so this must not throw either.
    expect(() => ensureReadonlyCommandGate(MAIN_AGENT_ID)).not.toThrow()
    expect(ensureReadonlyCommandGate(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('the deny-rule gate (tiltott-osszetett-parancs)', () => {
  it('injectDenyNormalizingGate writes one Bash PreToolUse entry, fail-open, idempotent', () => {
    const s: Record<string, unknown> = {}
    injectDenyNormalizingGate(s)
    injectDenyNormalizingGate(s)
    const cmds = ptuCommands(s).filter((c) => c.includes('deny-normalizing-gate.py'))
    expect(cmds).toHaveLength(1)
    // barracuda, #306: no `exec` (python's own exit status must not become the hook's), readability not
    // existence, and a closing `exit 0`
    expect(cmds[0]).toMatch(/^bash -c '\[ -r .*deny-normalizing-gate\.py ] && python3 .*deny-normalizing-gate\.py; exit 0'$/)
    expect(cmds[0]).not.toContain('exec')
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as { matcher: string }[]
    expect(ptu.find((e) => JSON.stringify(e).includes('deny-normalizing-gate.py'))!.matcher).toBe('Bash')
  })

  it('an existing script this user cannot read ends in exit 0, never in the 2 that blocks every Bash call', () => {
    const dir = join(testAgentDir, 'unreadable-hook')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'deny-normalizing-gate.py')
    writeFileSync(script, 'print("x")\n')
    chmodSync(script, 0)
    try {
      const s: Record<string, unknown> = {}
      injectDenyNormalizingGate(s)
      const cmd = ptuCommands(s).find((c) => c.includes('deny-normalizing-gate.py'))!
      const real = join(PROJECT_ROOT, 'scripts', 'hooks', 'deny-normalizing-gate.py')
      const r = spawnSync('bash', ['-c', cmd.replace(/^bash -c '/, '').replace(/'$/, '').split(real).join(script)], { encoding: 'utf-8' })
      // a root user reads everything, so the unreadable case cannot be built there
      if (process.getuid && process.getuid() !== 0) {
        expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
      }
    } finally {
      chmodSync(script, 0o600)
    }
  })

  it('keeps the other PreToolUse hooks (it adds, it does not replace)', () => {
    const s: Record<string, unknown> = {}
    injectReadonlyCommandGate(s)
    injectDenyNormalizingGate(s)
    const cmds = ptuCommands(s)
    expect(cmds.some((c) => c.includes('readonly-command-gate.py'))).toBe(true)
    expect(cmds.some((c) => c.includes('deny-normalizing-gate.py'))).toBe(true)
  })

  it('ensureDenyNormalizingGate wires a non-main agent whatever its profile, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeAgentSecurityProfile(TEST_AGENT, 'default')
    expect(ensureDenyNormalizingGate(TEST_AGENT)).toBe(true)
    expect(ensureDenyNormalizingGate(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(ptuCommands(written).some((c) => c.includes('deny-normalizing-gate.py'))).toBe(true)
  })

  it('never wires the gate for MAIN_AGENT_ID', () => {
    expect(ensureDenyNormalizingGate(MAIN_AGENT_ID)).toBe(false)
  })
})

/*
  THE THREE LAUNCHERS THAT WERE LEFT (task tiltott-osszetett-parancs; acrobot's approval 2026-10-26 18:40, after #306
  and #307): the staleness guard and the provenance gate (UserPromptSubmit, where exit 2 blocks the PROMPT itself)
  and the permission-approval hook (PermissionRequest). MI PIROSIT: a launcher with `exec` or `[ -f ]` again; a
  script that exists but cannot be read by this user ending in anything but status 0 and no output; an agent wired
  with the older shape that is not upgraded in place, once, then left alone.
*/
describe('the staleness, provenance and permission-approval launchers', () => {
  const HOOKS = [
    { name: 'staleness-guard.py', event: 'UserPromptSubmit', ensure: ensureAgentStalenessHook, strict: false },
    { name: 'provenance-gate.py', event: 'UserPromptSubmit', ensure: ensureAgentProvenanceHook, strict: false },
    { name: 'permission-approval.py', event: 'PermissionRequest', ensure: ensurePermissionApprovalHook, strict: true },
  ] as const

  const commandsOf = (settings: Record<string, unknown>, event: string, name: string): string[] => {
    const entries = ((settings.hooks as Record<string, unknown>)?.[event] ?? []) as { hooks: { command: string }[] }[]
    return entries.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c.includes(name))
  }
  const settingsOf = () => JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8')) as Record<string, unknown>
  const scriptPath = (name: string) => join(PROJECT_ROOT, 'scripts', 'hooks', name)

  for (const hook of HOOKS) {
    it(`${hook.name}: [ -r ] && python3, no exec, ends in exit 0`, () => {
      mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
      writeAgentSecurityProfile(TEST_AGENT, hook.strict ? 'researcher-reader' : 'default')
      expect(hook.ensure(TEST_AGENT)).toBe(true)
      const cmds = commandsOf(settingsOf(), hook.event, hook.name)
      expect(cmds).toHaveLength(1)
      const script = scriptPath(hook.name)
      expect(cmds[0]).toBe(`bash -c '[ -r ${script} ] && python3 ${script}; exit 0'`)
      expect(cmds[0]).not.toContain('exec')
    })

    it(`${hook.name}: an existing script this user cannot read ends in exit 0, no output`, () => {
      const dir = join(testAgentDir, `unreadable-${hook.name}`)
      mkdirSync(dir, { recursive: true })
      const script = join(dir, hook.name)
      writeFileSync(script, 'print("x")\n')
      chmodSync(script, 0)
      try {
        mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
        writeAgentSecurityProfile(TEST_AGENT, hook.strict ? 'researcher-reader' : 'default')
        hook.ensure(TEST_AGENT)
        const cmd = commandsOf(settingsOf(), hook.event, hook.name)[0]!
        const inner = cmd.replace(/^bash -c '/, '').replace(/'$/, '').split(scriptPath(hook.name)).join(script)
        const r = spawnSync('bash', ['-c', inner], { encoding: 'utf-8' })
        // a root user reads everything, so the unreadable case cannot be built there
        if (process.getuid && process.getuid() !== 0) {
          expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
        }
      } finally {
        chmodSync(script, 0o600)
      }
    })

    it(`${hook.name}: an agent wired with the older [ -f ] && exec shape is upgraded in place, once`, () => {
      mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
      writeAgentSecurityProfile(TEST_AGENT, hook.strict ? 'researcher-reader' : 'default')
      const script = scriptPath(hook.name)
      const old = `bash -c '[ -f ${script} ] && exec python3 ${script}; exit 0'`
      const entry = { hooks: [{ type: 'command', command: old, timeout: 10 }] }
      writeFileSync(
        join(testAgentDir, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { [hook.event]: [hook.event === 'PermissionRequest' ? { matcher: 'Bash', ...entry } : entry] } }),
      )
      expect(hook.ensure(TEST_AGENT)).toBe(true)
      const cmds = commandsOf(settingsOf(), hook.event, hook.name)
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).not.toContain('exec')
      expect(hook.ensure(TEST_AGENT)).toBe(false)
    })
  }

  it('injectPermissionApprovalHook still replaces rather than duplicates', () => {
    const s: Record<string, unknown> = {}
    injectPermissionApprovalHook(s)
    injectPermissionApprovalHook(s)
    expect(commandsOf(s, 'PermissionRequest', 'permission-approval.py')).toHaveLength(1)
  })
})

/*
  THE LAST FOUR LAUNCHERS (acrobot's approval 2026-10-26 18:55, after #306, #307, #308): the settings template's
  skill-usage-capture (PostToolUse), channel-inbox-drain and voice-reply-directive (both UserPromptSubmit, where exit
  2 blocks the incoming message) and the measurement statusLine. MI PIROSIT: any `exec` or `[ -f ]` launcher back in
  the template (a GUARD over the whole template, so a sixth cannot slip in); a statusLine on an unreadable script
  ending in anything but status 0 and no output; a legacy entry the template merge does not move to the new shape.
*/
describe('the settings template launchers and the measurement statusLine', () => {
  const template = JSON.parse(
    resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')),
  ) as { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

  const launchers = Object.entries(template.hooks).flatMap(([event, entries]) =>
    entries.flatMap((e) =>
      (e.hooks ?? []).flatMap((h) => (h.command?.startsWith("bash -c '[ -") ? [{ event, command: h.command }] : [])),
    ),
  )

  it('no launcher in the template uses exec or an existence test, and each ends in exit 0', () => {
    // a floor, so a template that quietly lost its launchers does not pass by having none to check
    expect(launchers.length).toBeGreaterThanOrEqual(5)
    for (const { event, command } of launchers) {
      expect([event, command.includes('exec ')]).toEqual([event, false])
      expect([event, /^bash -c '\[ -r \S+ \] && python3 \S+; exit 0'$/.test(command)]).toEqual([event, true])
    }
  })

  it('the three that were left are among them', () => {
    for (const name of ['skill-usage-capture.py', 'channel-inbox-drain.py', 'voice-reply-directive.py'])
      expect(launchers.some((l) => l.command.includes(name))).toBe(true)
  })

  it('the template merge moves an older-shape entry to the new one, once', () => {
    const names = ['skill-usage-capture.py', 'channel-inbox-drain.py', 'voice-reply-directive.py']
    const old = (n: string) => {
      const script = join(PROJECT_ROOT, 'scripts', 'hooks', n)
      return `bash -c '[ -f ${script} ] && exec python3 ${script}; exit 0'`
    }
    const existing: Record<string, unknown> = {
      PostToolUse: [{ hooks: [{ type: 'command', command: old(names[0]!) }] }],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: old(names[1]!) }] },
        { hooks: [{ type: 'command', command: old(names[2]!) }] },
      ],
    }
    expect(upgradeLegacyHookCommands(existing, template.hooks)).toBe(true)
    const now = JSON.stringify(existing)
    expect(now).not.toContain('exec python3')
    for (const n of names) expect(now).toContain(`[ -r ${join(PROJECT_ROOT, 'scripts', 'hooks', n)} ]`)
    expect(upgradeLegacyHookCommands(existing, template.hooks)).toBe(false)
  })

  it('the statusLine is [ -r ] && NAME=agent python3, no exec, and keeps the flag and the agent', () => {
    const script = join(PROJECT_ROOT, 'scripts', 'measure-statusline.py')
    expect(measureStatusLineCommand('murena', true)).toBe(
      `bash -c '[ -r ${script} ] && MEASURE_AGENT=murena python3 ${script} --export-usage; exit 0'`,
    )
    expect(measureStatusLineCommand('murena', false)).toBe(
      `bash -c '[ -r ${script} ] && MEASURE_AGENT=murena python3 ${script}; exit 0'`,
    )
  })

  it('a statusLine on an unreadable script ends in status 0 with no output', () => {
    const dir = join(testAgentDir, 'unreadable-measure')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'measure-statusline.py')
    writeFileSync(script, 'print("x")\n')
    chmodSync(script, 0)
    try {
      const real = join(PROJECT_ROOT, 'scripts', 'measure-statusline.py')
      const inner = measureStatusLineCommand('murena', true).replace(/^bash -c '/, '').replace(/'$/, '').split(real).join(script)
      const r = spawnSync('bash', ['-c', inner], { encoding: 'utf-8' })
      // a root user reads everything, so the unreadable case cannot be built there
      if (process.getuid && process.getuid() !== 0) {
        expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
      }
    } finally {
      chmodSync(script, 0o600)
    }
  })

  it('an agent whose statusLine has the older shape is upgraded in place, once', () => {
    const real = join(PROJECT_ROOT, 'scripts', 'measure-statusline.py')
    const settings: Record<string, unknown> = {
      statusLine: { type: 'command', command: `bash -c '[ -f ${real} ] && MEASURE_AGENT=murena exec python3 ${real} --export-usage; exit 0'`, padding: 0 },
    }
    expect(injectMeasureStatusLine(settings, 'murena', true)).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('exec')
    expect(injectMeasureStatusLine(settings, 'murena', true)).toBe(false)
  })
})

/*
  THE TWO PATHS THE BACKFILL MISSED (measured 2026-10-26 19:07, after #309 and the dashboard restart): murena and
  nautilus still carried the old `[ -f ] && exec` read-only gate (their profile is no longer strict, the strict-only
  ensure returned before looking at it), and all six agents still carried the old statusLine (it was written only when
  an agent STARTS). MI PIROSIT: a non-strict agent's existing entry left on the old shape; a non-strict agent given an
  entry it never had; a statusLine left old at the boot backfill, or one somebody set on purpose being overwritten, or
  one added where there was none.
*/
describe('the upgrade paths of the read-only gate, the approval hook and the statusLine', () => {
  const settingsPathOf = () => join(testAgentDir, '.claude', 'settings.json')
  const readSettings = () => JSON.parse(readFileSync(settingsPathOf(), 'utf-8')) as Record<string, unknown>
  const oldLauncher = (n: string) => {
    const script = join(PROJECT_ROOT, 'scripts', 'hooks', n)
    return `bash -c '[ -f ${script} ] && exec python3 ${script}; exit 0'`
  }
  const hookCmds = (event: string) => {
    const entries = ((readSettings().hooks as Record<string, unknown>)?.[event] ?? []) as { hooks: { command: string }[] }[]
    return entries.flatMap((e) => e.hooks.map((h) => h.command))
  }

  const CASES = [
    { name: 'readonly-command-gate.py', event: 'PreToolUse', ensure: ensureReadonlyCommandGate },
    { name: 'permission-approval.py', event: 'PermissionRequest', ensure: ensurePermissionApprovalHook },
  ] as const

  for (const c of CASES) {
    it(`${c.name}: a NON-strict agent's old entry is upgraded in place, once`, () => {
      mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
      writeAgentSecurityProfile(TEST_AGENT, 'default')
      writeFileSync(
        settingsPathOf(),
        JSON.stringify({ hooks: { [c.event]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldLauncher(c.name), timeout: 10 }] }] } }),
      )
      expect(c.ensure(TEST_AGENT)).toBe(true)
      const cmds = hookCmds(c.event).filter((cmd) => cmd.includes(c.name))
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).not.toContain('exec')
      expect(cmds[0]).toContain('[ -r ')
      expect(c.ensure(TEST_AGENT)).toBe(false)
    })

    it(`${c.name}: a NON-strict agent without the entry is not given one`, () => {
      mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
      writeAgentSecurityProfile(TEST_AGENT, 'default')
      writeFileSync(settingsPathOf(), JSON.stringify({ hooks: {} }))
      expect(c.ensure(TEST_AGENT)).toBe(false)
      expect(JSON.stringify(readSettings())).not.toContain(c.name)
    })
  }

  const statusLine = (command: string) => ({ statusLine: { type: 'command', command, padding: 0 } })
  const real = join(PROJECT_ROOT, 'scripts', 'measure-statusline.py')

  it('the boot backfill upgrades an old-shape measurement statusLine, once', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(
      settingsPathOf(),
      JSON.stringify(statusLine(`bash -c '[ -f ${real} ] && MEASURE_AGENT=${TEST_AGENT} exec python3 ${real} --export-usage; exit 0'`)),
    )
    expect(ensureMeasureStatusLineUpgrade(TEST_AGENT)).toBe(true)
    const cmd = (readSettings().statusLine as { command: string }).command
    expect(cmd).toBe(`bash -c '[ -r ${real} ] && MEASURE_AGENT=${TEST_AGENT} python3 ${real} --export-usage; exit 0'`)
    expect(ensureMeasureStatusLineUpgrade(TEST_AGENT)).toBe(false)
  })

  it('a statusLine somebody set on purpose is left alone, and none is added where there was none', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(settingsPathOf(), JSON.stringify(statusLine('echo my own line')))
    expect(ensureMeasureStatusLineUpgrade(TEST_AGENT)).toBe(false)
    expect((readSettings().statusLine as { command: string }).command).toBe('echo my own line')

    writeFileSync(settingsPathOf(), JSON.stringify({ hooks: {} }))
    expect(ensureMeasureStatusLineUpgrade(TEST_AGENT)).toBe(false)
    expect(readSettings().statusLine).toBeUndefined()
  })

  it('never for the main agent, and the boot backfill calls it', () => {
    expect(ensureMeasureStatusLineUpgrade(MAIN_AGENT_ID)).toBe(false)
    const web = readFileSync(join(PROJECT_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureMeasureStatusLineUpgrade(agentName)')
  })
})
