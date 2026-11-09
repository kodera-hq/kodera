import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'developer-docs.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5190',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'npm run docs:check && VITE_ENABLE_MSW=1 VITE_AUTH_MODE=mock npx vite build --outDir dist/docs-browser && npx vite preview --outDir dist/docs-browser --host 127.0.0.1 --port 5190 --strictPort',
    url: 'http://127.0.0.1:5190',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
