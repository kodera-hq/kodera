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

/** Load the channel sigil face before full-page Matrix SSO can replace this document. */
export async function prepareWorkspaceFontsInDocument() {
  await document.fonts.ready
  await document.fonts.load('500 16px "IBM Plex Mono"', 'É’—012345')
  await document.fonts.ready
}
