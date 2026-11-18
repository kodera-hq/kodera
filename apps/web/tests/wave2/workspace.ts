import type { Page } from '@playwright/test'

/** Channel links belong to the connected workspace, so enter that surface before selecting one. */
export async function enterWorkspace(
  page: Page,
  organisation: string,
  readySelector: string,
  channelPath?: string
) {
  const entry = `/${organisation}/workspace`
  const current = new URL(page.url()).pathname
  if (current !== entry && !current.startsWith(`${entry}/`))
    await page.locator(`a[href="${entry}"]`).first().click()
  await page.locator(readySelector).waitFor({ state: 'visible', timeout: 15_000 })
  if (channelPath && new URL(page.url()).pathname !== channelPath) {
    await page.locator(`a[href="${channelPath}"]`).first().click()
    await page.locator(readySelector).waitFor({ state: 'visible', timeout: 15_000 })
  }
}
