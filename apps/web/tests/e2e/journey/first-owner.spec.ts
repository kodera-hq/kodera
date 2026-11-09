// The connected first-owner journey (docs/specs/09-owner-claim.md), on the build with
// `VITE_FIRST_OWNER_JOURNEY=1` (the `journey` project in playwright.config.ts): invitation link,
// protected sign-in, explicit confirm, fresh owner read, then Order, where the CGV and DPA are
// accepted and the order placed, and only then the workspace.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { useScenario } from '../support/useScenario'

// The contract example's organisation (`getOrganisationBootstrap`, `consumeOwnerClaim`).
const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const SLUG = 'acme-sa'
const SECRET = 'synthetic-invitation-secret'
const CLAIM_PATH = `/claim/${ORGANISATION_ID}/${SLUG}`

async function expectAxeClean(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
}

test('claim/journey: a first owner goes from the invitation link to a created workspace', async ({
  page,
}) => {
  await useScenario(page, ['order.catalogue-default', 'workspace.awaiting-order', 'claim.issued'])
  const leaked: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(SECRET)) leaked.push(request.url())
  })

  await page.goto(`${CLAIM_PATH}#${SECRET}`)
  // The secret leaves the address bar before anything else is fetched.
  await expect(page).toHaveURL(new URL(CLAIM_PATH, page.url()).href)
  const signInHeading = page.getByRole('heading', {
    level: 1,
    name: 'Connectez-vous avec le compte invité pour devenir propriétaire de votre organisation',
  })
  await expect(signInHeading).toBeFocused()
  await expectAxeClean(page)

  const popupOpened = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Se connecter' }).click()
  const popup = await popupOpened
  await popup.getByRole('button', { name: 'Continuer' }).click()

  const confirmHeading = page.getByRole('heading', {
    level: 1,
    name: 'Confirmez que vous devenez propriétaire de votre organisation',
  })
  await expect(confirmHeading).toBeFocused()
  await expectAxeClean(page)

  const consume = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/owner-claims/actions/consume')
  )
  // Keyboard only: the confirm is the next stop after the focused heading.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Devenir propriétaire' })).toBeFocused()
  await page.keyboard.press('Enter')
  const sent = await consume
  expect(sent.postDataJSON()).toEqual({ token: SECRET })
  expect(sent.headers()['idempotency-key']).toMatch(/^[!-~]{16,255}$/)
  expect(sent.headers()['authorization']).toMatch(/^Bearer \S+$/)

  // The new owner chooses an offer and accepts the agreements before anything is created.
  await page.waitForURL(new RegExp(`/${SLUG}/order/[^/]+/plan$`))
  await expect(
    page.getByRole('heading', { level: 1, name: 'Choisissez votre formule' })
  ).toBeVisible()

  await page.getByLabel('Combien de personnes dans votre organisation ?').fill('120')
  await page.getByLabel('Combien de personnes dans votre organisation ?').blur()
  await expect(page.getByText(/Nous vous recommandons/)).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.getByLabel('Raison sociale').fill('ACME Construction')
  await page.getByLabel('Identifiant souhaité').fill('acme-construction')
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

  // The order carries the DPA acceptance and the exact CGV, SLA and AUP versions shown.
  const order = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && /\/organisations\/[^/]+\/orders$/.test(request.url())
  )
  await page.getByRole('checkbox', { name: /ACME Construction/ }).click()
  await page.getByRole('button', { name: 'Signer et recevoir la facture' }).click()
  const placed = (await order).postDataJSON() as {
    dpa_acceptance: { accepted: boolean; dpa_id: string }
    legal_acceptances: { code: string; version: string; locale: string }[]
  }
  expect(placed.dpa_acceptance).toMatchObject({ accepted: true })
  expect(placed.legal_acceptances.map(({ code }) => code).sort()).toEqual(['aup', 'cgv', 'sla'])
  expect(placed.legal_acceptances.every(({ version, locale }) => version && locale)).toBe(true)

  await page.getByRole('link', { name: 'Créer votre espace de travail' }).click()
  await page.waitForURL((url) => url.pathname === `/${SLUG}/workspace`)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Votre espace de travail est prêt à être créé' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Créer l’espace de travail' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()

  expect(leaked).toEqual([])
  // Nor does the secret sit in the page's storage or history.
  const kept = await page.evaluate(
    (secret) =>
      [
        JSON.stringify({ ...sessionStorage }),
        JSON.stringify({ ...localStorage }),
        JSON.stringify(history.state),
      ].some((value) => value.includes(secret)),
    SECRET
  )
  expect(kept).toBe(false)
})

test('claim/landing: an expired invitation asks for a new link and offers no confirm', async ({
  page,
}) => {
  await useScenario(page, ['claim.issued', 'claim.expired'])
  const consumed: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/owner-claims/actions/consume')) consumed.push(request.url())
  })

  await page.goto(`${CLAIM_PATH}#${SECRET}`)
  const popupOpened = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await (await popupOpened).getByRole('button', { name: 'Continuer' }).click()

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Cette invitation a expiré. Demandez-nous un nouveau lien.',
    })
  ).toBeFocused()
  await expect(page.getByRole('button')).toHaveCount(0)
  expect(consumed).toEqual([])
})

test('claim/landing: without the invitation secret the entry stops before the app', async ({
  page,
}) => {
  await useScenario(page, ['claim.issued'])
  const api: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/')) api.push(request.url())
  })

  await page.goto(CLAIM_PATH)

  await expect(
    page.getByRole('heading', { level: 1, name: 'La suite de votre demande est indisponible' })
  ).toBeVisible()
  await expect(page.getByRole('button')).toHaveCount(0)
  expect(api).toEqual([])
})
