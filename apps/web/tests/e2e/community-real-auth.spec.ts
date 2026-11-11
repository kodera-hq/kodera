import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer, type ViteDevServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

let server: ViteDevServer
const origin = 'http://127.0.0.1:4193'
const issuer = 'https://identity.example.test/realms/community'
const worker = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/legacy-probe')event.respondWith(new Response('simulated'));});`
test.beforeAll(async () => {
  process.env.VITE_AUTH_MODE = 'oidc'
  process.env.VITE_ENABLE_MSW = '0'
  process.env.VITE_CORE_API_URL = origin + '/api/v1'
  process.env.VITE_KEYCLOAK_URL = 'https://identity.example.test'
  process.env.VITE_OIDC_CLIENT_ID = 'console'
  const root = fileURLToPath(new URL('../..', import.meta.url))
  server = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port: 4193,
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
})
test.afterAll(async () => {
  await server?.close()
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
      await page.goto('/community/workspace')
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
      await page.goto('/__worker-install')
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
  await page.goto('/__worker-install')
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
  await page.goto('/community/workspace')
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
