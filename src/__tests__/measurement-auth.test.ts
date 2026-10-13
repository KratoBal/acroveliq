import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatherAuthFacts, resolveAuthMode, resolveAuthModes, type AuthSources } from '../web/measurement-auth.js'

// Where auth_mode may come from: only a credential the launch path explicitly
// wires in. Everything else is null (docs/measurement-layer-v1.md).

const base = (over: Partial<AuthSources> = {}): AuthSources => ({
  mainAgentId: 'acrobot',
  env: { MAIN_AGENT_MODEL: 'claude-opus-5-5', CLAUDE_CODE_OAUTH_TOKEN: 'x' },
  fleetTokenPresent: true,
  workerModel: 'claude-sonnet-5',
  subAgents: [],
  subAgentConfig: () => ({}),
  subAgentRemoteHost: () => null,
  subAgentModel: () => 'claude-sonnet-5',
  vaultApiKey: () => false,
  ...over,
})

describe('resolveAuthMode', () => {
  it('needs exactly one explicitly wired credential and a Claude model', () => {
    expect(resolveAuthMode({ model: 'claude-opus-5-5', oauthWired: true, apiKeyWired: false })).toBe('subscription')
    expect(resolveAuthMode({ model: 'claude-opus-5-5', oauthWired: false, apiKeyWired: true })).toBe('api')
    expect(resolveAuthMode({ model: 'claude-opus-5-5', oauthWired: true, apiKeyWired: true })).toBeNull()
    // "no API key found" alone is not subscription evidence
    expect(resolveAuthMode({ model: 'claude-opus-5-5', oauthWired: false, apiKeyWired: false })).toBeNull()
    // a Claude-looking agent name or a known agent without a model is not evidence
    expect(resolveAuthMode({ model: null, oauthWired: true, apiKeyWired: false })).toBeNull()
    expect(resolveAuthMode({ model: 'deepseek-v4-pro', oauthWired: true, apiKeyWired: false })).toBeNull()
    expect(resolveAuthMode(null)).toBeNull()
  })
})

describe('gatherAuthFacts / resolveAuthModes', () => {
  it('main agent: setup-token in .env or the fleet token file -> subscription', () => {
    expect(resolveAuthModes(base()).acrobot).toBe('subscription')
    expect(resolveAuthModes(base({ env: { MAIN_AGENT_MODEL: 'claude-opus-5-5' } })).acrobot).toBe('subscription')
    expect(resolveAuthModes(base({ env: { MAIN_AGENT_MODEL: 'claude-opus-5-5' }, fleetTokenPresent: false })).acrobot).toBeNull()
  })

  it('main agent: an API key in .env makes it api alone, null next to a token', () => {
    const env = { MAIN_AGENT_MODEL: 'claude-opus-5-5', ANTHROPIC_API_KEY: 'k' }
    expect(resolveAuthModes(base({ env, fleetTokenPresent: false })).acrobot).toBe('api')
    expect(resolveAuthModes(base({ env })).acrobot).toBeNull()
  })

  it('main agent: no MAIN_AGENT_MODEL -> null (the model is not guessed)', () => {
    expect(resolveAuthModes(base({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } })).acrobot).toBeNull()
  })

  it('worker: the fleet token file is its only wired credential', () => {
    expect(resolveAuthModes(base())['acrobot-worker']).toBe('subscription')
    expect(resolveAuthModes(base({ fleetTokenPresent: false }))['acrobot-worker']).toBeNull()
    expect(resolveAuthModes(base({ env: { ANTHROPIC_API_KEY: 'k' } }))['acrobot-worker']).toBeNull()
  })

  it('sub-agent: no explicit authMode key -> null, even though the launcher defaults to shared', () => {
    const m = resolveAuthModes(base({ subAgents: ['murena'] }))
    expect(m.murena).toBeNull()
  })

  it('sub-agent: explicit shared/own_team with the fleet token -> subscription', () => {
    const cfg: Record<string, Record<string, unknown>> = { a: { authMode: 'shared' }, b: { authMode: 'own_team' } }
    const m = resolveAuthModes(base({ subAgents: ['a', 'b'], subAgentConfig: (n) => cfg[n] }))
    expect(m.a).toBe('subscription')
    expect(m.b).toBe('subscription')
  })

  it('sub-agent: explicit api counts only when the launcher really exports a key', () => {
    const cfg = () => ({ authMode: 'api' })
    expect(resolveAuthModes(base({ subAgents: ['a'], subAgentConfig: cfg, vaultApiKey: () => true })).a).toBe('api')
    expect(resolveAuthModes(base({ subAgents: ['a'], subAgentConfig: cfg })).a).toBeNull()
  })

  it('sub-agent: remote host, own config dir, plan login or non-Claude model -> null', () => {
    const cfg: Record<string, Record<string, unknown>> = {
      r: { authMode: 'shared' },
      d: { authMode: 'shared', claudeConfigDir: '~/.other' },
      p: { authMode: 'shared', claudePlan: 'team' },
      o: { authMode: 'shared' },
    }
    const m = resolveAuthModes(base({
      subAgents: Object.keys(cfg),
      subAgentConfig: (n) => cfg[n],
      subAgentRemoteHost: (n) => (n === 'r' ? 'box' : null),
      subAgentModel: (n) => (n === 'o' ? 'qwen3.6:27b' : 'claude-sonnet-5'),
    }))
    expect(m).toMatchObject({ r: null, d: null, p: null, o: null })
  })

  // b77e2688 (barracuda, #86 review): the remote host is the router-owned registry's.
  // A remoteHost in the agent's own config is ignored at launch, so it must not take
  // a local agent out of the measurement, and a registered one is remote without it.
  it('sub-agent: the remote host comes from the registry, not from the agent config', () => {
    const own = resolveAuthModes(base({
      subAgents: ['a'],
      subAgentConfig: () => ({ authMode: 'shared', remoteHost: 'box' }),
      subAgentRemoteHost: () => null,
    }))
    expect(own.a).toBe('subscription')
    const registered = resolveAuthModes(base({
      subAgents: ['a'],
      subAgentConfig: () => ({ authMode: 'shared' }),
      subAgentRemoteHost: () => 'user@box',
    }))
    expect(registered.a).toBeNull()
  })

  it('the route wires the registry reader, the one the launcher uses', () => {
    const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/routes/measurements.ts'), 'utf-8')
    expect(route).toContain('subAgentRemoteHost: (n) => readAgentRemoteHost(n),')
  })

  it('never reports a fact for an agent it has no source for', () => {
    expect(Object.keys(gatherAuthFacts(base())).sort()).toEqual(['acrobot', 'acrobot-worker'])
  })
})
