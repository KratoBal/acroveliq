// Every test file gets its own launch-settings store (src/web/agent-launch-settings.ts): the launch path seeds an
// agent's entry on its first read, and without this a test run wrote the install's real
// store/agent-launch-settings.json, and one test's entry leaked into the next test's agent of the same name.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_LAUNCH_SETTINGS = join(mkdtempSync(join(tmpdir(), 'vitest-agent-launch-')), 'agent-launch-settings.json')
