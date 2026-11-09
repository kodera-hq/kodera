// docs/specs/05-invoices.md §12 — the ten acceptance tests, titled verbatim.
// Given = `useScenario` plus navigation (`signIn`), When = user actions,
// Then = assertions on the rendered French (docs/dev/TESTING.md).

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'
import { SUPPORT_EMAIL } from '../../src/app/supportContact'

const ORG = 'acme-sa'

test('invoices/list: states how late an invoice is and what happens next', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'])
  await signIn(page, ORG, '/invoices')

  const banner = page.getByRole('alert').filter({ hasText: 'La facture INV-2026-0142' })
  await expect(banner).toContainText('INV-2026-0142')
  await expect(banner).toContainText(/en retard de 12 jours/i)
  await expect(banner).toContainText(/6 juin 2027/)
  await expect(banner.getByRole('link', { name: /Payer/ })).toContainText('5 806,08')

  const row = page.getByRole('row', { name: /INV-2026-0142/ })
  await expect(row).toContainText(/En retard de 12 jours/)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('invoices/list: downloads any invoice as a PDF from the list', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.paid-history',
  ])
  await signIn(page, ORG, '/invoices')

  await expect(page.getByRole('row', { name: /INV-2026-0101/ })).toBeVisible()

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page
      .getByRole('row', { name: /INV-2026-0101/ })
      .getByRole('button', { name: /Télécharger le PDF/ })
      .click(),
  ])
  expect(popup.url()).toContain('.pdf')
  await popup.close()

  await page.getByRole('button', { name: /Afficher 25 de plus/ }).click()
  await expect(page.getByRole('row', { name: /INV-2026-0101/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /INV-2026-0104/ })).toBeVisible()
})

test('invoices/detail: renders the VAT regime sentence as issued', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.reverse-charge',
  ])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')

  await expect(page.getByText('TVA non applicable, autoliquidation par le preneur')).toBeVisible()
  await expect(page.getByText('TVA 0 %')).toBeVisible()
  // Reverse charge: vat_amount is zero, so total incl. tax equals total
  // excl. tax — both collapse to the same formatted amount, shown four
  // times on the page: the "À régler" hero amount, the line total, and
  // both DefinitionList totals.
  await expect(page.getByText('4 488 €')).toHaveCount(4)
})

test('invoices/detail: falls back to the PDF and support when the payment link fails', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.payment-link-failed',
  ])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')

  await page.getByRole('button', { name: 'Payer en ligne' }).click()

  await expect(
    page.getByText(
      'Le paiement en ligne est momentanément indisponible. Réessayez dans quelques instants, ou réglez par virement avec les coordonnées indiquées sur la facture PDF.'
    )
  ).toBeVisible()
  // SI-12: the fallback used to be a « Coordonnées bancaires » dialog with no
  // IBAN in it. The PDF, which carries the transfer details, is the primary
  // way to pay now, with support beside it.
  // The "À régler" card: its heading sits in the card's header.
  const toPay = page.getByRole('heading', { name: 'À régler' }).locator('xpath=../..')
  await expect(toPay.getByRole('button', { name: 'Télécharger le PDF' })).toBeVisible()
  // One PDF action on the page, and it leads the card's actions.
  await expect(page.getByRole('button', { name: 'Télécharger le PDF' })).toHaveCount(1)
  await expect(toPay.locator('button, a').first()).toHaveText('Télécharger le PDF')
  await expect(toPay.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
    'href',
    /\/acme-sa\/help\?invoiceNumber=INV-2026-0142$/
  )
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /coordonnées bancaires/i })).toHaveCount(0)
  await expect(page.getByText(/ci-dessous/)).toHaveCount(0)
  await expect(page.getByText(/50\d|502/)).toHaveCount(0)
})

test('invoices/detail: does not claim failure when a payment is still settling', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.payment-return-pending',
  ])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70?payment=return')

  await expect(
    page.getByText(
      "Nous n'avons pas encore reçu de règlement pour cette facture. Un paiement peut mettre quelques minutes à apparaître."
    )
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actualiser' })).toBeVisible()
  await expect(page.getByText(/échoué|erreur|failed/i)).toHaveCount(0)
})

test('invoices/detail: stays usable when the PDF is unavailable', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.pdf-missing',
  ])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')

  await expect(page.getByRole('heading', { name: 'Détail' })).toBeVisible()
  await expect(page.getByText('Total TTC')).toBeVisible()

  const pdfButton = page.getByRole('button', { name: 'Télécharger le PDF' })
  await expect(pdfButton).toBeDisabled()
  // Nothing to retry beside a disabled button: the reason, then support.
  await expect(
    page.getByText(
      `Le PDF de cette facture n'est pas disponible pour le moment. Écrivez-nous à ${SUPPORT_EMAIL} en indiquant son numéro.`
    )
  ).toBeVisible()

  const support = page.getByRole('link', { name: /Un problème avec cette facture/ })
  await expect(support).toHaveAttribute('href', /invoiceNumber=INV-2026-0142/)
})

test('invoices/dunning: shows the remaining steps with their dates', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.suspension-imminent',
  ])
  await signIn(page, ORG, '/invoices')

  await page.getByRole('button', { name: 'Échéances de règlement' }).click()
  const drawer = page.getByRole('dialog', { name: 'Échéances de règlement' })
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText('préavis de suspension')
  await expect(
    drawer.getByText(
      'suspension des connexions. Vos données sont conservées et les réunions en cours se terminent normalement.'
    )
  ).toBeVisible()
  await expect(drawer.getByText("Le règlement rétablit l'accès sous un jour ouvré.")).toBeVisible()
})

test('invoices/list: shows a credit note without a payment action', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.credit-note',
  ])
  await signIn(page, ORG, '/invoices')

  const row = page.getByRole('row', { name: /A-2026-0003/ })
  await expect(row).toContainText('Avoir')
  await expect(row).toContainText('594')
  await expect(row.getByRole('button', { name: /Payer/ })).toHaveCount(0)
})

test('invoices/list: explains when the first invoice will arrive', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'invoices.owner-role', 'invoices.empty'])
  await signIn(page, ORG, '/invoices')

  await expect(page.getByRole('heading', { name: 'Votre première facture arrive' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Voir mon abonnement' })).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('invoices/detail: offers no bank details the contract does not carry', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')

  // The detail pays online and says where the transfer details are.
  await expect(page.getByRole('button', { name: 'Payer en ligne' })).toBeVisible()
  await expect(
    page.getByText(
      'Vous pouvez aussi régler par virement : les coordonnées figurent sur la facture PDF.'
    )
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /coordonnées bancaires/i })).toHaveCount(0)

  // The list's row menu no longer offers a dialog with no IBAN in it.
  await page.getByRole('navigation').getByRole('link', { name: 'Facturation' }).click()
  await page.getByRole('button', { name: 'Actions pour la facture INV-2026-0142' }).click()
  await expect(page.getByRole('menuitem', { name: 'Voir le détail' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /coordonnées bancaires/i })).toHaveCount(0)
})

for (const role of ['admin', 'owner', 'billing'] as const) {
  test(`invoices/authority: ${role} reading and payment remain separate`, async ({ page }) => {
    const overlays = ['shell.single-organisation', 'invoices.overdue']
    if (role === 'owner') overlays.push('invoices.owner-role')
    if (role === 'billing') overlays.push('shell.billing-role')
    await useScenario(page, overlays)
    await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')
    await expect(page.getByRole('heading', { name: 'Facture INV-2026-0142' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Télécharger le PDF' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Payer en ligne' })).toHaveCount(
      role === 'admin' ? 0 : 1
    )
  })
}
