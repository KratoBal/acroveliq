// Measurement Layer v1: where a run's auth_mode comes from.
//
// Null over guesses. An auth mode is written only when the agent's LAUNCH PATH
// explicitly wires exactly one kind of credential into the session:
//
//   subscription  the fleet setup-token (CLAUDE_CODE_OAUTH_TOKEN) is exported,
//                 and no API key is wired into the same environment
//   api           an API key (ANTHROPIC_API_KEY) is exported, and no setup-token
//   null          neither, both (precedence would depend on Claude Code's own
//                 rules and a one-time key approval we cannot see), a non-Claude
//                 model, a remote host, or no explicit per-agent setting
//
// What is deliberately NOT evidence: that no API key was found, that a Claude
// model runs, that the agent name is known, or readAgentAuthMode()'s 'shared'
// default for a config without the key. The API guard (scripts/api-guard.py)
// stays a separate safety signal: "no API config found" is not "subscription".
//
// The resolver is pure; gatherAuthFacts() reads the same inputs the launchers
// read (scripts/channels.sh for the main agent, agent-worker.ts for the worker,
// agent-process.ts for sub-agents) without changing any of them.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type MeasuredAuthMode = 'subscription' | 'api'

export interface AuthFacts {
  /** The model the launch path starts, or null if the launch path does not name one. */
  model: string | null
  /** The fleet setup-token is exported into this session's environment. */
  oauthWired: boolean
  /** An Anthropic API key is exported into this session's environment. */
  apiKeyWired: boolean
}

export function resolveAuthMode(f: AuthFacts | null): MeasuredAuthMode | null {
  if (!f || !f.model || !f.model.startsWith('claude-')) return null
  if (f.oauthWired && !f.apiKeyWired) return 'subscription'
  if (f.apiKeyWired && !f.oauthWired) return 'api'
  return null
}

export interface AuthSources {
  mainAgentId: string
  /** Keys of the install's .env (only the ones below are read). */
  env: Record<string, string>
  /** store/.claude-oauth-token exists and is non-empty. */
  fleetTokenPresent: boolean
  /** The worker's launch model (MARVEEN_WORKER_MODEL || DEFAULT_AGENT_MODEL). */
  workerModel: string | null
  subAgents: string[]
  /** The raw agent-config.json object of a sub-agent ({} if missing/unreadable). */
  subAgentConfig: (name: string) => Record<string, unknown>
  /**
   * The sub-agent's remote host as the launcher resolves it: the router-owned
   * registry (readAgentRemoteHost, b77e2688), never the agent's own config, where
   * a remoteHost is ignored at launch and an agent could write one to drop out of
   * the measurement.
   */
  subAgentRemoteHost: (name: string) => string | null
  /** The model the sub-agent launcher resolves (readAgentModel). */
  subAgentModel: (name: string) => string | null
  /** A per-agent API key exists in the vault (agent-<name>-api-key). */
  vaultApiKey: (name: string) => boolean
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/** agent name -> facts, or null when there is no explicit setting to read. */
export function gatherAuthFacts(s: AuthSources): Record<string, AuthFacts | null> {
  // channels.sh exports .env's ANTHROPIC_API_KEY into the tmux server's global
  // environment, so every session started on that server can inherit it.
  const sharedApiKey = nonEmpty(s.env.ANTHROPIC_API_KEY)
  const out: Record<string, AuthFacts | null> = {}

  // Main agent (scripts/channels.sh): .env CLAUDE_CODE_OAUTH_TOKEN, else the
  // fleet token file; .env ANTHROPIC_API_KEY. Model: .env MAIN_AGENT_MODEL only.
  out[s.mainAgentId] = {
    model: nonEmpty(s.env.MAIN_AGENT_MODEL) ? s.env.MAIN_AGENT_MODEL.trim() : null,
    oauthWired: nonEmpty(s.env.CLAUDE_CODE_OAUTH_TOKEN) || s.fleetTokenPresent,
    apiKeyWired: sharedApiKey,
  }

  // Worker (agent-worker.ts startWorkerSessionFor): the fleet token file when
  // present; no key of its own, but it starts on the same tmux server.
  out[`${s.mainAgentId}-worker`] = {
    model: s.workerModel,
    oauthWired: s.fleetTokenPresent,
    apiKeyWired: sharedApiKey,
  }

  // Sub-agents (agent-process.ts): only an EXPLICIT authMode key counts.
  for (const name of s.subAgents) {
    const cfg = s.subAgentConfig(name)
    const mode = cfg.authMode
    if (mode !== 'shared' && mode !== 'own_team' && mode !== 'api') { out[name] = null; continue }
    // A remote host or an own config dir / plan login is outside what we can see.
    if (nonEmpty(s.subAgentRemoteHost(name)) || nonEmpty(cfg.claudeConfigDir) || nonEmpty(cfg.claudePlan)) {
      out[name] = null
      continue
    }
    const model = s.subAgentModel(name)
    if (mode === 'api') {
      // The launcher exports the key only when the vault has it; without it the
      // session falls back to whatever login it finds, which we cannot see.
      out[name] = { model, oauthWired: false, apiKeyWired: s.vaultApiKey(name) || sharedApiKey }
    } else {
      out[name] = { model, oauthWired: s.fleetTokenPresent, apiKeyWired: sharedApiKey }
    }
  }
  return out
}

export function resolveAuthModes(s: AuthSources): Record<string, MeasuredAuthMode | null> {
  const facts = gatherAuthFacts(s)
  const out: Record<string, MeasuredAuthMode | null> = {}
  for (const [name, f] of Object.entries(facts)) out[name] = resolveAuthMode(f)
  return out
}

export function readJsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const v = JSON.parse(readFileSync(path, 'utf-8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch { return {} }
}

export function agentConfigPath(agentDir: string): string {
  return join(agentDir, 'agent-config.json')
}
