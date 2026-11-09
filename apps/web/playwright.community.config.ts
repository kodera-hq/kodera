import { defineConfig, devices } from '@playwright/test'

// An explicit running development server is required; no infrastructure is provisioned.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['community-workspace.spec.ts', 'developer-docs.spec.ts', 'demo-walkthrough.spec.ts'],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  outputDir: './playwright-report/lane77-evidence',
  reporter: [['list'], ['json', { outputFile: './playwright-report/lane77-summary.json' }]],
  use: {
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    permissions: ['clipboard-read', 'clipboard-write'],
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
