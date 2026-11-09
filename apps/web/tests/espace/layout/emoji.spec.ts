// Emoji in the composer (docs/specs/11-workspace.md, « Emoji in the composer »), in a real
// browser with the console's own styles: the palette opens above the composer box, inside the
// window, eight to a row, and six at phone width with 44 px cells; the shortcode list opens above the field; and a
// code typed key by key becomes its emoji with the caret after it. jsdom lays nothing out and
// fires no real input events, so none of the placement can be seen there.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout`.

import { expect, test, type Locator, type Page } from '@playwright/test'

// The page's hook (harness.ts), restated: that file draws the live view, so it is type-checked
// with the browser project and not imported here.
declare global {
  interface Window {
    layoutHarness: { show(count: number): void }
  }
}

async function open(page: Page): Promise<Locator> {
  await page.goto('/tests/espace/layout/harness.html')
  await page.waitForFunction(() => window.layoutHarness !== undefined)
  await page.evaluate(() => window.layoutHarness.show(3))
  const field = page.getByRole('combobox', { name: 'Message dans #général' })
  await expect(field).toBeVisible()
  return field
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found).not.toBeNull()
  return found!
}

async function insideWindow(page: Page, locator: Locator) {
  const { width, height } = page.viewportSize()!
  const { x, y, width: w, height: h } = await box(locator)
  expect(x).toBeGreaterThanOrEqual(0)
  expect(y).toBeGreaterThanOrEqual(0)
  expect(x + w).toBeLessThanOrEqual(width)
  expect(y + h).toBeLessThanOrEqual(height)
}

for (const size of [
  { name: 'desktop', width: 1280, height: 800, columns: 8, floor: 0 },
  { name: 'phone', width: 375, height: 812, columns: 6, floor: 44 },
]) {
  test(`layout/emoji: the palette opens above the composer box, in the window, ${size.columns} to a row (${size.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    const field = await open(page)
    await field.fill('Bien joué')
    await field.evaluate((input: HTMLInputElement) => input.setSelectionRange(4, 4))
    await page.getByRole('button', { name: 'Insérer un émoji' }).click()
    const palette = page.getByRole('dialog', { name: 'Émojis' })
    await expect(palette).toBeVisible()
    await insideWindow(page, palette)
    // Above the whole box, field included: the text being written stays in view.
    expect((await box(palette)).y + (await box(palette)).height).toBeLessThanOrEqual(
      (await box(field)).y
    )
    const cells = palette.getByRole('button')
    await expect(cells).toHaveCount(32)
    const rows = new Set<number>()
    for (const cell of await cells.all()) {
      const { y, width, height } = await box(cell)
      rows.add(Math.round(y))
      expect(width).toBeGreaterThanOrEqual(size.floor)
      expect(height).toBeGreaterThanOrEqual(size.floor)
    }
    expect(rows.size).toBe(Math.ceil(32 / size.columns))
    const last = size.columns - 1
    expect((await box(cells.nth(last))).y).toBe((await box(cells.nth(0))).y)
    expect((await box(cells.nth(size.columns))).y).toBeGreaterThan((await box(cells.nth(0))).y)
    // The arrow keys follow the drawn rows: down from the first cell lands under it.
    await expect(cells.nth(0)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(cells.nth(size.columns)).toBeFocused()
    await page.keyboard.press('ArrowUp')

    await expect(cells.nth(0)).toBeFocused()
    await palette.getByRole('button', { name: 'Insérer 🔥' }).click()
    await expect(palette).toBeHidden()
    await expect(field).toHaveValue('Bien🔥 joué')
    await expect(field).toBeFocused()
    expect(await field.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(
      'Bien🔥'.length
    )
  })
}

test('layout/emoji: the shortcode list opens above the field, and a typed code becomes its emoji', async ({
  page,
}) => {
  const field = await open(page)
  await field.click()
  await page.keyboard.type('Bravo :ta')
  const list = page.getByRole('listbox', { name: 'Émojis correspondants' })
  await expect(list).toBeVisible()
  await insideWindow(page, list)
  expect((await box(list)).y + (await box(list)).height).toBeLessThanOrEqual(
    (await box(field)).y + 1
  )
  await page.keyboard.press('Enter')
  await expect(list).toBeHidden()
  await expect(field).toHaveValue('Bravo 🎉 ')

  await page.keyboard.type('et :wave: merci')
  await expect(field).toHaveValue('Bravo 🎉 et 👋 merci')
  expect(await field.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(
    'Bravo 🎉 et 👋 merci'.length
  )
})
