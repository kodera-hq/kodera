import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer, type ViteDevServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let server: ViteDevServer
let origin: string
let cacheDir: string
const fixtureEnvKeys = [
  'VITE_AUTH_MODE',
  'VITE_ENABLE_MSW',
  'VITE_CORE_API_URL',
  'VITE_KEYCLOAK_URL',
  'VITE_OIDC_CLIENT_ID',
] as const
let previousEnv: Record<string, string | undefined> = {}
const issuer = 'https://identity.example.test/realms/community'
const worker = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/legacy-probe')event.respondWith(new Response('simulated'));});`
test.beforeAll(async ({ browser }) => {
  const port = 4193 + test.info().workerIndex
  origin = `http://127.0.0.1:${port}`
  previousEnv = Object.fromEntries(fixtureEnvKeys.map((key) => [key, process.env[key]]))
  process.env.VITE_AUTH_MODE = 'oidc'
  process.env.VITE_ENABLE_MSW = '0'
  process.env.VITE_CORE_API_URL = origin + '/api/v1'
  process.env.VITE_KEYCLOAK_URL = 'https://identity.example.test'
  process.env.VITE_OIDC_CLIENT_ID = 'console'
  const root = fileURLToPath(new URL('../..', import.meta.url))
  cacheDir = mkdtempSync(resolve(tmpdir(), 'kodera-community-auth-'))
  server = await createServer({
    root,
    envDir: false,
    cacheDir,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: {
        allow: [
          resolve(root, '../..'),
          realpathSync(resolve(root, '../../node_modules')),
          realpathSync(resolve(root, '../../node_modules/@kodera/design-tokens')),
        ],
      },
    },
    plugins: [
      {
        name: 'community-retirement-browser-fixture',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url === '/mockServiceWorker.js') {
              response.setHeader('Content-Type', 'text/javascript')
              response.setHeader('Cache-Control', 'no-store')
              response.end(worker)
            } else if (request.url === '/__worker-install') {
              response.setHeader('Content-Type', 'text/html')
              response.end('<!doctype html><title>Worker fixture</title>')
            } else if (request.url === '/legacy-probe') response.end('network')
            else next()
          })
        },
      },
    ],
  })
  await server.listen()
  // A listening dev server still has a cold asynchronous module graph. Prove readiness in a
  // disposable context, so behavioral assertions never include compilation or share auth state.
  const context = await browser.newContext()
  try {
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    )
    const page = await context.newPage()
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.name))
    page.on('requestfailed', (request) => failures.push(new URL(request.url()).pathname))
    page.on('response', (response) => {
      if (response.status() >= 400)
        failures.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    try {
      await page.goto(origin + '/community/workspace')
      await expect(page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible({
        timeout: 20_000,
      })
    } catch (error) {
      console.error('Community fixture failed to become ready', failures.slice(-20))
      throw error
    }
  } finally {
    await context.close()
  }
})
test.afterAll(async () => {
  try {
    await server?.close()
  } finally {
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true })
    for (const key of fixtureEnvKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
})

for (const locale of ['fr', 'en'] as const) {
  test(`${locale}: explicit login and registration use real S256 transactions`, async ({
    page,
  }) => {
    await page.addInitScript(
      (language) => sessionStorage.setItem('console:language', language),
      locale
    )
    await page.route(issuer + '/.well-known/openid-configuration', (route) =>
      route.fulfill({
        json: {
          issuer,
          authorization_endpoint: issuer + '/protocol/openid-connect/auth',
          token_endpoint: issuer + '/protocol/openid-connect/token',
          jwks_uri: issuer + '/protocol/openid-connect/certs',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        },
      })
    )
    for (const registration of [false, true]) {
      await page.goto(origin + '/community/workspace')
      await expect(page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible()
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      if (!registration)
        await page.screenshot({
          path: test.info().outputPath('community-welcome.png'),
          fullPage: true,
        })
      await expect(page.locator('[data-demo-disclosure]')).toHaveCount(0)
      const endpoint =
        issuer + '/protocol/openid-connect/' + (registration ? 'registrations' : 'auth')
      await page.route(endpoint + '**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Identity flow</title>',
        })
      )
      const requested = page.waitForRequest((request) => request.url().startsWith(endpoint))
      await page
        .getByRole('button', {
          name: registration
            ? locale === 'fr'
              ? 'Créer un compte'
              : 'Create an account'
            : locale === 'fr'
              ? 'Se connecter'
              : 'Sign in',
          exact: true,
        })
        .click()
      const url = new URL((await requested).url())
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('state')).toBeTruthy()
      expect(url.searchParams.get('redirect_uri')).toBe(origin + '/auth/callback')
      expect(url.searchParams.get('client_id')).toBe('console')
      // Observing the request does not mean its navigation has committed yet.
      await expect(page).toHaveTitle('Identity flow')
      await page.goto(origin + '/__worker-install')
      expect(await page.evaluate(() => sessionStorage.getItem('kodera.web.auth.returnTo'))).toBe(
        '/community/workspace'
      )
      await page.evaluate(() => sessionStorage.removeItem('kodera.web.auth.realm'))
    }
  })
}

test('a returning browser retires a real legacy worker, clears simulated state and reaches the auth gate once', async ({
  page,
}) => {
  await page.goto(origin + '/__worker-install')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/mockServiceWorker.js')
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        })
      )
    sessionStorage.setItem('msw:scenarios', '["community"]')
    sessionStorage.setItem('kodera.demo.local-workspaces', '[]')
    sessionStorage.setItem('console:language', 'en')
    sessionStorage.setItem('unrelated-state', 'preserved')
  })
  expect(await page.evaluate(async () => (await fetch('/legacy-probe')).text())).toBe('simulated')
  let navigations = 0
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1
  })
  await page.goto(origin + '/community/workspace')
  await expect(page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible()
  expect(navigations).toBeLessThanOrEqual(2)
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
  ).toBe(0)
  expect(await page.evaluate(async () => (await fetch('/legacy-probe')).text())).toBe('network')
  expect(await page.evaluate(() => sessionStorage.getItem('msw:scenarios'))).toBeNull()
  expect(
    await page.evaluate(() => sessionStorage.getItem('kodera.demo.local-workspaces'))
  ).toBeNull()
  expect(await page.evaluate(() => sessionStorage.getItem('unrelated-state'))).toBe('preserved')
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible()
})
