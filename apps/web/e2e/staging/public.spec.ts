// What anyone on the VPN can check, with no account: the Console is served as it should be, its
// sign-in reaches the organisation's own Keycloak with PKCE, and the invitation page tells a good
// link from a bad one. Nothing here signs in, accepts or writes.
import { expect, test } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWalkOutputDir, OUTPUT_DIR_VARIABLE } from './output-dir'
import { discover, ORG, startSignIn } from './support'

test('a failure is written only to the temporary directory teardown removes', () => {
  expect(process.env['PLAYWRIGHT_NO_COPY_PROMPT']).toBe('1')
  const outputDir = process.env[OUTPUT_DIR_VARIABLE]
  expect(isWalkOutputDir(outputDir)).toBe(true)
  expect(test.info().project.outputDir).toBe(outputDir)
})

test('teardown accepts no directory the walk could not have made', () => {
  for (const path of [
    undefined,
    '',
    homedir(),
    tmpdir(),
    join(tmpdir(), 'kodera-e2e-walk-'),
    join(tmpdir(), 'other-abc123'),
    join(tmpdir(), 'kodera-e2e-walk-abc123', 'inner'),
    join(tmpdir(), 'kodera-e2e-walk-abc123', '..', 'x'),
    'kodera-e2e-walk-abc123',
  ])
    expect(isWalkOutputDir(path), String(path)).toBe(false)
  expect(isWalkOutputDir(join(tmpdir(), 'kodera-e2e-walk-abc123'))).toBe(true)
})

test('the Console is served with its security headers', async ({ request }) => {
  const answer = await request.get('/')
  expect(answer.status()).toBe(200)
  const headers = answer.headers()
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['cache-control']).toBe('no-store')
  const csp = headers['content-security-policy'] ?? ''
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("object-src 'none'")
})

test('a built asset is cached for a year and sent compressed; the document is not', async ({
  request,
}) => {
  // docs/specs/asset-caching-and-compression.md: the entry script the document names.
  const document = await request.get('/', { headers: { 'accept-encoding': 'br, gzip' } })
  expect(document.headers()['cache-control']).toBe('no-store')
  const entry = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(await document.text())
  expect(entry, 'the document names a module script under /assets').not.toBeNull()
  const asset = await request.get(entry![1]!, { headers: { 'accept-encoding': 'br, gzip' } })
  expect(asset.status()).toBe(200)
  const headers = asset.headers()
  expect(headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(headers['vary']).toBe('Accept-Encoding')
  expect(['br', 'gzip']).toContain(headers['content-encoding'])
})

test('Core refuses /me without a token', async ({ request }) => {
  expect((await request.get('/api/v1/me')).status()).toBe(401)
})

test("sign-in hands off to the organisation's Keycloak with PKCE S256", async ({
  page,
  request,
}) => {
  const { issuer } = await discover(request, ORG)
  const authorize = page.waitForRequest((sent) =>
    sent.url().startsWith(`${issuer}/protocol/openid-connect/auth?`)
  )
  await startSignIn(page, ORG)
  const query = new URL((await authorize).url()).searchParams
  expect(query.get('response_type')).toBe('code')
  expect(query.get('code_challenge_method')).toBe('S256')
  expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(new URL(query.get('redirect_uri') ?? '').origin).toBe(new URL(page.url()).origin)
  // Keycloak's own page, stopped at its first field: nothing is typed.
  await expect(page.locator('#username').or(page.locator('#password')).first()).toBeVisible()
  expect(page.url()).toContain(`${issuer}/`)
})

test("a protected page with no session goes to the organisation's sign-in", async ({
  page,
  request,
}) => {
  const { issuer } = await discover(request, ORG)
  // The slug in the address names the realm, so the Console goes straight to its Keycloak.
  const authorize = page.waitForRequest((sent) =>
    sent.url().startsWith(`${issuer}/protocol/openid-connect/auth?`)
  )
  await page.goto(`/${ORG}/home`)
  expect(new URL((await authorize).url()).searchParams.get('code_challenge_method')).toBe('S256')
  await expect(page.locator('#username').or(page.locator('#password')).first()).toBeVisible()
})

test.describe('the invitation page', () => {
  // The contract's bound is 32 to 256 printable characters; this one is well formed and unknown.
  // It is never sent: the page asks Core only on « Rejoindre », after a sign-in.
  const token = randomBytes(32).toString('base64url')

  test('a well-formed link names the organisation and offers its sign-in, and the token leaves the address bar', async ({
    page,
    request,
  }) => {
    const { organisation } = await discover(request, ORG)
    await page.goto(`/invitations/accept/${organisation.id}/${ORG}#${token}`)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: `Vous êtes invité à rejoindre ${organisation.name}. Connectez-vous avec le compte créé pour vous.`,
      })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
  })

  test("a link whose organisation id is not the slug's own is refused before any sign-in", async ({
    page,
  }) => {
    await page.goto(`/invitations/accept/${randomUUID()}/${ORG}#${token}`)
    await expect(
      page.getByText('Ce lien d’invitation n’est pas valide', { exact: false })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Se connecter' })).toHaveCount(0)
  })

  test('a malformed link shows the recovery page', async ({ page }) => {
    await page.goto(`/invitations/accept/not-an-id/${ORG}#${token}`)
    await expect(
      page.getByRole('heading', { name: 'La suite de votre demande est indisponible' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Se connecter' })).toHaveCount(0)
  })
})
