import { defineConfig, devices } from '@playwright/test'

// Espace's real-stack audio proof runs locally and in CI from
// `bash tests/espace/stack/bin/audio-proof.sh`. The stack defaults to ../server in this
// monorepo and writes only generated .runtime/config state. Layout specs use a fake store
// and need no stack; select them by path.
//
// The page is served by Vite's dev server on 127.0.0.1:5173, the one origin room-access's CORS
// allows (`CONSOLE_ORIGIN`), and a plain-HTTP homeserver on this machine is accepted in
// development only (src/auth/matrix.ts).
const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/espace',
  testMatch: /\/(audio|layout)\/.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    // Chromium's fake microphone plays a tone, and nobody is asked for it.
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    permissions: ['microphone'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${BASE_URL}/tests/espace/audio/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
