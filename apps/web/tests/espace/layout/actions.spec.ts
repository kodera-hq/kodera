// When a message's actions are drawn (docs/specs/espace-message-actions.md), in a real browser
// with the console's own styles: faded at rest but keeping their space, shown under the pointer,
// with keyboard focus and while a menu or the reaction palette is open, and always on a screen
// with no hover or in forced colours. jsdom computes no hover, no media query and no `:has()`,
// so none of it can be seen there.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout`.

import { expect, test, type Locator, type Page } from '@playwright/test'

// The page's hook (harness.ts), restated: that file draws the live view, so it is type-checked
// with the browser project and not imported here.
declare global {
  interface Window {
    layoutHarness: { show(count: number): void }
  }
}

async function open(page: Page, count: number): Promise<Locator> {
  await page.goto('/tests/espace/layout/harness.html')
  await page.waitForFunction(() => window.layoutHarness !== undefined)
  await page.evaluate((n) => window.layoutHarness.show(n), count)
  const log = page.getByRole('log', { name: 'Messages de général' })
  await expect(log).toBeVisible()
  return log
}

const opacity = (actions: Locator) =>
  actions.evaluate((element) => Number(getComputedStyle(element).opacity))

const toolbar = (article: Locator) => article.locator('[data-message-actions]')

/** The log's messages, found by CSS: an open menu hides the rest of the page from its roles. */
const messages = (page: Page) => page.locator('[role="log"] article')

/** Moves the pointer onto the page's corner, over no message. */
const pointerAway = (page: Page) => page.mouse.move(1, 1)

test('layout/actions: faded at rest, keeping their space, and shown under the pointer only', async ({
  page,
}) => {
  await open(page, 3)
  await pointerAway(page)
  const articles = messages(page)
  await expect(articles).toHaveCount(3)
  for (const article of await articles.all()) {
    await expect.poll(() => opacity(toolbar(article))).toBe(0)
    const box = await toolbar(article).boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(0)
  }

  const [first, second] = [articles.nth(0), articles.nth(1)]
  const text = first.getByText('Message 0', { exact: true })
  const textBefore = await text.boundingBox()
  await first.hover()
  await expect.poll(() => opacity(toolbar(first))).toBe(1)
  await expect.poll(() => opacity(toolbar(second))).toBe(0)
  // Shown, the actions take no more room than faded: the text does not move.
  expect(await text.boundingBox()).toEqual(textBefore)
})

test('layout/actions: shown while focus is in the message, and while its menu is open', async ({
  page,
}) => {
  await open(page, 2)
  await pointerAway(page)
  const first = messages(page).first()
  const menu = toolbar(first).locator('button[aria-haspopup="menu"]')
  await expect(menu).toHaveAccessibleName(/^Actions du message de/)

  await menu.focus()
  await expect.poll(() => opacity(toolbar(first))).toBe(1)

  // Open, the menu holds focus in its own layer, outside the message: the actions stay shown.
  await page.keyboard.press('Enter')
  const items = page.getByRole('menu')
  await expect(items).toBeVisible()
  await expect(page.locator('[role="menu"] :focus, [role="menu"]:focus')).toHaveCount(1)
  await expect.poll(() => opacity(toolbar(first))).toBe(1)

  await page.keyboard.press('Escape')
  await expect(items).toBeHidden()
  await expect(menu).toBeFocused()
  await expect.poll(() => opacity(toolbar(first))).toBe(1)

  await menu.blur()
  await expect.poll(() => opacity(toolbar(first))).toBe(0)
})

test('layout/actions: shown while its reaction palette is open', async ({ page }) => {
  await open(page, 2)
  await pointerAway(page)
  const first = messages(page).first()
  const palette = toolbar(first).getByRole('button', { name: 'Ajouter une réaction' })
  await palette.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  // The pointer leaves and focus is in the palette's own layer: only the open state holds it.
  await pointerAway(page)
  await expect(page.locator('[role="dialog"] :focus, [role="dialog"]:focus')).toHaveCount(1)
  await expect.poll(() => opacity(toolbar(first))).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('layout/actions: always shown in forced colours', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' })
  await open(page, 2)
  await pointerAway(page)
  const articles = messages(page)
  await expect(articles).toHaveCount(2)
  for (const article of await articles.all()) {
    await expect.poll(() => opacity(toolbar(article))).toBe(1)
  }
})

test.describe('on a touch screen with no hover', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('layout/actions: always shown', async ({ page }) => {
    const log = await open(page, 2)
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    // `.all()` does not wait: count first, or an empty list would pass without a look.
    await expect(log.getByRole('article')).toHaveCount(2)
    for (const article of await log.getByRole('article').all()) {
      await expect.poll(() => opacity(toolbar(article))).toBe(1)
    }
  })
})
