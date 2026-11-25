import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function openDrive(page: Page) {
  await page.goto('/login?demo=1&org=community')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/community\/workspace$/)
  if ((page.viewportSize()?.width ?? 1280) < 960)
    await page.getByRole('button', { name: 'Salons', exact: true }).click()
  await page.getByTestId('workspace-docs-editor-toggle').click()
  await expect(page.getByTestId('docs-drive-explorer')).toBeVisible()
}

test('static documentation remains available as text artifacts', async ({ request }) => {
  const llms = await request.get('/llms.txt')
  expect(llms.status()).toBe(200)
  expect(llms.headers()['content-type']).toContain('text/plain')
  expect(await llms.text()).toContain('# Kodera')
  const api = await request.get('/developer-docs/en/api.md')
  expect(api.status()).toBe(200)
  expect(await api.text()).toContain('# API reference & webhooks')
})

test('community access links to the canonical external documentation portal', async ({ page }) => {
  await openDrive(page)
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Administration de l’espace…', exact: true }).click()
  await page.getByRole('tab', { name: 'Hébergement', exact: true }).click()
  await page.getByRole('button', { name: 'Communauté · community.kodera.io', exact: true }).click()
  const link = page.getByRole('link', { name: 'Ouvrir la documentation développeur', exact: true })
  await expect(link).toHaveAttribute('href', 'https://kodera.io/docs')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(page.getByTestId('developer-docs-hub')).toHaveCount(0)
})

for (const width of [1600, 390]) {
  test(`unified Drive stays accessible and within its canvas at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
    await openDrive(page)
    const surface = page.getByTestId('workspace-collaborative-docs')
    await expect(page.getByRole('heading', { name: 'Drive & Docs', exact: true })).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'arrivals', exact: true })).toBeHidden()
    await expect(surface.locator('[style]')).toHaveCount(0)
    const filters = surface.getByRole('group', { name: 'Filtrer par type' })
    await expect(filters.getByRole('button')).toHaveText([
      'Tout',
      'Dossiers',
      'Pages',
      'Bases',
      'Tableaux blancs',
      'Fichiers',
    ])
    const geometry = await surface.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
      viewportOverflow: document.documentElement.scrollWidth > innerWidth,
    }))
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
    expect(geometry.viewportOverflow).toBe(false)
    expect(
      (
        await new AxeBuilder({ page })
          .include('[data-testid="workspace-collaborative-docs"]')
          .analyze()
      ).violations
    ).toEqual([])
    await page.screenshot({
      path: info.outputPath(`drive-docs-${width}.png`),
      animations: 'disabled',
    })
  })
}
