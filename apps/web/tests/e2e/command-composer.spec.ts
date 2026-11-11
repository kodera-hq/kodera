import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
for (const theme of ['light', 'dark', 'black']) {
  test(`${theme}: live workspace palette, formatting, slash drafts and attachment staging`, async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript((value) => localStorage.setItem('console:theme', value), theme)
    await page.goto('/login?demo=1&org=community')
    await page.getByRole('button', { name: 'Continuer', exact: true }).click()
    await page.waitForURL(/\/community\/workspace$/)
    const search = page.getByRole('button', { name: 'Rechercher', exact: true })
    const modifier = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Meta' : 'Control'
    )
    await search.focus()
    await page.keyboard.press(`${modifier}+k`)
    const dialog = page.getByRole('dialog', { name: 'Commandes et navigation rapide' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox')).toBeFocused()
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations
    ).toEqual([])
    await dialog.getByRole('combobox').fill('gnrl')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    const field = page.getByRole('textbox', { name: /Message/ }).first()
    await field.fill('hello')
    await field.press('ControlOrMeta+a')
    await field.press(`${modifier}+b`)
    await expect(field).toHaveValue('**hello**')
    await field.fill('/code')
    await expect(page.getByRole('option', { name: /^\/code/ })).toBeVisible()
    await field.press('Enter')
    await expect(field).toHaveValue('```\n\n```')
    await field.fill('/poll')
    await expect(page.getByRole('option', { name: /^\/poll/ })).toBeVisible()
    await field.press('Enter')
    await expect(field).toHaveValue(/Question.*\n- Choix 1\n- Choix 2/)
    await page.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Local preview'),
    })
    await expect(page.getByText(/uniquement des aperçus/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Envoyer', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Retirer notes.txt' }).click()
    await expect(page.getByRole('button', { name: 'Envoyer', exact: true })).toBeEnabled()
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      canvas.getContext('2d')!.fillRect(0, 0, 2, 2)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    await page.locator('input[type="file"]').setInputFiles({
      name: 'pixels.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })
    await expect
      .poll(() =>
        page.locator('form canvas').evaluate((element) => (element as HTMLCanvasElement).width)
      )
      .toBe(256)
    await page.getByRole('button', { name: 'Retirer pixels.png' }).click()
    expect(
      (await new AxeBuilder({ page }).include('form:has([role="toolbar"])').analyze()).violations
    ).toEqual([])
    await page.screenshot({ path: info.outputPath(`composer-${theme}.png`) })
    await search.click()
    await dialog.getByRole('combobox').fill('Voix')
    await dialog.getByRole('combobox').press('Enter')
    await expect(page.getByRole('tab', { name: /Voix/ })).toHaveAttribute('aria-selected', 'true')
  })
}
