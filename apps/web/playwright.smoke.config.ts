import { defineConfig, devices } from '@playwright/test'

// The v1 smoke (tests/smoke/README.md): real browsers against a Console that is already served,
// locally or on staging, named by SMOKE_BASE_URL. No web server, no mocks, no retries: a red step
// is a finding.
const baseURL = process.env['SMOKE_BASE_URL']
if (!baseURL) throw new Error('SMOKE_BASE_URL names no Console (tests/smoke/README.md)')
// A trace records every field typed and every URL: the password, the codes and the claim link.
// Kept only for a loopback Console, whose accounts are derived test values.
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 180_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'fr-FR',
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    permissions: ['microphone'],
    trace: loopback ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium' }],
})
