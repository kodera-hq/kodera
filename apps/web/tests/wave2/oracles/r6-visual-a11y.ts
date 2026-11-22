/// <reference lib="dom" />
import type { Locator, Page, PageScreenshotOptions } from '@playwright/test'
import type * as Playwright from '@playwright/test'
import type * as Axe from '@axe-core/playwright'
import { guard } from './shared'

// Driver dependencies load only when browser helpers execute; pure oracle checks stay isolated.
const assertionsPackage = '@playwright/test'
const axePackage = '@axe-core/playwright'
const loadAssertions = (): Promise<typeof Playwright> =>
  import(/* @vite-ignore */ assertionsPackage)
const loadAxe = (): Promise<typeof Axe> => import(/* @vite-ignore */ axePackage)

export const VIEWPORT_WIDTHS = [375, 768, 1440] as const
export const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
] as const
export interface VisualCell {
  origin: 'web' | 'landing' | 'auth'
  surface: string
  state: string
  theme: 'light' | 'dark'
  language: 'fr' | 'en'
  width: (typeof VIEWPORT_WIDTHS)[number]
  height: 900
}
export function snapshotKey(cell: VisualCell): string {
  guard(
    VIEWPORT_WIDTHS.includes(cell.width) &&
      cell.height === 900 &&
      /^(?:S\d{2}|L\d{2}|A\d{2})(?:-D[123])?$/.test(cell.surface) &&
      /^[a-z0-9-]+$/.test(cell.state),
    'R6_CELL'
  )
  return `${cell.origin}-${cell.surface}-${cell.state}-${cell.theme}-${cell.language}-${cell.width}x${cell.height}.png`
}
export function assertTheme(
  actual: { theme: string | null; dark: boolean; scheme: string },
  cell: VisualCell
) {
  guard(actual.theme === (cell.origin === 'auth' ? null : cell.theme), 'R6_THEME_NOT_SET')
  guard(
    actual.dark === (cell.theme === 'dark') && actual.scheme.split(/\s+/).includes(cell.theme),
    'R6_COLOR_SCHEME'
  )
}
export async function prepareCell(page: Page, cell: VisualCell) {
  await page.setViewportSize({ width: cell.width, height: cell.height })
  await page.emulateMedia({ colorScheme: cell.theme, reducedMotion: 'reduce' })
  const setPreferences = (value: VisualCell) => {
    if (value.origin !== 'auth')
      localStorage.setItem(value.origin === 'web' ? 'console:theme' : 'kodera-theme', value.theme)
    if (value.origin === 'web') sessionStorage.setItem('console:language', value.language)
  }
  await page.addInitScript(setPreferences, cell)
}
export async function assertCell(page: Page, cell: VisualCell) {
  const { expect } = await loadAssertions()
  assertTheme(
    await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    })),
    cell
  )
  if (cell.origin === 'web') {
    await expect(
      page.getByRole('link', {
        name: cell.language === 'en' ? 'Skip to content' : 'Aller au contenu',
        exact: true,
      })
    ).toBeAttached()
  } else guard((await page.locator('html').getAttribute('lang')) === cell.language, 'R6_LANGUAGE')
  // Keep the document-language discrepancy visible without silently relabelling the UI cell.
  return {
    documentLanguageMatches: (await page.locator('html').getAttribute('lang')) === cell.language,
  }
}

/** Executed verbatim by evaluate and by the DOM self-tests. No driver closures. */
export function layoutFaultsInDocument(): string[] {
  const faults: string[] = []
  const scroller = document.scrollingElement ?? document.documentElement
  const edge = scroller.clientWidth
  if (scroller.scrollWidth > edge) faults.push('R6_OVERFLOW:document')
  const tableBox = (element: Element) =>
    element.matches('[role="region"]') && element.querySelector(':scope > table') !== null
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (element.closest('.sr-only')) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const box = element.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    const region = element.parentElement?.closest('[role="region"]')
    if (!(region && tableBox(region)) && (box.right > edge + 1 || box.left < -1))
      faults.push(`R6_OVERFLOW:${element.tagName}`)
    if (
      element.textContent?.trim() &&
      element.scrollHeight > element.clientHeight + 1 &&
      ['hidden', 'clip'].includes(style.overflowY) &&
      !element.matches('textarea, input, select, [contenteditable="true"]')
    )
      faults.push(`R6_VERTICAL_CLIPPING:${element.tagName}`)
    if (
      element.scrollWidth <= element.clientWidth + 1 ||
      tableBox(element) ||
      element.matches('input, textarea, select, [contenteditable="true"]')
    )
      continue
    if (style.overflowX === 'auto' || style.overflowX === 'scroll')
      faults.push(`R6_INNER_SCROLL:${element.tagName}`)
    if (['hidden', 'clip'].includes(style.overflowX) && style.textOverflow !== 'ellipsis')
      faults.push(`R6_CLIPPING:${element.tagName}`)
  }
  return faults
}
export async function layoutFaults(page: Page): Promise<string[]> {
  guard(VIEWPORT_WIDTHS.includes(page.viewportSize()?.width as VisualCell['width']), 'R6_VIEWPORT')
  return page.evaluate(layoutFaultsInDocument)
}
export function assertLayout(faults: readonly string[]) {
  guard(faults.length === 0, 'R6_OVERFLOW')
}

export interface RenderedFont {
  familyName: string
  isCustomFont: boolean
}
export function assertRenderedFont(fonts: readonly RenderedFont[], family: string) {
  guard(
    fonts.length === 1 &&
      fonts[0]?.isCustomFont &&
      (fonts[0].familyName === family || fonts[0].familyName.startsWith(`${family} `)),
    'R6_FONT_FAMILY_RENAMED'
  )
}
export async function renderedFonts(page: Page, locator: Locator): Promise<RenderedFont[]> {
  const { expect } = await loadAssertions()
  await expect(locator).toBeVisible()
  await locator.evaluate((element) => element.setAttribute('data-wave2-font-probe', ''))
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-wave2-font-probe]',
    })
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont }))
  } finally {
    await cdp.detach()
    await locator.evaluate((element) => element.removeAttribute('data-wave2-font-probe'))
  }
}
export interface FontScan {
  scanned: number
  missing: string[]
  sans: string
  mono: string
  negativeFacePresent: boolean
}
export function assertFontScan(scan: FontScan, requireMono = true) {
  guard(scan.scanned > 20, 'R6_FONT_VACUOUS_SCAN')
  guard(!scan.negativeFacePresent, 'R6_CHECK_NOT_DISCRIMINATING')
  guard(
    scan.sans === 'Inter Variable' && (!requireMono || scan.mono === 'IBM Plex Mono'),
    'R6_FONT_FAMILY_RENAMED'
  )
  guard(
    !scan.missing.some((item) => /^IBM Plex Mono 600\b/.test(item)),
    'R6_FONT_WEIGHT_SYNTHESIZED'
  )
  guard(!scan.missing.length, 'R6_FONT_ASSET_MISSING')
}
export function scanFontsInDocument(origin: VisualCell['origin']): FontScan {
  const unquote = (name: string) => name.trim().replace(/^["']|["']$/g, '')
  const faces: FontFace[] = []
  document.fonts.forEach((face) => {
    if (face.status === 'loaded') faces.push(face)
  })
  const missing = new Set<string>()
  const required: [string, number, string][] = [400, 500, 600, 700, 800].map((weight) => [
    'Inter Variable',
    weight,
    'normal',
  ])
  if (origin === 'web') required.push(['Inter Variable', 400, 'italic'])
  if (origin !== 'auth')
    required.push(['IBM Plex Mono', 400, 'normal'], ['IBM Plex Mono', 500, 'normal'])
  for (const [family, weight, style] of required)
    if (
      !faces.some((face) => {
        const [low = NaN, high = low] = face.weight
          .split(/\s+/)
          .map((value) => (value === 'normal' ? 400 : value === 'bold' ? 700 : Number(value)))
        return (
          unquote(face.family) === family && face.style === style && weight >= low && weight <= high
        )
      })
    )
      missing.add(`${family} ${weight} ${style}`)
  let scanned = 0
  const inspect = (element: Element, pseudo?: string) => {
    const style = getComputedStyle(element, pseudo)
    const family = unquote(style.fontFamily.split(',')[0] ?? '')
    const weight =
      style.fontWeight === 'normal'
        ? 400
        : style.fontWeight === 'bold'
          ? 700
          : Number(style.fontWeight)
    scanned++
    if (
      !faces.some((face) => {
        const [low = NaN, high = low] = face.weight
          .split(/\s+/)
          .map((value) => (value === 'normal' ? 400 : value === 'bold' ? 700 : Number(value)))
        return (
          unquote(face.family) === family &&
          face.style === style.fontStyle &&
          weight >= low &&
          weight <= high
        )
      })
    )
      missing.add(`${family} ${weight} ${style.fontStyle}`)
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() && node.parentElement?.checkVisibility())
      inspect(node.parentElement)
  }
  for (const element of document.querySelectorAll('body *')) {
    if (!element.checkVisibility()) continue
    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(element, pseudo).content
      if (content && !['none', 'normal', '""'].includes(content)) inspect(element, pseudo)
    }
  }
  const root = getComputedStyle(document.documentElement)
  return {
    scanned,
    missing: [...missing],
    sans: unquote(root.fontFamily.split(',')[0] ?? ''),
    mono: unquote(root.getPropertyValue('--font-mono').split(',')[0] ?? ''),
    negativeFacePresent: faces.some((face) => unquote(face.family) === 'Kodera No Such Family'),
  }
}
/** CSSOM rules work under style-src-attr restrictions and do not depend on utility classes. */
export function installFontProbesInDocument(requireMono: boolean): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(
    '[data-wave2-glyph-probe="sans"] { font-family: var(--font-sans); } [data-wave2-glyph-probe="mono"] { font-family: var(--font-mono); }'
  )
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  for (const family of requireMono ? ['sans', 'mono'] : ['sans']) {
    const probe = document.createElement('span')
    probe.dataset.wave2GlyphProbe = family
    probe.textContent = 'É\u202f’—012345'
    document.body.append(probe)
  }
}
export function removeFontProbesInDocument(): void {
  document.querySelectorAll('[data-wave2-glyph-probe]').forEach((element) => element.remove())
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
    (sheet) => !sheet.cssRules[0]?.cssText.includes('[data-wave2-glyph-probe=')
  )
}

export async function verifyFonts(
  page: Page,
  sans: Locator,
  mono?: Locator,
  origin: VisualCell['origin'] = 'web'
) {
  try {
    await page.evaluate(async (origin) => {
      const descriptors = [400, 500, 600, 700, 800].map(
        (weight) => `${weight} 16px "Inter Variable"`
      )
      if (origin === 'web') descriptors.push('italic 400 16px "Inter Variable"')
      if (origin !== 'auth')
        descriptors.push('400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"')
      await Promise.all(
        descriptors.map((descriptor) => document.fonts.load(descriptor, 'É\u202f’—012345'))
      )
      await document.fonts.ready
    }, origin)
  } catch {
    throw new Error('R6_FONT_ASSET_MISSING')
  }
  const scan = await page.evaluate(scanFontsInDocument, origin)
  assertRenderedFont(await renderedFonts(page, sans), 'Inter')
  if (origin !== 'auth') {
    guard(mono, 'R6_MONO_SAMPLE_MISSING')
    assertRenderedFont(await renderedFonts(page, mono), 'IBM Plex Mono')
  }
  assertFontScan(scan, origin !== 'auth')
  await page.evaluate(installFontProbesInDocument, origin !== 'auth')
  try {
    assertRenderedFont(
      await renderedFonts(page, page.locator('[data-wave2-glyph-probe="sans"]')),
      'Inter'
    )
    if (origin !== 'auth')
      assertRenderedFont(
        await renderedFonts(page, page.locator('[data-wave2-glyph-probe="mono"]')),
        'IBM Plex Mono'
      )
  } finally {
    await page.evaluate(removeFontProbesInDocument)
  }
  return {
    scanned: scan.scanned,
    identityMonoAsset: origin === 'auth' ? 'operator-pending' : 'verified',
  }
}
export function assertLocalFont(url: string, origin: string) {
  guard(new URL(url).origin === origin, 'R6_THIRD_PARTY_FONT')
}

export function assertTokenValues(values: Record<string, string>, expectedCount: number) {
  guard(Object.keys(values).length === expectedCount && expectedCount > 0, 'R6_TOKEN_COUNT')
  guard(
    Object.entries(values).every(
      ([key, value]) => key.startsWith('--') && value.trim() && !value.includes('var(')
    ),
    'R6_TOKEN_UNRESOLVED'
  )
}
export async function verifyTokenBinding(
  page: Page,
  cell: VisualCell,
  selector: string,
  foreground = '--c-ink',
  background = '--c-surface'
) {
  if (cell.origin === 'auth') {
    const bound = await page.evaluate((theme) => {
      const style = getComputedStyle(document.documentElement)
      const value = (name: string) => style.getPropertyValue(name).trim()
      return (
        ['bg', 'fg', 'brand-panel'].every((name) => value(`--lms-${name}`)) &&
        value('--lms-bg') === value(`--theme-${theme}-surface`) &&
        value('--lms-brand-panel') === value(`--theme-${theme}-action`) &&
        value('--pf-v5-global--FontFamily--text') === value('--font-sans') &&
        value('--pf-v5-global--FontFamily--heading') === value('--font-sans')
      )
    }, cell.theme)
    guard(bound, 'R6_TOKEN_BINDING')
    return
  }
  const result = await page.evaluate(
    ({ theme, selector, foreground, background }) => {
      const root = getComputedStyle(document.documentElement)
      const names = new Set<string>()
      const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText
              .split(',')
              .some((s) =>
                [
                  `[data-theme="${theme}"]`,
                  `[data-theme='${theme}']`,
                  `[data-theme=${theme}]`,
                ].includes(s.trim())
              )
          ) {
            for (const name of rule.style) if (name.startsWith('--')) names.add(name)
          }
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
        }
      }
      for (const sheet of document.styleSheets) walk(sheet.cssRules)
      const values = Object.fromEntries(
        [...names].map((name) => [name, root.getPropertyValue(name).trim()])
      )
      const element = document.querySelector(selector)
      if (!element) return { values, binding: false, anchor: false }
      const actual = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const painter = canvas.getContext('2d')!
      const ancestors: string[] = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        ancestors.unshift(getComputedStyle(parent).backgroundColor)
      const pixel = (layers: string[]) => {
        painter.clearRect(0, 0, 1, 1)
        for (const color of layers) {
          painter.fillStyle = color
          painter.fillRect(0, 0, 1, 1)
        }
        return [...painter.getImageData(0, 0, 1, 1).data].join(',')
      }
      const expectedFg = root.getPropertyValue(foreground).trim()
      const expectedBg = root.getPropertyValue(background).trim()
      const inverse = root.getPropertyValue('--c-inverse').trim()
      return {
        values,
        anchor:
          Boolean(inverse) &&
          pixel([inverse]) === (theme === 'dark' ? [7, 9, 13, 255] : [17, 24, 39, 255]).join(','),
        binding:
          Boolean(expectedFg && expectedBg) &&
          pixel([...ancestors, actual.backgroundColor]) === pixel([...ancestors, expectedBg]) &&
          pixel([...ancestors, actual.backgroundColor, actual.color]) ===
            pixel([...ancestors, expectedBg, expectedFg]),
      }
    },
    { theme: cell.theme, selector, foreground, background }
  )
  assertTokenValues(result.values, cell.origin === 'landing' ? 87 : 119)
  guard(result.binding, 'R6_TOKEN_BINDING')
  guard(result.anchor, 'R6_TOKEN_ANCHOR')
}

export function assertScreenshotOptions(options: PageScreenshotOptions) {
  guard(options.fullPage !== true, 'R6_FULLPAGE_BASELINE')
  guard(options.type !== 'jpeg', 'R6_LOSSY_BASELINE')
}
export async function viewportScreenshot(
  page: Page,
  cell: VisualCell,
  options: PageScreenshotOptions = {}
) {
  assertScreenshotOptions(options)
  guard(
    page.viewportSize()?.width === cell.width && page.viewportSize()?.height === cell.height,
    'R6_VIEWPORT'
  )
  await page.evaluate(() => document.fonts.ready)
  assertLayout(await layoutFaults(page))
  return page.screenshot({ ...options, fullPage: false, animations: 'disabled', type: 'png' })
}

export function assertA11yResult(
  result: { passes: readonly unknown[]; violations: readonly unknown[] },
  tags: readonly string[] = WCAG_TAGS
) {
  guard(JSON.stringify(tags) === JSON.stringify(WCAG_TAGS), 'A11Y_TAGSET')
  guard(result.passes.length > 10, 'A11Y_VACUOUS_SCAN')
  guard(result.violations.length === 0, 'A11Y_VIOLATIONS')
}
export async function verifyWcag(page: Page) {
  const { default: AxeBuilder } = await loadAxe()
  const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
  assertA11yResult(results)
}
export type TabOrder = readonly string[] | Readonly<Record<VisualCell['width'], readonly string[]>>
export function tabOrderForViewport(
  order: TabOrder,
  width: VisualCell['width']
): readonly string[] {
  const selectors = Array.isArray(order)
    ? order
    : (order as Readonly<Record<VisualCell['width'], readonly string[]>>)[width]
  guard(selectors?.length > 0, 'A11Y_VACUOUS_ORDER')
  return selectors
}

export function resetDocumentFocus(): void {
  const original = document.body.getAttribute('tabindex')
  document.body.setAttribute('tabindex', '-1')
  document.body.focus({ preventScroll: true })
  document.body.blur()
  if (original === null) document.body.removeAttribute('tabindex')
  else document.body.setAttribute('tabindex', original)
}

export async function verifySkipLink(page: Page, targetId: string) {
  const { expect } = await loadAssertions()
  await page.evaluate(resetDocumentFocus)
  const prior = await page.evaluate(() => ({ url: location.href, x: scrollX, y: scrollY }))
  try {
    const link = page.locator(`a[href="#${targetId}"]`)
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab')
      if (await link.evaluate((el) => el === document.activeElement)) break
    }
    await expect(link).toBeFocused()
    await expect(link).toBeInViewport()
    const box = await link.boundingBox()
    guard(
      box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width,
      'A11Y_SKIP_LINK_CLIPPED'
    )
    await page.keyboard.press('Enter')
    guard(
      await page.evaluate((id) => {
        const target = document.getElementById(id)
        return Boolean(target && target.contains(document.activeElement))
      }, targetId),
      'A11Y_SKIP_LINK_DEAD'
    )
  } finally {
    await page.evaluate((prior) => {
      history.replaceState(history.state, '', prior.url)
      window.scrollTo(prior.x, prior.y)
    }, prior)
    await page.evaluate(resetDocumentFocus)
  }
}
export async function verifyTabOrder(page: Page, selectors: readonly string[]) {
  const { expect } = await loadAssertions()
  await page.evaluate(resetDocumentFocus)
  guard(selectors.length > 0, 'A11Y_VACUOUS_ORDER')
  guard(
    await page
      .locator('[tabindex]')
      .evaluateAll((elements) => elements.every((el) => Number(el.getAttribute('tabindex')) <= 0)),
    'A11Y_ORDER_REORDERED'
  )
  const prior = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
  try {
    for (const selector of selectors) {
      await page.keyboard.press('Tab')
      const target = page.locator(selector)
      await expect(target).toBeFocused()
      guard(
        await target.evaluate((element) => {
          const style = getComputedStyle(element)
          const box = element.getBoundingClientRect()
          const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          return (
            (style.outlineStyle !== 'none' || style.boxShadow !== 'none') &&
            Boolean(top && (element.contains(top) || top.contains(element)))
          )
        }),
        'A11Y_FOCUS_OBSCURED'
      )
    }
  } finally {
    await page.evaluate((prior) => window.scrollTo(prior.x, prior.y), prior)
    await page.evaluate(resetDocumentFocus)
  }
}
export async function verifyDialog(page: Page, opener: Locator, dialog: Locator, tabStops: number) {
  const { expect } = await loadAssertions()
  guard(tabStops > 0 && tabStops <= 80, 'A11Y_DIALOG_STOPS')
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  for (const key of ['Tab', 'Shift+Tab'])
    for (let i = 0; i <= tabStops; i++) {
      guard(await dialog.evaluate((el) => el.contains(document.activeElement)), 'A11Y_TRAP_LEAK')
      await page.keyboard.press(key)
    }
  guard(await dialog.evaluate((el) => el.contains(document.activeElement)), 'A11Y_TRAP_LEAK')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  guard(await opener.evaluate((el) => el === document.activeElement), 'A11Y_FOCUS_STRANDED')
}
