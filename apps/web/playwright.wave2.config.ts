import { defineConfig, devices } from '@playwright/test'

const origins = {
  web: process.env['KODERA_WAVE2_WEB_ORIGIN'] ?? 'https://web.example.test',
  landing: process.env['KODERA_WAVE2_LANDING_ORIGIN'] ?? 'https://landing.example.test',
  auth: process.env['KODERA_WAVE2_AUTH_ORIGIN'] ?? 'https://auth.example.test',
  api: process.env['KODERA_WAVE2_API_ORIGIN'] ?? 'https://api.example.test',
}

// An externally promoted deployment owns all services. This config starts no local processes.
process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1'
export default defineConfig({
  testDir: './tests/wave2',
  testMatch: '*.spec.ts',
  outputDir: './test-results/wave2',
  globalSetup: './tests/wave2/teardown.ts',
  globalTeardown: './tests/wave2/teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { threshold: 0, maxDiffPixels: 0, animations: 'disabled' },
  },
  reporter: './tests/wave2/reporter.ts',
  metadata: { origins, qualification: 'runtime-pending' },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origins.web,
    locale: 'fr-FR',
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
})
