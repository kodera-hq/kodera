import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test('desktop shell uses the token width and preserves the page when toggled', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signIn(page, 'acme-sa')
  const sidebar = page.getByRole('navigation', { name: 'Navigation principale' })
  const header = page.getByRole('banner', { name: 'En-tête de la page' })
  await expect(header).toBeVisible()
  const width = await sidebar.evaluate((el) => ({
    actual: el.getBoundingClientRect().width,
    expected: Number.parseFloat(getComputedStyle(el).getPropertyValue('--shell-sidebar-width')),
    background: getComputedStyle(el).backgroundColor,
  }))
  expect(width.actual).toBe(width.expected)
  expect(width.actual).toBe(264)
  // Icons only (docs/specs/icon-only-controls.md): the rail item draws no text; its name shows
  // beside it as a tooltip once it has the focus, drawn for the eye and kept out of the tree.
  const settings = page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: 'Réglages', exact: true })
  await expect(settings).toHaveText('')
  await settings.focus()
  await expect(page.locator('[data-side="right"]').filter({ hasText: 'Réglages' })).toBeVisible()
  await expect(settings).not.toHaveAttribute('aria-describedby')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-side="right"]').filter({ hasText: 'Réglages' })).toHaveCount(0)
  expect(width.background).not.toBe('rgba(0, 0, 0, 0)')
  await sidebar.getByRole('link', { name: 'Applications', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/status$/)
  await expect(header).toContainText('Applications')
  const heading = page.getByRole('main').getByRole('heading', { level: 1 })
  await expect(heading).toBeVisible()
  const before = await heading.textContent()
  const toggle = header.getByRole('button', { name: 'Masquer la navigation' })
  await toggle.focus()
  await page.keyboard.press('Space')
  const restore = header.getByRole('button', { name: 'Afficher la navigation' })
  await expect(restore).toHaveAttribute('aria-expanded', 'false')
  await expect(restore).toBeFocused()
  await expect(sidebar).toBeHidden()
  await expect(heading).toHaveText(before ?? '')
  await expect(page).toHaveURL(/\/acme-sa\/status$/)
  await page.keyboard.press('Enter')
  await expect(sidebar).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await header.getByRole('link', { name: 'Aide', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/help$/)
  await expect(header).toContainText('Aide')
})
