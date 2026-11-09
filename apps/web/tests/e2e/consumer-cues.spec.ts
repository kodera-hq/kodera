/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

async function roleColor(page: Page, role: string): Promise<string> {
  return page.evaluate((name) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim()
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Unresolved theme role ${name}`)
    return `rgb(${[1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)).join(', ')})`
  }, role)
}

async function keyboardCue(page: Page, control: Locator) {
  await control.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(control).toBeFocused()
  await expect(control).toHaveCSS('text-decoration-line', 'underline')
  await expect(control).not.toHaveCSS('box-shadow', 'none')
}

for (const [theme, label] of [
  ['light', 'Clair'],
  ['dark', 'Sombre'],
  ['black', 'Noir'],
] as const) {
  test(`consumer cues: ordinary real-route actions retain ink and keyboard cues in ${theme}`, async ({
    page,
  }, testInfo) => {
    await useScenario(page, [
      'shell.single-organisation',
      'home.default',
      'invoices.owner-role',
      'invoices.paid-history',
    ])
    await page.setViewportSize({ width: 1440, height: 1000 })
    await signIn(page, 'acme-sa', '/appearance')
    await page.getByRole('radio', { name: label, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.getByRole('link', { name: 'Accueil', exact: true }).click()
    await expect(page).toHaveURL(/\/acme-sa\/home$/)

    const link = page.getByRole('link', { name: 'Voir les applications', exact: true })
    await expect(link).toBeVisible()
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(link).toHaveCSS('color', await roleColor(page, 'ink'))
      await link.hover()
      await expect(link).toHaveCSS('text-decoration-line', 'underline')
      await keyboardCue(page, link)
      if (width < 400) {
        const box = await link.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(44)
        expect(box?.width).toBeGreaterThanOrEqual(44)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      )
    }
    const fontLoaded = await page.evaluate(async () => {
      await document.fonts.ready
      const faces = await document.fonts.load('400 16px "Plus Jakarta Sans"')
      return faces.length > 0 && faces.every((face) => face.status === 'loaded')
    })
    expect(fontLoaded).toBe(true)
    await testInfo.attach(`consumer-home-320-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
    await link.press('Enter')
    await expect(page).toHaveURL(/\/acme-sa\/status$/)

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('link', { name: 'Facturation', exact: true }).click()
    const invoice = page.locator('a[href*="/invoices/"]').filter({ hasText: /INV-/ }).first()
    await expect(invoice).toBeVisible()
    await expect(invoice).toHaveCSS('color', await roleColor(page, 'ink'))
    await keyboardCue(page, invoice)
    const href = await invoice.getAttribute('href')
    if (href === null) throw new Error('Invoice link lost its actual destination')
    const target = new URL(href, page.url()).pathname
    await invoice.press('Enter')
    await expect(page).toHaveURL((url) => url.pathname === target)

    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Aide', exact: true })
      .click()
    const invoicesHelp = page.getByRole('link', { name: 'Voir vos factures', exact: true })
    await expect(invoicesHelp).toHaveCSS('color', await roleColor(page, 'ink'))
    await keyboardCue(page, invoicesHelp)
    await invoicesHelp.press('Enter')
    await expect(page).toHaveURL(/\/acme-sa\/invoices$/)
  })
}

test('consumer cues: login back action keeps the entered address and its keyboard cue', async ({
  page,
}) => {
  await useScenario(page, ['login.unknown-domain'])
  await page.goto('/login')
  await page.getByLabel('Adresse e-mail').fill('marie.dupont@unknown-example.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page.getByLabel('Identifiant de votre organisation')).toBeVisible()
  const back = page.getByRole('button', { name: 'Utiliser une adresse e-mail' })
  await expect(back).toHaveCSS('color', await roleColor(page, 'ink'))
  await keyboardCue(page, back)
  await back.press('Enter')
  await expect(page.getByLabel('Adresse e-mail')).toHaveValue('marie.dupont@unknown-example.fr')
})
