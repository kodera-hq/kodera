// The narrow layout (docs/specs/00-shell-and-login.md §4.5, "The narrow layout, as built"; §12
// tests 10–12), at the size the delivered mock draws its mobile frames, 390 × 780, and on phones
// held sideways. Every test here fails on the shell before this layout existed — there was no tab
// bar to find, and the rail and the sidebar left the page scrolling sideways on every journey
// screen.

import AxeBuilder from '@axe-core/playwright'
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

// The initials the account button shows, then its purpose (WCAG 2.5.3, label in name).
const ACCOUNT_BUTTON = /^[A-Z]{1,2} · Compte et organisation$/

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true })

const ORG = 'acme-sa'
const TAB_BAR = 'Navigation par onglets'

function tabBar(page: Page) {
  return page.getByRole('navigation', { name: TAB_BAR })
}

/**
 * Presses `key` until `target` has focus, the way a keyboard user gets there — never
 * `locator.focus()`, which reaches a control Tab cannot (`tabIndex={-1}`). Fails after `limit`
 * presses. `inside`, when given, must hold focus after every press (a sheet's focus trap).
 */
async function pressUntilFocused(
  page: Page,
  target: Locator,
  key: 'Tab' | 'Shift+Tab',
  limit = 60,
  inside?: Locator
): Promise<void> {
  for (let press = 0; press < limit; press += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return
    await page.keyboard.press(key)
    if (inside !== undefined) {
      expect(await inside.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
  }
  await expect(target).toBeFocused({ timeout: 1 })
}

test('shell/narrow: reaches every area from the tab bar and the Plus sheet with the keyboard', async ({
  page,
}) => {
  // Some forty key presses and seven route changes: under a loaded local run it outlasted 90 s.
  test.setTimeout(180_000)
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signIn(page, ORG)

  // Neither the rail nor the sidebar is drawn; the tab bar is its own named landmark.
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Modules' })).toHaveCount(0)
  await expect(tabBar(page)).toBeVisible()

  // The documented order from the top of the page: skip link, the top menu, then the tabs.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: ACCOUNT_BUTTON })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(tabBar(page).getByRole('link', { name: 'Accueil' })).toBeFocused()

  const tabs: ReadonlyArray<[string, RegExp, string]> = [
    ['Applications', /\/status$/, 'ACME'],
    ['Facturation', /\/invoices$/, 'Factures'],
    ['Aide', /\/help$/, 'Aide'],
    ['Accueil', /\/home$/, 'Bonjour'],
  ]
  for (const [name, url, heading] of tabs) {
    const tab = tabBar(page).getByRole('link', { name })
    // Wherever focus is — the tab bar or the page `h1` after a route change — the tab is
    // reached by Shift+Tab: the bar comes before `main` in the reading order.
    await pressUntilFocused(page, tab, 'Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading)
    // Current by more than colour: announced, heavier, and edged.
    await expect(tab).toHaveAttribute('aria-current', 'page')
    await expect(tab).toHaveCSS('font-weight', '600')
    await expect(tab).toHaveCSS('border-top-width', '2px')
  }

  const places: ReadonlyArray<[string, RegExp, string]> = [
    ['Personnes', /\/people$/, 'Personnes'],
    ['Domaine & identité', /\/domain$/, 'Domaine & identité'],
    ['Sécurité et connexion', /\/security$/, 'Sécurité et connexion'],
    ['Apparence', /\/appearance$/, 'Apparence'],
  ]
  const more = tabBar(page).getByRole('button', { name: 'Plus' })
  for (const [name, url, heading] of places) {
    await pressUntilFocused(page, more, 'Shift+Tab')
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'Plus' })
    await expect(sheet).toBeVisible()
    await expect
      .poll(() => sheet.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true)
    // Tab walks to the row and never leaves the sheet on the way.
    await pressUntilFocused(page, sheet.getByRole('link', { name }), 'Tab', 10, sheet)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(url)
    await expect(sheet).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    await expect(more).toHaveAttribute('aria-current', 'true')
  }

  // A full lap of Tab inside the sheet stays inside it, and Escape returns focus to « Plus ».
  await pressUntilFocused(page, more, 'Shift+Tab')
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Plus' })
  await expect(sheet).toBeVisible()
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('shell/narrow: reaches every area by tap and keeps the session in the top menu', async ({
  page,
}) => {
  await useScenario(page, ['shell.multi-organisation', 'home.default'])
  await signIn(page, ORG)

  await tabBar(page).getByRole('link', { name: 'Applications' }).tap()
  await expect(page).toHaveURL(/\/status$/)
  await tabBar(page).getByRole('link', { name: 'Facturation' }).tap()
  await expect(page).toHaveURL(/\/invoices$/)
  await tabBar(page).getByRole('link', { name: 'Aide' }).tap()
  await expect(page).toHaveURL(/\/help$/)
  await tabBar(page).getByRole('button', { name: 'Plus' }).tap()
  await page.getByRole('dialog', { name: 'Plus' }).getByRole('link', { name: 'Personnes' }).tap()
  await expect(page).toHaveURL(/\/people$/)
  await tabBar(page).getByRole('link', { name: 'Accueil' }).tap()
  await expect(page).toHaveURL(/\/home$/)

  // The top menu: the organisation (a real switcher with two memberships), the account, and
  // sign-out — and « Plus » repeats none of them.
  await page.getByRole('button', { name: ACCOUNT_BUTTON }).tap()
  const menu = page.getByRole('dialog', { name: 'Compte et organisation' })
  await expect(menu.getByRole('combobox', { name: 'Organisation' })).toBeVisible()
  await expect(menu.getByText('Administratrice / Administrateur')).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Se déconnecter' })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: ACCOUNT_BUTTON })).toBeFocused()

  await tabBar(page).getByRole('button', { name: 'Plus' }).tap()
  const sheet = page.getByRole('dialog', { name: 'Plus' })
  await expect(sheet.getByRole('link')).toHaveText([
    'Personnes',
    'Domaine & identité',
    'Sécurité et connexion',
    'Apparence',
  ])
  await expect(sheet.getByRole('button', { name: 'Se déconnecter' })).toHaveCount(0)
  await expect(sheet.getByRole('combobox')).toHaveCount(0)
})

test('shell/narrow: Sécurité et connexion opens the placeholder, never the enrolment guide', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signIn(page, ORG)
  await tabBar(page).getByRole('button', { name: 'Plus' }).tap()
  await page
    .getByRole('dialog', { name: 'Plus' })
    .getByRole('link', { name: 'Sécurité et connexion' })
    .tap()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/security$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sécurité et connexion')
  await expect(page.getByText("Cette page n'est pas encore disponible.")).toBeVisible()
  // Inside the shell, with its bars: this is a place, not the enrolment guide.
  await expect(tabBar(page)).toBeVisible()
  await expect(page.getByText(/authentification|appareil/i)).toHaveCount(0)

  // The wide layout's account menu opens the same page.
  await page.setViewportSize({ width: 1280, height: 800 })
  await tabBar(page).waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Accueil' }).first().click()
  await expect(page).toHaveURL(/\/home$/)
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: /Julie Marchand/ })
    .click()
  await page.getByRole('menuitem', { name: 'Sécurité et connexion' }).click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/security$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sécurité et connexion')
})

test('shell/narrow: a member gets four tabs and no management place', async ({ page }) => {
  await useScenario(page, ['shell.member-role', 'home.default'])
  await signIn(page, ORG)

  await expect(tabBar(page).getByRole('listitem')).toHaveCount(4)
  await expect(tabBar(page).getByRole('link', { name: 'Facturation' })).toHaveCount(0)
  await tabBar(page).getByRole('button', { name: 'Plus' }).tap()
  await expect(page.getByRole('dialog', { name: 'Plus' }).getByRole('link')).toHaveText([
    'Sécurité et connexion',
    'Apparence',
  ])
})

test('shell/narrow: the shell is clean under axe with the tab bar and the Plus sheet', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signIn(page, ORG)
  await expect(page.getByRole('heading', { level: 1, name: 'Bonjour Julie' })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await tabBar(page).getByRole('button', { name: 'Plus' }).tap()
  await expect(page.getByRole('dialog', { name: 'Plus' })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('shell/narrow: the wide layout comes back at 768 px', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signIn(page, ORG)
  await expect(tabBar(page)).toBeVisible()
  await page.setViewportSize({ width: 768, height: 900 })
  await expect(tabBar(page)).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible()
})

test('shell/narrow: a toast sits above the tab bar', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signIn(page, ORG, '/status')
  await page.getByRole('button', { name: 'Copier' }).first().tap()
  // The toast itself, in the notifications region — not the copy button's own live text.
  const toast = page
    .getByRole('region', { name: /Notifications/ })
    .locator('li')
    .filter({ hasText: /copié/i })
    .first()
  await expect(toast).toBeVisible()
  const toastBottom = await toast.evaluate((node) => node.getBoundingClientRect().bottom)
  const barTop = await tabBar(page).evaluate((node) => node.getBoundingClientRect().top)
  expect(toastBottom).toBeLessThanOrEqual(barTop)
})

// ---------------------------------------------------------------------------------------------
// Every journey screen. A table scrolls inside its own box (05-invoices.md §10, 08-home.md §10);
// nothing else may reach past the screen's edge or be cut off inside a clipping box, and every
// control is a 44 px target.

const SHELL = 'shell.single-organisation'

// `useScenario` is a Playwright helper, not a React hook; the hooks lint reads its name and
// refuses it in the loops below, so they call it under a name that says what it does.
const scenariosFor = useScenario

async function openOrderPlan(page: Page): Promise<void> {
  await page.goto(`/${ORG}/order`)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.waitForURL(/\/order\/[^/]+\/plan$/)
}

async function choosePlan(page: Page): Promise<void> {
  const headcount = page.getByLabel('Combien de personnes dans votre organisation ?')
  await headcount.fill('120')
  await headcount.blur()
  await expect(page.getByText(/Nous vous recommandons/)).toBeVisible()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/contacts$/)
}

async function fillContacts(page: Page): Promise<void> {
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
}

interface JourneyScreen {
  name: string
  /** The screen's own visible `h1` — an order step also carries the wizard's hidden one, and
   * a step that has not rendered yet must not be measured. */
  heading: string | RegExp
  scenarios: readonly string[]
  /** Drawn inside the shell, with its two bars. */
  shell: boolean
  open: (page: Page) => Promise<void>
}

const JOURNEY: readonly JourneyScreen[] = [
  {
    name: 'login',
    heading: 'Se connecter à votre console',
    scenarios: [],
    shell: false,
    open: (page) => page.goto('/login').then(() => undefined),
  },
  {
    name: 'login, two organisations',
    heading: /organisations/,
    scenarios: ['login.two-organisations'],
    shell: false,
    open: async (page) => {
      await page.goto('/login')
      await page.getByLabel('Adresse e-mail').fill('julie@acme.fr')
      await page.getByRole('button', { name: 'Continuer' }).click()
      await expect(page.getByRole('heading', { level: 1 })).toContainText('organisations')
    },
  },
  {
    name: 'mfa',
    heading: 'Sécurisez votre compte',
    scenarios: [SHELL, 'shell.mfa-not-enrolled'],
    shell: false,
    open: async (page) => {
      await page.goto(`/${ORG}/home`)
      await page.getByRole('button', { name: 'Continuer' }).click()
      await page.waitForURL(/\/security\/mfa$/)
    },
  },
  {
    name: 'home',
    heading: /Bonjour/,
    scenarios: [SHELL, 'home.default'],
    shell: true,
    open: (page) => signIn(page, ORG),
  },
  {
    name: 'home, incident banner',
    heading: /Bonjour/,
    scenarios: [SHELL, 'home.incident'],
    shell: true,
    open: (page) => signIn(page, ORG),
  },
  {
    name: 'applications',
    heading: 'ACME SAS',
    scenarios: [SHELL, 'status.live-healthy'],
    shell: true,
    open: (page) => signIn(page, ORG, '/status'),
  },
  {
    name: 'applications, provisioning',
    heading: /installation/,
    scenarios: [SHELL, 'status.provisioning-in-progress'],
    shell: true,
    open: (page) => signIn(page, ORG, '/status'),
  },
  {
    name: 'invoices',
    heading: 'Factures',
    scenarios: [SHELL, 'invoices.owner-role', 'invoices.overdue'],
    shell: true,
    open: (page) => signIn(page, ORG, '/invoices'),
  },
  {
    name: 'invoice detail',
    heading: /Facture INV/,
    scenarios: [SHELL, 'invoices.owner-role', 'invoices.reverse-charge'],
    shell: true,
    open: (page) => signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'),
  },
  {
    name: 'subscription',
    heading: 'Votre formule',
    scenarios: [SHELL, 'invoices.owner-role'],
    shell: true,
    open: (page) => signIn(page, ORG, '/invoices/subscription'),
  },
  {
    name: 'aide',
    heading: 'Aide',
    scenarios: [SHELL, 'home.default'],
    shell: true,
    open: (page) => signIn(page, ORG, '/help'),
  },
  {
    name: 'order, plan',
    heading: 'Choisissez votre formule',
    scenarios: [SHELL, 'order.catalogue-default'],
    shell: true,
    open: openOrderPlan,
  },
  {
    name: 'order, contacts',
    heading: 'Votre organisation',
    scenarios: [SHELL, 'order.catalogue-default'],
    shell: true,
    open: async (page) => {
      await openOrderPlan(page)
      await choosePlan(page)
    },
  },
  {
    name: 'order, agreements',
    heading: 'Documents à accepter',
    scenarios: [SHELL, 'order.catalogue-default'],
    shell: true,
    open: async (page) => {
      await openOrderPlan(page)
      await choosePlan(page)
      await fillContacts(page)
    },
  },
  {
    name: 'order, quote',
    heading: 'Parlons de votre projet',
    scenarios: [SHELL, 'order.catalogue-default'],
    shell: true,
    open: async (page) => {
      await openOrderPlan(page)
      await page.getByRole('link', { name: /Parlons-en/ }).click()
      await page.waitForURL(/\/quote$/)
    },
  },
]

/**
 * Opens each journey screen in a fresh context of the given size — each one signs in from
 * nothing, as a person would — runs `check` on it, and proves every screen was reached: a loop
 * that stopped early, or a list that lost its rows, would otherwise pass on what it did not see.
 */
async function everyJourneyScreen(
  browser: Browser,
  testInfo: TestInfo,
  size: { width: number; height: number },
  screens: readonly JourneyScreen[],
  check: (page: Page, screen: JourneyScreen) => Promise<string[]>
): Promise<void> {
  const failures: string[] = []
  const measured: string[] = []
  for (const screen of screens) {
    const context = await browser.newContext({
      ...(testInfo.project.use.baseURL === undefined
        ? {}
        : { baseURL: testInfo.project.use.baseURL }),
      viewport: size,
      hasTouch: true,
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    })
    const page = await context.newPage()
    await scenariosFor(page, screen.scenarios)
    await screen.open(page)
    // The screen's own h1, in the DOM and not a skeleton's; its visibility is not asked, since a
    // layout that pushes it out of view is exactly what the checks report.
    await expect(page.getByRole('heading', { level: 1, name: screen.heading })).toBeAttached()
    await page.evaluate(() => document.fonts.ready)
    // The narrow layout is what is being judged: at a phone's size it must be the one drawn.
    if (screen.shell) await expect(tabBar(page)).toBeVisible()
    for (const failure of await check(page, screen)) failures.push(`${screen.name}: ${failure}`)
    measured.push(screen.name)
    await context.close()
  }
  expect(measured).toEqual(screens.map((screen) => screen.name))
  expect(failures).toEqual([])
}

/**
 * What a phone must never show: the page scrolling sideways; an element reaching past the
 * screen's edge, unless it sits in a table's own scroll box (`Table`: a `role="region"` box
 * around a `<table>`, which specs 02, 05 and 08 ask to scroll inside itself); any other box
 * scrolling sideways inside itself, which is a page scrolling sideways under another name; and
 * a box that clips content sideways, unless it cuts text with an ellipsis on purpose. A
 * screen-reader-only label is 1 px and clipped by design, and is not judged; a text field
 * scrolls its own text and is not judged either.
 */
async function layoutFaults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const faults: string[] = []
    const scroller = document.scrollingElement ?? document.documentElement
    const edge = scroller.clientWidth
    if (scroller.scrollWidth > edge) {
      faults.push(`the page scrolls sideways (${scroller.scrollWidth} > ${edge})`)
    }
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}"`
    const isTableBox = (element: Element) =>
      element.matches('[role="region"]') && element.querySelector(':scope > table') !== null
    const isTextField = (element: Element) =>
      element.matches('input, textarea, select, [contenteditable="true"]')
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      if (element.closest('.sr-only') !== null) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      const inTableBox = element.parentElement?.closest('[role="region"]') ?? null
      const insideTable = inTableBox !== null && isTableBox(inTableBox)
      if (!insideTable && (box.right > edge + 1 || box.left < -1)) {
        faults.push(
          `${describe(element)} reaches past the screen (${Math.round(box.left)}–${Math.round(box.right)} of ${edge})`
        )
      }
      const overflowing = element.scrollWidth > element.clientWidth + 1
      if (!overflowing || isTableBox(element) || isTextField(element)) continue
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        faults.push(
          `${describe(element)} scrolls sideways inside itself (${element.scrollWidth} > ${element.clientWidth})`
        )
      }
      const clips = style.overflowX === 'hidden' || style.overflowX === 'clip'
      if (clips && style.textOverflow !== 'ellipsis') {
        faults.push(
          `${describe(element)} cuts off its content (${element.scrollWidth} > ${element.clientWidth})`
        )
      }
    }
    return faults
  })
}

/**
 * Every visible control under 44 px. A link inside running text is exempt (WCAG 2.5.8's inline
 * exception); a checkbox or a radio is judged by its row, which its label makes tappable too.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"]'
    const found: string[] = []
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (element.closest('.sr-only') !== null || element.classList.contains('sr-only')) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden') continue
      if (element.tagName === 'A' && style.display === 'inline') continue
      // A native control Radix keeps for forms, visually hidden behind its own button.
      if (element.getAttribute('aria-hidden') === 'true') continue
      const role = element.getAttribute('role')
      const judged =
        role === 'checkbox' || role === 'radio' ? (element.parentElement ?? element) : element
      const box = judged.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (box.height < 44 || box.width < 44) {
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim()
        found.push(
          `${element.tagName} "${name.slice(0, 40)}" ${Math.round(box.width)}×${Math.round(box.height)}`
        )
      }
    }
    return found
  })
}

async function layoutAndTargets(page: Page): Promise<string[]> {
  return [...(await layoutFaults(page)), ...(await smallTargets(page))]
}

test('shell/narrow: no journey screen scrolls sideways at 390 px', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  await everyJourneyScreen(
    browser,
    testInfo,
    { width: 390, height: 780 },
    JOURNEY,
    layoutAndTargets
  )
})

test('shell/narrow: no journey screen scrolls sideways at 320 px', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  await everyJourneyScreen(
    browser,
    testInfo,
    { width: 320, height: 640 },
    JOURNEY,
    layoutAndTargets
  )
})

test('shell/narrow: no journey screen scrolls sideways on a phone held sideways, 844 px', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  await everyJourneyScreen(
    browser,
    testInfo,
    { width: 844, height: 390 },
    JOURNEY,
    layoutAndTargets
  )
})

test('shell/narrow: no journey screen scrolls sideways on a phone held sideways, 932 px', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  await everyJourneyScreen(
    browser,
    testInfo,
    { width: 932, height: 430 },
    JOURNEY,
    layoutAndTargets
  )
})

/**
 * WCAG 2.4.11: Tab through the screen and judge every stop against the space between the top bar
 * and the tab bar. `whole`: the focused control is entirely in that space. `seen`: it is not
 * entirely hidden — the criterion's minimum, and all that can be promised everywhere: a text area
 * scrolls to its caret, not to its own edge, and in landscape a few controls (the agreements
 * table, a plan card) are taller than the space between the bars. The bars' own controls are
 * judged as themselves, and reaching one must not scroll the page; the skip link is drawn above
 * both bars on purpose.
 */
async function focusHiddenByBars(page: Page, rule: 'whole' | 'seen'): Promise<string[]> {
  const hidden: string[] = []
  const seen = new Set<string>()
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate((rule) => {
      const element = document.activeElement
      if (element === null || element === document.body) return null
      // Each stop gets its own mark, so two empty fields at the same place are two stops and
      // coming back to the first one is how the walk knows it has gone round.
      if (!(element instanceof HTMLElement)) return null
      const marks = window as unknown as { focusStops?: number }
      element.dataset.focusStop ??= String((marks.focusStops = (marks.focusStops ?? 0) + 1))
      const bar = document.querySelector('header')
      const tabs = document.querySelector('nav[aria-label="Navigation par onglets"]')
      if (bar === null || tabs === null) return { key: 'no bars', hidden: 'the bars are missing' }
      const box = element.getBoundingClientRect()
      const key = element.dataset.focusStop
      if (bar.contains(element) || tabs.contains(element)) {
        // A bar's own control is always in view; reaching it must not move the page.
        const marks = window as unknown as { lastScrollY?: number }
        const moved = marks.lastScrollY !== undefined && window.scrollY !== marks.lastScrollY
        marks.lastScrollY = window.scrollY
        return {
          key,
          hidden: moved
            ? `reaching "${(element.textContent ?? '').trim().slice(0, 30)}" in a bar scrolled the page`
            : null,
        }
      }
      ;(window as unknown as { lastScrollY?: number }).lastScrollY = window.scrollY
      if (element.getAttribute('href') === '#main-content') return { key, hidden: null }
      const top = bar.getBoundingClientRect().bottom
      const bottom = tabs.getBoundingClientRect().top
      const whole = box.top >= top - 0.5 && box.bottom <= bottom + 0.5
      const seen = box.bottom > top + 0.5 && box.top < bottom - 0.5
      return {
        key,
        hidden: (rule === 'whole' ? whole : seen)
          ? null
          : `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}" at ${Math.round(box.top)}–${Math.round(box.bottom)}, bars end at ${Math.round(top)} and start at ${Math.round(bottom)}`,
      }
    }, rule)
    if (stop === null) continue
    if (seen.has(stop.key)) break
    seen.add(stop.key)
    if (stop.hidden !== null) hidden.push(stop.hidden)
  }
  if (seen.size < 5) hidden.push(`only ${seen.size} focus stops were reached`)
  return hidden
}

test('shell/narrow: no control reached with Tab hides under a bar', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  await everyJourneyScreen(
    browser,
    testInfo,
    { width: 390, height: 780 },
    JOURNEY.filter((screen) => screen.shell),
    (page) => focusHiddenByBars(page, 'whole')
  )
})

for (const size of [
  { width: 320, height: 640 },
  { width: 667, height: 375 },
  { width: 844, height: 390 },
]) {
  test(`shell/narrow: no control reached with Tab is entirely hidden by a bar at ${size.width} × ${size.height}`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000)
    await everyJourneyScreen(
      browser,
      testInfo,
      size,
      JOURNEY.filter((screen) => screen.shell),
      (page) => focusHiddenByBars(page, 'seen')
    )
  })
}
