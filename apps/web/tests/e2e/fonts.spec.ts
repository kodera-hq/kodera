// The console's fonts are self-hosted (`src/index.css`) and NAMED by the tokens
// preset: `font-sans` asks for "Plus Jakarta Sans", `font-mono` for "IBM Plex
// Mono". Neither side can see the other. A face bundled under any other family
// name is matched by nothing, and the browser draws the next family in the
// stack — system-ui — with no error and no warning. A missing weight fails the
// same quiet way: `font-semibold` on a family bundled at 400 and 500 only is a
// 500 the browser thickens itself (a synthesized bold).
//
// Nothing in the CSS shows either failure, and a computed style does not
// either: `getComputedStyle().fontFamily` returns the whole declared stack
// whether or not its first entry exists. So these tests ask the browser what it
// actually drew with.
/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { signIn, signInToOrg } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'

/** The fonts Chromium's layout used for an element's text: the face it ended
 * up with after matching and fallback, from the DevTools protocol. */
async function renderedFonts(
  page: Page,
  locator: Locator
): Promise<{ familyName: string; isCustomFont: boolean }[]> {
  await locator.evaluate((element) => element.setAttribute('data-font-probe', ''))
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-font-probe]',
    })
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont }))
  } finally {
    await cdp.detach()
    await locator.evaluate((element) => element.removeAttribute('data-font-probe'))
  }
}

/** Every family, weight and style a visible text node on the page is drawn
 * with that no LOADED `@font-face` provides exactly. `scanned` is returned so a
 * page that yields no text cannot pass by checking nothing. */
async function facesNotBundled(page: Page): Promise<{ scanned: number; missing: string[] }> {
  await page.evaluate(() => document.fonts.ready)
  return page.evaluate(() => {
    const unquote = (name: string) => name.trim().replace(/^(["'])(.*)\1$/, '$2')
    const loaded: FontFace[] = []
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') loaded.push(face)
    })
    const provides = (face: FontFace, family: string, weight: number, style: string) => {
      if (unquote(face.family) !== family || face.style !== style) return false
      const [low = NaN, high = low] = face.weight.split(/\s+/).map(Number)
      return weight >= low && weight <= high
    }

    let scanned = 0
    const missing = new Set<string>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const element = node.parentElement
      if (element === null || node.textContent?.trim() === '' || !element.checkVisibility()) {
        continue
      }
      scanned += 1
      const style = getComputedStyle(element)
      const family = unquote(style.fontFamily.split(',')[0] ?? '')
      const weight = Number(style.fontWeight)
      if (!loaded.some((face) => provides(face, family, weight, style.fontStyle))) {
        missing.add(`${family} ${weight} ${style.fontStyle}`)
      }
    }
    return { scanned, missing: [...missing].sort() }
  })
}

test('fonts/home: draws the greeting heading in the bundled Plus Jakarta Sans', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)

  const heading = page.getByRole('heading', { name: 'Bonjour Julie' })
  await expect(heading).toBeVisible()
  await page.evaluate(() => document.fonts.ready)

  expect(await page.evaluate(() => document.fonts.check('600 16px "Plus Jakarta Sans"'))).toBe(true)
  // `check()` is not the proof. Per the CSS Font Loading spec it answers true
  // when NO face carries the family name at all, and on the build before this
  // test it did, while the heading was drawn from a fallback. The proof is the
  // face the glyphs came from: `familyName` is the font file's own name ("Plus
  // Jakarta Sans SemiBold" for the 600 file), and `isCustomFont` separates the
  // bundled face from a copy installed on the machine running the test, which
  // reports the same name and hid the defect on a machine that had one.
  expect(await renderedFonts(page, heading)).toEqual([
    { familyName: expect.stringMatching(/^Plus Jakarta Sans\b/), isCustomFont: true },
  ])
})

test('fonts/home: renders every visible weight from a bundled face, none synthesized', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signInToOrg(page, ORG)
  await expect(page.getByRole('heading', { name: 'Bonjour Julie' })).toBeVisible()
  // The "Prochaine facture" amount, the one mono headline on Home.
  await expect(page.getByText(/4\s488\s€/)).toBeVisible()

  const { scanned, missing } = await facesNotBundled(page)
  expect(scanned).toBeGreaterThan(20)
  expect(missing).toEqual([])
})

test('fonts/order: renders every visible weight from a bundled face, none synthesized', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'order.catalogue-default'])
  await page.goto(`/${ORG}/order`)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/order\/.+\/plan$/)
  await page.getByLabel('Combien de personnes dans votre organisation ?').fill('120')
  await page.getByLabel('Combien de personnes dans votre organisation ?').blur()
  // The plan cards' price headlines (`PlanPrice`, the sans face) are what this screen adds: the amount alone,
  // the sentence it belongs to being the card's accessible name.
  await expect(page.getByRole('radio', { name: /^Business,/ }).getByText(/^314\s€$/)).toBeVisible()

  const { scanned, missing } = await facesNotBundled(page)
  expect(scanned).toBeGreaterThan(20)
  expect(missing).toEqual([])
})

test('fonts/invoices: renders every visible weight from a bundled face, none synthesized', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'invoices.owner-role',
    'invoices.reverse-charge',
  ])
  await signIn(page, ORG, '/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70')
  // Four copies of the amount, one of them the "À régler" mono headline.
  await expect(page.getByText('4 488 €')).toHaveCount(4)

  const { scanned, missing } = await facesNotBundled(page)
  expect(scanned).toBeGreaterThan(20)
  expect(missing).toEqual([])
})
