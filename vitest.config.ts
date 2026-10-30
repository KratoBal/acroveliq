import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
    // Hard gates, run in every worker before any test module is imported:
    //  - assert-not-live-install: refuse to run inside a live install (see that
    //    setup file's header for the 2026-07-27 incident it prevents).
    //  - assert-supported-node: refuse to run on a Node whose ABI the installed
    //    native modules were not built for, which otherwise reds out 40 files
    //    with errors that look like bugs in those files (2026-08-17).
    // The delivery diagnostics (src/web/delivery-diag.ts) append to logs/delivery under the
    // install; router tests would write there from the repo. Tests that read the file set
    // their own path.
    env: { DELIVERY_DIAG_LOG: join(tmpdir(), 'vitest-delivery-diag', 'busy-pane.log') },
    setupFiles: [
      './src/__tests__/setup/assert-not-live-install.ts',
      './src/__tests__/setup/assert-supported-node.ts',
      './src/__tests__/setup/agent-profile-store.ts',
      './src/__tests__/setup/agent-launch-settings.ts',
    ],
  },
})
