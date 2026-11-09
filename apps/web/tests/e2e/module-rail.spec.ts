// The module rail, in a real browser: two named navigation landmarks that axe
// can tell apart, a skip link that is still first in the tab order (docs/specs/
// 00-shell-and-login.md §10), and the two marks in the two places that make
// the point — the maker's in the rail, the tenant's in the sidebar.
//
// Contrast is why this is an end-to-end spec rather than a jsdom one: the rail
// is the console's only dark surface, and jsdom cannot measure a colour pair
// at all (docs/dev/TESTING.md). The axe scans below are unfiltered, so
// `color-contrast` gates here.

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'
import { markReliability, registerReliability } from './support/reliabilityRecord'

registerReliability(test)

test('shell/rail: two named navigation landmarks, the skip link still first', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation'])
  markReliability(page, 'authentication')
  await signIn(page, 'acme-sa')

  markReliability(page, 'destination')
  const rail = page.getByRole('navigation', { name: 'Modules' })
  const sidebar = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(rail).toBeVisible()
  await expect(sidebar).toBeVisible()

  // §10's focus order opens with the skip link, and the rail is rendered after
  // it — adding a landmark must not push it down the tab order.
  markReliability(page, 'interaction')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeFocused()

  markReliability(page, 'axe')
  const results = await new AxeBuilder({ page }).analyze()
  markReliability(page, 'primary')
  expect(results.violations).toEqual([])
})

test('shell/rail: labels every module and marks the console as the current page', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signIn(page, 'acme-sa')

  const rail = page.getByRole('navigation', { name: 'Modules' })
  const links = rail.getByRole('link')
  // Visio, Docs, « Réglages » (the console) and the maker's mark — the
  // fixture's two applications plus the rail's two constants for an owner. No
  // « Messages »: the fixture's tenant does not run `messaging`. Asserted so the
  // loop below cannot pass over an empty rail.
  await expect(links).toHaveCount(4)

  // The brand mark is named. Icons only (docs/specs/icon-only-controls.md): a module draws no
  // text, and its name shows beside it as a tooltip while it has the focus.
  for (const link of await links.all()) {
    const name = await link.evaluate((el) => el.getAttribute('aria-label'))
    expect(name?.trim()).toBeTruthy()
  }
  for (const name of ['Visio', 'Docs', 'Réglages']) {
    const item = rail.getByRole('link', { name: new RegExp(`^${name}`) })
    await expect(item).toHaveText('')
    await item.focus()
    await expect(page.locator('[data-side="right"]').filter({ hasText: name })).toBeVisible()
  }

  // Exactly one current MODULE. Scoped to the lists: the maker's mark above them
  // links to the organisation home, and the router marks any link to the
  // current route `aria-current="page"` — the same annotation the sidebar's
  // own "Accueil" carries on this route.
  const current = rail.locator('ul [aria-current="page"]')
  await expect(current).toHaveCount(1)
  await expect(current).toHaveAttribute('aria-label', 'Réglages')

  // Still the current item away from home: the console is the surface, not
  // one of its screens. And away from home the rail has exactly one current
  // item overall, the mark no longer being on the page it points at.
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: 'Personnes', exact: true })
    .click()
  await expect(page).toHaveURL(/\/acme-sa\/people$/)
  await expect(rail.locator('[aria-current="page"]')).toHaveCount(1)
  await expect(rail.locator('[aria-current="page"]')).toHaveAttribute('aria-label', 'Réglages')
})

test('shell/rail: the maker mark is in the rail and the tenant mark is in the sidebar', async ({
  page,
}) => {
  await useScenario(page, ['shell.demo-branding', 'status.live-healthy'])
  await signIn(page, 'vercelli')

  const rail = page.getByRole('navigation', { name: 'Modules' })
  const sidebar = page.getByRole('navigation', { name: 'Navigation principale' })

  // The maker's mark: the published Kodera monogram, served from `public/`,
  // the same for every tenant.
  await expect(rail.locator('img[src="/kodera-mark-white.svg"]')).toBeVisible()
  await expect(sidebar.locator('img[src="/kodera-mark-white.svg"]')).toHaveCount(0)

  // The tenant's mark: demonstration only, inline, and beside the tenant's own
  // name — never in the rail, which is the product's.
  await expect(sidebar.getByText('Groupe Vercelli')).toBeVisible()
  const tenantMark = sidebar.locator('img[src^="data:image/svg+xml"]')
  await expect(tenantMark).toHaveCount(1)
  await expect(tenantMark).toHaveAttribute('alt', '')
  await expect(rail.locator('img[src^="data:image/svg+xml"]')).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
