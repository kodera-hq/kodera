import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

for (const width of [1440, 390]) {
  test(`collective studio keeps navigation, selection, draft and call at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000)
    const en = info.project.name.includes('dark')
    const lang = en ? 'en' : 'fr'
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/login?demo=1&org=community')
    if (en) await page.getByRole('button', { name: 'EN', exact: true }).click()
    await page.getByRole('button', { name: en ? 'Continue' : 'Continuer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'arrivals', exact: true })).toBeVisible()
    const navigation = async () => {
      if (width === 390)
        await page.getByRole('button', { name: en ? 'Channels' : 'Salons', exact: true }).click()
    }
    await navigation()
    for (const name of en
      ? ['Notifications', 'Messages', 'Drive & Docs', 'Calls', 'Calendar', 'Integrations']
      : ['Notifications', 'Messages', 'Drive & Docs', 'Appels', 'Agenda', 'Intégrations']) {
      await expect(
        page
          .getByRole('navigation', { name: en ? 'Channels' : 'Salons', exact: true })
          .getByRole('button', { name, exact: true })
      ).toBeVisible()
    }
    const notifications = page.getByRole('button', { name: 'Notifications', exact: true })
    await notifications.click()
    await expect(
      page.getByRole(width === 390 ? 'region' : 'dialog', { name: 'Notifications', exact: true })
    ).toContainText(en ? 'recent loaded activity' : 'activité récente chargée')
    const notificationPanel = page.getByRole(width === 390 ? 'region' : 'dialog', {
      name: 'Notifications',
      exact: true,
    })
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations
    ).toEqual([])
    await notificationPanel
      .getByRole('button', { name: en ? 'Close' : 'Fermer', exact: true })
      .focus()
    await page.keyboard.press('Escape')
    await expect(notifications).toBeFocused()
    await notifications.click()
    await notificationPanel.getByRole('button', { name: /^#support\b/ }).click()
    await expect(page.getByRole('heading', { name: 'support', exact: true })).toBeVisible()
    await navigation()
    await notifications.click()
    await notificationPanel.getByRole('button', { name: /^#announcements\b/ }).click()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    await navigation()
    await page.getByRole('button', { name: en ? 'Calls' : 'Appels', exact: true }).click()
    const callsSurface = page.getByRole('region', {
      name: en ? 'Calls' : 'Appels',
      exact: true,
    })
    await expect(callsSurface).toBeVisible()
    await callsSurface.getByRole('button', { name: /^(Rejoindre|Join) office-hours/ }).click()
    const dock = page.getByRole('region', {
      name: en ? 'Call in progress' : 'Appel en cours',
      exact: true,
    })
    await expect(dock).toBeVisible()
    const camera = dock.getByRole('button', { name: en ? 'Camera' : 'Caméra', exact: true })
    await camera.click()
    await expect(camera).toHaveAttribute('aria-pressed', 'true')
    await expect(dock.getByTestId('local-camera-preview')).toContainText(
      en ? 'simulated local preview' : 'aperçu local simulé'
    )
    await camera.click()
    await dock.evaluate((element) => element.setAttribute('data-continuity', 'retained'))
    const mute = dock.getByRole('button', { name: en ? 'Mute' : 'Couper le micro', exact: true })
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: info.outputPath(`workspace-${width}-${lang}.png`),
      fullPage: true,
      animations: 'disabled',
    })
    await navigation()
    await page.getByTestId('workspace-docs-editor-toggle').click()
    const drive = page.getByTestId('docs-drive-explorer')
    await expect(drive).toBeVisible()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeHidden()
    await expect(
      drive
        .getByRole('group', { name: en ? 'Filter by type' : 'Filtrer par type' })
        .getByRole('button')
    ).toHaveCount(6)
    await drive.getByTestId('drive-new-doc-btn').click()
    await page.getByTestId('docs-page-title-input').fill(en ? 'Review notes' : 'Notes de revue')
    await page.getByTestId('docs-surface-markdown').click()
    const source = page.getByRole('textbox', {
      name: en ? 'Markdown source' : 'Source Markdown',
      exact: true,
    })
    const content = '# Review notes\n\n## Decision\n\nPublish a single shared document.'
    await source.fill(content)
    await expect(page.getByTestId('docs-page-toc')).toContainText('Decision')
    await page
      .getByRole('button', {
        name: en ? 'Publish to channel' : 'Publier dans le salon',
        exact: true,
      })
      .click()
    await expect(
      page.getByText(en ? 'Document published to channel.' : 'Document publié dans le salon.', {
        exact: true,
      })
    ).toBeVisible()
    await expect(dock).toHaveAttribute('data-continuity', 'retained')
    await navigation()
    await page.getByTestId('espace-canvas-mode-chat').click()
    await page
      .getByRole('log')
      .getByRole('button', {
        name: new RegExp(en ? '^Review notes.*Open in Docs' : '^Notes de revue.*Ouvrir dans Docs'),
      })
      .click()
    await expect(page.getByTestId('docs-page-title-input')).toHaveValue(
      en ? 'Review notes' : 'Notes de revue'
    )
    await page.getByTestId('docs-surface-markdown').click()
    await expect(source).toHaveValue(content)
    await page.getByTestId('docs-breadcrumb-drive-root').click()
    await drive.getByTestId('drive-open-folder-virtual:channel-attachments').click()
    await expect(drive).toContainText(
      en
        ? 'Confidential attachments stay in their room.'
        : 'Les pièces jointes confidentielles restent dans leur salon.'
    )
    await expect(drive.getByTestId('drive-breadcrumbs')).toContainText(
      en ? 'Channel attachments' : 'Pièces jointes des salons'
    )
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations
    ).toEqual([])
    await expect(page.getByTestId('workspace-collaborative-docs').locator('[style]')).toHaveCount(0)
    await navigation()
    await page.getByRole('link', { name: 'announcements', exact: true }).click()
    await expect(page.getByRole('log')).toBeVisible()
    await expect(drive).toBeHidden()
    await dock.getByRole('button', { name: en ? 'Leave' : 'Quitter', exact: true }).click()
    await expect(dock).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    await navigation()
    await page.getByTestId('workspace-docs-editor-toggle').click()
    await drive
      .getByRole('button', {
        name: new RegExp(en ? '^Open document Review notes' : '^Ouvrir le document Notes de revue'),
      })
      .click()
    await page.getByTestId('docs-surface-markdown').click()
    await expect(source).toHaveValue(content)
    await page.screenshot({
      path: info.outputPath(`drive-docs-${width}-${lang}.png`),
      animations: 'disabled',
    })
  })
}
