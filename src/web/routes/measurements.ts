// /api/measurements/* -- Measurement Layer v1 (see docs/measurement-layer-v1.md).
//
// Read side:
//   GET  /api/measurements/tasks   per-card totals          ?agent=&limit=
//   GET  /api/measurements/runs    one row per in_progress   ?agent=&task=&limit=
//   GET  /api/measurements/usage   quota samples, newest 1st ?from=<epoch s>&limit=
// Write side (measurement tables only, never business data):
//   POST /api/measurements/refresh              re-ingest quota samples + re-derive runs
//   POST /api/measurements/runs/outcome         {runId, success, reviewer, note?}
//
// Every read response carries `provenance`, so exact and derived numbers
// cannot be told apart only by reading the docs.

import { join } from 'node:path'
import { getDb } from '../../db.js'
import { STORE_DIR, MAIN_AGENT_ID, DEFAULT_AGENT_MODEL } from '../../config.js'
import { readEnvFile } from '../../env.js'
import { json, readBody } from '../http-helpers.js'
import { agentDir, listAgentNames, readAgentModel, readAgentRemoteHost, readAgentClaudeConfigDir, readAgentClaudePlan } from '../agent-config.js'
import { hasFleetOauthToken } from '../agent-process.js'
import { getSecret } from '../vault.js'
import { agentConfigPath, readJsonObject, resolveAuthModes } from '../measurement-auth.js'
import {
  FIELD_PROVENANCE, SUCCESS_VALUES, deriveRuns, ingestQuotaSamples, listQuotaSamples,
  listRuns, listTasks, loadPriceFile, setRunOutcome, type SuccessValue,
} from '../measurements.js'
import type { RouteContext } from './types.js'
import { B29_ARNYEK_DIR, summarizeB29 } from '../b29-arnyek.js'

export const MEASUREMENTS_DIR = join(STORE_DIR, 'measurements')
export const QUOTA_SAMPLES_PATH = join(MEASUREMENTS_DIR, 'quota-samples.jsonl')
export const PRICES_PATH = join(MEASUREMENTS_DIR, 'prices.json')

/** Ingest + derive. Called by the periodic collector and by POST /refresh. */
export function refreshMeasurements(): { quotaInserted: number; runs: number } {
  const db = getDb()
  // Explicit launch configuration only; anything unreadable resolves to null.
  let authModes: Record<string, 'subscription' | 'api' | null> = {}
  try {
    authModes = resolveAuthModes({
      mainAgentId: MAIN_AGENT_ID,
      env: readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MAIN_AGENT_MODEL']),
      fleetTokenPresent: hasFleetOauthToken(),
      workerModel: process.env.MARVEEN_WORKER_MODEL || DEFAULT_AGENT_MODEL || null,
      subAgents: listAgentNames(),
      // the login keys from the trusted record, not from the agent's own config (agent-launch-settings.ts)
      subAgentConfig: (n) => ({ ...readJsonObject(agentConfigPath(agentDir(n))), claudeConfigDir: readAgentClaudeConfigDir(n), claudePlan: readAgentClaudePlan(n) }),
      subAgentRemoteHost: (n) => readAgentRemoteHost(n),
      subAgentModel: (n) => { try { return readAgentModel(n) } catch { return null } },
      vaultApiKey: (n) => { try { return !!getSecret(`agent-${n}-api-key`) } catch { return false } },
    })
  } catch { /* every run keeps auth_mode null */ }
  const quotaInserted = ingestQuotaSamples(db, QUOTA_SAMPLES_PATH)
  const runs = deriveRuns(db, { prices: loadPriceFile(PRICES_PATH), authModes })
  return { quotaInserted, runs }
}

function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name)
  if (v === null || v === '') return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

export async function tryHandleMeasurements(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/measurements/')) return false
  const db = getDb()

  if (path === '/api/measurements/runs' && method === 'GET') {
    json(res, {
      provenance: FIELD_PROVENANCE,
      runs: listRuns(db, {
        agent: url.searchParams.get('agent') || undefined,
        task: url.searchParams.get('task') || undefined,
        limit: intParam(url, 'limit'),
      }),
    })
    return true
  }

  if (path === '/api/measurements/tasks' && method === 'GET') {
    json(res, {
      provenance: FIELD_PROVENANCE,
      tasks: listTasks(db, { agent: url.searchParams.get('agent') || undefined, limit: intParam(url, 'limit') }),
    })
    return true
  }

  if (path === '/api/measurements/usage' && method === 'GET') {
    const samples = listQuotaSamples(db, { from: intParam(url, 'from'), limit: intParam(url, 'limit') })
    json(res, {
      source: 'claude-code-statusline rate_limits (one shared subscription account)',
      latest: samples[0] ?? null,
      samples,
    })
    return true
  }

  if (path === '/api/measurements/b29-arnyek' && method === 'GET') {
    json(res, {
      source: 'B29 shadow hook (scripts/hooks/b29-arnyek.py): an ESTIMATE of what the fo-agens strict profile would have asked or denied, not the engine',
      days: summarizeB29(B29_ARNYEK_DIR, intParam(url, 'days') ?? 7),
    })
    return true
  }

  if (path === '/api/measurements/refresh' && method === 'POST') {
    json(res, { ok: true, ...refreshMeasurements() })
    return true
  }

  if (path === '/api/measurements/runs/outcome' && method === 'POST') {
    let body: { runId?: unknown; success?: unknown; reviewer?: unknown; note?: unknown }
    try { body = JSON.parse((await readBody(req)).toString('utf-8') || '{}') } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    if (typeof body.runId !== 'string' || typeof body.reviewer !== 'string' || !body.reviewer.trim()
      || !SUCCESS_VALUES.includes(body.success as SuccessValue)) {
      json(res, { error: `runId, reviewer and success (${SUCCESS_VALUES.join('|')}) are required` }, 400)
      return true
    }
    const ok = setRunOutcome(db, body.runId, body.success as SuccessValue, body.reviewer.trim(),
      typeof body.note === 'string' ? body.note : null)
    json(res, ok ? { ok: true } : { error: 'run not found' }, ok ? 200 : 404)
    return true
  }

  return false
}
