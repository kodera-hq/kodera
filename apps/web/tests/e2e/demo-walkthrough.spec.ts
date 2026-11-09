// The walkable demo, walked (docs/dev/DEMO.md). Six steps in the order the
// script narrates them, and at each one the assertion the demo actually
// promises: that this screen is describing the same company as the last one.
//
// The joins are checked by CARRYING a value forward — the amount read off
// Home is the amount asserted on the billing screen, the invoice number read
// off the list is the number asserted on the detail — rather than by
// restating a constant on each screen. A constant repeated six times passes
// when six screens each read their own fixture; a value carried forward
// cannot.
//
// The last assertion of every step is the negative one: the contract's own
// example company must not appear. That is the failure this whole seed
// exists to prevent, and it is invisible to any per-screen assertion — a
// screen showing ACME SAS renders perfectly.

import { expect, test, type Page } from '@playwright/test'

const ORGANISATION = 'Groupe Vercelli'
const PERSON = 'Inès Kaci'
const INVOICE_NUMBER = /FA-\d{4}-\d{4}/
/** French typography puts a narrow no-break space before the `%` and inside
 * thousands, so a literal `'TVA 20 %'` typed with an ordinary space matches
 * nothing on screen. `\s` covers both. */
const VAT_LINE = /TVA\s20\s%/
/** The contract example's own organisation and person: what the generated
 * base handlers answer with, and therefore what a route the demo forgot to
 * seed would put on screen. */
const NOT_SEEDED = /ACME|Julie Marchand|julie@acme\.fr|INV-2026-0142/

async function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText()
}

/**
 * Waits for the screen's own data to be on the page before anything reads it.
 * The shell renders — navigation, organisation name, banner — before the
 * screen's queries resolve, so a body read taken on arrival passes the
 * organisation assertion and silently misses everything the screen is about.
 */
async function settled(page: Page, ...markers: ReadonlyArray<RegExp | string>): Promise<string> {
  for (const marker of markers) {
    // Named, because the commonest way for this to time out is not a slow
    // render: it is a route the demo did not seed, answered by the generated
    // base handler with another company's data, in which case the marker this
    // screen was waiting for never appears at all.
    await expect(
      page.getByText(marker).first(),
      `the screen never showed ${String(marker)} — is every route it calls seeded?`
    ).toBeVisible()
  }
  return bodyText(page)
}

async function expectSeededOnly(page: Page): Promise<void> {
  const text = await bodyText(page)
  expect(text, 'the screen names the organisation the demo is not about').not.toMatch(NOT_SEEDED)
  expect(text, 'the screen does not name the seeded organisation').toContain(ORGANISATION)
}

test('the demo path walks one organisation end to end', async ({ page }) => {
  // Step 1 — one URL, no session storage typed by hand.
  await page.goto('/login?demo=1&org=vercelli')
  await page.getByRole('textbox').first().fill('vercelli')
  await page.keyboard.press('Enter')
  // Demo authorization continues automatically after realm discovery.

  // Step 2 — Accueil.
  await page.waitForURL(/\/vercelli\/home$/)
  // Named, because the shell now has two navigation landmarks: the main navigation
  // and the module rail. An unnamed role query matches both and fails strict mode --
  // and a bare `.first()` would assert whichever the DOM happens to order first.
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible()
  await expect(page.getByText(PERSON).first()).toBeVisible()
  const home = await settled(page, 'Prochaine facture', /prélèvement le/, /46 personnes/)
  await expectSeededOnly(page)
  const amount = /(\d[\d\s]*€)\s*HT \/ mois/.exec(home)?.[1]
  expect(amount, 'Home does not show a next-invoice amount to carry forward').toBeTruthy()
  const nextInvoiceDate = /prélèvement le (.+)$/m.exec(home)?.[1]?.trim()
  expect(nextInvoiceDate, 'Home does not show a next-invoice date to carry forward').toBeTruthy()

  // Step 3 — Applications: the same tenant, the incident, the capacity.
  await page.getByRole('link', { name: 'Applications', exact: true }).click()
  await page.waitForURL(/\/vercelli\/status$/)
  const status = await settled(page, /46 personnes/, 'Votre formule', /Prochaine facture/)
  await expectSeededOnly(page)
  expect(status, 'the status screen and Home disagree about the next invoice').toContain(
    nextInvoiceDate!
  )
  expect(status, 'the applications are not on this organisation’s own domain').toContain(
    'https://visio.groupe-vercelli.fr'
  )

  // Step 4 — Facturation: the same subscription, and the ledger.
  await page.getByRole('link', { name: 'Facturation', exact: true }).click()
  await page.waitForURL(/\/vercelli\/invoices$/)
  const invoices = await settled(page, 'Liste de vos factures', INVOICE_NUMBER, 'Mensualité HT')
  await expectSeededOnly(page)
  expect(invoices, 'the billing screen prices the subscription differently from Home').toContain(
    amount!
  )
  expect(invoices, 'the billing screen and Home disagree about the next invoice').toContain(
    nextInvoiceDate!
  )
  const number = INVOICE_NUMBER.exec(invoices)?.[0]
  expect(number, 'the ledger carries no invoice to open').toBeTruthy()

  // Step 5 — one invoice, in detail.
  await page.getByText(number!).first().click()
  await page.waitForURL(/\/vercelli\/invoices\/[0-9a-f-]+$/)
  const invoice = await settled(page, VAT_LINE, INVOICE_NUMBER)
  await expectSeededOnly(page)
  expect(invoice, 'the invoice opened is not the one the list linked to').toContain(number!)
  expect(invoice, 'the invoice is not priced at the subscription’s own amount').toContain(amount!)
  expect(invoice, 'the invoice does not state a French VAT line').toMatch(VAT_LINE)

  // Step 6 — the pricing model, entered from the capacity that motivates it.
  await page.getByRole('link', { name: 'Applications', exact: true }).click()
  await page.waitForURL(/\/vercelli\/status$/)
  await expect(page.getByRole('button', { name: 'Voir les formules' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Voir les formules' }).first().click()
  await page.waitForURL(/\/vercelli\/order\/[0-9a-f-]+\/plan$/)
  // The plan's name, not only the tier's figures: a card is titled once its price row is read.
  const plan = await settled(
    page,
    'Choisissez votre formule',
    /participants simultanés/,
    'Business Plus'
  )
  await expectSeededOnly(page)
  expect(plan, 'the plan step does not offer the tier the capacity gauge suggests').toContain(
    'Business Plus'
  )
  // Submission is held on `main` (`SUBMISSION_HELD` in AgreementsStep.tsx), so
  // the demo stops here by design and says so. Asserted, not assumed: a demo
  // script that promised a completed order would be wrong the moment somebody
  // followed it.
  expect(plan, 'the order step no longer says submission is held').toContain(
    'temporairement suspendu'
  )
})

test('?demo=0 leaves the demo', async ({ page }) => {
  // The way back out, and the proof the entry point is a switch rather than a
  // one-way door: the same session, the same tab, the contract's own example
  // organisation again.
  await page.goto('/login?demo=1&org=vercelli')
  await page.getByRole('textbox').first().fill('vercelli')
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/vercelli\/home$/)
  await expect(page.getByText(ORGANISATION).first()).toBeVisible()

  await page.goto('/acme-sa/home?demo=0')
  await page.waitForURL(/\/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer' }).click()
  // The `?demo=0` stays on the URL through the round trip, so this matches on
  // the path rather than on the whole href.
  await page.waitForURL((url) => url.pathname === '/acme-sa/home')
  await expect(page.getByText('ACME').first()).toBeVisible()
  expect(await bodyText(page), 'the demo seed is still answering after ?demo=0').not.toContain(
    ORGANISATION
  )
})
