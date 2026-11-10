// docs/specs/06-support.md §12 — the interim Aide page's acceptance tests
// (§4.0), titled verbatim. The ticket form's own tests (1–10) wait for the
// ticket write path to be served.
//
// The first test is the proof SI-04 and SH-05 asked for: every support action
// the console renders, enumerated, each opened from its own screen in its own
// state, must land on the Aide page and never on the placeholder. A new
// support action joins this table; `src/features/support/help-links.test.ts`
// fails until the source and this table agree on which files carry one.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const INVOICE = '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'

interface SupportAction {
  /** Where the action is and what it says, for the step's name. */
  name: string
  scenarios: readonly string[]
  path: string
  press: (page: Page) => Promise<void>
  /** The subject the Aide page repeats from the context the action carried;
   * absent where the action carries none and the page asks for the page. */
  topic?: string
}

const SUPPORT_ACTIONS: readonly SupportAction[] = [
  {
    name: 'desktop header « Aide »',
    scenarios: ['shell.single-organisation', 'home.default'],
    path: '/home',
    press: (page) =>
      page
        .getByRole('banner', { name: 'En-tête de la page' })
        .getByRole('link', { name: 'Aide', exact: true })
        .click(),
  },
  {
    name: 'sidebar « Aide »',
    scenarios: ['shell.single-organisation', 'home.default'],
    path: '/home',
    press: (page) =>
      page.getByRole('navigation').getByRole('link', { name: 'Aide', exact: true }).click(),
  },
  {
    name: 'home support card « Écrire au support »',
    scenarios: ['shell.single-organisation', 'home.default'],
    path: '/home',
    press: (page) => page.getByRole('link', { name: 'Écrire au support' }).click(),
  },
  {
    name: 'home capacity at its limit « Nous en parler »',
    topic: 'Capacité de votre formule',
    scenarios: ['shell.single-organisation', 'home.capacity-at-limit'],
    path: '/home',
    press: (page) => page.getByRole('link', { name: 'Nous en parler' }).click(),
  },
  {
    name: 'home, instance suspended « Écrire au support »',
    topic: 'Votre instance est suspendue',
    scenarios: ['shell.single-organisation', 'status.lifecycle-suspended'],
    path: '/home',
    press: (page) => page.getByRole('link', { name: 'Écrire au support' }).click(),
  },
  {
    name: 'home, provisioning « Nous écrire »',
    topic: 'Mise en service de votre instance',
    scenarios: ['shell.single-organisation', 'home.provisioning'],
    path: '/home',
    press: (page) => page.getByRole('main').getByRole('link', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, instance suspended « Nous écrire »',
    topic: 'Votre instance est suspendue',
    scenarios: ['shell.single-organisation', 'status.lifecycle-suspended'],
    path: '/status',
    press: (page) => page.getByRole('link', { name: 'Nous écrire' }).click(),
  },
  // A failed installation that still lists its steps also offers the failed
  // step's own button; no scenario serves that shape, so that one is proven
  // in `src/features/status/StatusScreen.support-targets.test.tsx`, and its
  // target is the provisioning step's, proven two rows below.
  {
    name: 'status, installation failed « Nous écrire »',
    topic: 'Une opération sur votre instance a échoué',
    scenarios: ['shell.single-organisation', 'status.lifecycle-failed'],
    path: '/status',
    press: (page) => page.getByRole('link', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, provisioning with a failed step « Nous écrire »',
    topic:
      'Une étape de la mise en service a échoué (référence 8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f)',
    scenarios: ['shell.single-organisation', 'status.provisioning-failed'],
    path: '/status',
    press: (page) => page.getByRole('button', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, provisioning running late « Nous écrire »',
    topic: 'Mise en service de votre instance',
    scenarios: ['shell.single-organisation', 'status.provisioning-stalled'],
    path: '/status',
    press: (page) => page.getByRole('button', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, provisioning, the persistent « Nous écrire » link',
    topic: 'Mise en service de votre instance',
    scenarios: ['shell.single-organisation', 'status.provisioning-in-progress'],
    path: '/status',
    press: (page) => page.getByRole('link', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, stale heartbeat « Nous écrire »',
    topic: 'Votre instance ne donne plus de nouvelles',
    scenarios: ['shell.single-organisation', 'status.heartbeat-stale'],
    path: '/status',
    press: (page) => page.getByRole('button', { name: 'Nous écrire' }).click(),
  },
  {
    name: 'status, incident drawer « Ouvrir un ticket »',
    topic: 'Incident en cours sur votre instance',
    scenarios: ['shell.single-organisation', 'status.calls-degraded'],
    path: '/status',
    press: async (page) => {
      await page.getByRole('button', { name: /Appels vidéo perturbé/ }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Ouvrir un ticket' }).click()
    },
  },
  {
    name: 'status, capacity at its limit « Nous en parler »',
    topic: 'Capacité de votre formule',
    scenarios: ['shell.single-organisation', 'status.capacity-at-limit'],
    path: '/status',
    press: (page) => page.getByRole('button', { name: 'Nous en parler' }).click(),
  },
  {
    name: 'invoices, dunning drawer « Nous écrire »',
    topic: 'Retard de paiement',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.suspension-imminent'],
    path: '/invoices',
    press: async (page) => {
      await page.getByRole('button', { name: 'Échéances de règlement' }).click()
      await page
        .getByRole('dialog', { name: 'Échéances de règlement' })
        .getByRole('button', { name: 'Nous écrire' })
        .click()
    },
  },
  {
    name: 'invoice detail « Un problème avec cette facture ? »',
    topic: 'Facture INV-2026-0142',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'],
    path: INVOICE,
    press: (page) => page.getByRole('link', { name: 'Un problème avec cette facture ?' }).click(),
  },
  {
    name: 'invoice detail, payment link failed « Nous écrire »',
    topic: 'Facture INV-2026-0142',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.payment-link-failed'],
    path: INVOICE,
    press: async (page) => {
      await page.getByRole('button', { name: 'Payer en ligne' }).click()
      await page.getByRole('link', { name: 'Nous écrire' }).click()
    },
  },
  {
    name: 'subscription « Changer de formule »',
    topic: 'Changement de formule',
    scenarios: ['shell.single-organisation', 'invoices.owner-role'],
    path: '/invoices/subscription',
    press: (page) => page.getByRole('link', { name: 'Changer de formule' }).click(),
  },
]

/**
 * Most support actions are plain links, so the browser loads the page anew and
 * the session is restored silently (docs/specs/oidc-reload-bootstrap.md). In
 * this suite the mock identity provider answers that silent request only once
 * its frame is confirmed, the same step `01-order.spec.ts`'s reload takes.
 */
async function settleOnHelp(page: Page): Promise<void> {
  await page.waitForURL(new RegExp(`/${ORG}/help(\\?|$)`))
  const heading = page.getByRole('heading', { level: 1, name: 'Aide' })
  await expect
    .poll(
      async () => {
        if ((await heading.count()) > 0) return true
        const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))
        await frame
          ?.getByRole('button', { name: 'Continuer' })
          .evaluate((button: HTMLButtonElement) => button.click(), undefined, { timeout: 1_000 })
          .catch(() => undefined)
        return false
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

async function expectHelpPage(page: Page, topic?: string): Promise<void> {
  await settleOnHelp(page)
  await expect(page).toHaveURL(new RegExp(`/${ORG}/help(\\?|$)`))
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()
  await expect(page.getByText(/Écrivez-nous à support@kodera\.io\./)).toBeVisible()
  await expect(page.getByText("Cette page n'est pas encore disponible.")).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('list')).toContainText(
    topic === undefined ? 'La page sur laquelle vous étiez' : `Le sujet : ${topic}`
  )
}

test('support/help: every support action lands on the Aide page', async ({ browser }, testInfo) => {
  test.setTimeout(SUPPORT_ACTIONS.length * 30_000)
  const { baseURL, locale, timezoneId } = testInfo.project.use
  for (const action of SUPPORT_ACTIONS) {
    await test.step(action.name, async () => {
      const context = await browser.newContext({ baseURL, locale, timezoneId })
      try {
        const page = await context.newPage()
        await useScenario(page, action.scenarios)
        await signIn(page, ORG, action.path)
        await action.press(page)
        await expectHelpPage(page, action.topic)
      } finally {
        await context.close()
      }
    })
  }
})

test('support/help: gives the address, what to include and the context the action carried', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'])
  await signIn(page, ORG, `/help?invoiceNumber=INV-2026-0142`)

  await expectHelpPage(page, 'Facture INV-2026-0142')
  await expect(page.getByRole('heading', { name: "Écrire à l'assistance" })).toBeVisible()
  const include = page.getByRole('main').getByRole('list')
  await expect(include).toContainText('Le nom de votre organisation : ACME SAS')
  await expect(include).toContainText('Le sujet : Facture INV-2026-0142')
  // An invoice is a question: the page asks for it, not for the time of a problem.
  await expect(include).toContainText('Votre question, en quelques mots')
  await expect(include).not.toContainText("L'heure")

  const write = page.getByRole('link', { name: 'Écrire un e-mail' })
  const href = (await write.getAttribute('href')) ?? ''
  expect(href.startsWith('mailto:support@kodera.io?')).toBe(true)
  const mail = new URLSearchParams(href.slice(href.indexOf('?') + 1))
  expect(mail.get('subject')).toBe('Facture INV-2026-0142 — ACME SAS')
  expect(mail.get('body')).toContain('Organisation : ACME SAS (acme-sa)')
  expect(mail.get('body')).toContain('Sujet : Facture INV-2026-0142')
  expect(mail.get('body')).toContain('Votre question :')
  expect(mail.get('body')).not.toContain('Heure du problème')

  // The address is copyable for a customer with no mail app.
  await expect(page.getByRole('button', { name: 'Copier' })).toBeVisible()

  await expect(page.getByRole('link', { name: "Voir l'état de votre instance" })).toHaveAttribute(
    'href',
    `/${ORG}/status`
  )
  await expect(page.getByRole('link', { name: 'Voir vos factures' })).toHaveAttribute(
    'href',
    `/${ORG}/invoices`
  )

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('support/help: states no response time, hours or phone number it cannot source', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'shell.member-role'])
  await signIn(page, ORG, '/help?reason=bogus&invoiceNumber=Appelez%20le%2001%2023%2045%2067%2089')

  await expectHelpPage(page)
  const main = page.getByRole('main')
  await expect(main).not.toContainText(/heures? ouvrées|du lundi au vendredi|\d{1,2} ?h ?[–-]/)
  await expect(main).not.toContainText(/téléphone|appelez|\+33|0\d( ?\d{2}){4}/i)
  // Nothing the query string carried was repeated: the malformed number and
  // the unknown reason were dropped, so the page asks for the page instead.
  await expect(main).toContainText('La page sur laquelle vous étiez')
  // A member has no invoices area, so the page does not offer one.
  await expect(page.getByRole('link', { name: 'Voir vos factures' })).toHaveCount(0)
})
