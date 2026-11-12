import { expect, test } from '@playwright/test'

for (const entry of ['/', '/community/workspace']) {
  test(`a fresh ${entry} opens community without a demo flag`, async ({ page }) => {
    await page.goto(entry)
    await expect(page).toHaveURL(/\/community\/workspace$/)
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    await expect(page.getByText('Organisation introuvable', { exact: true })).toHaveCount(0)
  })
}

test('explicit demo opt-out survives a later community navigation', async ({ page }) => {
  await page.goto('/login?demo=0')
  await expect(page.getByRole('button', { name: 'Continuer', exact: true })).toBeVisible()
  await page.goto('/community/workspace')
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  expect(await page.evaluate(() => sessionStorage.getItem('msw:scenarios'))).toBeNull()
  expect(await page.evaluate(() => sessionStorage.getItem('msw:demo-disabled'))).toBe('1')
})

test('unknown organisation stays unresolved', async ({ page }) => {
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await page.goto('/unknown-org/home')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Organisation introuvable', exact: true })
  ).toBeVisible()
})

test('creates a workspace, sends a message and returns to community', async ({ page }) => {
  await page.goto('/community/workspace')
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: /Créer.*nouvel espace/ }).click()
  await page.getByRole('textbox', { name: 'Nom de l’espace', exact: true }).fill('QA Product Team')
  await expect(page.getByRole('textbox', { name: 'Adresse de l’espace', exact: true })).toHaveValue(
    'qa-product-team'
  )
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('dialog').getByRole('combobox').selectOption('open-source')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir l’espace', exact: true }).click()
  await expect(page).toHaveURL(/\/qa-product-team\/workspace/)
  await expect(page.getByRole('heading', { name: 'general', exact: true })).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Message dans #general', exact: true })
    .fill('First message in our new workspace')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('First message in our new workspace')
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page.getByRole('menuitemradio', { name: /Kodera Community/ }).click()
  await expect(page).toHaveURL(/\/community\/workspace/)
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page.getByRole('menuitemradio', { name: /QA Product Team/ }).click()
  await expect(page.getByRole('log')).toContainText('First message in our new workspace')
})

// The proximity template starts with one channel, as Core answers for it. A second one is not a
// special kind of channel and has no screen of its own: whoever is in the workspace adds it with
// the ordinary « Créer un salon » dialog and invites to it with the ordinary « Inviter » dialog.
test('the proximity template starts with one channel; a second is created and invited to with the ordinary dialogs', async ({
  page,
}) => {
  await page.goto('/community/workspace')
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: /Créer.*nouvel espace/ }).click()
  await page.getByRole('textbox', { name: 'Nom de l’espace', exact: true }).fill('Equipe Terrain')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('proximity')
  // The preview is the claim: one channel, under its French label.
  await expect(dialog.getByRole('listitem')).toHaveText(['#proximité'])
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir l’espace', exact: true }).click()
  await expect(page).toHaveURL(/\/equipe-terrain\/workspace/)
  await expect(page.getByRole('heading', { name: 'proximité', exact: true })).toBeVisible()
  const channels = page.getByRole('navigation', { name: 'Salons' })
  await expect(channels.getByRole('link')).toHaveCount(1)
  await expect(channels.getByRole('link')).toContainText(['proximité'])

  // A second proximity channel, through the existing creation dialog.
  await page
    .getByRole('button', { name: 'Créer un salon dans Equipe Terrain', exact: true })
    .click()
  await page.getByRole('textbox', { name: 'Nom du salon', exact: true }).fill('Proximité Nord')
  await page
    .getByRole('textbox', { name: 'Description ou sujet (facultatif)', exact: true })
    .fill('Présence, aile nord')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'proximite-nord', exact: true })).toBeVisible()
  await expect(channels.getByRole('link')).toHaveCount(2)
  await expect(channels.getByRole('link')).toContainText(['proximité', 'proximite-nord'])

  // People are invited to it through the existing invitation dialog.
  await page.getByRole('button', { name: 'Inviter', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Identifiant Matrix', exact: true })
    .fill('@lea:matrix.example')
  await page.getByRole('button', { name: 'Envoyer l’invitation Matrix', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Invitation Matrix envoyée')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Membres', exact: true }).click()
  await expect(
    page
      .getByRole('complementary', { name: 'Membres', exact: true })
      .getByText('Lea', { exact: true })
  ).toBeVisible()
})

test('creates text and voice channels with a topic', async ({ page }) => {
  await page.goto('/community/workspace')
  await page.getByRole('button', { name: 'Créer un salon dans Community', exact: true }).click()
  await page.getByRole('textbox', { name: 'Nom du salon', exact: true }).fill('Équipe Design')
  await page
    .getByRole('textbox', { name: 'Description ou sujet (facultatif)', exact: true })
    .fill('Daily design discussions')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'equipe-design', exact: true })).toBeVisible()
  await expect(page.getByText(/Daily design discussions/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Créer un salon dans Core Kodera', exact: true }).click()
  await page.getByRole('textbox', { name: 'Nom du salon', exact: true }).fill('QA Voice')
  await page.getByRole('combobox', { name: 'Type de salon', exact: true }).selectOption('audio')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await page.getByRole('button', { name: /Rejoindre qa-voice/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toContainText(
    'qa-voice'
  )
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()
})

test('mobile onboarding keeps the current conversation behind an accessible modal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: /Créer.*nouvel espace/ }).click()
  await expect(page.getByRole('dialog')).toBeInViewport()
  await expect(
    page.getByRole('textbox', { name: 'Message dans #announcements', exact: true })
  ).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeInViewport()
})
