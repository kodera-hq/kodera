// The ten acceptance tests of docs/specs/08-home.md §12, titled verbatim so
// the spec-test gate can match them. Given = `useScenario` plus the mock
// sign-in round trip, When = user actions, Then = assertions on the
// rendered French.

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { useScenario } from './support/useScenario'
import { signInToOrg } from './support/signIn'

const ORG = 'acme-sa'

test('home/overview: shows health, capacity and the next invoice in one screen', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)

  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'tout fonctionne' })).toBeVisible()

  // The capacity gauge: 62 of 100, from the overlay's own capacity block.
  await expect(page.getByRole('meter', { name: 'Capacité · maintenant' })).toHaveAttribute(
    'aria-valuenow',
    '62'
  )
  await expect(page.getByText('62 sur 100')).toBeVisible()

  // The next invoice: the overlay's own `total_excl_vat` (448800 minor
  // units) — matched loosely on whitespace, since French money typography
  // uses a narrow no-break space that a literal string would get wrong.
  await expect(page.getByText(/4\s488\s€/)).toBeVisible()

  // Applications: the base tenant-status example's one app, Visio, live.
  await expect(page.getByText('En ligne')).toBeVisible()
  await expect(page.getByRole('link', { name: /Ouvrir Visio/ })).toBeVisible()

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('home/overview: resends invitations that outlived their set-up link', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.pending-invitations'])
  await signInToOrg(page, ORG)

  await expect(page.getByText('4 invitations attendent depuis plus de 3 jours.')).toBeVisible()

  // One `POST /invitations/{id}/actions/resend` per invitation: the design's
  // bulk-resend endpoint does not exist (§6), so each of the four addresses
  // gets its own request, observed here rather than assumed.
  const resendRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/v1\/invitations\/.+\/actions\/resend$/.test(request.url())) {
      resendRequests.push(request.url())
    }
  })

  await page.getByRole('button', { name: 'Relancer' }).click()

  await expect(page.getByText('4 invitations renvoyées', { exact: true })).toBeVisible()
  await expect(page.getByText('4 invitations attendent depuis plus de 3 jours.')).not.toBeVisible()
  expect(resendRequests).toHaveLength(4)
})

test('home/overview: retries only the invitation that failed', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.default',
    'home.pending-invitations-partial',
  ])
  await signInToOrg(page, ORG)

  // The card first, the fake clock after: installed while Accueil is still loading, the fake
  // clock holds the page's own timers — the mock API schedules none — and the card can fail to
  // arrive within the test's time.
  await expect(page.getByRole('button', { name: 'Relancer' })).toBeVisible()
  await page.clock.install()
  await page.getByRole('button', { name: 'Relancer' }).click()

  // The successes (marc, paul, anne) are not re-listed; only the rate-limited
  // one (julie, index 1 of the overlay's fixture) is, with its countdown.
  await expect(page.getByText('julie@acme.fr')).toBeVisible()
  await expect(page.getByText('marc@acme.fr')).not.toBeVisible()
  await expect(page.getByText('Trop de tentatives. Réessayez dans 30 secondes.')).toBeVisible()
  // The count reflects only the failure — three of the original four
  // dropped out, none of them re-listed.
  await expect(page.getByText('1 invitation attend depuis plus de 3 jours.')).toBeVisible()

  // Retry is scoped to the failed subset: a second attempt targets only
  // julie's invitation.
  const secondAttempt: string[] = []
  page.on('request', (request) => {
    if (/\/api\/v1\/invitations\/.+\/actions\/resend$/.test(request.url())) {
      secondAttempt.push(request.url())
    }
  })
  await expect(page.getByRole('button', { name: 'Relancer' })).toBeDisabled()
  await page.clock.fastForward(31_000)
  await page.getByRole('button', { name: 'Relancer' }).click()
  await expect(page.getByText('Trop de tentatives. Réessayez dans 30 secondes.')).toBeVisible()
  expect(secondAttempt).toHaveLength(1)
  expect(secondAttempt[0]).toContain('4a6e2c1d-9b3f-4c7a-8e5d-000000000001')
})

test('home/overview: explains the capacity limit before offering an upgrade', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.capacity-92'])
  await signInToOrg(page, ORG)

  await expect(page.getByText('Proche de la limite')).toBeVisible()
  await expect(page.getByRole('meter', { name: 'Capacité · maintenant' })).toHaveAttribute(
    'aria-valuenow',
    '92'
  )
  // Reads as people out of people (§10's accessible sentence), and the
  // consequence is stated before the plans link.
  await expect(
    page.getByText('92 personnes en réunion en même temps sur 100 possibles.')
  ).toBeAttached()
  const consequence = page.getByText(/nouvelles connexions sont refusées/)
  const plansLink = page.getByRole('link', { name: 'Voir les formules' })
  await expect(consequence).toBeVisible()
  await expect(plansLink).toBeVisible()
})

test('home/overview: hides a figure it does not have instead of inventing one', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.capacity-null'])
  await signInToOrg(page, ORG)

  await expect(page.getByText('Bonjour Julie')).toBeVisible()
  await expect(page.getByRole('meter')).toHaveCount(0)
  await expect(page.getByText('Capacité · maintenant')).toHaveCount(0)
  await expect(page.getByText(/^0\s*%$/)).toHaveCount(0)
})

test('home/overview: keeps the page usable when one call fails', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.invitations-error'])
  await signInToOrg(page, ORG)

  // The three metric cards, the applications and the contract card all render.
  await expect(page.getByText('62 sur 100')).toBeVisible()
  await expect(page.getByText(/4\s488\s€/)).toBeVisible()
  await expect(page.getByText('Mesure en cours')).toBeVisible()
  await expect(page.getByText('En ligne')).toBeVisible()
  await expect(page.getByText('Votre contrat')).toBeVisible()

  // Only the invitations area reports its own problem, quietly.
  await expect(page.getByText("Les invitations en attente n'ont pas pu être lues.")).toBeVisible()
  await expect(page.getByRole('button', { name: 'Relancer' })).toHaveCount(0)

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('home/overview: shows the installation timeline instead of empty cards', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.provisioning'])
  await signInToOrg(page, ORG)

  await expect(
    page.getByRole('heading', { name: "Votre espace est en cours d'installation" })
  ).toBeVisible()
  await expect(
    page.getByText("Prêt sous un jour ouvré. Nous vous écrivons dès que c'est fait.")
  ).toBeVisible()

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

  // No dashboard card — the greeting, the metric cards and the applications
  // table this scenario would otherwise carry are all absent.
  await expect(page.getByText('Bonjour Julie')).toHaveCount(0)
  await expect(page.getByText('Capacité · maintenant')).toHaveCount(0)
  await expect(page.getByText('Prochaine facture')).toHaveCount(0)

  // Personnes and Aide stay reachable while the tenant is provisioning.
  await expect(page.getByRole('link', { name: 'Personnes', exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Aide', exact: true })
  ).toBeVisible()
  // No action that leads to a placeholder (owner ruling 2026-09-24); the one
  // the screen offers is support.
  await expect(page.getByRole('link', { name: 'Inviter des personnes' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Préparer votre domaine' })).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('link', { name: 'Nous écrire' })).toBeVisible()
})

test('home/overview: shows a member what their role allows and nothing else', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.member-role'])
  await signInToOrg(page, ORG)

  // Capacity and applications are visible.
  await expect(page.getByText('62 sur 100')).toBeVisible()
  await expect(page.getByText('En ligne')).toBeVisible()

  // The invoice card, the contract card and the invitations banner are absent.
  await expect(page.getByText(/4\s488\s€/)).toHaveCount(0)
  await expect(page.getByText('Votre contrat')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Relancer' })).toHaveCount(0)

  // No raw error anywhere on the page.
  await expect(page.getByText(/^[45]\d\d$/)).toHaveCount(0)
})

test('home/overview: tells a member who sets the organisation up, not how to order', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.no-tenant', 'home.member-role'])
  await signInToOrg(page, ORG)

  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(
    "Votre espace n'est pas encore prêt"
  )
  await expect(
    main.getByText(
      "Un propriétaire ou un administrateur de votre organisation doit d'abord le mettre en place."
    )
  ).toBeVisible()
  await expect(main.getByText(/commande/i)).toHaveCount(0)
  await expect(main.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

test('home/overview: reaches and copies an application address with the keyboard alone', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)

  const copyButton = page.getByRole('button', { name: 'Copier' })
  await expect(copyButton).toBeVisible()

  // Reached by real `Tab` presses from the top of the document — no
  // `.focus()` shortcut — so a control only a pointer could reach would
  // make this loop run out rather than pass.
  let reachedByKeyboard = false
  for (let presses = 0; presses < 60 && !reachedByKeyboard; presses += 1) {
    await page.keyboard.press('Tab')
    reachedByKeyboard = await copyButton.evaluate((el) => el === document.activeElement)
  }
  expect(reachedByKeyboard).toBe(true)
  await page.keyboard.press('Enter')

  await expect(page.getByText('Visio copié dans le presse-papiers.')).toBeAttached()
  await expect(page.getByRole('button', { name: 'Copié' })).toBeVisible()

  const openLink = page.getByRole('link', { name: /Ouvrir Visio/ })
  await expect(openLink).toHaveAttribute('target', '_blank')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await openLink.getAttribute('href')
  )
})

test('home/overview: freezes its figures with a timestamp when the connection drops', async ({
  page,
  context,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.pending-invitations'])
  await signInToOrg(page, ORG)

  await expect(page.getByText('62 sur 100')).toBeVisible()
  const resendButton = page.getByRole('button', { name: 'Relancer' })
  await expect(resendButton).toBeEnabled()

  await context.setOffline(true)

  // The resend action disables with the reason, and the already-rendered
  // figures stay on screen rather than disappearing.
  await expect(resendButton).toBeDisabled()
  await expect(page.getByText('Votre connexion à Internet est interrompue')).toBeVisible()
  await expect(page.getByText('62 sur 100')).toBeVisible()

  await context.setOffline(false)
  await expect(resendButton).toBeEnabled()
})

for (const failure of ['discovery', 'fallback'] as const) {
  test(`home recovery: ${failure} failure does not offer a fresh order`, async ({ page }) => {
    await useScenario(page, [
      'shell.single-organisation',
      'home.no-tenant',
      `home.${failure}-unavailable`,
    ])
    await signInToOrg(page, ORG)
    await expect(page.getByRole('alert')).toContainText('Impossible')
    await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
  })
}

test('home recovery: a real successful empty tenant response permits owner ordering', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.no-tenant', 'home.owner-role'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('home recovery: successful empty billing reads hide absent cards', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.cards-empty'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('link', { name: /Ouvrir Visio/ })).toBeVisible()
  await expect(page.getByText('Prochaine facture')).toHaveCount(0)
  await expect(page.getByText('Votre contrat')).toHaveCount(0)
  await expect(page.getByText(/La prochaine facture n'a pas pu/)).toHaveCount(0)
})

test('home recovery: card failures show bounded retry actions', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.cards-unavailable'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(3)
  await expect(page.getByRole('link', { name: /Ouvrir Visio/ })).toBeVisible()
})

test('home recovery: forbidden billing cards do not offer retries', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.billing-forbidden'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('link', { name: /Ouvrir Visio/ })).toBeVisible()
  await expect(page.getByText('Prochaine facture')).toHaveCount(0)
  await expect(page.getByText('Votre contrat')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
})

test('home recovery: provisional billing role sees plans without invitation management', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.default',
    'home.capacity-92',
    'home.billing-role',
  ])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('link', { name: 'Voir les formules' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Inviter des personnes' })).toHaveCount(0)
})

test('home recovery: maintenance does not promise initial provisioning', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.maintenance'])
  await signInToOrg(page, ORG)
  await expect(
    page.getByText('Une opération de maintenance est en cours sur votre espace.')
  ).toBeVisible()
  await expect(page.getByText(/Votre instance se prépare/)).toHaveCount(0)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('home recovery: denied clipboard access stays truthful and recoverable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Synthetic clipboard denial')
        },
      },
    })
  })
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)
  await page.getByRole('button', { name: 'Copier' }).click()
  await expect(
    page.getByText('Copie impossible. Sélectionnez l’adresse pour la copier.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copié' })).toHaveCount(0)
  await expect(page.getByText('https://visio.acme.fr', { exact: true })).toBeVisible()
})

test('home recovery: malformed successful tenant list does not authorize empty ordering', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.owner-role',
    'home.no-tenant',
    'home.fallback-malformed',
  ])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

test('home recovery: malformed successful summary does not authorize empty ordering', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.owner-role',
    'home.discovery-malformed',
  ])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

test('home recovery: a completed status without lifecycle is an error, not permanent loading', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default', 'home.status-malformed'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

async function enterHomeFromHelp(page: Page) {
  await page.goto('/')
  await page.goto(`/${ORG}/help`)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/help$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()
  await page.getByRole('link', { name: 'Accueil', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
}

async function expectHomeHeading(page: Page, title: string) {
  const heading = page.getByRole('main').getByRole('heading', { level: 1 })
  await expect(heading).toHaveCount(1)
  await expect(heading).toHaveText(title)
  await expect(heading).toBeFocused()
  await expect(heading).toHaveAttribute('tabindex', '-1')
  await expect(page.getByText('Page Accueil chargée.', { exact: true })).toHaveCount(1)
  await page.keyboard.press('Tab')
  await expect(heading).not.toBeFocused()
}

test('home/navigation: focuses an empty home after navigation', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.no-tenant', 'home.owner-role'])
  await enterHomeFromHelp(page)
  await expectHomeHeading(page, "Aucune instance pour l'instant")
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('home/navigation: focuses a home with failed summary discovery', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.no-tenant',
    'home.discovery-unavailable',
  ])
  await enterHomeFromHelp(page)
  await expectHomeHeading(page, 'État de votre espace')
  await expect(page.getByRole('alert')).toContainText('Impossible')
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

test('home/navigation: focuses a home with failed fallback discovery', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'home.no-tenant',
    'home.fallback-unavailable',
  ])
  await enterHomeFromHelp(page)
  await expectHomeHeading(page, 'État de votre espace')
  await expect(page.getByRole('alert')).toContainText('Impossible')
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Commander', exact: true })).toHaveCount(0)
})

// The first space in an element's text, as drawn: its width over the element's font size, with the
// page's word spacing and with `word-spacing: normal` set on the text's own element. Plus Jakarta
// Sans's space is narrow (0.178 em), and a negative tracking took more off it, so « Bonjour Julie »
// read as one word (docs/specs/icon-only-controls.md, second slice).
async function spaceWidthEm(
  page: Page,
  name: string,
  role: 'heading' | 'link'
): Promise<{ drawn: number; unspaced: number }> {
  return page.getByRole(role, { name }).evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node
      const at = text.textContent?.indexOf(' ') ?? -1
      if (at < 0) continue
      const host = text.parentElement ?? (el as HTMLElement)
      const size = Number.parseFloat(getComputedStyle(host).fontSize)
      // From the end of the word before to the start of the word after: the space as the eye
      // sees it, with the tracking and word spacing applied to it (a range over the space alone
      // measures the glyph's own advance only).
      const gap = (): number => {
        const before = document.createRange()
        before.setStart(text, at - 1)
        before.setEnd(text, at)
        const after = document.createRange()
        after.setStart(text, at + 1)
        after.setEnd(text, at + 2)
        return (after.getBoundingClientRect().left - before.getBoundingClientRect().right) / size
      }
      const drawn = gap()
      const previous = host.style.wordSpacing
      host.style.wordSpacing = 'normal'
      const unspaced = gap()
      host.style.wordSpacing = previous
      return { drawn, unspaced }
    }
    return { drawn: Number.NaN, unspaced: Number.NaN }
  })
}

test('home/overview: draws a visible space between words in the title and in buttons', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  // The rule must add its own width, measured against the same text with `word-spacing: normal`,
  // so a font or rounding change on another renderer cannot pass it or fail it alone: 0.08 em with
  // a little room for rounding. And the drawn space must stay near a fifth of the type size: the
  // title measured 0.133 em before (4 px at 30 px), a 600-weight action 0.178 em.
  const title = await spaceWidthEm(page, 'Bonjour Julie', 'heading')
  const action = await spaceWidthEm(page, 'Voir les applications', 'link')
  expect(title.drawn - title.unspaced).toBeGreaterThanOrEqual(0.06)
  expect(action.drawn - action.unspaced).toBeGreaterThanOrEqual(0.06)
  expect(title.drawn).toBeGreaterThanOrEqual(0.19)
  expect(action.drawn).toBeGreaterThanOrEqual(0.2)
})
