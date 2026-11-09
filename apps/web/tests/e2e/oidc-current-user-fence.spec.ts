/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

declare global {
  interface Window {
    __currentUserFenceReads?: number
  }
}

async function completeSilentRenewal(page: Page): Promise<void> {
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().includes('prompt=none')).length)
    .toBe(1)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
}

test('shell/session: only the latest credential can reopen protected content', async ({ page }) => {
  await page.addInitScript(() => {
    window.__currentUserFenceReads = 0
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/v1/me')) window.__currentUserFenceReads! += 1
      return original(input, init)
    }
  })
  await useScenario(page, ['oidc.current-user-fence'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  expect(await page.evaluate(() => window.__currentUserFenceReads)).toBe(1)

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await completeSilentRenewal(page)
  await expect.poll(() => page.evaluate(() => window.__currentUserFenceReads)).toBe(2)
  await expect(page.getByRole('navigation')).toHaveCount(0)

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await completeSilentRenewal(page)
  await expect.poll(() => page.evaluate(() => window.__currentUserFenceReads)).toBe(3)
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await expect(page).not.toHaveURL(/\/security\/mfa$/)
})
