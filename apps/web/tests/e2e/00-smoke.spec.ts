// Full sign-in round-trip through the mock identity provider (ADR-0007),
// landing on the authenticated shell with its six primary navigation items.
// Individual journey specifications cover the screens inside the frame.

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { useScenario } from './support/useScenario'

const NAV_LABELS = [
  'Accueil',
  'Applications',
  'Personnes',
  'Domaine & identité',
  'Facturation',
  'Aide',
]

test('signs in through the mock identity provider and lands on the shell', async ({ page }) => {
  // Same-origin only, for requests the PAGE issues itself: fonts are
  // self-hosted and the console talks to no host but the Core API and, in
  // this build, the mock identity provider — both served from this same
  // preview server (docs/dev/API_CLIENT.md, ADR-0003). This guard covers
  // page-issued requests only — MSW intercepts Core API traffic inside the
  // page's own service worker before `page.route` ever sees it, so a mock
  // handler pointed at a third-party host would not be caught here.
  const offSiteRequests: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      await route.continue()
      return
    }
    offSiteRequests.push(route.request().url())
    await route.abort()
  })

  await useScenario(page, ['shell.single-organisation'])

  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Se connecter à votre console' })).toBeVisible()

  // The mock sign-in path: a deep link to the organisation triggers
  // `signIn(realm)` through the adapter (`src/app/org-route.tsx`), which
  // redirects to the mock identity provider's own page.
  await page.goto('/acme-sa/home')
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await expect(page.getByRole('heading', { name: /^Continuer vers/ })).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()

  // Code exchange, session start, and back to the deep link that started it
  // (`src/app/callback-route.tsx`, `src/auth/return-to.ts`).
  await expect(page).toHaveURL(/\/acme-sa\/home$/)

  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  for (const label of NAV_LABELS) {
    // `exact: true`: a loose match on "Personnes" would also resolve any
    // action whose name contains it, such as the design's "Inviter des
    // personnes", withheld on Home until People ships.
    await expect(navigation.getByRole('link', { name: label, exact: true })).toBeVisible()
  }

  const results = await new AxeBuilder({ page }).analyze()
  // Unfiltered on purpose: this real-browser scan measures contrast on
  // Home (jsdom's headless story run cannot measure contrast at all,
  // `docs/dev/TESTING.md`), so `color-contrast` gates here like every
  // other rule.
  expect(results.violations).toEqual([])

  expect(offSiteRequests).toEqual([])
})
