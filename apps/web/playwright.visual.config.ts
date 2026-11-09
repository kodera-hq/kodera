import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

// The visual suite (docs/dev/TESTING.md §7): the end-to-end suite's build, mock
// API and locale, changing only what makes pixels reproducible. Baselines come
// from one renderer — the pinned image in `scripts/visual.sh` and in CI — so a
// baseline written on any other machine is a false difference.
export default defineConfig({
  ...base,
  testDir: './tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  // A retry turns a nondeterministic baseline into an intermittent green.
  retries: 0,
  // The pinned image is amd64. On Apple silicon it runs emulated, several times
  // slower than CI, and one full-page capture can outlast the default five
  // seconds. These limits only widen a wait; no comparison is loosened.
  timeout: 120_000,
  // `threshold: 0`: any pixel that changed is a difference. Playwright's default
  // 0.2 counts a per-pixel colour change below that as identical, and passed a
  // shift of the ink roles on every screen. One pinned renderer makes zero safe.
  expect: { timeout: 30_000, toHaveScreenshot: { threshold: 0 } },
  use: { ...base.use, contextOptions: { reducedMotion: 'reduce' } },
  // The app's own server only: the first-owner journey's build has no baseline.
  webServer: Array.isArray(base.webServer) ? base.webServer[0] : base.webServer,
  // A laptop's first screen, not the full page: the shell is sticky and one
  // viewport tall, so a full-page capture draws it once over a blank ground —
  // a picture nobody ever sees.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
