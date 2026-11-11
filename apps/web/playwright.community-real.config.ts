import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'community-real-auth.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:4193' },
})
