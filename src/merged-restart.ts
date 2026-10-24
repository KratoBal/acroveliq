// A FRESH SESSION AFTER A MERGE (Balázs, Token thread 2026-10-24 18:04 UTC, via
// acrobot 35964). When pr-beolvaszt.sh records `merged` on a task and its author
// has no other open task, the dashboard restarts that agent with a fresh session,
// if the task has a handoff record to continue from. Without a handoff it only
// tells the main agent: a fresh session with nothing to read starts from zero.
//
// The standing rule of 2026-10-13 holds: a running session is never cut. The
// live-work signals are the context-restart gate's own (pane, child processes,
// transcript quiet, dispatched messages, an open question, the hard guard), read
// by the same gatherGateInputs, and FAIL-CLOSED: an unmeasurable signal is live
// work, and then the main agent is told instead.
//
// The decision is pure; the runner below does the I/O.
import type Database from 'better-sqlite3'

import { createAgentMessage } from './db.js'
import { logger } from './logger.js'
import { latestTaskHandoff } from './task-handoff.js'
import { assigneeTasks, isTaskPaused } from './task-usage.js'
import type { GateInputs } from './context-restart-gate.js'
import { DEFAULT_TRANSCRIPT_QUIET_MS } from './context-restart-gate.js'

/** The events after which a task is no longer open work. */
export const ENDED_KINDS: ReadonlySet<string> = new Set(['done', 'merged', 'deployed', 'cancelled', 'failed', 'partial'])

export interface MergedRestartInputs {
  agent: string | null
  isMainAgent: boolean
  /** The agent's other tasks that are neither ended nor paused. */
  otherOpenTasks: string[]
  hasHandoff: boolean
  live: Pick<
    GateInputs,
    'paneState' | 'hasChildProcesses' | 'msSinceTranscriptWrite' | 'pendingOutboundCount' | 'hasOpenQuestion' | 'hardGuardPhase'
  > | null
}

export type MergedRestartDecision =
  | { action: 'restart'; agent: string; reason: string }
  | { action: 'notify'; agent: string; reason: string }
  | { action: 'skip'; reason: string }

/** Which live-work signal holds the agent, or null when it is idle. FAIL-CLOSED. */
export function liveWork(live: MergedRestartInputs['live'], quietMs = DEFAULT_TRANSCRIPT_QUIET_MS): string | null {
  if (live === null) return 'live work not measurable'
  if (live.hardGuardPhase !== 'idle' && live.hardGuardPhase !== 'cooldown') return `context guard: ${live.hardGuardPhase}`
  if (live.paneState !== 'idle') return `pane: ${live.paneState ?? 'not capturable'}`
  if (live.hasChildProcesses !== false) return live.hasChildProcesses === null ? 'child processes not measurable' : 'child processes running'
  if (live.msSinceTranscriptWrite === null) return 'transcript not readable'
  if (live.msSinceTranscriptWrite < quietMs) return 'transcript written in the last minutes'
  if (live.pendingOutboundCount > 0) return 'dispatched messages waiting'
  if (live.hasOpenQuestion) return 'an open question'
  return null
}

export function decideMergedRestart(i: MergedRestartInputs): MergedRestartDecision {
  if (!i.agent) return { action: 'skip', reason: 'the task has no assignee' }
  if (i.isMainAgent) return { action: 'skip', reason: 'the main agent is service-managed' }
  if (i.otherOpenTasks.length > 0)
    return { action: 'skip', reason: `other open task: ${i.otherOpenTasks.join(', ')}` }
  if (!i.hasHandoff) return { action: 'notify', agent: i.agent, reason: 'no handoff record: not restarted' }
  const holding = liveWork(i.live)
  if (holding) return { action: 'notify', agent: i.agent, reason: `live work (${holding}): not restarted` }
  return { action: 'restart', agent: i.agent, reason: 'merged, no other open task, handoff present, idle' }
}

/** The assignee's other tasks that are still open work (not ended, not paused). */
export function otherOpenTasks(db: Database.Database, agent: string, taskId: string): string[] {
  return assigneeTasks(db, agent)
    .filter((t) => t.id !== taskId && t.last_kind !== null && !ENDED_KINDS.has(t.last_kind) && !isTaskPaused(db, t.id))
    .map((t) => t.id)
}

export interface MergedRestartDeps {
  db: Database.Database
  mainAgent: string
  isMainAgent: (name: string) => boolean
  gatherLive: (name: string) => MergedRestartInputs['live']
  restart: (name: string) => Promise<{ ok: boolean; error?: string }>
  notify?: (from: string, to: string, text: string, taskId: string) => void
}

/**
 * After a `merged` event: decide and act. Never throws; every outcome is logged,
 * and the main agent hears of a restart and of a notify.
 */
export async function afterMergedEvent(taskId: string, deps: MergedRestartDeps): Promise<MergedRestartDecision> {
  const notify = deps.notify ?? ((from, to, text, task) => void createAgentMessage(from, to, text, null, null, task))
  let decision: MergedRestartDecision
  try {
    const row = deps.db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(taskId) as { assignee: string | null } | undefined
    const agent = row?.assignee ?? null
    decision = decideMergedRestart({
      agent,
      isMainAgent: agent ? deps.isMainAgent(agent) : false,
      otherOpenTasks: agent ? otherOpenTasks(deps.db, agent, taskId) : [],
      hasHandoff: latestTaskHandoff(deps.db, taskId) !== null,
      live: agent ? deps.gatherLive(agent) : null,
    })
  } catch (err) {
    logger.warn({ err, taskId }, 'merged-restart: decision failed, nothing done')
    return { action: 'skip', reason: 'decision failed' }
  }
  logger.info({ taskId, ...decision }, 'merged-restart: decision')
  try {
    if (decision.action === 'restart') {
      const result = await deps.restart(decision.agent)
      notify(
        'system',
        deps.mainAgent,
        result.ok
          ? `${decision.agent} ujrainditva friss munkamenettel a ${taskId} beolvadasa utan. Atado rekord: fleet-api.sh handoff-read ${taskId}`
          : `${decision.agent} ujrainditasa a ${taskId} beolvadasa utan nem sikerult: ${result.error ?? 'ismeretlen hiba'}`,
        taskId,
      )
    } else if (decision.action === 'notify') {
      notify('system', deps.mainAgent, `${decision.agent}: a ${taskId} beolvadt, ${decision.reason}.`, taskId)
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'merged-restart: action failed')
  }
  return decision
}
