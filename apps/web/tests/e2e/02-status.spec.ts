// The nine acceptance tests of docs/specs/02-status.md §12, plus the
// keyboard-only drawer test. Every scenario overlay this spec activates is
// named in §7 and defined under src/mocks/overlays/status.*.ts.

import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { useScenario } from './support/useScenario'
import { markReliability, registerReliability } from './support/reliabilityRecord'

registerReliability(test)

// The same mock sign-in round-trip `00-smoke.spec.ts` proves on its own —
// repeated here as a plain helper rather than a shared support file, since
// no other spec needs it yet.
async function signInAndGoTo(page: Page, path: string): Promise<void> {
  markReliability(page, 'entry')
  await page.goto(path)
  markReliability(page, 'authentication')
  await page.getByRole('button', { name: 'Continuer' }).click()
  markReliability(page, 'destination')
  await expect(page).toHaveURL(new RegExp(`${path}$`))
}

test('status/overview: shows readable provisioning progress without internal names', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'status.provisioning-in-progress'])
  await signInAndGoTo(page, '/acme-sa/status')

  await expect(
    page.getByRole('heading', { name: "Votre espace est en cours d'installation" })
  ).toBeVisible()
  await expect(page.getByText('Prêt sous un jour ouvré', { exact: false })).toBeVisible()

  for (const label of [
    'Commande enregistrée',
    'Serveur réservé à Paris',
    'Installation des applications',
    'Adresses et certificats',
    'Comptes et connexion',
    'Sauvegardes et surveillance',
  ]) {
    await expect(page.getByText(label)).toBeVisible()
  }

  const bodyText = await page.locator('body').innerText()
  for (const internalName of ['tofu', 'ansible', 'preflight', 'deploy']) {
    expect(bodyText.toLowerCase()).not.toContain(internalName)
  }

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('status/overview: shows the application addresses and copies one', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(baseURL!).origin,
  })
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signInAndGoTo(page, '/acme-sa/status')

  await expect(page.getByText('https://visio.acme.fr')).toBeVisible()
  await expect(page.getByText('https://docs.acme.fr')).toBeVisible()

  await page.getByRole('button', { name: 'Copier' }).first().click()
  await expect(page.getByText('Copié').first()).toBeVisible()

  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard).toBe('https://visio.acme.fr')
})

test('status/overview: explains the capacity limit before offering an upgrade', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'status.owner-role', 'status.capacity-92'])
  await signInAndGoTo(page, '/acme-sa/status')

  const meter = page.getByRole('meter')
  await expect(meter).toBeVisible()
  await expect(meter).toHaveAttribute('aria-valuenow', '46')

  await expect(page.getByText('Proche de la limite')).toBeVisible()
  await expect(
    page.getByText('Au-delà de 50 personnes en même temps, les nouvelles connexions sont refusées')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Voir les formules' })).toBeVisible()
})

test('status/overview: describes a calls outage by what the user cannot do', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.calls-degraded'])
  await signInAndGoTo(page, '/acme-sa/status')

  markReliability(page, 'primary')
  await expect(page.getByText('Appels vidéo perturbé').first()).toBeVisible()
  // Owner ruling 2026-09-24: this screen is the status source; it links to no
  // external status page.
  await expect(page.locator('a[href*="://status."]')).toHaveCount(0)

  markReliability(page, 'interaction')
  await page.getByRole('button', { name: /Appels vidéo perturbé/ }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()

  const terms = await drawer.getByRole('term').allInnerTexts()
  expect(terms).toEqual([...terms].sort())
  expect(terms.length).toBe(2)
})

test('status/overview: distinguishes a stale heartbeat from an outage', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.heartbeat-stale'])
  await signInAndGoTo(page, '/acme-sa/status')

  markReliability(page, 'primary')
  await expect(page.getByText("Nous ne recevons plus d'informations").first()).toBeVisible()
  await expect(page.getByText('Appels vidéo perturbé')).toHaveCount(0)

  markReliability(page, 'interaction')
  await page.getByRole('button', { name: 'Nous écrire' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/help\?reason=stale/)
})

test('status/overview: marks a failed step and opens support with the reference', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'status.provisioning-failed'])
  await signInAndGoTo(page, '/acme-sa/status')

  await expect(page.getByText('Échec')).toBeVisible()
  await expect(page.getByText('Terminé').first()).toBeVisible()

  await page.getByRole('button', { name: 'Nous écrire' }).click()
  await expect(page).toHaveURL(
    /\/acme-sa\/help\?reason=step-failed&job_id=8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f/
  )
})

test('status/overview: keeps the page usable when one card fails', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.components-error'])
  await signInAndGoTo(page, '/acme-sa/status')

  await expect(page.getByText('https://visio.acme.fr')).toBeVisible()
  await expect(page.getByRole('meter')).toBeVisible()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('status/overview: offers one action when there is no space yet', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.owner-role', 'status.no-tenant'])
  await signInAndGoTo(page, '/acme-sa/status')

  await expect(
    page.getByText("Aucun espace n'est encore associé à votre organisation.")
  ).toBeVisible()
  const actions = page.getByRole('link', { name: 'Commander' })
  await expect(actions).toHaveCount(1)
})

test('status/incident: opens and closes the detail with the keyboard alone', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.calls-degraded'])
  await signInAndGoTo(page, '/acme-sa/status')

  const trigger = page.getByRole('button', { name: /Appels vidéo perturbé/ })
  await trigger.focus()
  await page.keyboard.press('Enter')

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  // Focus enters the drawer and stays inside it — Radix moves it to the
  // panel's own content, not to the container `role="dialog"` sits on.
  await expect(drawer.locator(':focus')).toBeVisible()

  await page.keyboard.press('Tab')
  await expect(drawer.locator(':focus')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('status recovery: history returns focus to its opener', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signInAndGoTo(page, '/acme-sa/status')
  const trigger = page.getByRole('link', { name: 'Historique sur sept jours' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(trigger).toBeFocused()
})

for (const state of [
  'ready',
  'maintenance',
  'upgrading',
  'suspended',
  'decommissioning',
  'deleted',
  'failed',
]) {
  test(`status recovery: ${state} is not live service`, async ({ page }) => {
    await useScenario(page, ['shell.single-organisation', `status.lifecycle-${state}`])
    await signInAndGoTo(page, '/acme-sa/status')
    await expect(page.getByRole('heading', { name: 'État de votre espace' })).toBeVisible()
    await expect(page.getByText('Tout fonctionne')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
    await expect(page.getByRole('meter')).toHaveCount(0)
  })
}
for (const scenario of ['tenant-error', 'tenant-malformed', 'summary-malformed']) {
  test(`status recovery: ${scenario} remains recoverable`, async ({ page }) => {
    await useScenario(page, [
      'shell.single-organisation',
      'status.live-healthy',
      `status.${scenario}`,
    ])
    await signInAndGoTo(page, '/acme-sa/status')
    await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
  })
}
test('status recovery: members neither read subscriptions nor receive order actions', async ({
  page,
}) => {
  const reads: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/subscriptions')) reads.push(request.url())
  })
  await useScenario(page, ['shell.single-organisation', 'shell.member-role', 'status.capacity-92'])
  await signInAndGoTo(page, '/acme-sa/status')
  await expect(page.getByRole('meter')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Voir les formules' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Voir mes factures' })).toHaveCount(0)
  expect(reads).toEqual([])
})
test('status recovery: billing reads invoices through the invoice destination', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'shell.billing-role',
    'status.live-healthy',
  ])
  await signInAndGoTo(page, '/acme-sa/status')
  await page.getByRole('button', { name: 'Voir mes factures' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/invoices$/)
})
for (const scenario of ['subscription-empty', 'subscription-error', 'subscription-forbidden']) {
  test(`status recovery: ${scenario} preserves card truth`, async ({ page }) => {
    await useScenario(page, [
      'shell.single-organisation',
      'status.live-healthy',
      `status.${scenario}`,
    ])
    await signInAndGoTo(page, '/acme-sa/status')
    await expect(page.getByText('https://visio.acme.fr')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Votre formule' })).toHaveCount(0)
    if (scenario === 'subscription-error')
      await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
    else await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
  })
}

test('status recovery: failed polling keeps cached maintenance visible with retry', async ({
  page,
}) => {
  await page.clock.install()
  await useScenario(page, ['shell.single-organisation', 'status.closed-refresh-error'])
  await signInAndGoTo(page, '/acme-sa/status')
  await expect(
    page.getByText('Une opération de maintenance est en cours sur votre espace.')
  ).toBeVisible()
  await page.clock.runFor(30_000)
  await page.clock.runFor(5_000)
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(
    page.getByText('Une opération de maintenance est en cours sur votre espace.')
  ).toBeVisible()
})
