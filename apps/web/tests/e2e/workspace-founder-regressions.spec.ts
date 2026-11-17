import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Runs only through the standard hosted production-build/MSW browser matrix.
// This mock workspace proves reachable UI; it does not certify live provider writes or FPS.
test.use({ reducedMotion: 'reduce' })

test('founder surfaces: profile, audio controls, connector target and settings Escape', async ({
  page,
}, info) => {
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  const trigger = page.getByRole('button', { name: 'Réglages', exact: true })
  await trigger.click()
  const settings = page.getByRole('dialog', { name: 'Réglages', exact: true })
  await expect(
    settings.getByRole('textbox', { name: 'Nom d’affichage', exact: true })
  ).toBeVisible()
  await expect(
    settings.getByRole('button', { name: 'Copier l’ID Matrix', exact: true })
  ).toBeVisible()
  await settings.getByRole('tab', { name: 'Voix & audio', exact: true }).click()
  await expect(
    settings.getByRole('slider', { name: 'Volume principal', exact: true })
  ).toBeVisible()
  await expect(settings.getByRole('heading', { level: 1 })).toHaveCount(0)
  await expect(
    settings.getByRole('heading', { level: 3, name: 'Ambiance sonore', exact: true })
  ).toBeVisible()
  await expect(
    settings.getByRole('radiogroup', { name: 'Signature sonore', exact: true })
  ).toBeVisible()
  await expect(settings.getByRole('radiogroup', { name: 'Mode sonore', exact: true })).toBeVisible()
  await expect(
    settings.getByRole('switch', { name: 'Mentions et messages', exact: true })
  ).toBeVisible()
  await expect(
    settings.getByRole('radiogroup', { name: 'Signal de mention et message direct', exact: true })
  ).toBeVisible()
  const messages = settings.getByRole('switch', { name: 'Mentions et messages', exact: true })
  const before = await messages.getAttribute('aria-checked')
  await messages.click()
  await expect(messages).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
  await expect(settings.getByRole('button', { name: 'Tester le son', exact: true })).toBeVisible()
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations
  ).toEqual([])
  await page.screenshot({
    path: info.outputPath('workspace-audio-controls.png'),
    animations: 'disabled',
  })

  await settings.getByRole('tab', { name: 'Connecteurs & extensions', exact: true }).click()
  await settings
    .getByRole('button', { name: /— Connecter$/ })
    .first()
    .click()
  const target = settings.getByRole('combobox', { name: 'Salon de destination', exact: true })
  await expect(target).toBeEnabled()
  expect(await target.locator('option').count()).toBeGreaterThan(1)
  await target.selectOption({ index: 1 })
  await expect(target).not.toHaveValue('')
  await expect(
    settings.getByText(
      'Ce choix prépare la configuration. Aucune connexion n’est encore activée.',
      { exact: true }
    )
  ).toBeVisible()
  const disclosure = settings.getByText('Détails techniques & sécurité', { exact: true })
  await expect(disclosure.locator('..')).not.toHaveAttribute('open', '')
  await expect(settings.getByText('Schéma v1 vérifié', { exact: true })).not.toBeVisible()
  await expect(
    settings.getByRole('textbox', { name: /URL de destination du webhook/ })
  ).not.toBeVisible()
  await disclosure.click()
  await expect(settings.getByText('Schéma v1 vérifié', { exact: true })).toBeVisible()
  await expect(
    settings.getByRole('textbox', { name: /URL de destination du webhook/ })
  ).toBeVisible()
  await page.screenshot({
    path: info.outputPath('workspace-connector-target.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('founder canvases: Docs and Files mount, channel selection restores chat, raster draft previews safely', async ({
  page,
}, info) => {
  await page.goto('/community/workspace')
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await expect(page.getByTestId('espace-inline-docs-canvas')).toBeVisible()
  await expect(
    page.getByText('Cette page n’est pas encore disponible', { exact: false })
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Fichiers', exact: true }).click()
  const files = page.getByRole('region', { name: 'Fichiers de l’espace', exact: true })
  await expect(files).toBeVisible()
  await expect(
    files.getByRole('textbox', { name: 'Rechercher un fichier', exact: true })
  ).toBeVisible()
  await expect(files.getByRole('button', { name: 'Images', exact: true })).toBeVisible()
  const firstCard = files.locator('ul > li').first()
  await expect(firstCard).toBeVisible()
  const cardBounds = await firstCard.boundingBox()
  expect(cardBounds).not.toBeNull()
  // A single file/document packs at its content height instead of filling the canvas.
  expect(cardBounds!.height).toBeLessThanOrEqual(160)

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations
  ).toEqual([])
  await page.screenshot({ path: info.outputPath('workspace-files.png'), animations: 'disabled' })
  await page.getByRole('link', { name: 'announcements', exact: true }).click()
  await expect(page.getByRole('log')).toBeVisible()
  await expect(files).toHaveCount(0)
  const heading = page.getByRole('heading', { name: 'announcements', exact: true })
  await heading.focus()
  await expect(heading).toHaveCSS('outline-style', 'none')

  // Simulation intentionally previews a local draft and never publishes storage bytes.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('input[type="file"]').setInputFiles({
    name: 'founder-preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  })
  await expect(page.getByText(/^founder-preview\.png \(\d+ KB\)$/)).toHaveCount(1)
  await expect
    .poll(() =>
      page.locator('form canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).width)
    )
    .toBe(256)
  await page.getByRole('button', { name: 'Retirer founder-preview.png', exact: true }).click()
  await expect(page.getByText(/^founder-preview\.png \(\d+ KB\)$/)).toHaveCount(0)
})
