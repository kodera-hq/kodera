import { defineConfig, devices } from '@playwright/test'
import { devNull } from 'node:os'
import { walkOutputDir } from './output-dir'

// The staging walk (e2e/staging/README.md): real browsers against the deployed staging Console,
// against the target deployment. No web server, no mocks, no retries: a red step is a finding. It never changes
// staging data beyond what a signed-in person reads, and never places an order.
const baseURL = process.env['KODERA_STAGING_URL'] ?? 'https://app.example.test'

// A failure on staging can capture a username, a one-time code field or an invitation link.
// Traces, screenshots and videos are off. Playwright still writes `error-context.md` for a failed
// test: the error, its call log and an ARIA snapshot of the page. The variable below stops the
// snapshot taken when a test fails outside an assertion (a sign-in step on Keycloak's page); a
// failed assertion attaches its own, and nothing turns that off. So every output goes to a fresh
// temporary directory (output-dir.ts), which teardown.ts removes after the run. The config is
// read again by each worker: they inherit the first one's directory. The runner's
// `.last-run.json` is written after teardown, into that directory by default: it goes nowhere
// instead (and `--last-failed` has nothing to read).
process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1'
process.env['PLAYWRIGHT_LAST_RUN_OUTPUT_FILE'] = devNull
const outputDir = walkOutputDir()

export default defineConfig({
  testDir: '.',
  outputDir,
  globalTeardown: './teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
})
