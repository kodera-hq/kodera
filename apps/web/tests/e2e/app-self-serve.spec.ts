import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import { EXAMPLES } from '../../src/mocks/generated/examples'

const app = 'https://app.kodera.test'
const community = 'https://community.kodera.test'
const identity = 'https://identity.kodera.test'
const issuer = identity + '/realms/community'
const user = { ...EXAMPLES.getMe.body.identities[0]!, issuer, realm: 'community' }
const form = app + '/workspaces/new'
const continuation = form + '?signIn=community'
const workspaceName = 'Atelier Studio'
const slug = 'atelier-test'

let dist: string

// The default preview uses mock auth. The Community menu and the app-owned handoff
// both require the real OIDC build, served under two distinct HTTPS origins.
test.describe.configure({ mode: 'default' })
test.use({ serviceWorkers: 'block' })
test.beforeAll(async () => {
  test.setTimeout(180_000)
  dist = await mkdtemp(join(tmpdir(), 'kodera-self-serve-'))
  await build({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    envDir: false,
    logLevel: 'error',
    define: {
      'import.meta.env.VITE_AUTH_MODE': JSON.stringify('oidc'),
      'import.meta.env.VITE_ENABLE_MSW': JSON.stringify('0'),
      'import.meta.env.VITE_MATRIX_DOMAIN': JSON.stringify('kodera.test'),
      'import.meta.env.VITE_APP_ORIGIN': JSON.stringify(app),
      'import.meta.env.VITE_KEYCLOAK_URL': JSON.stringify(identity),
      'import.meta.env.VITE_CORE_API_URL': JSON.stringify(app + '/api/v1'),
      'import.meta.env.VITE_OIDC_CLIENT_ID': JSON.stringify('console'),
    },
    build: { outDir: dist },
  })
})
test.afterAll(async () => {
  if (dist) await rm(dist, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const { origin, pathname } = new URL(route.request().url())
    if (origin === app || origin === community) {
      const file = join(dist, route.request().isNavigationRequest() ? 'index.html' : pathname)
      if (existsSync(file)) return route.fulfill({ path: file })
    }
    return route.fulfill({ status: 404 })
  })
  await mockCommunityIdentity(page)
  await mockWorkspaceApi(page)
})

async function mockCommunityIdentity(page: Page) {
  await page.route(issuer + '/.well-known/openid-configuration', (route) =>
    route.fulfill({
      json: {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
    })
  )
  await page.route(issuer + '/authorize?**', (route) => {
    const request = new URL(route.request().url())
    const callback = new URL(request.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', request.searchParams.get('state')!)
    callback.searchParams.set('code', 'fixture-code')
    // Start a new document request so Playwright also intercepts the app callback.
    // Chromium follows HTTP redirects from a fulfilled route outside its route handler.
    return route.fulfill({
      contentType: 'text/html',
      body: `<meta http-equiv="refresh" content="0;url=${callback.href.replaceAll('&', '&amp;')}">`,
    })
  })
  await page.route(issuer + '/token', (route) => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { sub: user.subject, iss: issuer, aud: 'console', iat: now, exp: now + 600 }
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return route.fulfill({
      json: {
        id_token: [encode({ alg: 'RS256' }), encode(claims), 'fixture'].join('.'),
        access_token: 'fixture-access',
        token_type: 'Bearer',
        expires_in: 600,
      },
    })
  })
}

async function mockWorkspaceApi(page: Page) {
  const { getMe, createSelfServeWorkspace, getWorkspace, listTenants } = EXAMPLES
  const member = getMe.body.organisations[0]!
  const communityMembership = {
    ...member,
    role: 'org_member',
    organisation: {
      ...member.organisation,
      slug: 'community',
      name: 'Kodera Community',
      realm: 'community',
    },
  }
  const created = createSelfServeWorkspace.body
  let hasWorkspace = false

  await page.route(app + '/api/v1/me', (route) => {
    const ownerMembership = {
      ...member,
      membership_id: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a',
      role: 'org_owner',
      shared_realm: true,
      plan_tier: 'freemium_pme',
      organisation: { id: created.organisation_id, slug, name: workspaceName, realm: 'community' },
    }
    const organisations = hasWorkspace
      ? [communityMembership, ownerMembership]
      : [communityMembership]
    return route.fulfill({ json: { ...getMe.body, identities: [user], organisations } })
  })
  await page.route(app + '/api/v1/organisations/*/workspace', (route) =>
    route.fulfill({ json: getWorkspace.body })
  )
  await page.route(app + '/api/v1/organisations/*/tenants*', (route) =>
    // This Core fixture covers the workspace shell without a messaging homeserver.
    route.fulfill({ json: { ...listTenants.body, data: [] } })
  )
  await page.route(app + '/api/v1/workspaces/self-serve', (route) => {
    const request = route.request()
    expect(request.method()).toBe('POST')
    expect(request.headers()['authorization']).toBe('Bearer fixture-access')
    const body = request.postDataJSON() as { slug: string }
    if (body.slug === 'admin') {
      return route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        json: {
          type: 'https://kodera.io/problems/validation-error',
          title: 'Validation error',
          status: 422,
          errors: [{ pointer: '/slug', code: 'slug_reserved' }],
        },
      })
    }
    expect(body).toEqual({ name: workspaceName, slug, locale: 'fr' })
    hasWorkspace = true
    return route.fulfill({
      status: 201,
      headers: createSelfServeWorkspace.headers,
      json: {
        ...created,
        organisation_slug: slug,
        redirect_path: '/' + slug + '/workspace',
      },
    })
  })
}

const switcher = (page: Page, name: string) =>
  page.getByRole('button', { name: name + ', changer d’organisation', exact: true }).first()

async function signIn(page: Page, origin: string) {
  await page.goto(origin + '/community/workspace')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await expect(switcher(page, 'Kodera Community')).toBeVisible()
}

async function expectCardlessForm(page: Page) {
  await expect(page.getByRole('heading', { name: 'Créez votre espace' })).toBeVisible()
  await expect(page.getByText(/sans carte bancaire jusqu’à 5 membres/)).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)
  // Before editing the address, the workspace name is the form's only input.
  await expect(page.locator('form input')).toHaveCount(1)
  await expect(page.locator('input[autocomplete^="cc-"], iframe[title*="payment" i]')).toHaveCount(
    0
  )
  await expect(page.getByRole('button', { name: 'Créer mon espace gratuit' })).toBeVisible()
}

async function fillWorkspace(page: Page, address: string) {
  await page.getByRole('textbox', { name: 'Nom de l’espace' }).fill(workspaceName)
  await page.getByRole('button', { name: 'Modifier' }).click()
  await page.getByRole('textbox', { name: 'Adresse' }).fill(address)
}

async function createWorkspace(page: Page) {
  await page.getByRole('button', { name: 'Créer mon espace gratuit' }).click()
  await expect(page).toHaveURL(app + '/' + slug + '/workspace')
  await expect(switcher(page, workspaceName)).toBeVisible()
  await expect(page.getByRole('link', { name: 'bienvenue', exact: true })).toBeVisible()
}

for (const path of ['/workspaces/new', '/workspaces/new?plan=sovereign']) {
  test(`creates a cardless workspace from ${path} with the default release flags`, async ({
    page,
  }) => {
    await signIn(page, app)
    await page.goto(app + path)
    await expectCardlessForm(page)
    await fillWorkspace(page, slug)
    await createWorkspace(page)
  })
}

test('a reserved address can be corrected on the creation form', async ({ page }) => {
  await signIn(page, app)
  await page.goto(form)
  await fillWorkspace(page, 'admin')
  const submit = page.getByRole('button', { name: 'Créer mon espace gratuit' })
  await submit.click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Cette adresse est réservée.' })
  ).toBeVisible()
  await expect(page).toHaveURL(form)
  await expect(submit).toBeDisabled()
  await page.getByRole('textbox', { name: 'Adresse' }).fill(slug)
  await createWorkspace(page)
})

test('Community hands sign-in to the app once and reuses the restored session', async ({
  page,
}) => {
  await signIn(page, community)
  await switcher(page, 'Kodera Community').click()
  const create = page.getByRole('menuitem', { name: 'Créer mon espace', exact: true })
  await expect(create).toHaveAttribute('href', continuation)
  const authorizations: URL[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(issuer + '/authorize?'))
      authorizations.push(new URL(request.url()))
  })
  await create.click()
  await expectCardlessForm(page)
  await expect(page).toHaveURL(form)
  expect(authorizations).toHaveLength(1)
  const params = authorizations[0]!.searchParams
  expect(params.get('redirect_uri')).toBe(app + '/auth/callback')
  expect(params.get('code_challenge_method')).toBe('S256')
  expect(params.get('prompt')).toBeNull()

  await page.goto(continuation)
  await expectCardlessForm(page)
  await expect(page).toHaveURL(form)
  expect(authorizations.map((url) => url.searchParams.get('prompt'))).toEqual([null, 'none'])
})
