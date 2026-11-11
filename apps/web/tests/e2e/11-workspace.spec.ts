// The workspace (docs/specs/11-workspace.md §12) in a real browser, against the mock Core API:
// the starter workspace's channels, the keyboard path through them, the phone drawer, each setup
// state, the create action, and the area's absence from the navigation.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const SHELL = 'shell.single-organisation'

/** Every workspace page is reached by its address: the area is in no navigation yet. */
const openWorkspace = (page: Page) => signIn(page, ORG, '/workspace')

function channels(page: Page) {
  return page.getByRole('navigation', { name: 'Salons' })
}

/** Whether the page takes ⌘ K rather than Ctrl K. The console decides by the browser's user agent
 * (`isMac` in `ChannelSearch.tsx`), not by the machine running the suite: the projects use
 * `devices['Desktop Chrome']`, whose user agent names Windows on every host. */
function pageIsMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent))
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
}

test('workspace/channels: shows the starter categories and channels in the order received', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.ready'])
  await openWorkspace(page)

  const nav = channels(page)
  await expect(nav.getByText('ACME', { exact: false }).first()).toBeVisible()
  await expect(nav.locator('button[aria-expanded][aria-controls]')).toHaveText([
    'Général',
    'Équipe',
  ])
  await expect(nav.getByRole('link')).toHaveText(['#bienvenue', '#général'])
  // The starter audio channel is named, not a link; the contract's example has its room pending.
  // `.last()`: the « Équipe » category's own row contains this one too.
  await expect(nav.getByRole('listitem').filter({ hasText: 'détente' }).last()).toHaveText(
    'détente, Salon audioEn préparation'
  )

  await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'bienvenue' })).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByText('La messagerie n’est pas disponible pour votre organisation.')
  ).toBeVisible()
  // Its own surface: the rail, and none of the console's navigation.
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Personnes' })).toHaveCount(0)
  await expectAxeClean(page)
})

test('workspace/channels: opens a channel from the keyboard and moves focus to its heading', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.ready'])
  await openWorkspace(page)

  const category = channels(page).getByRole('button', { name: 'Général' })
  await category.focus()
  await page.keyboard.press('Enter')
  await expect(category).toHaveAttribute('aria-expanded', 'false')
  await expect(channels(page).getByRole('link')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(category).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Tab')
  await expect(channels(page).getByRole('link', { name: 'bienvenue' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(channels(page).getByRole('link', { name: 'général' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace/[0-9a-f-]+$`))
  const heading = page.getByRole('heading', { level: 1, name: 'général' })
  await expect(heading).toBeFocused()
  await expect(channels(page).getByRole('link', { name: 'général' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  // The screen stayed mounted: the category is still as the person left it.
  await expect(category).toHaveAttribute('aria-expanded', 'true')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('workspace/channels: opens the channels in a drawer on a phone', async ({ page }) => {
    await useScenario(page, [SHELL, 'workspace.ready'])
    await openWorkspace(page)

    await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()
    await page.getByRole('button', { name: 'Salons', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Salons' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('link', { name: 'général' }).click()

    await expect(drawer).toHaveCount(0)
    const heading = page.getByRole('heading', { level: 1, name: 'général' })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    // No console tab bar inside the workspace.
    await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace/[0-9a-f-]+$`))
  })

  test('workspace/navigation: leads back to the console from its tab bar on a phone', async ({
    page,
  }) => {
    await useScenario(page, [SHELL, 'workspace.ready'])
    await openWorkspace(page)
    await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()
    const tabs = page.getByRole('navigation', { name: 'Navigation par onglets' })
    await expect(tabs).toHaveCount(0)

    // The rail's places, as the workspace's own tab bar; the top bar keeps the maker's mark.
    const modules = page.getByRole('navigation', { name: 'Modules' })
    await expect(modules).toBeVisible()
    await expect(page.getByRole('banner').getByRole('link')).toHaveCount(0)
    await expect(modules.getByRole('link', { name: 'Messages', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // The tenant's Visio, opening in a new tab; Espace itself is « Messages », not an application.
    await expect(modules.getByRole('link')).toHaveText(['Accueil', 'Messages', 'Visio'])
    await expect(
      modules.getByRole('link', { name: 'Visio — Ouvre un nouvel onglet', exact: true })
    ).toHaveAttribute('target', '_blank')

    const back = modules.getByRole('link', { name: 'Accueil', exact: true })
    await expect(back).toBeVisible()
    // The workspace on a phone, its tab bar included, before leaving it.
    await expectAxeClean(page)
    // A touch target on a phone (README §3): 44 px at least each way.
    const box = await back.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
    await back.click()

    await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`))
    await expect(tabs).toBeVisible()
    await expectAxeClean(page)
  })
})

test('workspace/preparing: greys every channel under the banner while the tenant is prepared', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.tenant-preparing'])
  await openWorkspace(page)

  await expect(
    page.getByText('Votre espace se prépare. Vous pourrez y écrire dès qu’il sera prêt.')
  ).toBeVisible()
  const nav = channels(page)
  await expect(nav.getByRole('link')).toHaveCount(0)
  for (const name of ['bienvenue', 'général', 'détente'])
    await expect(nav.getByRole('listitem').filter({ hasText: name }).last()).toContainText(
      'En préparation'
    )
  await expect(
    page.getByRole('main').getByRole('button', { name: 'Ouvrir les messages' })
  ).toHaveCount(0)
  // This build has no matrix domain: outside preparation the pane would say messaging is not
  // available. Under the banner it says nothing more.
  await expect(
    page.getByText('La messagerie n’est pas disponible pour votre organisation.')
  ).toHaveCount(0)
  await expectAxeClean(page)
})

test('workspace/setup: says setup is in progress and offers no action', async ({ page }) => {
  await useScenario(page, [SHELL, 'workspace.setup-pending'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', { level: 1, name: 'Votre espace de travail est en préparation' })
  ).toBeVisible()
  await expect(
    page.getByText('Cette page se met à jour d’elle-même.', { exact: false })
  ).toBeVisible()
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  await expectAxeClean(page)
})

test('workspace/setup: tells the owner their ownership is being confirmed', async ({ page }) => {
  await useScenario(page, [SHELL, 'home.owner-role', 'workspace.awaiting-owner'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', { level: 1, name: 'Nous confirmons votre rôle de propriétaire' })
  ).toBeVisible()
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
})

test('workspace/setup: tells anyone but the owner that setup is under way', async ({ page }) => {
  await useScenario(page, [SHELL, 'shell.member-role', 'workspace.awaiting-owner'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', { level: 1, name: 'Votre espace de travail est en préparation' })
  ).toBeVisible()
  await expect(page.getByText('propriétaire', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
})

test("workspace/setup: says setup stopped and offers the team's help with a reference", async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.setup-failed'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'La préparation de votre espace de travail s’est arrêtée',
    })
  ).toBeVisible()
  await expect(page.getByText(/^Identifiant de la requête\s: [0-9a-f-]{36}$/)).toBeVisible()
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  await expectAxeClean(page)

  await page.getByRole('main').getByRole('link', { name: 'Nous écrire' }).click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/help\\?reason=step-failed$`))
})

test('workspace/setup: lets an owner create the starter workspace, then shows it', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.not-initialised'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', { level: 1, name: 'Votre espace de travail est prêt à être créé' })
  ).toBeVisible()
  await expectAxeClean(page)
  const initialise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/actions/initialise')
  )
  await page.getByRole('button', { name: 'Créer l’espace de travail' }).click()
  const sent = await initialise
  expect(sent.headers()['idempotency-key']).toMatch(/^[!-~]{16,255}$/)
  expect(sent.postData() ?? '').toBe('')

  await expect(channels(page).getByRole('link')).toHaveText(['#bienvenue', '#général'])
  await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()
})

test('workspace/setup: tells a member the workspace has not been created yet', async ({ page }) => {
  await useScenario(page, [SHELL, 'shell.member-role', 'workspace.member-not-created'])
  await openWorkspace(page)

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Votre espace de travail n’a pas encore été créé',
    })
  ).toBeVisible()
  await expect(
    page.getByText('Un propriétaire ou un administrateur de votre organisation peut le créer.')
  ).toBeVisible()
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
})

test('workspace/navigation: the rail leads to it, the console navigation does not', async ({
  page,
}) => {
  // The rail draws « Messages » only for a tenant that runs `messaging`; no pack on sale does.
  await useScenario(page, [SHELL, 'home.default', 'status.with-messaging', 'workspace.ready'])
  await signIn(page, ORG, '/home')

  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Espace de travail' })).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: 'Messages' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace`))
})

test('workspace/navigation: offers Messages to a member before the organisation has a tenant', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'home.no-tenant', 'home.member-role'])
  await signIn(page, ORG, '/home')

  const rail = page.getByRole('navigation', { name: 'Modules' })
  await expect(rail.getByRole('link', { name: 'Messages' })).toHaveAttribute(
    'href',
    `/${ORG}/workspace`
  )
  // A member has no settings to change: « Réglages » is not offered.
  await expect(rail.getByRole('link', { name: 'Réglages' })).toHaveCount(0)
})

test('workspace/navigation: no Messages in the rail for a tenant without messaging', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'home.default', 'status.live-healthy'])
  await signIn(page, ORG, '/home')

  const rail = page.getByRole('navigation', { name: 'Modules' })
  await expect(rail.getByRole('link', { name: /^Visio/ })).toBeVisible()
  await expect(rail.getByRole('link', { name: 'Messages' })).toHaveCount(0)
})

test('workspace/search: opens a channel from Ctrl K by its name', async ({ page }) => {
  await useScenario(page, [SHELL, 'workspace.ready'])
  await openWorkspace(page)
  await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()

  await page.keyboard.press((await pageIsMac(page)) ? 'Meta+k' : 'Control+k')
  const dialog = page.getByRole('dialog', { name: 'Commandes et navigation rapide' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('combobox', { name: 'Rechercher espaces, salons, documents et commandes' })
  ).toBeFocused()
  await page.keyboard.type('gén')
  await expect(dialog.getByRole('option', { name: /général/ })).toBeVisible()
  await expectAxeClean(page)
  await page.keyboard.press('Enter')

  await expect(dialog).toHaveCount(0)
  const heading = page.getByRole('heading', { level: 1, name: 'général' })
  await expect(heading).toBeFocused()
  await expect(channels(page).getByRole('link', { name: 'général' })).toHaveAttribute(
    'aria-current',
    'page'
  )
})

test('workspace/search: says when no channel has the name, and gives focus back on Escape', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'workspace.ready'])
  await openWorkspace(page)

  const search = channels(page).getByRole('button', { name: 'Rechercher' })
  await expect(search).toHaveAttribute(
    'aria-keyshortcuts',
    (await pageIsMac(page)) ? 'Meta+K' : 'Control+K'
  )
  await search.click()
  const dialog = page.getByRole('dialog', { name: 'Commandes et navigation rapide' })
  await page.keyboard.type('zzzzzzzzz')
  await expect(dialog.getByRole('status')).toHaveText(
    'Aucune destination ni commande ne correspond.'
  )
  await expect(dialog.getByRole('option')).toHaveCount(0)
  await expectAxeClean(page)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(search).toBeFocused()
})

test('workspace/navigation: switches organisation from the head of the channel column', async ({
  page,
}) => {
  await useScenario(page, ['shell.multi-organisation', 'workspace.ready'])
  await page.goto('/')
  await signIn(page, ORG, '/workspace')

  const header = channels(page).getByRole('button', {
    name: 'ACME Construction, changer d’organisation',
  })
  await header.click()
  await page.getByRole('menuitemradio', { name: /ACME Holding/ }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer' }).click()

  await expect(page).toHaveURL(/\/acme-holding\/workspace$/)
  await expect(channels(page).getByText('ACME Holding', { exact: true })).toBeVisible()
})
