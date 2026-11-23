import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test.use({ reducedMotion: 'reduce' })

test('Files and Integrations stay in the canvas while global shortcuts own one accessible modal', async ({
  page,
}) => {
  await page.goto('/community/workspace')
  await page.getByRole('button', { name: 'Fichiers', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fichiers', exact: true })).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Rechercher un fichier', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'arrivals', exact: true })).toBeHidden()
  await expect(
    page.getByRole('group', { name: 'Filtrer par type' }).getByRole('button')
  ).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Commandes et navigation rapide' })
  await expect(palette).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const field = palette.getByRole('combobox')
  await expect(field).toBeFocused()
  await field.fill('support')
  await page.keyboard.press('Escape')
  await expect(field).toHaveValue('')
  await expect(palette).toBeVisible()
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    []
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Intégrations', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: "Catalogue d'extensions Kodera v1" })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/community\/workspace$/)
  await page
    .getByRole('button', { name: /— Connecter$/ })
    .first()
    .click()
  await expect(page.getByRole('textbox', { name: /URL de destination du webhook/ })).toBeHidden()
  await page.locator('summary').filter({ hasText: 'Détails techniques & sécurité' }).click()
  await expect(page.getByRole('textbox', { name: /URL de destination du webhook/ })).toBeVisible()
})

test('the console opens the global palette and shortcut reference', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('heading', { name: 'Bonjour Julie', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Commandes et navigation rapide' })).toBeVisible()
  await expect(page.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a phone keeps searchable channels when its drawer is closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/community/workspace')
  await expect(page.getByRole('button', { name: 'Salons', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const field = page.getByRole('combobox')
  await expect(field).toBeFocused()
  await field.fill('developers-community')
  await expect(page.getByRole('option', { name: /developers-community/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Salons', exact: true }).click()
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click()
  await expect(page.getByRole('combobox')).toBeFocused()
  await page.getByRole('combobox').fill('support')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/community\/workspace\/[^/]+$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
