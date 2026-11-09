import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'
import { markReliability, registerReliability } from './support/reliabilityRecord'

registerReliability(test)

// Initial missing-screen acceptance. Explicit overlays keep each security
// condition visible instead of letting an unrelated fixture shape imply it.
test('preview foundation exposes the recovered Home screen', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
})

test('preview foundation refuses order entry without matching identity evidence', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.identity-mismatch'])
  await page.goto('/acme-sa/order')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(
    page.getByText(
      'Nous n’avons pas pu vérifier vos droits pour cette commande. Réessayez avant de poursuivre.'
    )
  ).toBeVisible()
  await expect(page.getByLabel('Combien de personnes dans votre organisation ?')).toHaveCount(0)
})

test('preview foundation preserves the existing invoice page', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa', '/invoices')
  await expect(page.getByRole('heading', { name: 'Factures', exact: true })).toBeVisible()
})

test('combined screens preserve navigation from Home through Status and invoice detail', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'status.live-healthy'])
  markReliability(page, 'authentication')
  await signIn(page, 'acme-sa')
  markReliability(page, 'home')
  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
  markReliability(page, 'applications')
  await page.getByRole('link', { name: 'Applications', exact: true }).click()
  await expect(page.getByText('https://visio.acme.fr')).toBeVisible()
  markReliability(page, 'billing')
  await page.getByRole('link', { name: 'Facturation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Factures', exact: true })).toBeVisible()
  markReliability(page, 'invoice')
  await page.getByRole('link', { name: 'INV-2026-0142', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Facture INV-2026-0142', exact: true })
  ).toBeVisible()
  markReliability(page, 'home')
  await page.getByRole('link', { name: 'Accueil', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
})

test('combined owner entry refreshes authority and prepares a draft while purchase remains held', async ({
  page,
}) => {
  const meReads: string[] = []
  const purchases: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/me') meReads.push(request.url())
    if (
      request.method() === 'POST' &&
      /\/organisations\/[^/]+\/orders$/.test(new URL(request.url()).pathname)
    )
      purchases.push(request.url())
  })
  await useScenario(page, [
    'shell.single-organisation',
    'home.no-tenant',
    'order.catalogue-default',
  ])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('heading', { name: "Aucune instance pour l'instant" })).toBeVisible()
  const beforeEntry = meReads.length
  await page.getByRole('link', { name: 'Commander', exact: true }).click()
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page).toHaveURL(/\/acme-sa\/order\/[^/]+\/plan$/)
  await expect.poll(() => meReads.length - beforeEntry).toBeGreaterThanOrEqual(2)
  await page.getByLabel('Combien de personnes dans votre organisation ?').fill('120')
  await page.getByLabel('Combien de personnes dans votre organisation ?').blur()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByLabel('Raison sociale').fill('Synthetic Organisation')
  await page.getByLabel('Identifiant souhaité').fill('synthetic-preview')
  await page.getByLabel('Identifiant souhaité').blur()
  await page.getByLabel("SIREN ou numéro d'entreprise").fill('830485108')
  await page.getByLabel('Adresse').fill('12 rue Exemple')
  await page.getByLabel('Code postal').fill('75011')
  await page.getByLabel('Ville').fill('Paris')
  await page.getByLabel('Administrateur').fill('admin@example.test')
  await page.getByLabel('Facturation').fill('billing@example.test')
  await page.getByLabel('Sécurité et confidentialité').fill('security@example.test')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
  await expect(
    page.getByText(
      'L’envoi des commandes est temporairement suspendu. Vous pouvez préparer votre brouillon.'
    )
  ).toBeVisible()
  expect(purchases).toEqual([])
})

test('combined billing reader sees Home and invoices without management or purchase authority', async ({
  page,
}) => {
  await useScenario(page, ['screens.billing-identity', 'home.no-tenant'])
  markReliability(page, 'authentication')
  await signIn(page, 'acme-sa')
  markReliability(page, 'home')
  await expect(page.getByRole('heading', { name: "Aucune instance pour l'instant" })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Personnes', exact: true })).toHaveCount(0)
  markReliability(page, 'billing')
  await page.getByRole('link', { name: 'Facturation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Factures', exact: true })).toBeVisible()
  markReliability(page, 'entry')
  await page.goto('/acme-sa/order')
  markReliability(page, 'restoration')
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  markReliability(page, 'authentication')
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  markReliability(page, 'primary')
  await expect(
    page.getByText(
      'Seul le propriétaire de l’organisation peut préparer cette commande et générer son DPA.'
    )
  ).toBeVisible()
  await expect(page.getByLabel('Combien de personnes dans votre organisation ?')).toHaveCount(0)
})
