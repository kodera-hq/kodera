import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test('explicit logout removes authenticated content and saved form data', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await page.evaluate(() => {
    sessionStorage.setItem('kodera.web.session.formStash', 'synthetic private form')
    localStorage.setItem('order-draft:synthetic', 'synthetic contacts')
  })
  await page.getByRole('button', { name: /Julie/ }).click()
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  expect(
    await page.evaluate(() => sessionStorage.getItem('kodera.web.session.formStash'))
  ).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('order-draft:synthetic'))).toBeNull()
})
