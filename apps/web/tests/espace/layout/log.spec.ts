// Where the message log draws its messages (docs/specs/11-workspace.md, "Message history"), in a
// real browser with the console's own styles: a short channel rests on the composer, and a long
// one still scrolls to its first message. jsdom lays nothing out, so neither can be seen there.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout`. Name the
// path: the audio spec reads the stack's `.runtime/config` as it loads. And stop any other checkout's dev
// server on 5173 first, since the config reuses it and would measure that checkout's view.

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

/** The log's box and padding, its first and last children's boxes, and its scroll. */
function measure(log: Locator) {
  return log.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const first = element.firstElementChild?.getBoundingClientRect()
    const last = element.lastElementChild?.getBoundingClientRect()
    if (first === undefined || last === undefined) throw Error('the log is empty')
    return {
      top: box.top + parseFloat(style.paddingTop),
      bottom: box.bottom - parseFloat(style.paddingBottom),
      firstTop: first.top,
      lastBottom: last.bottom,
      lastText: element.lastElementChild?.textContent ?? '',
      firstText: element.firstElementChild?.textContent ?? '',
      overflow: element.scrollHeight - element.clientHeight,
      belowView: element.scrollHeight - element.scrollTop - element.clientHeight,
    }
  })
}

test('layout/log: a short channel rests on the composer, its newest message nearest the field', async ({
  page,
}) => {
  const log = await open(page, 2)
  const at = await measure(log)
  expect(at.overflow).toBe(0)
  expect(at.lastText).toContain('Message 1')
  // The newest message ends where the log does, just above the composer…
  expect(Math.abs(at.bottom - at.lastBottom)).toBeLessThanOrEqual(1)
  // …and the empty space is above the history's edge, not under the messages.
  expect(at.firstText).toContain('Début de #général')
  expect(at.firstTop - at.top).toBeGreaterThan(200)
})

test('layout/log: an empty channel says so just above the composer', async ({ page }) => {
  const log = await open(page, 0)
  const at = await measure(log)
  expect(at.lastText).toContain('Aucun message dans #général.')
  expect(Math.abs(at.bottom - at.lastBottom)).toBeLessThanOrEqual(1)
})

test('layout/log: a long channel opens on its newest message and scrolls back to its start', async ({
  page,
}) => {
  const log = await open(page, 80)
  const opened = await measure(log)
  expect(opened.overflow).toBeGreaterThan(0)
  expect(opened.belowView).toBeLessThanOrEqual(1)
  expect(Math.abs(opened.bottom - opened.lastBottom)).toBeLessThanOrEqual(1)

  // Rows pushed to the log's end (`justify-end`) spill above its top, where no scroll reaches:
  // Chromium then reports no overflow at all, which the first assertion above refuses. Here the
  // log overflows, and scrolled to the top, the history's edge is there to read.
  await log.evaluate((element) => {
    element.scrollTop = 0
  })
  const top = await measure(log)
  expect(top.firstText).toContain('Début de #général')
  expect(Math.abs(top.firstTop - top.top)).toBeLessThanOrEqual(1)
})
