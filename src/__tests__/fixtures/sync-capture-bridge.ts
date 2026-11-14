// Card b8ed4f45, slice (b): the router and injection paths read the pane with an ASYNC tmux child now
// (`setCaptureExecForTest` in agent-process.ts). A test that fakes the pane through a mocked
// `execFileSync` (an argument-inspecting answer for `capture-pane`) keeps its fake: this bridges the
// async launcher to it, so the same fake answers both kinds of read and no test needs a second one.
type SyncFake = (file: string, args?: string[], opts?: unknown) => unknown

export function bridgeAsyncCaptureToSync(sync: SyncFake) {
  return ((file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
    try {
      cb(null, String(sync(file, args, { encoding: 'utf-8' }) ?? ''))
    } catch (err) {
      cb(err as Error, '')
    }
    return { stdin: { end: () => undefined } }
  }) as unknown as never
}
