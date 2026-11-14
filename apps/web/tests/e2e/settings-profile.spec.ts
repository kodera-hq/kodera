import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { useScenario } from './support/useScenario'

test.use({ permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' })

const sections = [
  'Mon profil & statut',
  'Apparence & thèmes',
  'Voix & audio',
  'Membres, rôles & invitations',
  'Connecteurs & extensions',
  'Hébergement & administration',
]

async function openSettings(page: Page) {
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  return page.getByRole('dialog', { name: 'Réglages', exact: true })
}

test('settings exposes every section to members while keeping administration role-gated', async ({
  page,
}) => {
  await useScenario(page, ['demo.groupe-vercelli', 'demo.community-member'])
  const settings = await openSettings(page)
  await expect(settings).toContainText('Rôle dans l’organisation: Membre')
  for (const name of sections) {
    await settings.getByRole('tab', { name, exact: true }).click()
    await expect(settings.getByRole('heading', { name, exact: true })).toBeVisible()
  }
  for (const name of ['Domaine', 'Fédération', 'Facturation']) {
    await expect(settings.getByRole('link', { name, exact: true })).toHaveCount(0)
  }
  await expect(settings.getByRole('link', { name: 'Sécurité & MFA', exact: true })).toBeVisible()
  await settings.getByRole('tab', { name: 'Membres, rôles & invitations', exact: true }).click()
  await expect(
    settings.getByRole('link', { name: 'Gérer les membres de l’espace', exact: true })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Réglages', exact: true })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
})

test('appearance themes remain accessible and nested studio closes before settings', async ({
  page,
}, info) => {
  test.setTimeout(60000)
  const settings = await openSettings(page)
  await settings.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
  for (const [name, mode] of [
    ['Clair · Givre', 'light'],
    ['Sombre · Ardoise', 'dark'],
    ['Noir OLED', 'black'],
  ]) {
    await settings.getByRole('button', { name: new RegExp(name!) }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode!)
    await expect(settings.getByRole('button', { name: new RegExp(name!) })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const accessibility = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(accessibility.violations, `Settings accessibility in ${mode}`).toEqual([])
    await page.screenshot({ path: info.outputPath(`settings-${mode}.png`), animations: 'disabled' })
  }
  await settings.getByRole('button', { name: 'Ouvrir Theme Studio', exact: true }).click()
  await expect(page.getByTestId('theme-share-code-input')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('theme-share-code-input')).toHaveCount(0)
  await expect(settings).toBeVisible()
  await expect(
    settings.getByRole('button', { name: 'Ouvrir Theme Studio', exact: true })
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
})

test('extensions signs and verifies locally and rejects a modified body', async ({ page }) => {
  const settings = await openSettings(page)
  await settings.getByRole('tab', { name: 'Connecteurs & extensions', exact: true }).click()
  await expect(settings.getByText('22 implémentations de référence', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Générer un secret de test', exact: true }).click()
  await settings.getByRole('button', { name: 'Signer l’exemple', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Exemple signé')
  await settings.getByRole('button', { name: 'Vérifier la signature', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Signature vérifiée')
  await settings.getByLabel('Corps JSON brut', { exact: true }).fill('{"modified":true}')
  await settings.getByRole('button', { name: 'Vérifier la signature', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('La signature ne correspond pas')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  await page.getByRole('tab', { name: 'Connecteurs & extensions', exact: true }).click()
  await expect(page.getByLabel('Secret de signature de test', { exact: true })).toHaveValue('')
})

test('mobile settings keeps every section in the viewport and returns focus to the module bar', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const settings = await openSettings(page)
  for (const name of sections) {
    await settings.getByRole('tab', { name, exact: true }).click()
    await expect(settings.getByRole('heading', { name, exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(
      true
    )
  }
  await settings.getByRole('tab', { name: 'Mon profil & statut', exact: true }).click()
  await page.screenshot({ path: info.outputPath('settings-mobile.png'), animations: 'disabled' })
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(accessibility.violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Réglages', exact: true })).toBeFocused()
})

test('profile updates are visible in messages, profile cards and after reload', async ({
  page,
}) => {
  const settings = await openSettings(page)
  await settings
    .getByRole('textbox', { name: 'Nom d’affichage', exact: true })
    .fill('Browser QA Designer')
  await settings
    .getByRole('textbox', { name: 'Message de statut', exact: true })
    .fill('Reviewing workspace')
  await settings.getByRole('radio', { name: 'Concentré', exact: true }).click()
  await settings.getByRole('button', { name: 'Copier l’ID Matrix', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^@[^:]+:community\.kodera\.io$/
  )
  await page.keyboard.press('Escape')
  await page
    .getByRole('textbox', { name: 'Message dans #announcements', exact: true })
    .fill('Profile integration check')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await page
    .getByRole('log')
    .getByRole('button', { name: 'Browser QA Designer', exact: true })
    .last()
    .click()
  const profile = page.getByRole('dialog', { name: 'Browser QA Designer', exact: true })
  await expect(profile).toContainText('Reviewing workspace')
  await expect(profile).toContainText('Concentré')
  await page.keyboard.press('Escape')
  await page
    .getByRole('log')
    .getByRole('button', { name: 'Elena Vance', exact: true })
    .last()
    .click()
  await page
    .getByRole('dialog', { name: 'Elena Vance', exact: true })
    .getByRole('button', { name: 'Mentionner', exact: true })
    .click()
  const composer = page.getByRole('textbox', { name: 'Message dans #announcements', exact: true })
  await expect(composer).toBeFocused()
  await expect(composer).not.toHaveValue('')
  await page.reload()
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Nom d’affichage', exact: true })).toHaveValue(
    'Browser QA Designer'
  )
  await expect(page.getByRole('radio', { name: 'Concentré', exact: true })).toBeChecked()
})
