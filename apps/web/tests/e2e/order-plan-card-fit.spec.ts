// A plan card's price and its recommendation pill must stay inside the card at
// the widths the console is used at. No role- or text-based assertion can see
// this defect: a price drawn past its card is still in the DOM and still
// "visible" while it runs over the next card. So this reads rendered geometry.
//
// The width a card gets is not a function of the viewport alone. The cards
// share the plan column with the order summary and the shell's sidebar, so on
// the production mock build the column is narrower at 1024 px, where the
// summary moves beside it, than at 900 px. 640, 1024 and 1280 are the three
// widths that exposed the clipping: one column, the summary's squeeze, and a
// laptop's three cards side by side.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { useScenario } from './support/useScenario'

// The column is the viewport less about 741 px (539 px at 1280), and four cards stand across
// from a 45rem (720 px) column: 1480 px is about the first width with four across, the
// tightest each card gets; 1600 px is a roomier four across.
const WIDTHS = [640, 1024, 1280, 1480, 1600] as const

/** A rendered line that ends up outside the box it belongs in. */
interface Escape {
  width: number
  card: string
  text: string
  /** `card`: the card's content box; `pill`: the recommendation pill's own box. */
  box: 'card' | 'pill'
  past: number
}

interface CardReading {
  name: string
  /** The card's own yearly amount was found among its text: the check below measured a price. */
  priceFound: boolean
  pillFound: boolean
  escapes: { text: string; box: 'card' | 'pill'; past: number }[]
}

const SCENARIOS = ['shell.single-organisation', 'order.catalogue-default'] as const

/** The plan step with 120 people entered, so Business is recommended. Scenarios are set first. */
async function openPlanStep(page: Page): Promise<void> {
  await page.goto('/acme-sa/order')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/order\/.+\/plan$/)
  const headcount = page.getByLabel('Combien de personnes dans votre organisation ?')
  await headcount.fill('120')
  await headcount.blur()
  await expect(page.getByText(/Nous vous recommandons Business/)).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function resize(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  // The shell's sidebar is rendered from a media query; let React commit it.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

// With Docs ticked, every card is priced from the Docs pack; the widest amount, « 1 341 € », is Enterprise's.
for (const docs of [false, true]) {
  test(`order/plan: shows each plan price and recommendation whole inside its card${docs ? ', Docs ticked' : ''}`, async ({
    page,
  }) => {
    await useScenario(page, SCENARIOS)
    await openPlanStep(page)
    if (docs) {
      await page.getByRole('checkbox', { name: 'Docs — documents collaboratifs' }).check()
      await expect(page.getByRole('radio', { name: /^Business, 403\s€/ })).toBeVisible()
    }
    const cards = page.getByRole('radio', { name: /participants simultanés\.$/ })
    await expect(cards).toHaveCount(4)

    const escapes: Escape[] = []
    const unmeasured: string[] = []
    for (const width of WIDTHS) {
      await resize(page, width)

      let pills = 0
      for (const card of await cards.all()) {
        const reading = await card.evaluate((radio): CardReading => {
          const TOLERANCE = 0.5
          const name = radio.getAttribute('aria-label') ?? ''

          // The card's content box: the innermost box of the single-child chain
          // under the radio (Card, then CardBody), inside its padding and border.
          let body: Element = radio
          while (body.children.length === 1) body = body.children[0]!
          const style = getComputedStyle(body)
          const outer = body.getBoundingClientRect()
          const content = {
            left: outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
            right:
              outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
          }

          const textNodes = (root: Node): Text[] => {
            const found: Text[] = []
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (node.textContent?.trim()) found.push(node as Text)
            }
            return found
          }
          const rectsOf = (node: Text): DOMRect[] => {
            const range = document.createRange()
            range.selectNodeContents(node)
            return Array.from(range.getClientRects())
          }
          const label = (node: Text) => node.textContent!.replace(/\s+/g, ' ').trim()

          const escapes: CardReading['escapes'] = []
          const measure = (
            node: Text,
            box: { left: number; right: number },
            name: 'card' | 'pill',
            vertical?: DOMRect
          ) => {
            let past = 0
            for (const rect of rectsOf(node)) {
              past = Math.max(past, rect.right - box.right, box.left - rect.left)
              if (vertical !== undefined) {
                past = Math.max(past, rect.bottom - vertical.bottom, vertical.top - rect.top)
              }
            }
            if (past > TOLERANCE)
              escapes.push({ text: label(node), box: name, past: Math.round(past) })
          }

          // The price: everything in the card slot that holds this card's own
          // yearly amount, as the accessible name states it. The plan name has no comma; the
          // amount may (« 4 836,50 € »), so it runs up to « € », not to the next comma.
          const amount = /^[^,]+, (.+?€)/.exec(name)?.[1]?.replace(/\s/g, ' ')
          const all = textNodes(body)
          const amountNode = all.find(
            (node) => amount !== undefined && node.textContent!.replace(/\s/g, ' ').includes(amount)
          )
          let slot: Node | null = amountNode ?? null
          while (slot !== null && slot.parentNode !== body) slot = slot.parentNode
          if (slot !== null) for (const node of textNodes(slot)) measure(node, content, 'card')

          const title = body.querySelector('h3')
          if (title !== null) for (const node of textNodes(title)) measure(node, content, 'card')

          // The recommendation pill: whole inside the card, and its words inside
          // its own pill rather than spilling out of a fixed-height capsule.
          const pillText = all.find((node) => node.textContent!.trim().startsWith('Recommandé'))
          if (pillText !== undefined) {
            const pill = pillText.parentElement!.getBoundingClientRect()
            measure(pillText, content, 'card')
            measure(pillText, pill, 'pill', pill)
          }

          return {
            name: name.split(',')[0]!,
            priceFound: slot !== null,
            pillFound: pillText !== undefined,
            escapes,
          }
        })
        if (!reading.priceFound) unmeasured.push(`${width}px ${reading.name}`)
        if (reading.pillFound) pills += 1
        for (const escape of reading.escapes) escapes.push({ width, card: reading.name, ...escape })
      }
      expect(pills, `one recommendation pill measured at ${width}px`).toBe(1)
    }

    expect(unmeasured, 'every card had its price measured').toEqual([])
    expect(escapes).toEqual([])
  })
}

// Side by side, the cards are read across: 01-order.md §4.1 sets amounts in tabular figures
// "so two cards can be compared column by column". At 900 and 1280 px the four cards stand two
// by two, at 1600 px four across; the prices of the cards in one row must line up.
test('order/plan: lines the plan prices up across the cards', async ({ page }) => {
  await useScenario(page, SCENARIOS)
  await openPlanStep(page)
  const cards = page.getByRole('radio', { name: /participants simultanés\.$/ })
  await expect(cards).toHaveCount(4)

  const misaligned: { width: number; rows: Record<string, number | null>[] }[] = []
  for (const width of [900, 1280, 1480, 1600]) {
    await resize(page, width)
    // Cards grouped by the row they sit in, by their own top edge.
    const rows = new Map<number, Record<string, number | null>>()
    for (const card of await cards.all()) {
      const reading = await card.evaluate((radio) => {
        const name = radio.getAttribute('aria-label') ?? ''
        const row = Math.round(radio.getBoundingClientRect().top)
        const amount = /^[^,]+, (.+?€)/.exec(name)?.[1]?.replace(/\s/g, ' ')
        const walker = document.createTreeWalker(radio, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (amount !== undefined && node.textContent!.replace(/\s/g, ' ').includes(amount)) {
            const range = document.createRange()
            range.selectNodeContents(node)
            const top = range.getClientRects()[0]!.top
            return { name: name.split(',')[0]!, row, top: Math.round(top * 10) / 10 }
          }
        }
        return { name: name.split(',')[0]!, row, top: null }
      })
      const tops = rows.get(reading.row) ?? {}
      tops[reading.name] = reading.top
      rows.set(reading.row, tops)
    }
    // A missing amount or a stacked column fails here too, rather than passing unmeasured.
    // The recommended card's 2 px border sits its content 1 px below a 1 px-bordered
    // neighbour's, measured exactly 1.0 px; half a pixel more absorbs rounding.
    // Every row holds at least two cards (a stacked column fails), and every price is found.
    const broken = [...rows.values()].some((tops) => {
      const found = Object.values(tops).filter((top): top is number => top !== null)
      return (
        Object.keys(tops).length < 2 ||
        found.length !== Object.keys(tops).length ||
        Math.max(...found) - Math.min(...found) > 1.5
      )
    })
    // At 1480 and 1600 px the four stand in one row: four across, not two by two.
    const fourAcross = width < 1480 || rows.size === 1
    if (broken || !fourAcross) misaligned.push({ width, rows: [...rows.values()] })
  }
  expect(misaligned).toEqual([])
})
