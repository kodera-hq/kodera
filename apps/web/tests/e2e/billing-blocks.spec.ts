import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test('billing overview presents subscription, payment guidance and the served address', async ({
  page,
}) => {
  const profileRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/v1\/organisations\/[^/]+$/.test(new URL(request.url()).pathname))
      profileRequests.push(request.url())
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.paid-history',
  ])
  await signIn(page, 'acme-sa', '/invoices')
  await expect(page.getByRole('heading', { name: 'Moyens de paiement' })).toBeVisible()
  const address = page.getByRole('region', { name: 'Adresse de facturation' })
  await expect(address.getByText('12 rue de la Paix')).toBeVisible()
  await expect(address.getByText('75002 Paris')).toBeVisible()
  await expect(address.getByText('FR', { exact: true })).toBeVisible()
  await expect(page.getByText(/^4\s488\s€\sMontant annuel HT$/)).toBeVisible()
  await expect(page.getByText('Montant annuel HT', { exact: true })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('button', { name: /Télécharger le PDF/ }).first()).toBeVisible()
  expect(profileRequests.length).toBeGreaterThan(0)
  await page.setViewportSize({ width: 390, height: 780 })
  await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toBeVisible()
  await expect(address).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a member denied Billing never requests the billing profile', async ({ page }) => {
  const profileRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/v1\/organisations\/[^/]+$/.test(new URL(request.url()).pathname))
      profileRequests.push(request.url())
  })
  await useScenario(page, ['shell.single-organisation', 'shell.member-role'])
  await signIn(page, 'acme-sa', '/invoices')
  await expect(
    page.getByText(
      "Les factures sont réservées au propriétaire et aux administrateurs de l'organisation."
    )
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Adresse de facturation' })).toHaveCount(0)
  expect(profileRequests).toEqual([])
})
