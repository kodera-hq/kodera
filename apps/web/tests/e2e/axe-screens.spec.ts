// Accessibility scans for the screens that had none (docs/dev/TESTING.md §3:
// "one scan per flow, on the states a story cannot reach"). Each is reached
// with overlays that already exist; none asserts on behaviour, which the
// area's own spec owns. Like every spec, these run on a light device and on a
// dark one, so contrast is judged in both themes.
//
// No rule is switched off and nothing is excluded. A violation is reported as
// its rule and the nodes it names, so a failure says what to fix.
//
// Browser-evaluated callbacks need DOM types in the Node-side test project.
/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const SHELL = 'shell.single-organisation'

/** Rule ids and the nodes they name: what a failure should print. */
async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`)
  )
}

/** The shell paints before a screen's reads resolve: judge the screen. An
 * order step carries the wizard's heading above its own, hence `last()`. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).last()).toBeVisible()
}

// ── Billing ──────────────────────────────────────────────────────────────

test('invoices/detail: passes axe with an invoice open', async ({ page }) => {
  await useScenario(page, [SHELL, 'invoices.owner-role', 'invoices.reverse-charge'])
  await signIn(page, 'acme-sa', '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')
  await settled(page)
  // The invoice itself, not the screen's loading state.
  await expect(page.getByRole('table')).toBeVisible()

  expect(await violations(page)).toEqual([])
})

test('invoices/subscription: passes axe with the plan shown', async ({ page }) => {
  await useScenario(page, [SHELL, 'invoices.owner-role'])
  await signIn(page, 'acme-sa', '/invoices/subscription')
  await expect(page.getByRole('heading', { level: 1, name: 'Votre formule' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Changer de formule' })).toBeVisible()

  expect(await violations(page)).toEqual([])
})

// ── Order: the steps after the plan ──────────────────────────────────────

const ORDER = [SHELL, 'order.catalogue-default']

async function openOrderPlan(page: Page): Promise<void> {
  await page.goto('/acme-sa/order')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.waitForURL(/\/acme-sa\/order\/[^/]+\/plan$/)
}

async function openOrderContacts(page: Page): Promise<void> {
  await openOrderPlan(page)
  const headcount = page.getByLabel('Combien de personnes dans votre organisation ?')
  await headcount.fill('120')
  await headcount.blur()
  await expect(page.getByText(/Nous vous recommandons/)).toBeVisible()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/contacts$/)
}

test('order/contacts: passes axe on the empty form and on its errors', async ({ page }) => {
  await useScenario(page, ORDER)
  await openOrderContacts(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Votre organisation' })).toBeVisible()

  expect(await violations(page)).toEqual([])

  // A form mid-error is a state no story reaches (TESTING.md §3).
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page.getByRole('alert').first()).toBeVisible()

  expect(await violations(page)).toEqual([])
})

test('order/agreements: passes axe with the documents listed', async ({ page }) => {
  await useScenario(page, ORDER)
  await openOrderContacts(page)
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
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/agreements$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Documents à accepter' })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()

  expect(await violations(page)).toEqual([])
})

test('order/quote: passes axe on the request form', async ({ page }) => {
  await useScenario(page, ORDER)
  await openOrderPlan(page)
  await page.getByRole('link', { name: /Parlons-en/ }).click()
  await page.waitForURL(/\/quote$/)
  await settled(page)

  expect(await violations(page)).toEqual([])
})

// ── Placeholder pages, for a role that may open them ─────────────────────
//
// `shell/access` (00-shell-and-login.spec.ts) scans the refusal a member gets;
// these are the pages themselves, as the organisation's owner.

async function expectPlaceholderClean(page: Page, path: string, title: string): Promise<void> {
  await signIn(page, 'acme-sa', path)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByText('Cette page est réservée aux administrateurs.')).toHaveCount(0)

  expect(await violations(page)).toEqual([])
}

test('shell/placeholder: the People page passes axe for an owner', async ({ page }) => {
  await useScenario(page, [SHELL])
  await expectPlaceholderClean(page, '/people', 'Personnes')
})

test('shell/placeholder: the Domain page passes axe for an owner', async ({ page }) => {
  await useScenario(page, [SHELL])
  await expectPlaceholderClean(page, '/domain', 'Domaine & identité')
})

test('shell/placeholder: the Federation page passes axe for an owner', async ({ page }) => {
  await useScenario(page, [SHELL])
  await signIn(page, 'acme-sa', '/federation')
  await settled(page)
  await expect(page.getByText('Cette page est réservée aux administrateurs.')).toHaveCount(0)

  expect(await violations(page)).toEqual([])
})

test('shell/security: the security page passes axe', async ({ page }) => {
  await useScenario(page, [SHELL])
  await expectPlaceholderClean(page, '/security', 'Sécurité et connexion')
})

// ── Outside the shell ────────────────────────────────────────────────────

test('shell/not-found: the unknown-organisation page passes axe', async ({ page }) => {
  await useScenario(page, [SHELL])
  // Signed in, but to no organisation of that name.
  await signIn(page, 'nowhere', '/home')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Organisation introuvable' })
  ).toBeVisible()

  expect(await violations(page)).toEqual([])
})
