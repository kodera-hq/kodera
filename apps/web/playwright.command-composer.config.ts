import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'command-composer.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5193',
    locale: 'fr-FR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    env: {
      VITE_CORE_API_URL: 'http://127.0.0.1:5193/api/v1',
      VITE_KEYCLOAK_URL: 'http://127.0.0.1:5193',
      VITE_OIDC_CLIENT_ID: 'console',
      VITE_MOCK_UNSERVED: '1',
      VITE_TENANT_DOMAIN: 'kodera.test',
    },
    command:
      'VITE_ENABLE_MSW=1 VITE_AUTH_MODE=mock npx vite build --outDir dist/command-composer && npx vite preview --outDir dist/command-composer --host 127.0.0.1 --port 5193 --strictPort',
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
