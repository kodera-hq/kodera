// The channel keys in a real browser (docs/specs/11-workspace.md, « Keyboard shortcuts »): while
// the address catches up with the channel asked for, the composer is not `disabled`, which in
// Chromium drops the focus to the page, so a member writing keeps writing. jsdom moves no focus
// off a disabled field, so it cannot be seen there.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout`.

import { expect, test } from '@playwright/test'

// The page's hook (harness.ts), restated: that file draws the live view, so it is type-checked
// with the browser project and not imported here. The other layout specs declare the hook's
// `show` on `Window`; this one reads its `navigating`.
type Navigating = { layoutHarness?: { navigating(delay: number): void } }

test('layout/shortcuts: Alt and an arrow change channel with the focus kept in the composer', async ({
  page,
}) => {
  await page.goto('/tests/espace/layout/harness.html')
  await page.waitForFunction(() => (window as unknown as Navigating).layoutHarness !== undefined)
  // Long enough for the field's state while the address is undecided to be read.
  await page.evaluate(() => (window as unknown as Navigating).layoutHarness!.navigating(400))
  const general = page.getByLabel('Message dans #général')
  await general.click()
  await page.keyboard.press('Alt+ArrowDown')

  // Undecided: the field is read-only, said to be unavailable, and keeps the focus.
  await expect(general).toHaveAttribute('readonly', '')
  await expect(general).toHaveAttribute('aria-disabled', 'true')
  await expect(general).toBeFocused()

  // Settled: the new channel's composer has the focus, and what is typed goes into it.
  const annonces = page.getByLabel('Message dans #annonces')
  await expect(annonces).toBeFocused()
  await expect(annonces).not.toHaveAttribute('readonly')
  await page.keyboard.type('bonjour')
  await expect(annonces).toHaveValue('bonjour')
})
