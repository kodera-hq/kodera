import type { Page } from '@playwright/test'

/** Switch through the application's controls and restore the workspace before measuring it. */
export async function selectInterfaceLanguage(
  page: Page,
  controls: { button: string; option: string; section?: string; close?: string }
) {
  await page.locator(controls.button).click()
  if (controls.section) await page.locator(controls.section).click()
  await page.locator(controls.option).click()
  if (controls.close) await page.locator(controls.close).click()
}
