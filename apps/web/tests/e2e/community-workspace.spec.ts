import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function login(page: Page) {
  await page.goto('/login?demo=1&org=community')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/community\/workspace$/)
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await expect(page.getByText('community.kodera.io', { exact: true }).first()).toBeVisible()
}
async function menu(page: Page, action: string, rail = false) {
  const triggers = page.getByRole('button', { name: /changer d’organisation/ })
  await (rail ? triggers.first() : triggers.last()).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test('community sidebar, both menus, appearance and product dialogs are usable', async ({
  page,
}, info) => {
  await login(page)
  for (const category of ['Community', 'Core Kodera', 'Design Partners']) {
    await expect(page.getByRole('button', { name: category, exact: true })).toBeVisible()
  }
  await expect(page.getByText('Équipe cœur Kodera', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rechercher', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Configurer un espace', exact: true })).toHaveCount(
    0
  )
  for (const [name, theme] of [
    ['Clair · Givre', 'light'],
    ['Sombre · Ardoise', 'dark'],
    ['Noir OLED', 'black'],
  ] as const) {
    await menu(page, 'Réglages de l’espace…', true)
    await page.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.screenshot({
      path: info.outputPath(`workspace-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    })
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(accessibility.violations, `Workspace accessibility in ${theme}`).toEqual([])
  }
  await menu(page, 'Réglages de l’espace…')
  await page.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir Theme Studio', exact: true }).click()
  await expect(page.getByTestId('theme-share-code-input')).toBeVisible()
  await page.getByTestId('theme-share-to-channel-btn').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('log')).toContainText('kodera-theme:v1:')
  await menu(page, 'Réglages de l’espace…', true)
  await page.getByRole('tab', { name: 'Connecteurs & extensions', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Frame.io')
  await page.keyboard.press('Escape')
  await menu(page, 'Réglages de l’espace…')
  await page.getByRole('tab', { name: 'Hébergement & administration', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Mode actuel')
  await page.keyboard.press('Escape')
})

test('channels, messages, reactions, threads, invitations and notes work together', async ({
  page,
}, info) => {
  await login(page)
  await page.getByRole('button', { name: 'Créer un salon dans Community', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('qa-discussion')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'qa-discussion', exact: true })).toBeVisible()
  const composer = page.getByRole('combobox', { name: 'Message dans #qa-discussion', exact: true })
  await composer.fill('Shared browser acceptance message')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Shared browser acceptance message')
  await page.getByRole('button', { name: 'Ajouter une réaction', exact: true }).last().click()
  await page.getByRole('button', { name: /👍/ }).first().click()
  await expect(page.getByRole('log')).toContainText('👍')
  await page
    .getByRole('button', { name: /Actions du message/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: 'Ouvrir le fil', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Répondre au fil', exact: true })
    .fill('Thread acceptance reply')
  await page.getByRole('button', { name: 'Répondre', exact: true }).click()
  await expect(page.getByText('Thread acceptance reply', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Inviter', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Identifiant Matrix', exact: true })
    .fill('@qa:matrix.example')
  await page.getByRole('button', { name: 'Envoyer l’invitation Matrix', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Invitation Matrix envoyée')
  for (const [name, prefix] of [
    ['Lien universel Matrix (matrix.to)', 'https://matrix.to/'],
    ['URI native Matrix', 'matrix:'],
  ] as const) {
    await page.getByRole('button', { name: `Copier : ${name}`, exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
  }
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Membres', exact: true }).click()
  await expect(
    page
      .getByRole('complementary', { name: 'Membres', exact: true })
      .getByText('Qa', { exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await page.getByRole('button', { name: 'Nouveau document', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Documents du salon' }).click()
  await page.getByLabel('Titre du document', { exact: true }).fill('QA decision')
  await page
    .getByLabel('Source Markdown', { exact: true })
    .fill('## Decision\nBrowser verified publication')
  await page.getByRole('button', { name: 'Publier dans le salon', exact: true }).click()
  await expect(page.getByText('Document publié dans le salon.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Browser verified publication')
  await page.screenshot({ path: info.outputPath('channel-published.png'), fullPage: true })
})

test('created workspaces switch without losing the previous conversation', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Créer un salon dans Community', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('retained-channel')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Message dans #retained-channel', exact: true })
    .fill('Retain across workspace switch')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await page.getByRole('button', { name: 'Nouveau document', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Documents du salon' }).click()
  await page.getByLabel('Titre du document', { exact: true }).fill('Retained note')
  await menu(page, '+ Créer ou configurer un nouvel espace')
  await page.getByLabel('Nom de l’espace', { exact: true }).fill('QA Studio')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir l’espace', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForURL(/\/qa-studio\/workspace/)
  await expect(page.getByRole('button', { name: /QA Studio, changer/ }).first()).toBeVisible()
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page
    .getByRole('menuitemradio', { name: 'Kodera Community community.kodera.io', exact: true })
    .click()
  await page.waitForURL(/\/community\/workspace/)
  await page.getByRole('link', { name: 'retained-channel', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Retain across workspace switch')
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await expect(page.getByLabel('Titre du document', { exact: true })).toHaveValue('Retained note')
})

test('console pages remain community-scoped and return to Messages', async ({ page }) => {
  await login(page)
  for (const route of ['home', 'people', 'status', 'security', 'appearance', 'support']) {
    await page.goto(`/community/${route}${route === 'support' ? '?topic=capacity' : ''}`)
    if (route === 'support')
      await expect(page).toHaveURL(/\/community\/help\?topic=capacity$/, { timeout: 20_000 })
    await expect(page.getByRole('navigation', { name: 'Modules', exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Kodera Community', { exact: true }).first()).toBeVisible()
    await expect(page.locator('body')).not.toContainText(
      /Groupe Vercelli|Inès Kaci|138 membres|groupe-vercelli\.fr/
    )
    await page.getByRole('link', { name: 'Messages', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  }
})

test('a healthy session stays unobstructed after one minute and keyboard focus', async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  await login(page)
  await page.waitForTimeout(61_000)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText(/Votre session va expirer/)).toHaveCount(0)
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeInViewport()
  await expect
    .poll(
      async () =>
        (await page.getByRole('heading', { name: 'announcements', exact: true }).boundingBox())
          ?.width ?? 0
    )
    .toBeGreaterThan(150)
  await page.screenshot({ path: info.outputPath('workspace-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Salons', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'Salons', exact: true })
    .getByRole('link', { name: 'support', exact: true })
    .click()
  await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'support', exact: true })).toBeInViewport()
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await expect(
    page.getByRole('menuitemradio', { name: 'Kodera Community community.kodera.io', exact: true })
  ).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Salons', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Salons', exact: true })
    .getByRole('button', { name: /Rejoindre office-hours/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toHaveCount(0)
  await page.getByRole('region', { name: 'Appel en cours', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('workspace-mobile-voice.png'), fullPage: true })
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('voice rooms expose usable local audio controls', async ({ page }, info) => {
  await login(page)
  await page.getByRole('button', { name: /Rejoindre office-hours/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Couper le micro', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Couper le micro', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.getByRole('button', { name: 'Couper le son', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Couper le son', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.screenshot({ path: info.outputPath('voice-controls.png'), fullPage: true })
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Créer un salon dans Core Kodera', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('qa-voice')
  await page.getByLabel('Type de salon', { exact: true }).selectOption('audio')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('button', { name: /Rejoindre qa-voice/ })).toBeVisible()
  await page.getByRole('button', { name: /Rejoindre qa-voice/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toContainText(
    'qa-voice'
  )
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()
})
