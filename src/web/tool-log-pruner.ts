// The tool-call log keeps a day (acrovelIQ P0-1, step sheet L6 point 8): the
// server prunes it, once at start and then hourly. The agents' hook used to
// do it through a route an agent's own token may not call (#84). Once at
// start, because a dashboard restarted within the hour would otherwise never
// reach the first tick, and the log would not shrink (barracuda, #84 review).

export const TOOL_LOG_PRUNE_EVERY_MS = 60 * 60 * 1000

export function startToolLogPruner(
  prune: () => void,
  warn: (err: unknown) => void,
  every: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
): ReturnType<typeof setInterval> {
  const run = () => {
    try {
      prune()
    } catch (err) {
      warn(err)
    }
  }
  run()
  return every(run, TOOL_LOG_PRUNE_EVERY_MS)
}
