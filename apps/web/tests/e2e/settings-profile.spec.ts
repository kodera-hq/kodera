import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { useScenario } from './support/useScenario'

test.use({ permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' })

const sections = [
  'Mon profil & statut',
  'Sécurité & connexion',
  'Apparence & thèmes',
  'Voix & audio',
  'Notifications',
  'Confidentialité & RGPD',
  'Raccourcis',
]

async function openSettings(page: Page) {
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'arrivals', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  return page.getByRole('dialog', { name: 'Paramètres personnels', exact: true })
}

test('settings exposes every personal section to members while keeping administration role-gated', async ({
  page,
}) => {
  await useScenario(page, ['demo.groupe-vercelli', 'demo.community-member'])
  const settings = await openSettings(page)
  await expect(settings).toContainText('Rôle dans l’organisation: Membre')
  for (const name of sections) {
    await settings.getByRole('tab', { name, exact: true }).click()
    await expect(settings.getByRole('heading', { name, exact: true })).toBeVisible()
  }
  // An ordinary member with no delegated permission gets no administration entry point:
  // no switch in the dialog header and no administration tab.
  await expect(
    settings.getByRole('button', { name: 'Administration de l’espace', exact: true })
  ).toHaveCount(0)
  for (const name of [
    'Profil de l’espace',
    'Membres',
    'Rôles & Tags',
    'Invitations',
    'Intégrations & extensions',
    'Sécurité & modération',
    'Logs d’audit',
    'Hébergement',
  ]) {
    await expect(settings.getByRole('tab', { name, exact: true })).toHaveCount(0)
  }
  await settings.getByRole('tab', { name: 'Sécurité & connexion', exact: true }).click()
  await expect(
    settings.getByRole('link', { name: 'Ouvrir la sécurité du compte', exact: true })
  ).toHaveAttribute('href', '/community/security')
  for (const name of ['Statut', 'Domaine', 'Fédération', 'Facturation']) {
    await expect(settings.getByRole('link', { name, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Réglages', exact: true })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'arrivals', exact: true })).toBeVisible()
})

test('appearance themes remain accessible and nested studio closes before settings', async ({
  page,
}, info) => {
  test.setTimeout(60000)
  const settings = await openSettings(page)
  await settings.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
  for (const label of ['Automatique', 'Clair', 'Sombre', 'Noir']) {
    await expect(settings.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await settings.getByRole('button', { name: 'Automatique', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Automatique', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  for (const [name, mode] of [
    ['Clair', 'light'],
    ['Sombre', 'dark'],
    ['Noir', 'black'],
  ] as const) {
    await settings.getByRole('button', { name, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    await expect(settings.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const accessibility = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
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
  await settings.getByRole('button', { name: 'Administration de l’espace', exact: true }).click()
  const admin = page.getByRole('dialog', { name: 'Administration de l’espace', exact: true })
  await admin.getByRole('tab', { name: 'Intégrations & extensions', exact: true }).click()
  await expect(admin.getByText('22 implémentations de référence', { exact: true })).toBeVisible()
  await expect(
    admin.getByText('Choisissez un connecteur pour voir sa configuration.', { exact: true })
  ).toBeVisible()
  await admin
    .getByRole('button', { name: /— Connecter$/ })
    .first()
    .click()
  await admin.locator('summary').filter({ hasText: 'Détails techniques & sécurité' }).click()
  await admin.getByRole('button', { name: 'Générer un secret de test', exact: true }).click()
  await admin.getByRole('button', { name: 'Signer l’exemple', exact: true }).click()
  await expect(admin.getByRole('status')).toContainText('Exemple signé')
  await admin.getByRole('button', { name: 'Vérifier la signature', exact: true }).click()
  await expect(admin.getByRole('status')).toContainText('Signature vérifiée')
  await admin.getByLabel('Corps JSON brut', { exact: true }).fill('{"modified":true}')
  await admin.getByRole('button', { name: 'Vérifier la signature', exact: true }).click()
  await expect(admin.getByRole('alert')).toContainText('La signature ne correspond pas')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Paramètres personnels', exact: true })
  await reopened.getByRole('button', { name: 'Administration de l’espace', exact: true }).click()
  const adminAgain = page.getByRole('dialog', { name: 'Administration de l’espace', exact: true })
  await adminAgain.getByRole('tab', { name: 'Intégrations & extensions', exact: true }).click()
  await expect(
    adminAgain.getByText('Choisissez un connecteur pour voir sa configuration.', { exact: true })
  ).toBeVisible()
  await adminAgain
    .getByRole('button', { name: /— Connecter$/ })
    .first()
    .click()
  await adminAgain.locator('summary').filter({ hasText: 'Détails techniques & sécurité' }).click()
  await expect(adminAgain.getByLabel('Secret de signature de test', { exact: true })).toHaveValue(
    ''
  )
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
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
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
  await page.getByRole('link', { name: 'announcements', exact: true }).click()
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
