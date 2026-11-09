import { defineConfig, devices } from '@playwright/test'

// End-to-end runs against a PRODUCTION BUILD served by `vite preview`, not
// against the dev server: the dev server transforms sources on the fly and
// hides the class of failure that only appears in a bundled, minified build.
//
// The Core API is never reached. MSW serves it from handlers generated off the
// pinned OpenAPI spec, with hand-written scenario overlays on top
// (docs/dev/TESTING.md). `VITE_ENABLE_MSW=1` is what makes the built bundle
// start the worker; without it the app would try to reach a real host and the
// suite would either hang or, worse, pass against staging data.
const PORT = 4173
const BASE_URL = `http://localhost:${PORT}`
// The first-owner journey (docs/specs/09-owner-claim.md) is off by default, and the suite above
// keeps proving it off. Its own build turns it on, served from its own directory and port.
const JOURNEY_PORT = 4174
const JOURNEY_URL = `http://localhost:${JOURNEY_PORT}`
const MOCK_ENV = {
  VITE_ENABLE_MSW: '1',
  // The mock identity provider (ADR-0007): the same library path runs end
  // to end, only the authorize page is faked, at an app-local route MSW
  // and the router only ever register under this mode.
  VITE_AUTH_MODE: 'mock',
  VITE_OIDC_CLIENT_ID: 'console',
  // The screens Core does not serve yet stay in the suites: MSW answers them (docs/dev/CAPABILITIES.md).
  VITE_MOCK_UNSERVED: '1',
  // The order previews a tenant's address under this domain (`src/features/order/tenantAddress.ts`).
  VITE_TENANT_DOMAIN: 'kodera.io',
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // Under CI the JSON report is what the `e2e` job reads to prove every shard ran its share
  // (.github/scripts/check-e2e-shards.py).
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'e2e-report/report.json' }]]
    : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // French is the product default (docs/dev/I18N.md). Running the suite under
    // any other locale would assert on copy no customer ever sees.
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  },
  // Every spec twice: on a light device, then on a dark one. « Automatique » is the default theme
  // and follows the device (docs/specs/10-appearance.md), so the second pass is each screen's
  // flow and axe check in the dark theme a person with a dark device gets on first load. A test
  // about the device itself sets its own with `page.emulateMedia`.
  projects: [
    {
      name: 'chromium',
      testIgnore: /\/e2e\/journey\//,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      testIgnore: /\/e2e\/journey\//,
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
    {
      name: 'journey',
      testMatch: /\/e2e\/journey\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light', baseURL: JOURNEY_URL },
    },
  ],
  webServer: [
    {
      command: `npm run build && npm run preview -- --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...MOCK_ENV,
        VITE_CORE_API_URL: `${BASE_URL}/api/v1`,
        VITE_KEYCLOAK_URL: `${BASE_URL}/auth`,
      },
    },
    {
      command:
        'npx vite build --outDir dist-journey && ' +
        `npx vite preview --outDir dist-journey --port ${JOURNEY_PORT} --strictPort`,
      url: JOURNEY_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...MOCK_ENV,
        VITE_FIRST_OWNER_JOURNEY: '1',
        VITE_CORE_API_URL: `${JOURNEY_URL}/api/v1`,
        VITE_KEYCLOAK_URL: `${JOURNEY_URL}/auth`,
      },
    },
  ],
})
