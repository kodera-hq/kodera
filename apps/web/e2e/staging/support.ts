// What the staging walk reads from the environment, and the Console's own sign-in as a person
// goes through it. No value is ever written to the repository (e2e/staging/README.md).
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { freshCode } from '../../tests/smoke/support/totp'

export const ORG = process.env['KODERA_STAGING_ORG'] ?? 'acme-team'

export interface Account {
  username: string
  password: string
  /** Base32, what an authenticator app is given. */
  totpBase32: string
}

/** The account named by the environment, or undefined when none is. Half an account is an error. */
export function readAccount(): Account | undefined {
  const names = [
    'KODERA_STAGING_USERNAME',
    'KODERA_STAGING_PASSWORD',
    'KODERA_STAGING_TOTP_BASE32',
  ] as const
  const values = names.map((name) => process.env[name] ?? '')
  if (values.every((value) => value === '')) return undefined
  const missing = names.filter((_, at) => values[at] === '')
  if (missing.length > 0) throw new Error(`${missing.join(', ')} not set (e2e/staging/README.md)`)
  const [username, password, totpBase32] = values as [string, string, string]
  return { username, password, totpBase32 }
}

export interface Discovered {
  realm: string
  issuer: string
  organisation: { id: string; slug: string; realm: string; name: string }
}

/** Core's public realm discovery for a slug: what the login and invitation pages ask first. */
export async function discover(request: APIRequestContext, slug: string): Promise<Discovered> {
  const answer = await request.post('/api/v1/auth/discover', {
    data: { slug },
    headers: { 'Idempotency-Key': randomUUID() },
  })
  expect(answer.status(), `discoverRealm ${slug}`).toBe(200)
  return (await answer.json()) as Discovered
}

/** From `/login`, by the organisation's identifier, to the organisation's Keycloak. */
export async function startSignIn(page: Page, slug: string): Promise<void> {
  await page.goto('/login')
  await page.getByRole('button', { name: "Utiliser l'identifiant de votre organisation" }).click()
  await page.getByLabel('Identifiant de votre organisation').fill(slug)
  await page.getByRole('button', { name: 'Continuer' }).click()
}

export interface Me {
  organisations?: { role: string; state: string; organisation: { slug: string } }[]
}

/** Signs in and returns the first `/me` the Console reads afterwards. Keycloak asks for nothing
 * when the browser holds its session already (a saved storage state); otherwise `who` answers. */
export async function signIn(page: Page, who: Account | undefined): Promise<Me> {
  const me = page.waitForResponse(
    (response) => response.request().method() === 'GET' && /\/api\/v1\/me$/.test(response.url()),
    { timeout: 60_000 }
  )
  await startSignIn(page, ORG)
  const username = page.locator('#username')
  const password = page.locator('#password')
  const asked = await Promise.race([
    password
      .or(username)
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true),
    me.then(() => false),
  ])
  if (asked) {
    if (who === undefined)
      throw new Error('Keycloak asks for a password: the saved session has expired. Save it again.')
    if (await username.isVisible()) await username.fill(who.username)
    await password.fill(who.password)
    await page.locator('#kc-login').click()
    const otp = page.locator('#otp')
    await otp.waitFor({ timeout: 15_000 })
    await otp.fill(await freshCode(who.totpBase32))
    await page.locator('#kc-login').click()
  }
  const answered = await me
  expect(answered.status(), 'GET /me after sign-in').toBe(200)
  return (await answered.json()) as Me
}
