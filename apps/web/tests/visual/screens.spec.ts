// One baseline per launch view, of its first screen, in each theme. Pixels do not replace
// functional acceptance; they catch what no assertion names — a colour role, a spacing
// step, a font that failed to load. Placeholder screens get no baseline.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { THEME_STORAGE_KEY } from '../../src/theme/theme'
import type { ThemePreference } from '../../src/theme/theme'
import { signIn, signInToOrg } from '../e2e/support/signIn'
import { useScenario } from '../e2e/support/useScenario'
import {
  assertExactBaseline,
  BASELINE_DIR,
  capture,
  compareDecoded,
  decodePng,
  encodePng,
  matchBaseline,
  MAX_CORNER_AA_CHANNEL_DELTA,
  MAX_CORNER_AA_PIXELS,
} from './support/exactBaseline'
import { withWorkspaceVisualDiagnostic } from './support/workspaceVisualDiagnostic'

/** Home greets with the date: a baseline that moves with the calendar is not one. */
const NOW = new Date('2026-09-02T09:30:00+02:00')

interface View {
  name: string
  scenarios: readonly string[]
  open: (page: Page) => Promise<void>
}

const HOME: View = {
  name: 'home',
  scenarios: ['shell.single-organisation', 'home.default'],
  open: (page) => signInToOrg(page, 'acme-sa'),
}

// The list of addresses (docs/specs/domain-addresses-list.md). Its heading is drawn while the
// list still loads, so the view waits for an address: a baseline of the skeleton would be one.
const DOMAIN: View = {
  name: 'domain',
  scenarios: ['shell.single-organisation', 'home.default', 'domain.mixed-addresses'],
  open: async (page) => {
    await signIn(page, 'acme-sa', '/domain')
    await expect(page.getByRole('rowheader', { name: 'visio.acme.fr', exact: true })).toBeVisible()
  },
}

const VIEWS: readonly View[] = [
  {
    name: 'login',
    scenarios: [],
    open: async (page) => {
      await page.goto('/login')
    },
  },
  HOME,
  {
    name: 'status',
    scenarios: ['shell.single-organisation', 'status.live-healthy'],
    open: (page) => signIn(page, 'acme-sa', '/status'),
  },
  {
    name: 'invoices',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'],
    open: (page) => signIn(page, 'acme-sa', '/invoices'),
  },
  DOMAIN,
  {
    name: 'help',
    scenarios: ['shell.single-organisation', 'home.default'],
    open: (page) => signIn(page, 'acme-sa', '/help'),
  },
  {
    name: 'order',
    scenarios: ['shell.single-organisation', 'order.catalogue-default'],
    open: async (page) => {
      await page.goto('/acme-sa/order')
      await page.getByRole('button', { name: 'Continuer' }).click()
      await page.waitForURL(/\/acme-sa\/order\/[^/]+\/[^/]+$/)
    },
  },
]

/**
 * The CPU the renderer ran on, printed once per worker, so a failing run records the host CPU
 * alongside the screenshot diff.
 */
test.beforeAll(() => {
  console.log(`VISUAL_RENDERER_CPU ${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores)`)
})

/** The shell paints before a screen's queries resolve; judge the screen, not its skeleton. */
async function settle(page: Page): Promise<void> {
  // `last()`: an order step carries the wizard's visually hidden h1 above its own visible one.
  await expect(page.getByRole('heading', { level: 1 }).last()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

/** Chooses a theme for every page this test loads, as a person's stored choice does. */
async function chooseTheme(page: Page, theme: ThemePreference): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: THEME_STORAGE_KEY,
    value: theme,
  })
}

/** Contrast, names and roles in the theme on screen; axe knows nothing of the baseline. */
async function expectAxeClean(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
}

for (const view of VIEWS) {
  test(`visual/${view.name}: matches its baseline`, async ({ page }) => {
    await useScenario(page, view.scenarios)
    await view.open(page)
    await settle(page)
    if (view.name === 'order') await expectAxeClean(page)
    await matchBaseline(page, `${view.name}-light.png`, test.info())
  })
}

// The narrow layout (docs/specs/00-shell-and-login.md §4.5), at the mock's mobile size, one
// baseline per journey screen plus the two sheets the shell opens. The wide baselines above are
// the proof the desktop did not move; these are the phone's own. The order's confirmation step has
// none: while submission is held (01-order.md) no draft reaches it.

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

async function openOrderAgreements(page: Page): Promise<void> {
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
}

const SHELL = 'shell.single-organisation'

const NARROW_VIEWS: readonly View[] = [
  { name: 'login', scenarios: [], open: (page) => page.goto('/login').then(() => undefined) },
  {
    name: 'mfa',
    scenarios: [SHELL, 'shell.mfa-not-enrolled'],
    open: async (page) => {
      await page.goto('/acme-sa/home')
      await page.getByRole('button', { name: 'Continuer' }).click()
      await page.waitForURL(/\/security\/mfa$/)
    },
  },
  HOME,
  {
    name: 'status',
    scenarios: [SHELL, 'status.live-healthy'],
    open: (page) => signIn(page, 'acme-sa', '/status'),
  },
  {
    name: 'invoices',
    scenarios: [SHELL, 'invoices.owner-role', 'invoices.overdue'],
    open: (page) => signIn(page, 'acme-sa', '/invoices'),
  },
  {
    name: 'invoice-detail',
    scenarios: [SHELL, 'invoices.owner-role', 'invoices.reverse-charge'],
    open: (page) => signIn(page, 'acme-sa', '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'),
  },
  {
    name: 'subscription',
    scenarios: [SHELL, 'invoices.owner-role'],
    open: (page) => signIn(page, 'acme-sa', '/invoices/subscription'),
  },
  DOMAIN,
  {
    name: 'help',
    scenarios: [SHELL, 'home.default'],
    open: (page) => signIn(page, 'acme-sa', '/help'),
  },
  { name: 'order-plan', scenarios: [SHELL, 'order.catalogue-default'], open: openOrderPlan },
  {
    name: 'order-contacts',
    scenarios: [SHELL, 'order.catalogue-default'],
    open: openOrderContacts,
  },
  {
    name: 'order-agreements',
    scenarios: [SHELL, 'order.catalogue-default'],
    open: openOrderAgreements,
  },
  {
    name: 'order-quote',
    scenarios: [SHELL, 'order.catalogue-default'],
    open: async (page) => {
      await openOrderPlan(page)
      await page.getByRole('link', { name: /Parlons-en/ }).click()
      await page.waitForURL(/\/quote$/)
    },
  },
]

// The screens with a table, at a smaller desktop. The 1440 px baselines above draw every table
// without overflow; at 1024 px they overflow their box, which is where a change to the table's
// box once redrew every desktop table's text while the 1440 px baselines stayed green.
const TABLE_VIEWS: readonly View[] = [
  HOME,
  {
    name: 'invoices',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.overdue'],
    open: (page) => signIn(page, 'acme-sa', '/invoices'),
  },
  {
    name: 'invoice-detail',
    scenarios: ['shell.single-organisation', 'invoices.owner-role', 'invoices.reverse-charge'],
    open: (page) => signIn(page, 'acme-sa', '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'),
  },
  DOMAIN,
]

test.describe('wide, 1024 px', () => {
  test.use({ viewport: { width: 1024, height: 800 } })

  for (const view of TABLE_VIEWS) {
    test(`visual/${view.name}-1024: matches its baseline`, async ({ page }) => {
      await useScenario(page, view.scenarios)
      await view.open(page)
      await settle(page)
      await matchBaseline(page, `${view.name}-1024-light.png`, test.info())
    })
  }

  test('visual/mutation-invoice-1024: a repainted colour role breaks the invoice baseline', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed',
      'a mutated page must never be written as a baseline'
    )
    const view = TABLE_VIEWS.find(({ name }) => name === 'invoice-detail')!
    await useScenario(page, view.scenarios)
    await view.open(page)
    await settle(page)
    await matchBaseline(page, 'invoice-detail-1024-light.png', test.info())

    await page.addStyleTag({ content: ':root { --c-inverse: #2D3843 }' })
    const failure = await expect(page)
      .toHaveScreenshot('invoice-detail-1024-light.png')
      .then(
        () => undefined,
        (error: Error) => error.message
      )
    expect(failure).toMatch(/pixels \(ratio [\d.]+ of all image pixels\) are different/)
  })
})

test.describe('narrow', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  for (const view of NARROW_VIEWS) {
    test(`visual/${view.name}-mobile: matches its baseline`, async ({ page }) => {
      await useScenario(page, view.scenarios)
      await view.open(page)
      await settle(page)
      await matchBaseline(page, `${view.name}-mobile-light.png`, test.info())
    })
  }

  // The two sheets, opened from the keyboard so no pointer rests on a row and paints its hover.
  // The account button's name starts with the initials it shows (WCAG 2.5.3); its menu keeps
  // the plain title.
  for (const [name, control] of [
    ['shell-more-sheet', { button: 'Plus', dialog: 'Plus' }],
    [
      'shell-account-menu',
      { button: /^[A-Z]{1,2} · Compte et organisation$/, dialog: 'Compte et organisation' },
    ],
  ] as const) {
    test(`visual/${name}-mobile: matches its baseline`, async ({ page }) => {
      await useScenario(page, HOME.scenarios)
      await HOME.open(page)
      await settle(page)
      await page.getByRole('button', { name: control.button, exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog', { name: control.dialog, exact: true })).toBeVisible()
      await matchBaseline(page, `${name}-mobile-light.png`, test.info())
    })
  }
})

// A phone held sideways: a touch screen 390 px tall gets the narrow layout although it is
// 844 px wide (docs/specs/00-shell-and-login.md §4.5, owner ruling 2026-09-24).
test.describe('narrow, held sideways', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true })

  test('visual/home-landscape: matches its baseline', async ({ page }) => {
    await useScenario(page, HOME.scenarios)
    await HOME.open(page)
    await settle(page)
    await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toBeVisible()
    await matchBaseline(page, 'home-landscape-light.png', test.info())
  })
})

// The dark and black themes (docs/specs/10-appearance.md): every launch view at 1440 px, the
// Apparence page in all three themes, and two phone screens in dark. Each passes axe in its
// theme first — contrast is the defect a theme introduces — and must be the theme it claims:
// a boot script that stopped applying the choice would otherwise baseline a light page twice.
// The light baselines above are the proof that choosing nothing changed nothing.

const THEMES = ['dark', 'black'] as const

for (const theme of THEMES) {
  for (const view of VIEWS) {
    test(`visual/${view.name}-${theme}: passes axe and matches its baseline`, async ({ page }) => {
      await chooseTheme(page, theme)
      await useScenario(page, view.scenarios)
      await view.open(page)
      await settle(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expectAxeClean(page)
      await matchBaseline(page, `${view.name}-${theme}.png`, test.info())
    })
  }
}

const APPEARANCE: View = {
  name: 'appearance',
  scenarios: ['shell.single-organisation', 'home.default'],
  open: (page) => signIn(page, 'acme-sa', '/appearance'),
}

// In light, nothing is chosen: the page's default, « Automatique » checked on a light device.
// In dark and black, the card of that theme is the chosen one.
for (const theme of ['light', ...THEMES] as const) {
  test(`visual/appearance-${theme}: passes axe and matches its baseline`, async ({ page }) => {
    if (theme !== 'light') await chooseTheme(page, theme)
    await useScenario(page, APPEARANCE.scenarios)
    await APPEARANCE.open(page)
    await settle(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByRole('radio', { checked: true })).toHaveAccessibleName(
      { light: 'Automatique', dark: 'Sombre', black: 'Noir' }[theme]
    )
    await expectAxeClean(page)
    await matchBaseline(page, `appearance-${theme}.png`, test.info())
  })
}

test.describe('narrow, dark', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  for (const view of VIEWS.filter(({ name }) => name === 'home' || name === 'invoices')) {
    test(`visual/${view.name}-mobile-dark: passes axe and matches its baseline`, async ({
      page,
    }) => {
      await chooseTheme(page, 'dark')
      await useScenario(page, view.scenarios)
      await view.open(page)
      await settle(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expectAxeClean(page)
      await matchBaseline(page, `${view.name}-mobile-dark.png`, test.info())
    })
  }
})

// The workspace (docs/specs/11-workspace.md): the reference screens the owner reviews — the
// ready workspace at 1440 px and on a phone, and three of the states before it exists, in light;
// the ready workspace in dark and black below. Each passes axe before its pixels are compared.
const WORKSPACE_VIEWS: readonly View[] = [
  ['workspace', 'workspace.ready'],
  ['workspace-setup-pending', 'workspace.setup-pending'],
  ['workspace-setup-failed', 'workspace.setup-failed'],
  ['workspace-not-initialised', 'workspace.not-initialised'],
].map(([name, scenario]) => ({
  name: name!,
  // `home.default`: a healthy service, so no incident banner sits above the screen under review.
  scenarios: [SHELL, 'home.default', scenario!],
  open: (page: Page) => signIn(page, 'acme-sa', '/workspace'),
}))

for (const view of WORKSPACE_VIEWS) {
  test(`visual/${view.name}: passes axe and matches its baseline`, async ({ page }) => {
    await useScenario(page, view.scenarios)
    await view.open(page)
    await settle(page)
    await expectAxeClean(page)
    await matchBaseline(page, `${view.name}-light.png`, test.info())
  })
}

// The ready workspace in the two dark themes: the surface's own layout has to hold its roles in
// each, and passes axe in the theme on screen before its pixels are compared.
for (const theme of THEMES) {
  const view = WORKSPACE_VIEWS[0]!
  test(`visual/workspace-${theme}: passes axe and matches its baseline`, async ({ page }) => {
    await chooseTheme(page, theme)
    await useScenario(page, view.scenarios)
    await view.open(page)
    await settle(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expectAxeClean(page)
    await matchBaseline(page, `workspace-${theme}.png`, test.info())
  })
}

test.describe('narrow, workspace', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  const view = WORKSPACE_VIEWS[0]!
  test('visual/workspace-mobile: passes axe and matches its baseline', async ({
    page,
  }, testInfo) => {
    await useScenario(page, view.scenarios)
    await view.open(page)
    await settle(page)
    await expectAxeClean(page)
    await withWorkspaceVisualDiagnostic(page, testInfo, async () => {
      await matchBaseline(page, 'workspace-mobile-light.png', test.info())
    })
  })
})

// The suite's proof that it can fail. It passes the baseline first, so a sign-in
// that broke cannot pass for a caught mutation, then repaints one role by two
// levels per channel and must see a pixel difference, not merely any failure. A
// subtle repaint on purpose: a loud one also passes a gate too lax to see a real
// role shift, which is how the default threshold went unnoticed.
test('visual/mutation: a repainted colour role breaks the home baseline', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed',
    'a mutated page must never be written as a baseline'
  )
  await useScenario(page, HOME.scenarios)
  await HOME.open(page)
  await settle(page)
  await matchBaseline(page, 'home-light.png', test.info())

  await page.addStyleTag({ content: ':root { --c-inverse: #2D3843 }' })
  const failure = await expect(page)
    .toHaveScreenshot('home-light.png')
    .then(
      () => undefined,
      (error: Error) => error.message
    )
  expect(failure).toMatch(/pixels \(ratio [\d.]+ of all image pixels\) are different/)
})

// The same proof for the dark baselines, which the light mutation above cannot give: it
// repaints `:root`'s role, and a dark page reads `[data-theme='dark']`'s. Two levels per channel
// off the dark rail ground (`#0C1116`), injected after the tokens, so it wins at equal
// specificity.
test('visual/mutation-dark: a repainted dark colour role breaks the dark home baseline', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed',
    'a mutated page must never be written as a baseline'
  )
  await chooseTheme(page, 'dark')
  await useScenario(page, HOME.scenarios)
  await HOME.open(page)
  await settle(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await matchBaseline(page, 'home-dark.png', test.info())

  await page.addStyleTag({ content: "[data-theme='dark'] { --c-inverse: #0E1318 }" })
  const failure = await expect(page)
    .toHaveScreenshot('home-dark.png')
    .then(
      () => undefined,
      (error: Error) => error.message
    )
  expect(failure).toMatch(/pixels \(ratio [\d.]+ of all image pixels\) are different/)
})

// The exact comparison's own proof, on both the defect it exists for and its bounded corner-AA
// tolerance:
// 1. Up to `MAX_CORNER_AA_PIXELS` (24) pixels differing by at most `MAX_CORNER_AA_CHANNEL_DELTA`
//    (2) channel units pass without writing `-exact-actual.png`.
// 2. Any pixel with channel delta > 2, more than 24 differing pixels, a dimension mismatch, or the
//    home screen's « Écrire au support » 1 px edge drawn in `border-strong` (#C9D3DE) instead of
//    `border-input` (#7C8894, channel delta 77) fails `assertExactBaseline` and writes
//    `<name>-exact-actual.png`.
test('visual/mutation-exact: a 1 px edge in the wrong colour breaks the exact comparison', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed',
    'a mutated page must never be written as a baseline'
  )
  await useScenario(page, HOME.scenarios)
  await HOME.open(page)
  await settle(page)
  await matchBaseline(page, 'home-light.png', test.info())

  const baselineBytes = readFileSync(join(BASELINE_DIR, 'home-light.png'))
  const baseline = decodePng(baselineBytes)
  const cloneWithShifts = (shifts: readonly { pixel: number; delta: number }[]): Buffer => {
    const rgba = new Uint8Array(baseline.rgba)
    for (const { pixel, delta } of shifts) {
      const idx = pixel * 4
      const cur = rgba[idx]!
      rgba[idx] = cur >= delta ? cur - delta : cur + delta
    }
    return encodePng({ width: baseline.width, height: baseline.height, rgba })
  }

  // Invariant 1: 1-to-2 unit channel delta on <= 24 pixels PASSES and writes no actual file.
  const cornerToleranceBytes = cloneWithShifts(
    Array.from({ length: MAX_CORNER_AA_PIXELS }, (_, i) => ({
      pixel: i,
      delta: i % 2 === 0 ? 1 : MAX_CORNER_AA_CHANNEL_DELTA,
    }))
  )
  const passOutPath = testInfo.outputPath('probe-pass-exact-actual.png')
  const passResult = assertExactBaseline(
    cornerToleranceBytes,
    baselineBytes,
    'probe-pass.png',
    (f) => testInfo.outputPath(f)
  )
  expect(passResult).toEqual({
    sameSize: true,
    differingPixels: MAX_CORNER_AA_PIXELS,
    loudPixels: 0,
    maxChannelDelta: MAX_CORNER_AA_CHANNEL_DELTA,
    passes: true,
  })
  expect(existsSync(passOutPath)).toBe(false)

  // Invariant 2a: 1 pixel with channel delta > 2 FAILS and writes `<name>-exact-actual.png`.
  const expectRefusal = (actual: Buffer, name: string, pattern: RegExp) => {
    const actualOut = testInfo.outputPath(name.replace(/\.png$/, '-exact-actual.png'))
    rmSync(actualOut, { force: true })
    let message = ''
    try {
      assertExactBaseline(actual, baselineBytes, name, (f) => testInfo.outputPath(f))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(pattern)
    expect(existsSync(actualOut)).toBe(true)
    expect(readFileSync(actualOut).equals(actual)).toBe(true)
    rmSync(actualOut, { force: true })
  }

  expectRefusal(
    cloneWithShifts([{ pixel: 0, delta: MAX_CORNER_AA_CHANNEL_DELTA + 1 }]),
    'probe-loud.png',
    /1 pixel\(s\) differ \(max channel delta 3, 1 pixel\(s\) with channel delta > 2/
  )

  // Invariant 2b: > 24 pixels with 1-unit delta FAILS and writes `<name>-exact-actual.png`.
  expectRefusal(
    cloneWithShifts(
      Array.from({ length: MAX_CORNER_AA_PIXELS + 1 }, (_, i) => ({ pixel: i, delta: 1 }))
    ),
    'probe-count.png',
    /25 pixel\(s\) differ \(max channel delta 1, 0 pixel\(s\) with channel delta > 2/
  )

  // Invariant 2c: dimension mismatch FAILS and writes `<name>-exact-actual.png`.
  expectRefusal(
    encodePng({
      width: baseline.width - 1,
      height: baseline.height,
      rgba: baseline.rgba.subarray(0, (baseline.width - 1) * baseline.height * 4),
    }),
    'probe-size.png',
    /a different size/
  )

  // Invariant 2d: live 1 px border colour change (`border-strong` #C9D3DE vs `border-input` #7C8894)
  // FAILS and writes `<name>-exact-actual.png`.
  const support = page.getByRole('link', { name: 'Écrire au support' })
  await support.evaluate((el) => el.style.setProperty('border-color', 'var(--c-border-strong)'))
  const mutatedCapture = await capture(page)
  const mutatedComparison = compareDecoded(decodePng(mutatedCapture), baseline)
  expect(mutatedComparison.passes).toBe(false)
  expect(mutatedComparison.loudPixels).toBeGreaterThan(0)
  expect(mutatedComparison.maxChannelDelta).toBeGreaterThan(MAX_CORNER_AA_CHANNEL_DELTA)
  expectRefusal(mutatedCapture, 'probe-border.png', /pixel\(s\) with channel delta > 2/)
})
