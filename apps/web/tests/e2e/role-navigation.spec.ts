import { expect, test } from '@playwright/test'
import { useScenario } from './support/useScenario'
import { signIn } from './support/signIn'

test('billing read access never grants people, domain or federation management', async ({
  page,
}) => {
  await useScenario(page, ['shell.billing-role'])
  await signIn(page, 'acme-sa')
  // The SIDEBAR, named: the shell now carries a second navigation landmark
  // (the module rail), and this spec is about what the role matrix puts in the
  // sidebar. The rail's own version of this assertion is in
  // `src/app/ModuleRail.test.tsx`.
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link', { name: 'Facturation' })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Personnes' })).toHaveCount(0)
  await expect(navigation.getByRole('link', { name: 'Domaine & identité' })).toHaveCount(0)
  await navigation.getByRole('link', { name: 'Facturation' }).click()
  await expect(page.getByRole('heading', { name: 'Factures' })).toBeVisible()
  await expect(
    page.getByText('Cette page est réservée aux administrateurs.', { exact: false })
  ).toHaveCount(0)

  for (const area of ['people', 'domain', 'federation']) {
    await page.goto(`/acme-sa/${area}`)
    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
      .toBe(true)
    const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
    await frame
      .getByRole('button', { name: 'Continuer' })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(
      page.getByText('Cette page est réservée aux administrateurs.', { exact: false })
    ).toBeVisible()
  }
})
