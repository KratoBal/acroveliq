import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Card b8ed4f45 / a8f718f7, slice (b2), task t-20261114-router-capture-nonblocking: after the router path (#364) the
// recurring watchers and runners still read panes with a SYNCHRONOUS `sudo fleet-pane` child each (one to four per
// agent per sweep). They read through the async twins now. The watchers are driven by timers and the live fleet, so the
// wiring is guarded in the source, the way the other source-level guards in this suite are: a file that is fully
// converted must contain no synchronous pane reader call.
//
// WHAT TURNS THIS RED: a watcher or runner that calls capturePane( or captureParkedInputView( again.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')
const SYNC_READ = /\b(capturePane|captureParkedInputView)\(/

/** Files whose every pane read is async now. */
const CONVERTED = [
  'agent-worker.ts',
  'auto-restart-runner.ts',
  'channel-health-monitor.ts',
  'channel-monitor.ts',
  'context-guard-runner.ts',
  'model-fallback-runner.ts',
  'reauth-healer.ts',
  'schedule-runner.ts',
  'stuck-input-watcher.ts',
  'stuck-tool-call-watcher.ts',
  'routes/agents.ts',
]

describe('the recurring watchers and runners read panes with no synchronous child', () => {
  for (const file of CONVERTED) {
    it(`${file}: no sync capturePane( or captureParkedInputView( call`, () => {
      expect(read(file)).not.toMatch(SYNC_READ)
    })
  }

  it('the converted files really use the async twins (the guard above is not satisfied by deleting the read)', () => {
    for (const file of CONVERTED.filter((f) => f !== 'routes/agents.ts')) {
      expect(read(file), file).toMatch(/\b(capturePaneAsync|captureParkedInputViewAsync)\(/)
    }
  })

  /*
    A pass that now awaits can still be running when its interval fires; the sync versions could not overlap by
    construction. The two monitors that were plain sync callbacks got an explicit one-at-a-time guard.
  */
  it('channel-health-monitor and reauth-healer sweeps cannot overlap', () => {
    expect(read('channel-health-monitor.ts')).toMatch(/let running = false/)
    expect(read('channel-health-monitor.ts')).toMatch(/if \(running\) return/)
    expect(read('reauth-healer.ts')).toMatch(/let sweeping = false/)
    expect(read('reauth-healer.ts')).toMatch(/if \(sweeping\) return/)
  })
})
