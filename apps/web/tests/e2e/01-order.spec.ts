// 01-order.md §12 — the twelve acceptance tests, titled verbatim (the
// spec-test gate matches them). Given = `useScenario` + navigation, When =
// user actions, Then = assertions on the rendered French.
//
// Browser-evaluated callbacks need DOM types in the Node-side test project.
/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { useScenario } from './support/useScenario'
import { SUPPORT_EMAIL } from '../../src/app/supportContact'
import { markReliability, registerReliability } from './support/reliabilityRecord'

registerReliability(test)

/** Signs in through the mock identity provider and lands on `/acme-sa/order`,
 * the same round-trip `00-smoke.spec.ts` proves for `/acme-sa/home` — a deep
 * link to an organisation-scoped route triggers it before anything else
 * loads (`src/app/org-route.tsx`). */
async function signInToOrder(page: Page): Promise<void> {
  markReliability(page, 'entry')
  await page.goto('/acme-sa/order')
  markReliability(page, 'destination')
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  markReliability(page, 'authentication')
  await page.getByRole('button', { name: 'Continuer' }).click()
  markReliability(page, 'destination')
  await expect(page).toHaveURL(/\/acme-sa\/order\/.+\/plan$/)
}

async function choosePlan(page: Page, headcount: string): Promise<void> {
  await page.getByLabel('Combien de personnes dans votre organisation ?').fill(headcount)
  await page.getByLabel('Combien de personnes dans votre organisation ?').blur()
  await expect(page.getByText(/Nous vous recommandons/)).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/contacts$/)
}

async function fillContacts(page: Page, slug: string): Promise<void> {
  await page.getByLabel('Raison sociale').fill('ACME Construction')
  await page.getByLabel('Identifiant souhaité').fill(slug)
  await page.getByLabel('Identifiant souhaité').blur()
  await page.getByLabel("SIREN ou numéro d'entreprise").fill('830485108')
  await page.getByLabel('Adresse').fill('12 rue des Lilas')
  await page.getByLabel('Code postal').fill('75011')
  await page.getByLabel('Ville').fill('Paris')
  await page.getByLabel('Administrateur').fill('marie.dupont@acme.fr')
  await page.getByLabel('Facturation').fill('compta@acme.fr')
  await page.getByLabel('Sécurité et confidentialité').fill('dpo@acme.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/agreements$/)
}

async function enterUnavailablePlan(page: Page) {
  await page.goto('/acme-sa/help')
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()
  await page.getByRole('link', { name: 'Accueil', exact: true }).click()
  await page.getByRole('link', { name: 'Commander', exact: true }).click()
  await completeSilentOrderSignIn(page)
  await expect(page).toHaveURL(/\/acme-sa\/order\/.+\/plan$/)
}

async function expectUnavailablePlanHeading(page: Page) {
  const heading = page.getByRole('heading', { level: 1, name: 'Choisissez votre formule' })
  await expect(heading).toBeVisible()
  const flowTitle = page.getByRole('heading', { level: 1, name: 'Commander votre instance' })
  await expect(flowTitle).not.toBeFocused()
  await expect(flowTitle).not.toHaveAttribute('tabindex')
  await expect(page.getByRole('button', { name: 'Continuer', exact: true })).toHaveCount(0)
}

test('order/plan: keeps a visible heading after a catalogue failure', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'home.no-tenant',
    'order.catalogue-unavailable',
  ])
  await enterUnavailablePlan(page)
  await expect(page.getByRole('alert')).toContainText('support@kodera.io')
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  await expectUnavailablePlanHeading(page)
})

test('order/plan: keeps a visible heading with an empty catalogue', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'home.no-tenant',
    'order.catalogue-empty',
  ])
  await enterUnavailablePlan(page)
  await expect(page.getByText(/Les formules sont momentanément indisponibles/)).toContainText(
    'support@kodera.io'
  )
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
  await expectUnavailablePlanHeading(page)
})

test('order/plan: recommends a tier from headcount and headlines the annual price', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)

  await page.getByLabel('Combien de personnes dans votre organisation ?').fill('120')
  await page.getByLabel('Combien de personnes dans votre organisation ?').blur()

  await expect(
    page.getByText(/Nous vous recommandons Business\. Elle est prévue pour 84 à 166 personnes/)
  ).toBeVisible()
  const businessCard = page.getByRole('radio', { name: /^Business,/ })
  await expect(businessCard).toHaveAttribute('aria-checked', 'true')
  // Billed annually, the card headlines the monthly equivalent, "314 € /mois, facturé
  // annuellement", and gives the annual total Core invoices under it; the full sentence stays in
  // the card's accessible name.
  await expect(businessCard).toHaveAccessibleName(
    /^Business, 314\s€ par mois, facturé annuellement,/
  )
  await expect(businessCard.getByText(/^314\s€$/)).toBeVisible()
  await expect(businessCard.getByText('/mois HT, facturé annuellement')).toBeVisible()
  await expect(businessCard.getByText(/^soit 3\s768\s€ HT par an$/)).toBeVisible()
})

test('order/contacts: rejects a taken identifier and offers alternatives', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'order.slug-taken',
  ])
  await signInToOrder(page)
  await choosePlan(page, '120')

  await page.getByLabel('Identifiant souhaité').fill('acme')
  await page.getByLabel('Identifiant souhaité').blur()

  await expect(page.getByText('Ce nom est déjà pris — essayez « acme-fr ».')).toBeVisible()
  const suggestion = page.getByRole('button', { name: 'acme-group' })
  await expect(suggestion).toBeVisible()
  await suggestion.click()
  await expect(page.getByLabel('Identifiant souhaité')).toHaveValue('acme-group')
})

test('order/agreements: holds submission while legal documents remain readable', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await choosePlan(page, '120')
  await fillContacts(page, 'acme-construction')
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
  await expect(
    page.getByText(
      'L’envoi des commandes est temporairement suspendu. Vous pouvez préparer votre brouillon.'
    )
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lire' }).first()).toBeEnabled()
})

test('order/agreements: blocks acceptance when a document cannot be shown', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'order.dpa-unavailable',
  ])
  await signInToOrder(page)
  await choosePlan(page, '120')
  await fillContacts(page, 'acme-construction')

  await page.getByRole('button', { name: 'Lire' }).nth(1).click()
  await expect(page.getByText("Ce document n'a pas pu s'afficher.")).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /ACME Construction/ })).toBeDisabled()
})

test('order/agreements: does not send a purchase or allocate a retry key during the hold', async ({
  page,
}) => {
  const orders: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/organisations\/[^/]+\/orders$/.test(request.url()))
      orders.push(request.url())
  })
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await choosePlan(page, '120')
  await fillContacts(page, 'acme-construction')
  await page.getByRole('checkbox', { name: /ACME Construction/ }).click()
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
  expect(orders).toEqual([])
  const saved = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('order-draft:'))
      .map(([, value]) => value)
      .join('')
  )
  expect(saved).not.toContain('submitIdempotencyKey')
  expect(saved).not.toContain('orderId')
})

async function reloadOrder(page: Page, path?: string) {
  if (path === undefined) await page.reload()
  else await page.goto(path)
  await completeSilentOrderSignIn(page)
}

async function completeSilentOrderSignIn(page: Page) {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
}

test('order/recovery: holds a legacy possible purchase without restoring its fields', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  const path = new URL(page.url()).pathname
  const id = path.split('/')[3]!
  await page.evaluate(
    ({ id }) => {
      localStorage.setItem(
        `order-draft:${id}`,
        JSON.stringify({
          draftId: id,
          createdAt: new Date().toISOString(),
          billingPeriod: 'yearly',
          ngoRate: false,
          orderId: 'unknown-order',
          submitIdempotencyKey: 'original-intent',
          packCode: 'private-choice',
        })
      )
    },
    { id }
  )
  await reloadOrder(page)
  await expect(
    page.getByText(
      `Une commande pourrait déjà avoir été envoyée. Écrivez-nous à ${SUPPORT_EMAIL} avant d’en créer une autre.`
    )
  ).toBeVisible()
  await expect(page.getByLabel('Combien de personnes dans votre organisation ?')).toHaveCount(0)
  expect(
    await page.evaluate(({ id }) => localStorage.getItem(`order-draft:${id}`), { id })
  ).toContain('original-intent')
})

test('order/recovery: resumes only the same owner editable fields after reload', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await choosePlan(page, '120')
  await fillContacts(page, 'acme-resume')
  await reloadOrder(page)
  await expect(page.getByRole('checkbox', { name: /ACME Construction/ })).toBeVisible()
  await expect(page).toHaveURL(/\/agreements$/)
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
})

const PARTIAL_CONTACTS = {
  legalName: 'Draft Recovery Example',
  slug: 'acme-partial-draft',
  addressLine1: '12 rue Exemple',
  adminEmail: 'unfinished@',
}

async function enterPartialContacts(page: Page): Promise<void> {
  await page.getByLabel('Raison sociale').fill(PARTIAL_CONTACTS.legalName)
  await page.getByLabel('Identifiant souhaité').fill(PARTIAL_CONTACTS.slug)
  await page.getByLabel('Adresse', { exact: true }).fill(PARTIAL_CONTACTS.addressLine1)
  await page.getByLabel('Administrateur', { exact: true }).fill(PARTIAL_CONTACTS.adminEmail)
}

async function expectPartialContacts(page: Page): Promise<void> {
  await expect(page.getByLabel('Raison sociale')).toHaveValue(PARTIAL_CONTACTS.legalName)
  await expect(page.getByLabel('Identifiant souhaité')).toHaveValue(PARTIAL_CONTACTS.slug)
  await expect(page.getByLabel('Adresse', { exact: true })).toHaveValue(
    PARTIAL_CONTACTS.addressLine1
  )
  await expect(page.getByLabel('Administrateur', { exact: true })).toHaveValue(
    PARTIAL_CONTACTS.adminEmail
  )
  await expect(page.getByLabel("SIREN ou numéro d'entreprise")).toHaveValue('')
  await expect(page.getByLabel('Facturation', { exact: true })).toHaveValue('')
}

interface SavedPartialDraft {
  key: string
  value: {
    draftId: string
    owner: [string, string, string]
    editable: { contactEdits?: Record<string, string>; contacts?: Record<string, string> }
  }
}

async function savedPartialDraft(page: Page, draftId: string): Promise<SavedPartialDraft> {
  const read = () =>
    page.evaluate((id) => {
      for (const [key, raw] of Object.entries(localStorage)) {
        if (!key.startsWith('order-draft:editable-v1:')) continue
        const value = JSON.parse(raw) as SavedPartialDraft['value']
        if (value.draftId === id) return { key, value }
      }
      return undefined
    }, draftId)
  await expect
    .poll(async () => (await read())?.value.editable.contactEdits)
    .toMatchObject(PARTIAL_CONTACTS)
  const saved = (await read())!
  expect(saved.value.editable.contacts).toBeUndefined()
  expect(saved.value.owner).toHaveLength(3)
  expect(saved.key).toBe(
    `order-draft:editable-v1:${JSON.stringify([...saved.value.owner, draftId])}`
  )
  return saved
}

test('order/recovery: returns incomplete contacts through the real mock sign-in callback', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signInToOrder(page)
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await choosePlan(page, '120')
  const contactsPath = new URL(page.url()).pathname
  const draftId = contactsPath.split('/')[3]!
  await enterPartialContacts(page)
  const saved = await savedPartialDraft(page, draftId)

  // Trigger actual SDK expiry, never explicit logout or a forged authenticated session.
  expect(expiresIn).toBeGreaterThan(0)
  await page.clock.fastForward((expiresIn + 1) * 1000)
  await page.getByRole('button', { name: 'Se reconnecter', exact: true }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  const stashKey = `kodera.web.order.contactStash:${JSON.stringify([
    ...saved.value.owner,
    draftId,
  ])}`
  const stash = await page.evaluate((key) => sessionStorage.getItem(key), stashKey)
  expect(stash).not.toBeNull()
  expect(JSON.parse(stash!)).toMatchObject({
    purpose: 'order-contact-edits',
    owner: saved.value.owner,
    draftId,
    contacts: PARTIAL_CONTACTS,
  })

  // Keep the selected plan reachable but remove the redundant durable fields: a broken
  // stash read must not pass this journey by simply hydrating the already-saved local copy.
  await page.evaluate((key) => {
    const record = JSON.parse(localStorage.getItem(key)!) as SavedPartialDraft['value']
    delete record.editable.contactEdits
    delete record.editable.contacts
    localStorage.setItem(key, JSON.stringify(record))
  }, saved.key)
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${contactsPath}$`))
  await expectPartialContacts(page)
  await savedPartialDraft(page, draftId)
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), stashKey)).toBeNull()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${contactsPath}$`))
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toHaveCount(0)
})

test('order/recovery: reopens incomplete edits on the same contacts step', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await choosePlan(page, '120')
  const contactsPath = new URL(page.url()).pathname
  const draftId = contactsPath.split('/')[3]!
  await enterPartialContacts(page)
  await savedPartialDraft(page, draftId)

  // A real full-page index reopen follows the adapter's silent identity iframe; no
  // test writes contacts, authority or authentication data for this journey.
  await reloadOrder(page, '/acme-sa/order')
  await expect(page).toHaveURL(new RegExp(`${contactsPath}$`))
  await expectPartialContacts(page)
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${contactsPath}$`))
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toHaveCount(0)
  await savedPartialDraft(page, draftId)
})

test('order/recovery: explicit logout clears owner-bound contacts before a fresh order', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await choosePlan(page, '120')
  const draftId = new URL(page.url()).pathname.split('/')[3]!
  await enterPartialContacts(page)
  const saved = await savedPartialDraft(page, draftId)
  const stashKey = `kodera.web.order.contactStash:${JSON.stringify([
    ...saved.value.owner,
    draftId,
  ])}`
  // Pending-envelope cleanup fixture uses the actual saved owner/draft/fields. The
  // preceding sign-in acceptance separately proves production callback-created recovery.
  await page.evaluate(
    ({ key, value }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          purpose: 'order-contact-edits',
          owner: value.owner,
          draftId: value.draftId,
          editedAt: new Date().toISOString(),
          contacts: value.editable.contactEdits,
        })
      )
    },
    { key: stashKey, value: saved.value }
  )
  expect(await page.evaluate((key) => sessionStorage.getItem(key), stashKey)).not.toBeNull()
  expect(
    await page.evaluate(
      (owner) => localStorage.getItem(`order-draft-latest:editable-v1:${JSON.stringify(owner)}`),
      saved.value.owner
    )
  ).toBe(draftId)
  await page.getByRole('button', { name: /Julie/ }).click()
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  const remaining = await page.evaluate(() =>
    [localStorage, sessionStorage].flatMap((storage) =>
      Object.keys(storage).filter(
        (key) =>
          key.startsWith('order-draft:') ||
          key.startsWith('order-draft-latest:') ||
          key.startsWith('kodera.web.order.contactStash:')
      )
    )
  )
  expect(remaining).toEqual([])
  await signInToOrder(page)
  expect(new URL(page.url()).pathname.split('/')[3]).not.toBe(draftId)
  await expect(page.getByLabel('Combien de personnes dans votre organisation ?')).toHaveValue('')
  await expect(page.getByLabel('Raison sociale')).toHaveCount(0)
})

test('order/plan: shows a member who can place the order instead of a form', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'order.member-role',
  ])
  await signInToOrder(page)

  await expect(
    page.getByText(/Seul le propriétaire de l’organisation peut préparer cette commande/)
  ).toBeVisible()
  await expect(page.getByLabel('Combien de personnes dans votre organisation ?')).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('order/wizard: prepares a held draft with the keyboard alone', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  markReliability(page, 'interaction')

  // Headcount, by keyboard.
  await page.getByLabel('Combien de personnes dans votre organisation ?').click()
  await page.keyboard.type('120')
  await page.keyboard.press('Tab')
  await expect(page.getByText(/Nous vous recommandons Business/)).toBeVisible()

  // The plan cards are a real radio group: arrow keys move the choice.
  const teamCard = page.getByRole('radio', { name: /^Team,/ })
  await teamCard.focus()
  await page.keyboard.down('ArrowRight')
  await expect(page.getByRole('radio', { name: /^Business,/ })).toBeFocused()
  await page.keyboard.up('ArrowRight')
  await expect(page.getByRole('radio', { name: /^Business,/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )

  await page.getByRole('button', { name: 'Continuer' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/contacts$/)

  await page.getByLabel('Raison sociale').click()
  await page.keyboard.type('ACME Construction')
  await page.keyboard.press('Tab')
  await page.keyboard.type('acme-keyboard')
  await page.getByLabel("SIREN ou numéro d'entreprise").fill('830485108')
  await page.getByLabel('Adresse').fill('12 rue des Lilas')
  await page.getByLabel('Code postal').fill('75011')
  await page.getByLabel('Ville').fill('Paris')
  await page.getByLabel('Administrateur').fill('marie.dupont@acme.fr')
  await page.getByLabel('Facturation').fill('compta@acme.fr')
  await page.getByLabel('Sécurité et confidentialité').fill('dpo@acme.fr')
  await page.getByRole('button', { name: 'Continuer' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/agreements$/)

  // The document region scrolls by keyboard once it is opened.
  await page.getByRole('button', { name: 'Lire' }).first().focus()
  await page.keyboard.press('Enter')
  const viewer = page.getByRole('region').first()
  await viewer.focus()
  await page.keyboard.press('ArrowDown')

  const acceptance = page.getByRole('checkbox', { name: /ACME Construction/ })
  await acceptance.focus()
  await page.keyboard.press('Space')
  await expect(acceptance).toBeChecked()

  markReliability(page, 'primary')
  await expect(page.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
  await expect(page).toHaveURL(/\/agreements$/)
})

// §12 test 10. A step change used to leave focus on the visually hidden
// « Commander votre instance », and two regions spoke at once: the wizard's
// and the page announcement, as « Page Console chargée. ».
test('order/wizard: announces a step once and moves focus to its visible title', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await signInToOrder(page)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Choisissez votre formule' })
  ).toBeVisible()

  await page.getByLabel('Combien de personnes dans votre organisation ?').click()
  await page.keyboard.type('120')
  await page.keyboard.press('Tab')
  await expect(page.getByText(/Nous vous recommandons Business/)).toBeVisible()

  // What a screen reader announces from here on: text written into a live
  // region that is already on the page. A region that arrives with a new
  // screen, its text already in it, is not a change to anything.
  await page.evaluate(() => {
    const LIVE = '[aria-live], [role="status"], [role="alert"]'
    const present = new Set(Array.from(document.querySelectorAll(LIVE)))
    const announced: string[] = []
    ;(window as unknown as { announced: string[] }).announced = announced
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList' && record.addedNodes.length === 0) continue
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement
        const region = element?.closest(LIVE)
        if (region == null || !present.has(region)) continue
        const text = (region.textContent ?? '').trim()
        if (text !== '' && announced.at(-1) !== text) announced.push(text)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })

  await page.getByRole('button', { name: 'Continuer' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/contacts$/)

  // Focus is on the step's own title, drawn where a person can see it: the
  // hidden heading above it is a 1 px box.
  const title = page.getByRole('heading', { level: 1, name: 'Votre organisation' })
  await expect(title).toBeFocused()
  const box = await title.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(40)
  expect(box!.height).toBeGreaterThan(10)
  expect(await title.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')

  // One announcement, the wizard's, naming the step.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { announced: string[] }).announced))
    .toEqual(['Étape 2 sur 4 : Organisation.'])
  await expect(page.getByText(/^Page .+ chargée\.$/)).toHaveCount(0)

  // `Tab` goes on into the step from its title.
  await page.keyboard.press('Tab')
  await expect(title).not.toBeFocused()
  expect(await page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true)
})

test('order/support: uncertain-outcome contact preserves the hold without submitting or navigating', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/orders(?:\/|$)/.test(new URL(request.url()).pathname))
      posts++
  })
  await signInToOrder(page)
  const draftId = new URL(page.url()).pathname.split('/')[3]!
  const legacy = JSON.stringify({
    orderId: 'unresolved-synthetic-order',
    privateValue: 'never-in-mailto',
  })
  await page.evaluate(
    ({ draftId, legacy }) => localStorage.setItem(`order-draft:${draftId}`, legacy),
    { draftId, legacy }
  )
  await reloadOrder(page)
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    `Écrivez-nous à ${SUPPORT_EMAIL}`
  )
  const heldUrl = page.url()
  const contact = page.getByRole('link', { name: 'Nous écrire', exact: true })
  await expect(contact).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(page.getByLabel('Raison sociale')).toHaveCount(0)
  await expect(contact).not.toBeFocused()
  for (let tabs = 0; tabs < 40; tabs++) {
    if (await contact.evaluate((element) => document.activeElement === element)) break
    await page.keyboard.press('Tab')
  }
  await expect(contact).toBeFocused()
  await contact.evaluate((element) =>
    element.addEventListener('click', (event) => event.preventDefault(), { once: true })
  )
  await page.keyboard.press('Enter')
  expect(page.url()).toBe(heldUrl)
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    `Écrivez-nous à ${SUPPORT_EMAIL}`
  )
  expect(await page.evaluate((id) => localStorage.getItem(`order-draft:${id}`), draftId)).toBe(
    legacy
  )
  expect(posts).toBe(0)
})
