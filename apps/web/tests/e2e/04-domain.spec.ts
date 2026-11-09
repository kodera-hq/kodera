// The list of addresses, read-only — the first slice of docs/specs/04-domain.md,
// specified in docs/specs/domain-addresses-list.md, whose acceptance names these
// tests carry verbatim. None of the eleven tests named in 04-domain.md §12 is
// here: the one about the list is about the add action, which this slice does
// not draw.
//
// Given = `useScenario` plus navigation (`signIn`), When = user actions,
// Then = assertions on the rendered French (docs/dev/TESTING.md).
//
// No host name of ours is written in this file: the addresses provided with
// the instance are read from the same fixture the mocks answer with
// (`tests/unit/domain/hosting-boundary.test.ts` holds that rule).
/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { SUPPORT_EMAIL } from '../../src/app/supportContact'
import { LONG_HOST, mixedAddresses, providedHosts } from '../../src/mocks/fixtures/domainFixtures'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const SHELL = 'shell.single-organisation'
const AREA = 'Domaine & identité'
const UNAVAILABLE = `Le service est momentanément indisponible. Réessayez dans quelques minutes ; si cela persiste, écrivez-nous à ${SUPPORT_EMAIL}.`
const NONE_YET = "Aucune adresse à votre nom n'a encore été ajoutée."
// The query client tries a failed read three times before the screen says so.
const AFTER_RETRIES = { timeout: 20_000 }

const OWN_HOSTS = mixedAddresses().map((domain) => domain.fqdn)
const PROVIDED_HOSTS = providedHosts()

function main(page: Page): Locator {
  return page.getByRole('main')
}

function addressTable(page: Page): Locator {
  return page.getByRole('table', { name: 'Domaines' })
}

/** The first cell of every body row: the addresses, in the order they are read. */
async function listedHosts(page: Page): Promise<string[]> {
  return addressTable(page).getByRole('rowheader').allInnerTexts()
}

/** The cells of the row an address names, as the text a reader sees. */
async function rowOf(page: Page, host: string): Promise<string[]> {
  const row = addressTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: host, exact: true }) })
  await expect(row).toHaveCount(1)
  const cells = [
    await row.getByRole('rowheader').innerText(),
    ...(await row.getByRole('cell').allInnerTexts()),
  ]
  // A cell that stacks two facts (the application and what the address is
  // for, the state and its badge) reads as one line here.
  return cells.map((cell) => cell.split('\n').join(' · '))
}

/** Every domain read the page sends, recorded from before the first navigation. */
function recordDomainReads(page: Page): string[] {
  const reads: string[] = []
  page.on('request', (request) => {
    if (/\/tenants\/[^/]+\/domains(\?|$)/.test(request.url())) reads.push(request.url())
  })
  return reads
}

async function expectNothingToPress(page: Page): Promise<void> {
  await expect(main(page).getByRole('button')).toHaveCount(0)
  await expect(main(page).getByRole('link')).toHaveCount(0)
  await expect(main(page).getByRole('textbox')).toHaveCount(0)
  await expect(main(page).getByRole('tablist')).toHaveCount(0)
  await expect(page.getByText(/Ajouter une adresse|Gérer|Copier|Vérifier maintenant/)).toHaveCount(
    0
  )
}

test('domain/list: shows each address with its application and its state', async ({ page }) => {
  const reads = recordDomainReads(page)
  await useScenario(page, [SHELL, 'domain.mixed-addresses'])
  await signIn(page, ORG, '/domain')

  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(AREA)
  await expect(addressTable(page).getByRole('columnheader')).toHaveText([
    'Adresse',
    'Application',
    'État',
  ])
  await expect(
    addressTable(page).getByRole('rowheader', { name: 'visio.acme.fr', exact: true })
  ).toBeVisible()

  // The organisation's own addresses first, then the ones provided with its instance.
  expect(PROVIDED_HOSTS.length).toBeGreaterThanOrEqual(2)
  expect(await listedHosts(page)).toEqual([...OWN_HOSTS, ...PROVIDED_HOSTS])

  expect(await rowOf(page, 'visio.acme.fr')).toEqual([
    'visio.acme.fr',
    'Visio',
    'Vérifié · Principale',
  ])
  expect(await rowOf(page, 'livekit.visio.acme.fr')).toEqual([
    'livekit.visio.acme.fr',
    'Visio · Appels vidéo',
    'Vérifié',
  ])
  expect(await rowOf(page, 'docs.acme.fr')).toEqual([
    'docs.acme.fr',
    'Docs',
    'En attente de configuration',
  ])
  expect(await rowOf(page, 'reunions.acme.fr')).toEqual([
    'reunions.acme.fr',
    'Visio',
    'Vérification en cours',
  ])
  expect(await rowOf(page, 'visio.acme-travaux.fr')).toEqual([
    'visio.acme-travaux.fr',
    'Visio',
    'Échec',
  ])
  // A provided address is labelled, and carries no state the API did not report.
  for (const host of PROVIDED_HOSTS) {
    expect((await rowOf(page, host))[2]).toBe('Secours')
  }
  // One main address: the one the API flags.
  await expect(addressTable(page).getByText('Principale')).toHaveCount(1)

  // A long name is cut with an ellipsis inside its column, in monospace, never spilled.
  const longHost = addressTable(page).getByText(LONG_HOST)
  await expect(longHost).toHaveCSS('text-overflow', 'ellipsis')
  expect(await longHost.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  await expect(longHost).toHaveAttribute('title', LONG_HOST)
  expect(await longHost.evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Mono')

  // At this window (1280 px wide) the three columns fit: the table's box has nothing to scroll.
  const region = page.getByRole('region', { name: 'Domaines' })
  expect(page.viewportSize()?.width).toBe(1280)
  expect(await region.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0)

  // Read-only: nothing in the screen can be pressed, and no second tab is promised.
  await expectNothingToPress(page)
  await expect(page.getByText(/Connexion \(Google/)).toHaveCount(0)

  // One read of the addresses, a page of 50, and the list was complete.
  expect(reads).toHaveLength(1)
  expect(new URL(reads[0] as string).searchParams.get('limit')).toBe('50')

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('domain/list: shows the provided addresses alone when none has been added, without offering an action it cannot perform', async ({
  page,
}) => {
  await useScenario(page, [SHELL, 'domain.none'])
  await signIn(page, ORG, '/domain')

  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(AREA)
  await expect(page.getByText(NONE_YET)).toBeVisible()
  expect(await listedHosts(page)).toEqual(PROVIDED_HOSTS)
  for (const host of PROVIDED_HOSTS) {
    expect((await rowOf(page, host))[2]).toBe('Secours')
  }
  await expect(addressTable(page).getByText(/Vérifié|En attente|Échec|Principale/)).toHaveCount(0)

  await expectNothingToPress(page)
  // Not the invitation to do what the slice cannot do yet.
  await expect(page.getByText('Utilisez votre propre adresse')).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('domain/list: shows every address when the list arrives in several pages', async ({
  page,
}) => {
  const reads = recordDomainReads(page)
  await useScenario(page, [SHELL, 'domain.short-pages'])
  await signIn(page, ORG, '/domain')

  await expect(
    addressTable(page).getByRole('rowheader', { name: LONG_HOST, exact: true })
  ).toBeVisible()
  expect(await listedHosts(page)).toEqual([...OWN_HOSTS, ...PROVIDED_HOSTS])
  await expect(page.getByText(NONE_YET)).toHaveCount(0)

  // Three pages of two, each asked for with the cursor of the page before.
  expect(reads.map((url) => new URL(url).searchParams.get('cursor'))).toEqual([
    null,
    'offset-2',
    'offset-4',
  ])
  // Nothing to press to get the rest: it is all there.
  await expectNothingToPress(page)
})

test('domain/list: explains a failed load and recovers on retry', async ({ page }) => {
  // Two failed reads, each tried three times with the client's own back-off, then a third.
  test.setTimeout(120_000)
  const reads = recordDomainReads(page)
  await useScenario(page, [SHELL, 'domain.list-unavailable'])
  await signIn(page, ORG, '/domain')

  const alert = main(page).getByRole('alert')
  await expect(alert).toHaveText(UNAVAILABLE, AFTER_RETRIES)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AREA)
  await expect(page.getByRole('table')).toHaveCount(0)
  // Not the provided addresses alone, passed off as the list.
  await expect(page.getByText(PROVIDED_HOSTS[0] as string)).toHaveCount(0)
  // Plain words, never the status the API answered with.
  await expect(main(page).getByText(/\b500\b|internal/i)).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  // Still down: trying again asks the API again and, when that fails too, says so again.
  const retry = page.getByRole('button', { name: 'Réessayer' })
  const readsBeforeRetry = reads.length
  await retry.click()
  // The alert leaves while the new read is in flight. Waiting for that is what
  // makes the next line about the NEW failure, not the alert already on screen.
  await expect(alert).toHaveCount(0, AFTER_RETRIES)
  await expect(alert).toHaveText(UNAVAILABLE, AFTER_RETRIES)
  expect(reads.length).toBeGreaterThan(readsBeforeRetry)

  // The outage ends (`domain.list-unavailable` reads this key on every request).
  await page.evaluate(() => window.sessionStorage.setItem('msw:domain-outage', 'over'))
  await retry.click()

  await expect(
    addressTable(page).getByRole('rowheader', { name: 'visio.acme.fr', exact: true })
  ).toBeVisible()
  expect(await listedHosts(page)).toEqual([...OWN_HOSTS, ...PROVIDED_HOSTS])
  await expect(main(page).getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
})

test('domain/list: keeps the addresses readable when the connection drops', async ({
  page,
  context,
}) => {
  await useScenario(page, [SHELL, 'domain.mixed-addresses'])
  await signIn(page, ORG, '/domain')
  await expect(
    addressTable(page).getByRole('rowheader', { name: 'visio.acme.fr', exact: true })
  ).toBeVisible()
  const before = await listedHosts(page)

  await context.setOffline(true)

  // The shell says so; the list already loaded stays, with its states.
  await expect(page.getByText('Pas de connexion', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AREA)
  expect(await listedHosts(page)).toEqual(before)
  expect(await rowOf(page, 'visio.acme.fr')).toEqual([
    'visio.acme.fr',
    'Visio',
    'Vérifié · Principale',
  ])
  await expect(main(page).getByRole('alert')).toHaveCount(0)

  await context.setOffline(false)

  await expect(page.getByText('Pas de connexion', { exact: false })).toHaveCount(0)
  expect(await listedHosts(page)).toEqual(before)
  await expect(main(page).getByRole('alert')).toHaveCount(0)
})

test('domain/list: says when the organisation has no instance yet', async ({ page }) => {
  const reads = recordDomainReads(page)
  await useScenario(page, [SHELL, 'status.no-tenant', 'domain.mixed-addresses'])
  await signIn(page, ORG, '/domain')

  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(AREA)
  await expect(main(page).getByRole('heading', { name: "Pas encore d'instance" })).toBeVisible()
  await expect(
    page.getByText("Aucun espace n'est encore associé à votre organisation.")
  ).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expectNothingToPress(page)
  // With no instance there is no address to ask for.
  expect(reads).toEqual([])

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('domain/list: reaches the table with the keyboard alone', async ({ page }) => {
  await useScenario(page, [SHELL, 'domain.mixed-addresses'])
  await signIn(page, ORG, '/domain')
  await expect(
    addressTable(page).getByRole('rowheader', { name: 'visio.acme.fr', exact: true })
  ).toBeVisible()

  // Tab from wherever the shell left the focus: the table's own scroll box is a stop, named as
  // the table is, so a keyboard can scroll it wherever it does not fit.
  const region = page.getByRole('region', { name: 'Domaines' })
  for (let press = 0; press < 60; press += 1) {
    if (await region.evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(region).toBeFocused()

  // It is the only stop of the screen: the next Tab leaves `main`.
  await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => document.querySelector('main')?.contains(document.activeElement))
  ).toBe(false)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true })

  test('domain/list: stays usable on a phone, the table scrolling inside its own box', async ({
    page,
  }) => {
    await useScenario(page, [SHELL, 'domain.mixed-addresses'])
    await signIn(page, ORG, '/domain')

    // The narrow frame is the one drawn, and the screen is inside it.
    await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(AREA)
    await expect(
      addressTable(page).getByRole('rowheader', { name: 'visio.acme.fr', exact: true })
    ).toBeVisible()
    await page.evaluate(() => document.fonts.ready)

    const region = page.getByRole('region', { name: 'Domaines' })
    const faults = await page.evaluate(() => {
      const found: string[] = []
      const scroller = document.scrollingElement ?? document.documentElement
      const edge = scroller.clientWidth
      if (scroller.scrollWidth > edge) {
        found.push(`the page scrolls sideways (${scroller.scrollWidth} > ${edge})`)
      }
      for (const element of Array.from(document.body.querySelectorAll('*'))) {
        if (element.closest('.sr-only') !== null) continue
        // A table scrolls inside its own box by ruling; what is inside it is not judged.
        const box = element.parentElement?.closest('[role="region"]') ?? null
        if (box !== null && box.querySelector(':scope > table') !== null) continue
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        if (rect.right > edge + 1 || rect.left < -1) {
          found.push(
            `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}" reaches past the screen`
          )
        }
      }
      return found
    })
    expect(faults).toEqual([])

    // Three columns with a long address do not fit 390 px: the box holds them and scrolls to the
    // last one.
    expect(await region.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
    const lastColumn = addressTable(page).getByRole('columnheader', { name: 'État' })
    await expect(lastColumn).not.toBeInViewport()
    await region.evaluate((node) => {
      node.scrollLeft = node.scrollWidth
    })
    await expect(lastColumn).toBeInViewport()

    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
})

test('domain/list: keeps the list from a member and sends no domain request', async ({ page }) => {
  const reads = recordDomainReads(page)
  await useScenario(page, [SHELL, 'shell.member-role', 'domain.mixed-addresses'])
  await signIn(page, ORG, '/domain')

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AREA)
  await expect(
    page.getByText('Cette page est réservée aux administrateurs.', { exact: false })
  ).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByText('visio.acme.fr')).toHaveCount(0)
  // The first test of this file proves this recorder sees a domain read when one is sent.
  expect(reads).toEqual([])
})
