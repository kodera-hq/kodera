import { expect, test } from '@playwright/test'

for (const locale of ['fr', 'en']) {
  test(`fresh community entry discloses local simulation in ${locale}`, async ({ page }) => {
    await page.addInitScript(
      (language) => sessionStorage.setItem('console:language', language),
      locale
    )
    await page.goto('/community/workspace')
    const title =
      locale === 'fr'
        ? 'Simulation interactive locale au navigateur'
        : 'Interactive browser-local simulation'
    const disclosure = page.getByRole('status', { name: title })
    await expect(disclosure).toBeVisible()
    await expect(disclosure.getByRole('link', { name: 'support@kodera.io' })).toHaveAttribute(
      'href',
      'mailto:support@kodera.io'
    )
    await page.getByRole('link', { name: 'support', exact: true }).click()
    await expect(page.getByRole('log')).toContainText(/simul/i)
    await expect(page.getByRole('log')).toContainText('support@kodera.io')
    await expect(page.getByRole('textbox')).toHaveAccessibleDescription(/sessionStorage/)
    await page.getByRole('textbox').fill('Local simulated support example')
    await page.getByRole('textbox').press('Enter')
    await expect(page.getByRole('log')).toContainText('Local simulated support example')
    await expect(disclosure).toBeVisible()
    await page.reload()
    await expect(disclosure).toBeVisible()
    await expect(page.getByRole('log')).toContainText('Local simulated support example')
    await page
      .getByRole('button', { name: locale === 'fr' ? 'Membres' : 'Members', exact: true })
      .click()
    await expect(page.getByTestId('espace-members-presence-summary')).toContainText(/simul/i)
  })
}
