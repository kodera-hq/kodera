/// <reference lib="dom" />

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { build, type InlineConfig } from 'vite'
import { radixSelectViewportStylePlugin } from '../../scripts/vite/radixSelectViewportStyle'
import { EXAMPLES } from '../../src/mocks/generated/examples'

const app = 'https://app.kodera.test'
const ingestion = 'https://eu.i.posthog.com/i/v0/e/'
const issuer = app + '/auth/realms/acme-sa'
const me = EXAMPLES.getMe.body
const member = me.organisations[0]!
const scopeKey = 'kodera.telemetry.consent.v1:' + JSON.stringify([me.id, member.organisation.id])
const general = EXAMPLES.getWorkspace.body.categories[0]!.channels[1]!
const confidential = {
  ...general,
  id: '0192f3a4-5b6c-7d8e-9f01-23456789abdf',
  name: 'confidential',
  template_key: 'confidential',
  is_confidential: true,
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
let dist: string

test.describe.configure({ mode: 'default' })
test.use({ serviceWorkers: 'block' })
test.beforeAll(async () => {
  test.setTimeout(180_000)
  dist = await mkdtemp(join(tmpdir(), 'kodera-h55-'))
  const options: InlineConfig = {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    envDir: false,
    logLevel: 'error',
    define: {
      'import.meta.env.VITE_AUTH_MODE': JSON.stringify('oidc'),
      'import.meta.env.VITE_ENABLE_MSW': JSON.stringify('0'),
      'import.meta.env.VITE_KEYCLOAK_URL': JSON.stringify(app + '/auth'),
      'import.meta.env.VITE_CORE_API_URL': JSON.stringify(app + '/api/v1'),
      'import.meta.env.VITE_OIDC_CLIENT_ID': JSON.stringify('console'),
      'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify('ph' + 'c_fixture'),
      'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify('https://eu.i.posthog.com'),
    },
  }
  await build({ ...options, build: { outDir: dist } })
  // The component fixture has its own entry; the application retains its bootstrap graph gate.
  await build({
    ...options,
    configFile: fileURLToPath(new URL('../../.storybook/vite.config.ts', import.meta.url)),
    plugins: [radixSelectViewportStylePlugin()],
    resolve: {
      alias: {
        'react-style-singleton': fileURLToPath(
          new URL('../../src/ui/csp/styleSingleton.ts', import.meta.url)
        ),
      },
    },
    build: {
      outDir: dist,
      emptyOutDir: false,
      rollupOptions: { input: fileURLToPath(new URL('./fixtures/h55-live.html', import.meta.url)) },
    },
  })
})
test.afterAll(async () => {
  if (dist) await rm(dist, { recursive: true, force: true })
})

interface Capture {
  api_key: string
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}

async function fixture(page: Page, planTier = 'freemium_pme', hostingMode?: string) {
  const captures: Capture[] = []
  const workspace = structuredClone(EXAMPLES.getWorkspace.body)
  workspace.categories[0]!.channels.push(confidential, {
    ...confidential,
    id: confidential.id + '-audio',
    kind: 'audio',
    name: 'confidential-audio',
  })
  await page.route('**/*', (route) => {
    const request = route.request()
    const { origin, pathname } = new URL(request.url())
    if (request.url() === ingestion) {
      if (request.method() === 'POST') captures.push(request.postDataJSON() as Capture)
      return route.fulfill({
        json: { status: 1 },
        headers: {
          'Access-Control-Allow-Origin': app,
          'Access-Control-Allow-Headers': 'content-type',
        },
      })
    }
    if (origin !== app) return route.fulfill({ status: 404 })
    if (pathname === '/api/v1/me')
      return route.fulfill({
        json: {
          ...me,
          identities: [{ ...me.identities[0], issuer }],
          organisations: [{ ...member, plan_tier: planTier }],
        },
      })
    if (pathname.startsWith('/api/v1/') && pathname.endsWith('/workspace'))
      return route.fulfill({ json: workspace })
    if (pathname.startsWith('/api/v1/') && pathname.endsWith('/tenants'))
      return route.fulfill({
        json: {
          data: hostingMode
            ? [
                {
                  id: 'fixture-tenant',
                  slug: 'acme-sa',
                  status: 'active',
                  hosting_mode: hostingMode,
                },
              ]
            : [],
        },
      })
    // Contract examples serve the remaining read-only shell and home collections.
    if (pathname.startsWith('/api/v1/')) {
      const example = Object.values(EXAMPLES).find(
        (entry) =>
          entry.method === 'get' &&
          new RegExp('^/api/v1' + entry.path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(pathname)
      )
      return route.fulfill({ json: example?.body ?? { data: [] } })
    }
    if (pathname.endsWith('/.well-known/openid-configuration'))
      return route.fulfill({
        json: {
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        },
      })
    if (pathname.endsWith('/authorize')) {
      const params = new URL(request.url()).searchParams
      const callback = new URL(params.get('redirect_uri')!)
      callback.searchParams.set('state', params.get('state')!)
      callback.searchParams.set('code', 'fixture-code')
      return route.fulfill({
        contentType: 'text/html',
        body: `<meta http-equiv="refresh" content="0;url=${callback.href.replaceAll('&', '&amp;')}">`,
      })
    }
    if (pathname.endsWith('/token')) {
      const now = Math.floor(Date.now() / 1000)
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
      return route.fulfill({
        json: {
          id_token: [
            encode({ alg: 'RS256' }),
            encode({
              sub: me.identities[0]!.subject,
              iss: issuer,
              aud: 'console',
              iat: now,
              exp: now + 600,
            }),
            'fixture',
          ].join('.'),
          access_token: 'fixture-access',
          token_type: 'Bearer',
          expires_in: 600,
        },
      })
    }
    const file = join(
      dist,
      request.isNavigationRequest() && !pathname.endsWith('h55-live.html') ? 'index.html' : pathname
    )
    return existsSync(file)
      ? route.fulfill({
          path: file,
          headers: { 'Content-Security-Policy': "style-src 'self'; style-src-attr 'none'" },
        })
      : route.fulfill({ status: 404 })
  })
  return captures
}

async function signIn(page: Page, path = '/workspace') {
  await page.goto(app + '/acme-sa' + path)
  await expect(page.locator('main h1').first()).toBeVisible()
}
async function privacyPanel(page: Page) {
  await page.locator('[data-workspace-settings-trigger]').first().click()
  await page.getByRole('tab', { name: 'Confidentialité & RGPD', exact: true }).click()
  return page.getByRole('switch', {
    name: 'Autoriser les diagnostics facultatifs pour cet espace',
    exact: true,
  })
}
async function canary(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('canary.pii@acme.fr Auth' + 'Token sample') })
    )
    window.dispatchEvent(new Event('kodera:route-error'))
  })
}

const allowedProperties: Record<string, string[]> = {
  navigation_completed: ['area', 'duration_ms'],
  web_vital: ['metric', 'value'],
  resource_latency: ['operation', 'duration_ms'],
  client_error: ['source', 'kind', 'area', 'component', 'stack'],
  home_viewed: ['tenant_state', 'cards_rendered'],
}
function expectPrivate(captures: Capture[]) {
  expect(captures.length).toBeGreaterThan(0)
  for (const capture of captures) {
    expect(Object.keys(capture).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties'])
    expect(capture.api_key).toBe('ph' + 'c_fixture')
    expect(capture.distinct_id).toMatch(uuid)
    expect(allowedProperties[capture.event], capture.event).toBeDefined()
    expect(capture.properties).toMatchObject({
      $geoip_disable: true,
      $process_person_profile: false,
    })
    expect(
      Object.keys(capture.properties).every((key) =>
        [
          ...allowedProperties[capture.event]!,
          '$geoip_disable',
          '$process_person_profile',
        ].includes(key)
      )
    ).toBe(true)
  }
  expect(JSON.stringify(captures)).not.toMatch(/canary|acme|Bearer|secret/i)
}

test('EU opt-in excludes PII, aborts in flight at a confidential channel and rotates the session on return', async ({
  page,
}) => {
  const captures = await fixture(page)
  await signIn(page, '/workspace/' + general.id)
  await canary(page)
  const toggle = await privacyPanel(page)
  await expect(toggle).not.toBeChecked()
  expect(captures).toHaveLength(0)
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const beforePending = captures.length
  await expect
    .poll(async () => {
      await canary(page)
      return captures.length
    })
    .toBeGreaterThanOrEqual(beforePending + 2)
  await expect
    .poll(() => captures.filter((capture) => capture.event === 'client_error').length)
    .toBeGreaterThan(0)
  expectPrivate(captures)
  const d1 = captures.at(-1)!.distinct_id
  // The real fetch starts, while its response stays pending. The page records its own signal.
  let releaseResponse = () => {}
  await page.evaluate((url) => {
    const original = window.fetch.bind(window)
    Object.assign(window, {
      h55Aborted: false,
      h55Started: false,
      h55AbortPath: '',
      h55Deliveries: [] as string[],
    })
    window.fetch = (input, init) => {
      if (input === url && init?.signal) {
        ;(window as unknown as { h55Deliveries: string[] }).h55Deliveries.push(location.pathname)
        Object.assign(window, { h55Started: true })
        init.signal.addEventListener(
          'abort',
          () => Object.assign(window, { h55Aborted: true, h55AbortPath: location.pathname }),
          { once: true }
        )
      }
      return original(input, init)
    }
  }, ingestion)
  let holdIngestion = true
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route(ingestion, async (route) => {
    if (route.request().method() !== 'POST' || !holdIngestion) return route.fallback()
    captures.push(route.request().postDataJSON() as Capture)
    await responseReleased
    await route
      .fulfill({ json: { status: 1 }, headers: { 'Access-Control-Allow-Origin': app } })
      .catch(() => undefined)
  })
  try {
    const pendingCount = captures.length
    await canary(page)
    await expect.poll(() => captures.length).toBeGreaterThanOrEqual(pendingCount + 2)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { h55Started: boolean }).h55Started))
      .toBe(true)
    await page.getByRole('link', { name: 'confidential', exact: true }).click()
    await expect(page).toHaveURL(app + '/acme-sa/workspace/' + confidential.id)
    expect(
      await page.evaluate(() => (window as unknown as { h55Aborted: boolean }).h55Aborted)
    ).toBe(true)
    expect(
      await page.evaluate(() => (window as unknown as { h55AbortPath: string }).h55AbortPath)
    ).toBe('/acme-sa/workspace/' + confidential.id)
  } finally {
    holdIngestion = false
    releaseResponse()
  }
  const count = captures.length
  await canary(page)
  const held = await privacyPanel(page)
  await expect(held).toBeDisabled()
  await expect(held).not.toBeChecked()
  await expect(
    page.getByText(/Les diagnostics sont suspendus dans ce canal confidentiel/).first()
  ).toBeVisible()
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(count)
  expect(
    await page.evaluate(() => (window as unknown as { h55Deliveries: string[] }).h55Deliveries)
  ).not.toContain('/acme-sa/workspace/' + confidential.id)
  expect(await page.evaluate((key) => localStorage.getItem(key), scopeKey)).toBe('yes')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('link', { name: 'général', exact: true }).click()
  await expect(page).toHaveURL(app + '/acme-sa/workspace/' + general.id)
  await expect
    .poll(async () => {
      await canary(page)
      return captures.length
    })
    .toBeGreaterThan(count)
  const after = captures.slice(count)
  expect(after.every((capture) => capture.distinct_id !== d1)).toBe(true)
  expect(new Set(after.map((capture) => capture.distinct_id)).size).toBe(1)
  expectPrivate(captures)
})

test('sovereign policy overrides pre-seeded consent without erasing the choice', async ({
  page,
}) => {
  const captures = await fixture(page, 'sovereign')
  await page.addInitScript(({ key }) => localStorage.setItem(key, 'yes'), { key: scopeKey })
  await signIn(page)
  await canary(page)
  const toggle = await privacyPanel(page)
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText(/politique d’hébergement de cet espace/).first()).toBeVisible()
  await canary(page)
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), scopeKey)).toBe('yes')
})

test('dedicated hosting blocks saved consent on a direct home entry and keeps settings disabled', async ({
  page,
}) => {
  const captures = await fixture(page, 'freemium_pme', 'cloud_dedicated')
  await page.addInitScript((key) => localStorage.setItem(key, 'yes'), scopeKey)
  await signIn(page, '/home')
  await canary(page)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: 'Confidentialité & RGPD', exact: true }).click()
  const toggle = page.getByRole('switch', {
    name: 'Autoriser les diagnostics facultatifs pour cet espace',
    exact: true,
  })
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText(/politique d’hébergement de cet espace/).first()).toBeVisible()
  await canary(page)
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), scopeKey)).toBe('yes')
})

test('a confidential audio channel URL cuts off saved consent before navigation and vitals', async ({
  page,
}) => {
  const captures = await fixture(page)
  await page.addInitScript((key) => localStorage.setItem(key, 'yes'), scopeKey)
  await signIn(page, '/workspace/' + confidential.id + '-audio')
  await canary(page)
  const toggle = await privacyPanel(page)
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(0)
})

test('a confidential call in the dock and an unsynced DM hold the live view transport', async ({
  page,
}) => {
  const captures = await fixture(page)
  await page.goto(app + '/tests/e2e/fixtures/h55-live.html')
  await expect(page.getByTestId('telemetry-state')).toHaveText('active')
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: 'Telemetry probe', exact: true }).click()
      return captures.length
    })
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: /Rejoindre Protected audio/ }).click()
  await page.getByRole('link', { name: /^général/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toBeVisible()
  await expect(page.getByTestId('telemetry-state')).toHaveText('held')
  let count = captures.length
  await page.getByRole('button', { name: 'Telemetry probe', exact: true }).click()
  await canary(page)
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(count)
  await page.getByRole('button', { name: 'End protected call', exact: true }).click()
  await expect(page.getByTestId('telemetry-state')).toHaveText('active')
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: 'Telemetry probe', exact: true }).click()
      return captures.length
    })
    .toBeGreaterThan(count)
  await page.getByRole('button', { name: 'Pending DM', exact: true }).click()
  await expect(page.getByTestId('telemetry-state')).toHaveText('held')
  count = captures.length
  await canary(page)
  await page.getByRole('button', { name: 'Telemetry probe', exact: true }).click()
  await page.waitForTimeout(250)
  expect(captures).toHaveLength(count)
})

for (const theme of ['dark', 'black', 'light'] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${theme} ${viewport.width}×${viewport.height}: four surfaces preserve tokens, branding, layout and AA contrast`, async ({
      page,
    }) => {
      test.setTimeout(90_000)
      await page.setViewportSize(viewport)
      await fixture(page)
      await page.addInitScript((choice) => localStorage.setItem('console:theme', choice), theme)
      for (const path of ['/login', '/acme-sa/home', '/acme-sa/appearance', '/acme-sa/workspace']) {
        if (path === '/acme-sa/home') await signIn(page, '/home')
        else await page.goto(app + path)
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await page.evaluate(() => document.fonts.ready)
        await expect
          .poll(
            () =>
              page
                .locator('[style]')
                .evaluateAll((elements) => elements.map((element) => element.outerHTML)),
            { message: path }
          )
          .toEqual([])
        const visual = await page.evaluate(() => {
          const root = document.documentElement
          const css = getComputedStyle(root)
          const hexColor = (value: string) => {
            const hex = value.trim().replace('#', '').toLowerCase()
            return '#' + (hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex)
          }
          const luminance = (value: string) => {
            const hex = hexColor(value).slice(1)
            const values = hex
              .match(/.{2}/g)!
              .map((component) => parseInt(component, 16) / 255)
              .map((component) =>
                component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
              )
            return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722
          }
          const ratios = ['--c-ink', '--c-ink-2'].flatMap((ink) =>
            ['--c-page', '--c-surface'].map((surface) => {
              const values = [
                luminance(css.getPropertyValue(ink)),
                luminance(css.getPropertyValue(surface)),
              ].sort((a, b) => a - b)
              return (values[1]! + 0.05) / (values[0]! + 0.05)
            })
          )
          const mono = document.createElement('code')
          mono.className = 'font-mono'
          document.body.append(mono)
          const monoFont = getComputedStyle(mono).fontFamily
          mono.remove()
          return {
            overflow: root.scrollWidth > innerWidth,
            page: hexColor(css.getPropertyValue('--c-page')),
            font: css.fontFamily,
            monoFont,
            ratios,
            fonts: [...document.querySelectorAll('body *')].map(
              (element) => getComputedStyle(element).fontFamily
            ),
          }
        })
        expect(visual.overflow, path).toBe(false)
        expect(visual.page).toBe({ dark: '#08090a', black: '#000000', light: '#ffffff' }[theme])
        expect(visual.font).toContain('Inter Variable')
        expect(visual.monoFont).toContain('IBM Plex Mono')
        expect(visual.fonts.join(' ')).not.toContain(['Plus', 'Jakarta', 'Sans'].join(' '))
        for (const ratio of visual.ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
        // Desktop rail uses the published SVG file; the narrow header and login inline the same mark.
        const mark = page.locator('svg[viewBox="0 0 463 608.663"]').first()
        if (await mark.count()) await expect(mark.locator('path')).toHaveCount(7)
        else {
          const image = page.locator('img[src="/kodera-mark-white.svg"]').first()
          await expect(image).toBeVisible()
          const svg = await page.evaluate(async () =>
            (await fetch('/kodera-mark-white.svg')).text()
          )
          expect(svg).toContain('viewBox="0 0 463 608.663"')
          expect(svg.match(/<path\b/g)).toHaveLength(7)
        }
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
        expect(axe.violations, path).toEqual([])
      }
    })
  }
}
