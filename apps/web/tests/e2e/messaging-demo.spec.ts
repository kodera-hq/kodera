// The messaging demo preview, in a real browser against the production-shaped
// mock build (`playwright.config.ts` builds with VITE_AUTH_MODE=mock
// VITE_ENABLE_MSW=1, which is the only configuration that registers this
// route at all — `src/app/routeTree.test.ts` proves the other three do not).
//
// Two things only a browser can answer, which the jsdom suite in
// `src/features/messaging/MessagingDemoSurface.test.tsx` cannot:
//
//   - contrast, measured on the themed `c-*` roles as they actually resolve;
//   - `scrollable-region-focusable`, which needs layout to know that the
//     conversation and the member list overflow at all. This surface failed
//     that rule before its scroll containers became tab stops, and nothing
//     without a layout engine would have said so.
//
// No sign-in: the preview sits outside the `/$org` layout on purpose (see
// `src/features/messaging/demo-route.tsx`).

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('shows the Tchap preview, says it sends nothing, and passes axe', async ({ page }) => {
  await page.goto('/__demo-messaging')

  // The honest labelling is the point of the screen, so it is the first
  // assertion rather than a footnote: a reader must not be able to take this
  // for a messenger the console implements.
  await expect(page.getByRole('heading', { level: 1, name: 'Messagerie Tchap' })).toBeVisible()
  await expect(page.getByText('Aperçu de démonstration')).toBeVisible()
  await expect(page.getByText(/Il n’est relié à aucune messagerie/)).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation du canal #chantier-a13' })
  await expect(conversation.getByText('Sylvain Ellenstein')).toBeVisible()
  await expect(conversation.getByRole('listitem')).toHaveCount(5)

  // The permanent rooms — the part of the suite that is not a scheduled
  // meeting — with who is in them.
  const navigation = page.getByRole('navigation', { name: 'Canaux et salons de l’aperçu' })
  await expect(navigation.getByText('Conduite de travaux')).toBeVisible()
  await expect(
    navigation.getByRole('list', { name: 'Personnes présentes dans Conduite de travaux' })
  ).toBeVisible()

  await page.getByLabel('Message à #chantier-a13').fill('Bonjour')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'Rien n’a été envoyé : cet aperçu n’est relié à aucune messagerie.'
  )

  // Unfiltered, like the smoke spec's: `color-contrast` is the rule a
  // headless jsdom run cannot evaluate at all, and this surface introduces a
  // palette of six tint pairs that nothing else in the console uses.
  const results = await new AxeBuilder({ page }).include('[data-messaging-demo-surface]').analyze()
  expect(results.violations).toEqual([])
})
