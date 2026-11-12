import { defineConfig } from '@playwright/test'

// The split-origin harness alone (`tests/e2e/community-split-origin.spec.ts`): it starts its own
// five-origin stack, so it needs no `webServer`. The main suite runs it too.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'community-split-origin.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: { browserName: 'chromium', headless: true },
})
