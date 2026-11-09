// Keycloak's own pages, as a person goes through them: sign-in, the one-time code, and the
// required actions a new account meets (a password to set, an authenticator to configure). The
// Kodera login theme restyles these pages and keeps Keycloak's field ids.
import { expect, type Page } from '@playwright/test'
import { freshCode } from './totp'
import type { SmokeAccount } from './input'

/** Signs `who` in on the Keycloak page `page` shows, through to the page Keycloak hands back to. */
export async function throughKeycloak(page: Page, who: SmokeAccount): Promise<void> {
  const username = page.locator('#username')
  const password = page.locator('#password')
  await expect(password.or(username).first()).toBeVisible({ timeout: 30_000 })
  if (await username.isVisible()) await username.fill(who.username)
  if (await password.isVisible()) {
    await password.fill(who.password)
    await page.locator('#kc-login').click()
  }
  const otp = page.locator('#otp')
  const setUp = page.locator('#totp')
  const next = await Promise.race([
    otp.waitFor({ timeout: 15_000 }).then(() => 'otp' as const),
    setUp.waitFor({ timeout: 15_000 }).then(() => 'configure' as const),
    page
      .waitForURL((url) => !url.pathname.includes('/realms/'), { timeout: 15_000 })
      .then(() => 'done' as const),
  ])
  if (next === 'otp') {
    await otp.fill(await freshCode(who.totpBase32))
    await page.locator('#kc-login').click()
  }
  if (next === 'configure') throw new Error(`${who.username} has no authenticator configured yet`)
}

/** Keycloak's required actions for a new account: the password, then the authenticator, whose
 * key is read from the page's manual mode and returned, Base32, for later sign-ins. */
export async function completeRequiredActions(page: Page, newPassword: string): Promise<string> {
  const passwordNew = page.locator('#password-new')
  if (await passwordNew.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await passwordNew.fill(newPassword)
    await page.locator('#password-confirm').fill(newPassword)
    await page.locator('input[type="submit"], button[type="submit"]').first().click()
  }
  await page.locator('#mode-manual').click()
  const secret = ((await page.locator('#kc-totp-secret-key').textContent()) ?? '').replace(
    /\s/g,
    ''
  )
  await page.locator('#totp').fill(await freshCode(secret))
  await page.locator('#saveTOTPBtn').click()
  return secret
}
