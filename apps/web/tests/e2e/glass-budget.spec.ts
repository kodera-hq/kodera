// The frame-rate gate of the Ciel default (packages/design-tokens/docs/specs/ethereal-sky-glass.md,
// decided item 3): a blurred surface re-samples everything behind it on every frame it moves over,
// so no screen shows more than three at once — the budget that keeps Espace and Docs at 60 frames
// a second on the low-end laptops a 120-person company buys. And translucency is never required to
// read the interface: under `prefers-contrast: more` every surface is opaque, material or not.

/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { useScenario } from './support/useScenario'

/** At most this many blurred surfaces on screen at once. */
const GLASS_BUDGET = 3
const SCENARIOS = ['demo.groupe-vercelli', 'demo.community-member']

/** The elements, pseudo-elements included, that blur what is behind them and are on screen. */
function blurredSurfaces(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const blurs = (style: CSSStyleDeclaration) =>
      [style.backdropFilter, style.getPropertyValue('-webkit-backdrop-filter')].some(
        (value) => value !== '' && value !== 'none'
      )
    const onScreen = (element: Element) => {
      const box = element.getBoundingClientRect()
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < window.innerHeight &&
        box.left < window.innerWidth &&
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      )
    }
    const found: string[] = []
    for (const element of document.querySelectorAll('*')) {
      if (!onScreen(element)) continue
      const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${[
        ...element.classList,
      ].join('.')}`
      if (blurs(getComputedStyle(element))) found.push(name)
      for (const pseudo of ['::before', '::after'])
        if (blurs(getComputedStyle(element, pseudo))) found.push(`${name}${pseudo}`)
    }
    return found
  })
}

/** Opens the demo workspace. The caller activates `SCENARIOS` first: the hooks lint rule refuses
 * a `use*` call inside a named helper. */
async function openEspace(page: Page): Promise<void> {
  await page.goto('/community/workspace')
  await expect(page.getByRole('button', { name: 'Réglages', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^ciel/)
}

test('glass budget: Espace, its settings and Docs show at most three blurred surfaces', async ({
  page,
}) => {
  await useScenario(page, SCENARIOS)
  await openEspace(page)
  expect((await blurredSurfaces(page)).length).toBeLessThanOrEqual(GLASS_BUDGET)

  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Réglages', exact: true })).toBeVisible()
  expect((await blurredSurfaces(page)).length).toBeLessThanOrEqual(GLASS_BUDGET)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await expect(page.getByTestId('workspace-docs-editor-toggle')).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect((await blurredSurfaces(page)).length).toBeLessThanOrEqual(GLASS_BUDGET)
})

test('glass budget: the measure sees a material surface, and the budget refuses a fourth', async ({
  page,
}) => {
  await useScenario(page, SCENARIOS)
  await openEspace(page)
  const before = (await blurredSurfaces(page)).length
  // Four material panels on screen: the glass is on in Ciel, so each one blurs…
  await page.evaluate((count) => {
    const box = [
      ['position', 'fixed'],
      ['top', '0'],
      ['left', '0'],
      ['width', '96px'],
      ['height', '96px'],
    ]
    for (let index = 0; index < count; index += 1) {
      const probe = document.createElement('div')
      probe.className = 'material-panel'
      for (const [property, value] of box) probe.style.setProperty(property!, value!)
      document.body.append(probe)
    }
  }, GLASS_BUDGET + 1)
  const withProbes = (await blurredSurfaces(page)).length
  expect(withProbes - before).toBe(4)
  // …and four over a budget of three is what this gate exists to refuse.
  expect(withProbes).toBeGreaterThan(GLASS_BUDGET)
})

test('glass budget: more contrast turns every blurred surface opaque', async ({ page }) => {
  await useScenario(page, SCENARIOS)
  await openEspace(page)
  await page.evaluate(() => {
    // A material surface, and a blur that comes from no material at all.
    const box = [
      ['position', 'fixed'],
      ['top', '0'],
      ['left', '0'],
      ['width', '96px'],
      ['height', '96px'],
    ]
    const material = document.createElement('div')
    material.className = 'material-panel'
    const blurred = document.createElement('div')
    blurred.style.setProperty('backdrop-filter', 'blur(8px)')
    for (const probe of [material, blurred]) {
      for (const [property, value] of box) probe.style.setProperty(property!, value!)
      document.body.append(probe)
    }
  })
  expect((await blurredSurfaces(page)).length).toBeGreaterThanOrEqual(2)
  await page.emulateMedia({ contrast: 'more' })
  expect(await blurredSurfaces(page)).toEqual([])
})
