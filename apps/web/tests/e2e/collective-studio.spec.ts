import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

for (const width of [1440, 390]) {
  test(`collective studio keeps navigation, selection, draft and call at ${width}px`, async ({
    page,
  }, info) => {
    const en = info.project.name.includes('dark')
    const lang = en ? 'en' : 'fr'
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/login?demo=1&org=community')
    if (en) await page.getByRole('button', { name: 'EN', exact: true }).click()
    await page.getByRole('button', { name: en ? 'Continue' : 'Continuer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    const navigation = async () => {
      if (width === 390)
        await page.getByRole('button', { name: en ? 'Channels' : 'Salons', exact: true }).click()
    }
    await navigation()
    for (const name of en
      ? ['Notifications', 'Messages', 'Docs', 'Calls', 'Files', 'Integrations']
      : ['Notifications', 'Messages', 'Docs', 'Appels', 'Fichiers', 'Intégrations']) {
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
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
    await notificationPanel
      .getByRole('button', { name: en ? 'Close' : 'Fermer', exact: true })
      .focus()
    await page.keyboard.press('Escape')
    await expect(notifications).toBeFocused()
    await notifications.click()
    await notificationPanel.getByRole('button', { name: /#support/ }).click()
    await expect(page.getByRole('heading', { name: 'support', exact: true })).toBeVisible()
    await navigation()
    await notifications.click()
    await notificationPanel.getByRole('button', { name: /#announcements/ }).click()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    await navigation()
    await page.getByRole('button', { name: en ? 'Calls' : 'Appels', exact: true }).click()
    await page
      .getByRole(width === 390 ? 'region' : 'dialog', {
        name: en ? 'Calls' : 'Appels',
        exact: true,
      })
      .getByRole('button', { name: 'office-hours', exact: true })
      .click()
    await expect(page.getByRole('button', { name: /^(Rejoindre|Join) office-hours/ })).toBeFocused()
    await page.getByRole('button', { name: /^(Rejoindre|Join) office-hours/ }).click()
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
    await page
      .locator('summary')
      .filter({ hasText: en ? 'Channel documents' : 'Documents du salon' })
      .click()
    await page
      .getByRole('button', { name: en ? 'New document' : 'Nouveau document', exact: true })
      .click()
    await page
      .getByLabel(en ? 'Document title' : 'Titre du document', { exact: true })
      .fill(en ? 'Review notes' : 'Notes de revue')
    await page
      .locator('summary')
      .filter({ hasText: en ? 'Channel documents' : 'Documents du salon' })
      .click()
    const source = page.getByRole('textbox', {
      name: en ? 'Markdown source' : 'Source Markdown',
      exact: true,
    })
    const content = en
      ? '## Before sharing\n- [x] Review the guide\n- [ ] Check access\n\n==One version for the whole team.=='
      : '## Avant de partager\n- [x] Relire le guide\n- [ ] Vérifier les accès\n\n==Une version pour toute l’équipe.=='
    await source.fill(content)
    await expect(source).toHaveValue(content)
    await source.evaluate((element) => {
      const field = element as HTMLTextAreaElement
      field.focus()
      field.setSelectionRange(3, field.value.indexOf('\n'))
    })
    await expect
      .poll(() => source.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
      .toBe(3)
    await page.getByRole('button', { name: en ? 'Bold' : 'Gras', exact: true }).click()
    await expect(source).toHaveValue(content.replace(/^## (.+)/, '## **$1**'))
    await expect(source).toBeFocused()
    await page.getByRole('button', { name: en ? 'Undo' : 'Annuler', exact: true }).click()
    await expect(source).toHaveValue(content)
    await page
      .getByRole('checkbox', { name: en ? 'Check access' : 'Vérifier les accès', exact: true })
      .check()
    await expect(source).toHaveValue(content.replace('- [ ]', '- [x]'))
    await page
      .getByRole('button', { name: en ? 'Insert link' : 'Insérer un lien', exact: true })
      .click()
    await page
      .getByLabel(en ? 'Link address' : 'Adresse du lien', { exact: true })
      .fill('https://example.com/review')
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('button', { name: en ? 'Insert link' : 'Insérer un lien', exact: true })
    ).toBeFocused()
    await page.getByRole('button', { name: 'Mention', exact: true }).click()
    await page.getByRole('button', { name: 'Claire Mercer', exact: true }).click()
    expect(await source.inputValue()).toContain('@Claire Mercer')
    await page.getByRole('button', { name: en ? 'Undo' : 'Annuler', exact: true }).click()
    await expect(source).toBeFocused()
    await source.evaluate((element) => {
      const field = element as HTMLTextAreaElement
      field.focus()
      field.setSelectionRange(3, field.value.indexOf('\n'))
    })
    await source.press('ArrowLeft')
    for (const _character of en ? 'Before sharing' : 'Avant de partager')
      await source.press('Shift+ArrowRight')
    const comments = page.getByRole('complementary', {
      name: en ? 'Comments' : 'Commentaires',
      exact: true,
    })
    await expect(comments.locator('form blockquote')).toHaveText(
      en ? 'Before sharing' : 'Avant de partager'
    )
    await comments
      .getByRole('textbox', { name: en ? 'Your comment' : 'Votre commentaire' })
      .fill('Please confirm access before sharing.')
    await comments
      .getByRole('button', { name: en ? 'Add comment' : 'Ajouter un commentaire' })
      .click()
    await expect(comments).toContainText('Please confirm access before sharing.')
    await expect(comments.locator('li blockquote')).toHaveText(
      en ? 'Before sharing' : 'Avant de partager'
    )
    await comments.getByRole('button', { name: en ? 'Resolve' : 'Résoudre', exact: true }).click()
    await expect(
      comments.getByRole('button', { name: en ? 'Reopen' : 'Rouvrir', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByRole('complementary', { name: en ? 'Comments' : 'Commentaires', exact: true })
    ).toBeVisible()
    await expect(dock).toHaveAttribute('data-continuity', 'retained')
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('studio-document').evaluate((element) => {
      let parent = element.parentElement
      while (parent) {
        parent.scrollTop = 0
        parent = parent.parentElement
      }
      window.scrollTo(0, 0)
    })
    await page.screenshot({
      path: info.outputPath(`document-${width}-${lang}.png`),
      fullPage: true,
      animations: 'disabled',
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))
    ).toEqual([])
    await source.evaluate((element) => {
      const field = element as HTMLTextAreaElement
      field.focus()
      field.setSelectionRange(3, field.value.indexOf('\n'))
    })
    await page
      .getByRole('button', { name: en ? 'Insert link' : 'Insérer un lien', exact: true })
      .click()
    await page
      .getByLabel(en ? 'Link address' : 'Adresse du lien', { exact: true })
      .fill('https://example.com/review')
    await page.getByRole('button', { name: en ? 'Insert' : 'Insérer', exact: true }).click()
    await expect(
      page.getByRole('link', { name: en ? 'Before sharing' : 'Avant de partager', exact: true })
    ).toHaveAttribute('href', 'https://example.com/review')
    const linkedContent = await source.inputValue()
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
    await navigation()
    await page.getByTestId('espace-canvas-mode-chat').click()
    await page
      .getByRole('log')
      .getByRole('button', {
        name: new RegExp(en ? '^Review notes.*Open in Docs' : '^Notes de revue.*Ouvrir dans Docs'),
      })
      .click()
    await expect(source).toHaveValue(linkedContent)
    await navigation()
    await page.getByRole('button', { name: en ? 'Files' : 'Fichiers', exact: true }).click()
    const files = page.getByRole(width === 390 ? 'region' : 'dialog', {
      name: en ? 'Files' : 'Fichiers',
      exact: true,
    })
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
    await files
      .getByRole('button', {
        name: new RegExp(en ? '^Community guide review' : '^Revue du guide communautaire'),
      })
      .click()
    await expect(
      page.getByRole('heading', {
        name: en ? 'Community guide review' : 'Revue du guide communautaire',
        exact: true,
      })
    ).toBeVisible()
    await navigation()
    await page.getByRole('button', { name: en ? 'Files' : 'Fichiers', exact: true }).click()
    await files
      .getByRole('button', { name: new RegExp(en ? '^Review notes' : '^Notes de revue') })
      .click()
    await expect(source).toHaveValue(linkedContent)
    await expect(dock).toHaveAttribute('data-continuity', 'retained')
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'black'
    })
    await camera.click()
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
    await navigation()
    await notifications.click()
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
    await notificationPanel.getByRole('button', { name: /#announcements/ }).click()
    await navigation()
    await page.getByRole('button', { name: en ? 'Files' : 'Fichiers', exact: true }).click()
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
    await files
      .getByRole('button', { name: new RegExp(en ? '^Review notes' : '^Notes de revue') })
      .click()
    await dock.getByRole('button', { name: en ? 'Leave' : 'Quitter', exact: true }).click()
    await expect(dock).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
    await navigation()
    await page.getByRole('button', { name: en ? 'Files' : 'Fichiers', exact: true }).click()
    await files
      .getByRole('button', { name: new RegExp(en ? '^Review notes' : '^Notes de revue') })
      .click()
    await expect(source).toHaveValue(linkedContent)
    await expect(comments).toContainText('Please confirm access before sharing.')
    await expect(
      comments.getByRole('button', { name: en ? 'Reopen' : 'Rouvrir', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'black'
    })
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations
    ).toEqual([])
  })
}
