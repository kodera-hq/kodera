/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { NARROW_LAYOUT_QUERY } from '../../src/app/layoutQuery'
import { decodePng } from '../visual/support/exactBaseline'
import { signIn } from './support/signIn'
import { useScenario as activateScenario } from './support/useScenario'

const SEARCH = 'Rechercher un nom ou un e-mail'

// The same WCAG text/non-text minima as action-roles.test.ts and the focus
// contract in 00-shell-and-login.md. Measure browser-resolved colours, not classes.
function channels(colour: string): number[] {
  const match = /^rgba?\(([^)]+)\)$/.exec(colour)
  if (match === null) throw new Error(`Unsupported resolved colour: ${colour}`)
  return match[1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
}

function opaque(colour: string) {
  const values = channels(colour)
  return values.length === 3 || (values.length === 4 && values[3] === 1)
}

function contrast(a: string, b: string) {
  const luminance = (colour: string) => {
    const [r = 0, g = 0, blue = 0] = channels(colour)
      .slice(0, 3)
      .map((value) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue
  }
  const high = Math.max(luminance(a), luminance(b))
  const low = Math.min(luminance(a), luminance(b))
  return (high + 0.05) / (low + 0.05)
}

async function measurement(control: Locator) {
  const seen = await control.evaluate((element) => {
    // TextField paints its composite parent; Select paints its own trigger.
    const frame = element.tagName === 'INPUT' ? element.parentElement : element
    const labels = Array.from(document.querySelectorAll('label')).filter(
      (candidate) => candidate.control === element && candidate.isConnected
    )
    const readiness = {
      connected: element.isConnected,
      id: element.id,
      tag: element.tagName,
      sameDocument: element.ownerDocument === document,
      frameConnected: frame?.isConnected ?? false,
      labelCount: labels.length,
    }
    if (
      !readiness.connected ||
      readiness.id === '' ||
      !readiness.sameDocument ||
      frame === null ||
      !frame.isConnected ||
      labels.length !== 1
    ) {
      throw new Error(`Unready or unassociated field measurement: ${JSON.stringify(readiness)}`)
    }
    const label = labels[0]!
    const style = getComputedStyle(frame)
    const box = frame.getBoundingClientRect()
    const clipFor = (node: Element) => {
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      let paints = true
      let opaqueAncestors = true
      let unclipped = true
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const css = getComputedStyle(at)
        paints &&= Number.parseFloat(css.opacity) > 0 && css.visibility === 'visible'
        opaqueAncestors &&= Number.parseFloat(css.opacity) === 1 && css.filter === 'none'
        // Overflow is modelled below. Other clipping/masking is unsupported:
        // an owning ancestor hit outside a clipped ring cannot prove paint.
        unclipped &&= css.clipPath === 'none' && css.maskImage === 'none' && css.clip === 'auto'
        if (at === node) continue
        const bounds = at.getBoundingClientRect()
        if (/(hidden|clip|scroll|auto)/.test(css.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left + at.clientLeft)
          clip.right = Math.min(clip.right, bounds.left + at.clientLeft + at.clientWidth)
        }
        if (/(hidden|clip|scroll|auto)/.test(css.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top + at.clientTop)
          clip.bottom = Math.min(clip.bottom, bounds.top + at.clientTop + at.clientHeight)
        }
      }
      return { ...clip, paints, opaqueAncestors, unclipped }
    }
    const clip = clipFor(frame)
    const inside = (x: number, y: number, bounds = clip) =>
      bounds.paints && x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
    const hit = (owner: Element, x: number, y: number, shadow = false) => {
      const top = document.elementFromPoint(x, y)
      return top !== null && (owner.contains(top) || (shadow && top.contains(owner)))
    }
    const labelClip = clipFor(label)
    const labelRects: DOMRect[] = []
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (text.textContent?.trim() === '') continue
      const range = document.createRange()
      range.selectNodeContents(text)
      labelRects.push(...Array.from(range.getClientRects()))
    }
    const labelReadable =
      labelRects.length > 0 &&
      labelRects.every(
        (rect) =>
          rect.left >= labelClip.left &&
          rect.right <= labelClip.right &&
          rect.top >= labelClip.top &&
          rect.bottom <= labelClip.bottom &&
          [0.25, 0.5, 0.75].every(
            (fraction) =>
              inside(rect.left + rect.width * fraction, rect.top + rect.height / 2, labelClip) &&
              hit(label, rect.left + rect.width * fraction, rect.top + rect.height / 2)
          )
      )
    const textPaint = (owner: Element, foreground = getComputedStyle(owner)) => {
      let backing = ''
      let supportedBacking = true
      for (let at: Element | null = owner; at !== null; at = at.parentElement) {
        const css = getComputedStyle(at)
        supportedBacking &&= css.backgroundImage === 'none'
        const components = css.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? []
        const alpha = components.length === 3 ? 1 : components[3]
        supportedBacking &&= alpha === 0 || alpha === 1
        if (backing === '' && alpha === 1) backing = css.backgroundColor
        if (at === frame) break
      }
      return {
        ownerTag: owner.tagName,
        colour: foreground.color,
        foregroundOpaque: Number.parseFloat(foreground.opacity) === 1,
        backing,
        supportedBacking: supportedBacking && backing !== '',
        clip: clipFor(owner),
      }
    }
    const controlText = []
    if (element instanceof HTMLInputElement) {
      const placeholder = element.matches(':placeholder-shown') && element.placeholder !== ''
      controlText.push({
        ...textPaint(element, getComputedStyle(element, placeholder ? '::placeholder' : null)),
        readable: controlBoxForInput(element),
      })
    } else {
      // Radix paints the closed value in a descendant span, not the trigger.
      const values = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let text = values.nextNode(); text !== null; text = values.nextNode()) {
        const owner = text.parentElement
        if (
          text.textContent?.trim() === '' ||
          owner === null ||
          owner.closest('[aria-hidden="true"]')
        )
          continue
        const paint = textPaint(owner)
        const range = document.createRange()
        range.selectNodeContents(text)
        const rects = Array.from(range.getClientRects())
        controlText.push({
          ...paint,
          readable:
            rects.length > 0 &&
            rects.every(
              (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= box.left &&
                rect.right <= box.right &&
                rect.top >= box.top &&
                rect.bottom <= box.bottom &&
                inside(rect.left + rect.width / 2, rect.top + rect.height / 2, paint.clip) &&
                hit(owner, rect.left + rect.width / 2, rect.top + rect.height / 2, true)
            ),
        })
      }
    }
    function controlBoxForInput(input: HTMLInputElement) {
      const bounds = input.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0 && (input.value || input.placeholder) !== ''
    }
    const declaredGrounds: string[] = []
    for (let at = frame.parentElement; at !== null; at = at.parentElement) {
      const css = getComputedStyle(at)
      if (css.backgroundImage !== 'none') {
        // As in the existing token contrast tests, every gradient stop is a
        // ground. These are resolved CSS stops, not a screenshot-pixel claim.
        declaredGrounds.push(...(css.backgroundImage.match(/rgba?\([^)]*\)/g) ?? []))
        break
      }
      if (!/^rgba\([^)]*,\s*0\)$/.test(css.backgroundColor)) {
        declaredGrounds.push(css.backgroundColor)
        break
      }
    }
    const ringToken =
      /(#[0-9a-f]+|rgba?\([^)]*\)|[a-z]+)\s*$/i.exec(
        style.getPropertyValue('--tw-ring-shadow').trim()
      )?.[1] ?? ''
    const probe = document.createElement('span')
    probe.style.cssText = 'display:none'
    probe.style.color = ringToken
    document.body.append(probe)
    const ringColour = ringToken === '' ? '' : getComputedStyle(probe).color
    probe.remove()
    const ringOffset = Number.parseFloat(style.getPropertyValue('--tw-ring-offset-width')) || 0
    const bands: { colour: string; inner: number; outer: number; visible: boolean }[] = []
    let coveredThrough = 0
    for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
      const colour = shadow.match(/rgba?\([^)]+\)/)?.[0]
      if (colour === undefined || /^rgba\([^)]*,\s*0\)$/.test(colour) || shadow.includes('inset'))
        continue
      const lengths = shadow.replace(colour, '').trim().split(/\s+/).map(Number.parseFloat)
      if (lengths[0] !== 0 || lengths[1] !== 0 || lengths[2] !== 0 || !(lengths[3]! > 0)) continue
      const outer = lengths[3]!
      const inner = Math.max(ringOffset, coveredThrough)
      if (colour === ringColour && outer > inner) {
        const distance = (inner + outer) / 2
        const half = (outer - inner) / 2
        // Reuse the exposed-band witnesses of order-feedback-accessibility:
        // inside the ring, excluding offset gaps and earlier painted shadows.
        const segments = [
          [-distance, box.height / 2, false],
          [box.width + distance, box.height / 2, false],
          [box.width / 2, -distance, true],
          [box.width / 2, box.height + distance, true],
        ] as const
        const visible = segments.some(([dx, dy, horizontal]) =>
          [-half, 0, half].every((offset) => {
            const x = box.left + dx + (horizontal ? offset : 0)
            const y = box.top + dy + (horizontal ? 0 : offset)
            return inside(x, y) && hit(frame, x, y, true)
          })
        )
        bands.push({ colour, inner, outer, visible })
      }
      coveredThrough = Math.max(coveredThrough, outer)
    }
    const controlBox = element.getBoundingClientRect()
    return {
      controlId: element.id,
      frameContainsControl: frame === element || frame.contains(element),
      composite: frame !== element,
      focused: document.activeElement === element,
      focusVisible: element.matches(':focus-visible'),
      focusWithin: frame.matches(':focus-within'),
      frameSeen:
        box.left >= clip.left &&
        box.right <= clip.right &&
        box.top >= clip.top &&
        box.bottom <= clip.bottom,
      controlHit:
        inside(controlBox.left + controlBox.width / 2, controlBox.top + controlBox.height / 2) &&
        hit(
          element,
          controlBox.left + controlBox.width / 2,
          controlBox.top + controlBox.height / 2
        ),
      labelReadable,
      labelColour: getComputedStyle(label).color,
      textColour: getComputedStyle(element).color,
      controlText,
      fill: style.backgroundColor,
      declaredGrounds,
      viewport: { width: innerWidth, height: innerHeight },
      cornerRadius: Math.max(
        ...[
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomLeftRadius,
          style.borderBottomRightRadius,
        ].map(Number.parseFloat)
      ),
      edges: ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
        const css = style as unknown as Record<string, string>
        return {
          colour: css[`border${side}Color`]!,
          width: Number.parseFloat(css[`border${side}Width`]!),
          style: css[`border${side}Style`]!,
        }
      }),
      bands,
      shadow: style.boxShadow,
      ringColour,
      signature: [style.boxShadow, style.outlineStyle, style.outlineWidth, style.outlineColor].join(
        '|'
      ),
      box: box.toJSON(),
      controlBox: controlBox.toJSON(),
      clip,
      labelClip,
      labelRects: labelRects.map((rect) => rect.toJSON()),
    }
  })
  // Global gradient stops are not necessarily adjacent to this field. Read
  // every pixel along the actual exposed straight-edge strips instead.
  // scale:css maps CSS coordinates only; it is not browser/text enlargement.
  const screenshot = decodePng(
    await control.page().screenshot({ scale: 'css', animations: 'disabled' })
  )
  expect(screenshot.width).toBe(seen.viewport.width)
  expect(screenshot.height).toBe(seen.viewport.height)
  expect(
    await control.evaluate((element) => ({ id: element.id, connected: element.isConnected })),
    'same connected control during paint capture'
  ).toEqual({ id: seen.controlId, connected: true })
  expect(
    await control.evaluate((element) =>
      (element.tagName === 'INPUT' ? element.parentElement! : element)
        .getBoundingClientRect()
        .toJSON()
    ),
    'frame geometry unchanged during paint capture'
  ).toEqual(seen.box)
  const outerExtent = Math.max(0, ...seen.bands.map((band) => band.outer))
  const inset = Math.ceil(seen.cornerRadius) + 1
  const strips: { owner: 'frame' | 'label'; side: string; points: { x: number; y: number }[] }[] =
    []
  const horizontal = (
    owner: 'frame' | 'label',
    side: string,
    left: number,
    right: number,
    y: number
  ) => {
    const points = []
    for (let x = Math.ceil(left); x < Math.floor(right); x += 1)
      points.push({ x, y: Math.floor(y) })
    strips.push({ owner, side, points })
  }
  const vertical = (side: string, top: number, bottom: number, x: number) => {
    const points = []
    for (let y = Math.ceil(top); y < Math.floor(bottom); y += 1)
      points.push({ x: Math.floor(x), y })
    strips.push({ owner: 'frame', side, points })
  }
  const { box } = seen
  horizontal(
    'frame',
    'top',
    box.left + inset,
    box.right - inset,
    Math.floor(box.top - outerExtent) - 1
  )
  horizontal(
    'frame',
    'bottom',
    box.left + inset,
    box.right - inset,
    Math.ceil(box.bottom + outerExtent)
  )
  vertical('left', box.top + inset, box.bottom - inset, Math.floor(box.left - outerExtent) - 1)
  vertical('right', box.top + inset, box.bottom - inset, Math.ceil(box.right + outerExtent))
  for (const rect of seen.labelRects)
    horizontal('label', 'below text range', rect.left, rect.right, rect.bottom + 1)
  const ownership = await control.evaluate((element, groups) => {
    const frame = element.tagName === 'INPUT' ? element.parentElement! : element
    const label = Array.from(document.querySelectorAll('label')).find(
      (node) => node.htmlFor === element.id
    )!
    return groups.map((group) =>
      group.points.map(({ x, y }) => {
        const top = document.elementFromPoint(x + 0.5, y + 0.5)
        const owner = group.owner === 'frame' ? frame : label
        // Ground witnesses may hit the owning ancestor (or the label's own
        // line box), never a neighbouring control or unrelated overlay.
        return (
          top !== null && (top.contains(owner) || (group.owner === 'label' && owner.contains(top)))
        )
      })
    )
  }, strips)
  const local = strips.map((strip, index) => {
    const colours = new Set<string>()
    let allSamplesValid = strip.points.length > 0
    for (const [at, point] of strip.points.entries()) {
      const valid =
        point.x >= 0 &&
        point.y >= 0 &&
        point.x < screenshot.width &&
        point.y < screenshot.height &&
        ownership[index]![at] === true
      allSamplesValid &&= valid
      if (!valid) continue
      const offset = (point.y * screenshot.width + point.x) * 4
      expect(screenshot.rgba[offset + 3], 'opaque screenshot backing pixel').toBe(255)
      colours.add(
        `rgb(${screenshot.rgba[offset]}, ${screenshot.rgba[offset + 1]}, ${screenshot.rgba[offset + 2]})`
      )
    }
    return {
      owner: strip.owner,
      side: strip.side,
      first: strip.points[0],
      last: strip.points.at(-1),
      count: strip.points.length,
      allSamplesValid,
      colours: [...colours],
    }
  })
  return {
    ...seen,
    adjacentStrips: local,
    grounds: [
      ...new Set(
        local.filter((strip) => strip.owner === 'frame').flatMap((strip) => strip.colours)
      ),
    ],
    labelGrounds: [
      ...new Set(
        local.filter((strip) => strip.owner === 'label').flatMap((strip) => strip.colours)
      ),
    ],
  }
}

async function assertBoundary(control: Locator) {
  const seen = await measurement(control)
  await test.info().attach('painted-boundary-probe', {
    body: JSON.stringify(seen),
    contentType: 'application/json',
  })
  expect(seen.frameContainsControl, 'painted frame owns the control').toBe(true)
  expect(
    seen.clip.unclipped &&
      seen.labelClip.unclipped &&
      seen.controlText.every((text) => text.clip.unclipped),
    'supported unclipped paint path'
  ).toBe(true)
  // Uncomposited foreground math is qualified only for opaque paint owners.
  expect(
    seen.clip.opaqueAncestors && seen.labelClip.opaqueAncestors,
    'supported opaque ancestor paint'
  ).toBe(true)
  expect(seen.frameSeen, 'whole painted frame inside visible ancestor clips').toBe(true)
  expect(seen.controlHit, 'control centre is reachable and uncovered').toBe(true)
  expect(seen.labelReadable, 'standing label is readable and uncovered').toBe(true)
  expect(
    seen.adjacentStrips.every((strip) => strip.allSamplesValid),
    'local ground strips are visible and free of unrelated controls/overlays'
  ).toBe(true)
  expect(
    seen.edges.every((edge) => edge.width > 0 && edge.style === 'solid' && opaque(edge.colour)),
    'painted field boundary'
  ).toBe(true)
  expect(opaque(seen.fill), 'opaque actual field fill').toBe(true)
  expect(opaque(seen.labelColour), 'painted standing label text').toBe(true)
  expect(opaque(seen.textColour), 'painted control text').toBe(true)
  expect(seen.controlText.length, 'actual control text owner found').toBeGreaterThan(0)
  expect(
    seen.controlText.every(
      (text) => text.clip.paints && text.clip.opaqueAncestors && text.foregroundOpaque
    ),
    'supported opaque control text paint'
  ).toBe(true)
  for (const text of seen.controlText) {
    expect(text.readable, 'actual control text is exposed').toBe(true)
    expect(text.supportedBacking, 'supported control text backing').toBe(true)
    expect(opaque(text.colour), 'opaque actual control foreground').toBe(true)
    expect(contrast(text.colour, text.backing), 'control text contrast').toBeGreaterThanOrEqual(4.5)
  }
  expect(seen.grounds.length, 'actual adjacent ground found').toBeGreaterThan(0)
  for (const ground of seen.labelGrounds) {
    expect(opaque(ground)).toBe(true)
    expect(
      contrast(seen.labelColour, ground),
      'standing label text contrast'
    ).toBeGreaterThanOrEqual(4.5)
  }
  for (const ground of seen.grounds) {
    expect(opaque(ground)).toBe(true)
    for (const edge of seen.edges)
      expect(contrast(edge.colour, ground), 'boundary contrast outside').toBeGreaterThanOrEqual(3)
  }
  for (const edge of seen.edges)
    expect(contrast(edge.colour, seen.fill), 'boundary contrast inside').toBeGreaterThanOrEqual(3)
  return seen
}

async function assertFocus(control: Locator, resting: string) {
  const seen = await assertBoundary(control)
  expect(seen.focused, 'actual input/trigger keyboard focus').toBe(true)
  expect(seen.focusVisible, 'input/trigger focus-visible').toBe(true)
  expect(seen.focusWithin, 'painted frame contains focus').toBe(true)
  expect(seen.signature, 'focus-specific frame signature').not.toBe(resting)
  expect(seen.bands.length > 0, 'painted focus ring').toBe(true)
  expect(
    seen.bands.some((band) => band.visible),
    'uncovered exposed ring witness'
  ).toBe(true)
  for (const band of seen.bands) {
    expect(opaque(band.colour)).toBe(true)
    for (const ground of [seen.fill, ...seen.grounds])
      expect(contrast(band.colour, ground), 'ring contrast on both grounds').toBeGreaterThanOrEqual(
        3
      )
  }
  return seen
}

async function openPeople(page: Page, theme: string) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await activateScenario(page, ['shell.single-organisation', 'people.default'])
  await signIn(page, 'acme-sa', '/appearance')
  await page.getByRole('radio', { name: theme, exact: true }).click()
  await page.getByRole('link', { name: 'Personnes', exact: true }).click()
  await expect(
    page.getByRole('table', { name: 'Personnes' }).getByRole('row', { name: /Marc Petit/ })
  ).toBeVisible()
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready
      const faces = (
        await Promise.all(
          [400, 500].map((weight) => document.fonts.load(`${weight} 16px "Plus Jakarta Sans"`))
        )
      ).flat()
      return faces.length > 0 && faces.every((face) => face.status === 'loaded')
    }),
    'canonical bundled font loaded'
  ).toBe(true)
}

for (const [theme, label] of [
  ['light', 'Clair'],
  ['dark', 'Sombre'],
  ['black', 'Noir'],
] as const) {
  for (const width of [1440, 320]) {
    test(`people painted fields: ${theme} at ${width}px`, async ({ page }, info) => {
      await openPeople(page, label)
      await page.setViewportSize({ width, height: 1000 })
      await expect
        .poll(() => page.evaluate((query) => matchMedia(query).matches, NARROW_LAYOUT_QUERY))
        .toBe(width === 320)
      const modules = page.locator('nav[aria-label="Modules"]')
      const tabs = page.getByRole('navigation', { name: 'Navigation par onglets' })
      if (width === 320) {
        await expect(modules).toHaveCount(0)
        await expect(tabs).toBeVisible()
      } else {
        await expect(modules).toBeVisible()
        await expect(tabs).toHaveCount(0)
      }
      const search = page.getByRole('searchbox', { name: SEARCH })
      const filter = page.getByRole('combobox', { name: 'Rôle', exact: true })
      for (const control of [search, filter]) {
        await expect(control).toHaveCount(1)
        await expect(control).toBeVisible()
        await expect(control).toHaveAttribute('id', /.+/)
      }
      await expect(
        page.getByRole('table', { name: 'Personnes' }).getByRole('row', { name: /Marc Petit/ })
      ).toBeVisible()
      const idle = await assertBoundary(search)
      const filterIdle = await assertBoundary(filter)
      expect(idle.composite).toBe(true)
      expect(filterIdle.composite).toBe(false)
      if (width === 320) {
        for (const seen of [idle, filterIdle]) {
          expect(seen.controlBox.width).toBeGreaterThanOrEqual(44)
          expect(seen.controlBox.height).toBeGreaterThanOrEqual(44)
        }
      }
      // Noneditable page context: the actual slash shortcut must focus the input.
      await page.getByRole('heading', { name: 'Personnes', exact: true }).click()
      await page.keyboard.press('/')
      await expect(search).toBeFocused()
      const focused = await assertFocus(search, idle.signature)
      await search.fill('Petit')
      const table = page.getByRole('table', { name: 'Personnes' })
      await expect(table.getByRole('rowheader')).toHaveCount(1)
      await expect(table.getByRole('row', { name: /Marc Petit/ })).toBeVisible()
      await expect(search).toHaveValue('Petit')
      await assertFocus(search, idle.signature)
      await search.press('Escape')
      await expect(search).toHaveValue('')
      await expect(table.getByRole('rowheader')).toHaveCount(7)
      await page.keyboard.press('Tab')
      await expect(filter).toBeFocused()
      await assertFocus(filter, filterIdle.signature)
      await filter.press('Enter')
      await expect(page.getByRole('listbox')).toBeVisible()
      await expect(page.getByRole('option', { name: 'Toutes', exact: true })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('option', { name: 'Admins', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(filter).toBeFocused()
      await expect(filter).toContainText('Admins')
      await expect(table.getByRole('row', { name: /Marc Petit/ })).toHaveCount(0)
      const own = table.getByRole('row', { name: /Julie Marchand/ })
      await expect(own).toBeVisible()
      await expect(own.getByRole('button', { name: /^Actions pour/ })).toHaveCount(0)
      await filter.press('Enter')
      await expect(page.getByRole('listbox')).toBeVisible()
      await expect(page.getByRole('option', { name: 'Admins', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(filter).toBeFocused()
      await expect(filter).toContainText('Admins')
      await assertFocus(filter, filterIdle.signature)
      await filter.press('Enter')
      await expect(page.getByRole('listbox')).toBeVisible()
      await expect(page.getByRole('option', { name: 'Admins', exact: true })).toBeFocused()
      await page.keyboard.press('Home')
      await expect(page.getByRole('option', { name: 'Toutes', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(filter).toContainText('Toutes')
      await expect(table.getByRole('rowheader')).toHaveCount(7)
      await expect(filter).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(search).toBeFocused()
      await search.fill('zzznomatch')
      await expect(page.getByText('Aucune personne ne correspond à « zzznomatch ».')).toBeVisible()
      await page.getByRole('button', { name: 'Effacer la recherche', exact: true }).click()
      await expect(search).toHaveValue('')
      await expect(table.getByRole('rowheader')).toHaveCount(7)
      await page.getByRole('heading', { name: 'Personnes', exact: true }).click()
      await page.keyboard.press('/')
      await expect(search).toBeFocused()
      await assertFocus(search, idle.signature)
      await info.attach('painted-field-measurements', {
        body: JSON.stringify({ idle, focused, filterIdle }, null, 2),
        contentType: 'application/json',
      })
      await info.attach('people-fields-focus', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
    })
  }
}

test('people painted fields: boundary and ring losses are independently refused and restored', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPeople(page, 'Clair')
  const search = page.getByRole('searchbox', { name: SEARCH })
  const frame = search.locator('..')
  const idle = await assertBoundary(search)
  const original = await frame.getAttribute('style')
  const refusals: Record<string, unknown> = {}
  const restore = () =>
    frame.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, original)
  try {
    await frame.evaluate((element) => {
      const node = element as HTMLElement
      node.style.setProperty('transition', 'none', 'important')
      node.style.setProperty('border-color', 'transparent', 'important')
    })
    await expect(search).toBeVisible()
    await expect(page.getByText(SEARCH, { exact: true })).toBeVisible()
    refusals.transparentBoundary = await measurement(search)
    await expect(assertBoundary(search)).rejects.toThrow('painted field boundary')
  } finally {
    await restore()
  }
  await expect
    .poll(async () => (await measurement(search)).edges.every((edge) => opaque(edge.colour)))
    .toBe(true)
  const restoredBoundary = await assertBoundary(search)
  await page.getByRole('heading', { name: 'Personnes', exact: true }).click()
  await page.keyboard.press('/')
  await expect(search).toBeFocused()
  const focused = await assertFocus(search, idle.signature)
  const shadows = focused.shadow.split(/,(?![^(]*\))/)
  const ring = shadows.findIndex((layer) => layer.includes(focused.ringColour))
  expect(ring).toBeGreaterThanOrEqual(0)
  try {
    await frame.evaluate((element, index) => {
      const layers = getComputedStyle(element).boxShadow.split(/,(?![^(]*\))/)
      layers[index] = layers[index]!.replace(/rgba?\([^)]+\)/, 'rgba(0, 0, 0, 0)')
      ;(element as HTMLElement).style.setProperty('box-shadow', layers.join(','), 'important')
    }, ring)
    await expect(search).toBeFocused()
    const lost = await measurement(search)
    refusals.transparentRing = lost
    expect(lost.labelReadable).toBe(true)
    expect(lost.shadow.split(/,(?![^(]*\))/).filter((_, index) => index !== ring)).toEqual(
      shadows.filter((_, index) => index !== ring)
    )
    await expect(assertFocus(search, idle.signature)).rejects.toThrow('painted focus ring')
  } finally {
    await restore()
  }
  const restoredFocus = await assertFocus(search, idle.signature)
  await info.attach('intended-loss-restored-controls', {
    body: JSON.stringify({ refusals, restoredBoundary, focused, restoredFocus }, null, 2),
    contentType: 'application/json',
  })
})

for (const loss of ['input opacity', 'value opacity', 'input backing', 'ring clip'] as const) {
  test(`people painted fields: paint owner loss ${loss} is refused and restored`, async ({
    page,
  }, info) => {
    await openPeople(page, 'Clair')
    const search = page.getByRole('searchbox', { name: SEARCH })
    const filter = page.getByRole('combobox', { name: 'Rôle', exact: true })
    const control = loss === 'value opacity' ? filter : search
    const idle = await assertBoundary(control)
    await page.getByRole('heading', { name: 'Personnes', exact: true }).click()
    await page.keyboard.press('/')
    await search.fill('Petit')
    if (loss === 'value opacity') {
      await search.press('Escape')
      await page.keyboard.press('Tab')
    }
    await expect(control).toBeFocused()
    const before = await assertFocus(control, idle.signature)
    const target =
      loss === 'value opacity'
        ? filter.getByText('Toutes', { exact: true })
        : loss === 'ring clip'
          ? search.locator('..')
          : search
    const original = await target.getAttribute('style')
    const intended =
      loss === 'ring clip'
        ? 'supported unclipped paint path'
        : loss === 'input backing'
          ? 'control text contrast'
          : 'supported opaque control text paint'
    let lost: Awaited<ReturnType<typeof measurement>> | undefined
    try {
      await target.evaluate((element, change) => {
        const node = element as HTMLElement
        if (change === 'ring clip') node.style.setProperty('clip-path', 'inset(0)', 'important')
        else if (change === 'input backing')
          node.style.setProperty('background-color', getComputedStyle(node).color, 'important')
        else node.style.setProperty('opacity', '0', 'important')
      }, loss)
      await expect(search).toBeVisible()
      await expect(page.getByText(SEARCH, { exact: true })).toBeVisible()
      await expect(control).toBeFocused()
      lost = await measurement(control)
      expect(lost.shadow).toBe(before.shadow)
      expect(lost.labelReadable).toBe(true)
      await info.attach('paint-owner-loss', {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      await expect(assertFocus(control, idle.signature)).rejects.toThrow(intended)
    } finally {
      await target.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, original)
      expect(await target.getAttribute('style')).toBe(original)
      const restored = await assertFocus(control, idle.signature)
      expect(restored.shadow).toBe(before.shadow)
      expect(restored.textColour).toBe(before.textColour)
      await info.attach('paint-owner-loss-restored-control', {
        body: JSON.stringify({ loss, intended, original, before, lost, restored }, null, 2),
        contentType: 'application/json',
      })
    }
  })
}
