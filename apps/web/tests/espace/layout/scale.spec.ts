// The message log at scale (docs/specs/espace-timeline-scale.md), in a real browser with the
// console's own styles: a channel of ten thousand messages keeps at most sixty rows in the page,
// draws a new message within a frame, and still scrolls back to its first message. jsdom lays
// nothing out, so none of this can be seen there.
// Needs no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout/scale.spec.ts`.

import { expect, test, type Locator, type Page } from '@playwright/test'

// The page's hook (harness.ts), restated for this file: log.spec.ts declares `window.layoutHarness`
// with only the method it uses, so these read it through their own type.
interface ScaleHarness {
  live(count: number): void
  append(): number
}
type ScaleWindow = { layoutHarness: ScaleHarness }

const TEN_THOUSAND = 10_000
const MAX_ROWS = 60
/** One frame at 60 Hz. */
const FRAME_MS = 16

async function openLive(page: Page, count: number): Promise<Locator> {
  await page.goto('/tests/espace/layout/harness.html')
  await page.waitForFunction(() => window.layoutHarness !== undefined)
  await page.evaluate((n) => (window as unknown as ScaleWindow).layoutHarness.live(n), count)
  const log = page.getByRole('log', { name: 'Messages de général' })
  await expect(log).toBeVisible()
  return log
}

function drawnRows(log: Locator): Promise<number> {
  return log.locator('[data-timeline-row]').count()
}

test('espace/scale: ten thousand messages open on the newest with at most sixty rows drawn', async ({
  page,
}) => {
  const log = await openLive(page, TEN_THOUSAND)
  await expect(log.getByText(`Message ${TEN_THOUSAND - 1}`, { exact: true })).toBeVisible()
  expect(await drawnRows(log)).toBeLessThanOrEqual(MAX_ROWS)
  // The newest message ends where the log does: the member reads the end of the channel.
  const below = await log.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  )
  expect(below).toBeLessThanOrEqual(1)
  // The spacers stand in for the rest: the log is as tall as ten thousand messages.
  const height = await log.evaluate((element) => element.scrollHeight)
  expect(height).toBeGreaterThan(TEN_THOUSAND * 30)
})

test('espace/scale: a new message in a ten-thousand-message channel is drawn within a frame', async ({
  page,
}) => {
  const log = await openLive(page, TEN_THOUSAND)
  await expect(log.getByText(`Message ${TEN_THOUSAND - 1}`, { exact: true })).toBeVisible()
  // A few to warm the page up, then the measured ones.
  for (let warm = 0; warm < 5; warm += 1)
    await page.evaluate(() => (window as unknown as ScaleWindow).layoutHarness.append())
  const times: number[] = []
  for (let run = 0; run < 30; run += 1) {
    times.push(await page.evaluate(() => (window as unknown as ScaleWindow).layoutHarness.append()))
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]!
  test.info().annotations.push({ type: 'median-draw-ms', description: median.toFixed(2) })
  console.log(
    `espace/scale: median draw of a new message ${median.toFixed(2)} ms, slowest ${times.at(-1)!.toFixed(2)} ms`
  )
  expect(median, `median draw ${median.toFixed(2)} ms over ${times.length} messages`).toBeLessThan(
    FRAME_MS
  )
  const last = TEN_THOUSAND + 5 + 30 - 1
  await expect(log.getByText(`Message ${last}`, { exact: true })).toBeVisible()
  expect(await drawnRows(log)).toBeLessThanOrEqual(MAX_ROWS)
  // Still at the end: each new message kept the log on it.
  const below = await log.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  )
  expect(below).toBeLessThanOrEqual(1)
})

test('espace/scale: a ten-thousand-message channel scrolls back to its first message', async ({
  page,
}) => {
  const log = await openLive(page, TEN_THOUSAND)
  await expect(log.getByText(`Message ${TEN_THOUSAND - 1}`, { exact: true })).toBeVisible()
  await log.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(log.getByText('Message 0', { exact: true })).toBeVisible()
  expect(await drawnRows(log)).toBeLessThanOrEqual(MAX_ROWS)
  // And half-way, the rows under the scroll are the ones drawn.
  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
  })
  await expect
    .poll(async () => {
      const texts = await log.locator('[data-timeline-row] article').allTextContents()
      return texts.some((text) => /Message (4|5)\d{3}\b/.test(text))
    })
    .toBe(true)
  expect(await drawnRows(log)).toBeLessThanOrEqual(MAX_ROWS)
})
