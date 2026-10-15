// Every test file gets its own trusted-profile store (src/web/agent-profile-store.ts): the launch
// path seeds a record on its first read, and without this a test run wrote the install's real
// store/agent-profiles.json, and one test's record leaked into the next test's agent of the same name.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_PROFILE_STORE = join(mkdtempSync(join(tmpdir(), 'vitest-agent-profiles-')), 'agent-profiles.json')
