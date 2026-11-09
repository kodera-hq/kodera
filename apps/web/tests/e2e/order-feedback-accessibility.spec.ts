/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { useScenario as activateScenario } from './support/useScenario'
import { NARROW_LAYOUT_QUERY } from '../../src/app/layoutQuery'

type View = 'portrait' | 'landscape' | 'enlarged' | 'long-content'
type Feedback = 'empty' | 'error'

// Coarse-pointer landscape is part of the real narrow-layout contract. Keep
// the inherited project colour scheme, locale and installed browser.
test.use({ hasTouch: true })

async function focusMeasurement(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    const header = document.querySelector('header')!
    const tabs = document.querySelector('nav[aria-label="Navigation par onglets"]')!
    const inBar = header.contains(element) || tabs.contains(element)
    const clip = {
      left: 0,
      right: window.innerWidth,
      top: inBar ? 0 : header.getBoundingClientRect().bottom,
      bottom: inBar ? window.innerHeight : tabs.getBoundingClientRect().top,
    }
    let ancestorsPaint = true
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent)
      ancestorsPaint &&=
        Number.parseFloat(parentStyle.opacity) > 0 && parentStyle.visibility === 'visible'
      const bounds = parent.getBoundingClientRect()
      if (/(hidden|clip|scroll|auto)/.test(parentStyle.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + parent.clientLeft)
        clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth)
      }
      if (/(hidden|clip|scroll|auto)/.test(parentStyle.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + parent.clientTop)
        clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight)
      }
    }
    const inside = (x: number, y: number) =>
      x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom
    const labelUncovered = (x: number, y: number) => {
      const top = document.elementFromPoint(x, y)
      return top !== null && (top === element || element.contains(top))
    }
    const ringUncovered = (x: number, y: number) => {
      const top = document.elementFromPoint(x, y)
      // A shadow is painted outside the hit-test box. The owning ancestor
      // may be hit there; an unrelated overlay or sibling may not.
      return top !== null && (top === element || element.contains(top) || top.contains(element))
    }
    const labels: { left: number; right: number; top: number; bottom: number }[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (text.textContent?.trim() === '') continue
      const range = document.createRange()
      range.selectNodeContents(text)
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) labels.push(rect.toJSON())
      }
    }
    const labelReadable =
      ancestorsPaint &&
      labels.length > 0 &&
      labels.every(
        (rect) =>
          rect.left >= clip.left &&
          rect.right <= clip.right &&
          rect.top >= clip.top &&
          rect.bottom <= clip.bottom &&
          [0.25, 0.5, 0.75].every((fraction) =>
            labelUncovered(
              rect.left + (rect.right - rect.left) * fraction,
              (rect.top + rect.bottom) / 2
            )
          )
      )
    const hasPaint = (colour: string) => {
      const rgb = colour.match(/^rgba?\(([^)]+)\)$/)
      if (rgb === null) return false
      const values = rgb[1]!
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number)
      return values.length === 3 || (values.length === 4 && values[3]! > 0)
    }
    // The ground-colored offset is a gap, not the focus indicator. Resolve
    // the actual ring color using the browser's color serialization so only
    // its painted layer qualifies. This inert probe never receives focus.
    // The color is read off `--tw-ring-shadow`, the ring layer itself, where
    // the browser has already resolved it: Tailwind 4 leaves `--tw-ring-color`
    // unset unless a ring-color class sets it, and the ring then falls back to
    // the default ring color, so the variable alone would name no color.
    const ringToken =
      /(#[0-9a-f]+|rgba?\([^)]*\)|[a-z]+)\s*$/i
        .exec(style.getPropertyValue('--tw-ring-shadow').trim())?.[1]
        ?.trim() ?? ''
    const colourProbe = document.createElement('span')
    colourProbe.style.cssText = 'display:none'
    colourProbe.style.color = ringToken
    document.body.append(colourProbe)
    const ringColour = ringToken === '' ? '' : getComputedStyle(colourProbe).color
    colourProbe.remove()
    const ringOffset = Number.parseFloat(style.getPropertyValue('--tw-ring-offset-width')) || 0
    const bands: { kind: 'ring' | 'outline'; inner: number; outer: number }[] = []
    let coveredThrough = 0
    // CSS paints earlier shadows in front of later ones. Only support the
    // token's zero-offset, zero-blur geometry; exclude every ground layer.
    for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
      const colour = shadow.match(/rgba?\([^)]+\)/)?.[0]
      if (colour === undefined || !hasPaint(colour) || shadow.includes('inset')) continue
      const lengths = shadow.replace(colour, '').trim().split(/\s+/).map(Number.parseFloat)
      if (lengths[0] !== 0 || lengths[1] !== 0 || lengths[2] !== 0 || !(lengths[3]! > 0)) {
        continue
      }
      const outer = lengths[3]!
      const inner = Math.max(ringOffset, coveredThrough)
      if (colour === ringColour && outer > inner) bands.push({ kind: 'ring', inner, outer })
      // Conservatively exclude earlier painted layers, including translucent
      // ones: these tests claim an exposed ring witness, not compositing proof.
      coveredThrough = Math.max(coveredThrough, outer)
    }
    const outlineWidth = Number.parseFloat(style.outlineWidth)
    const outlineOffset = Number.parseFloat(style.outlineOffset)
    if (
      style.outlineStyle === 'solid' &&
      outlineWidth > 0 &&
      hasPaint(style.outlineColor) &&
      outlineOffset >= 0
    ) {
      bands.push({ kind: 'outline', inner: outlineOffset, outer: outlineOffset + outlineWidth })
    }
    // Sample strictly within exposed paint, not in the offset gap or on its
    // boundary. For the Retry token band (2,4), the witness lies at distance3.
    const bandSamples = bands.map((band) => {
      const distance = (band.inner + band.outer) / 2
      const segmentHalf = (band.outer - band.inner) / 2
      const segments = [
        [
          [box.left - distance, box.top + box.height / 2 - segmentHalf],
          [box.left - distance, box.top + box.height / 2],
          [box.left - distance, box.top + box.height / 2 + segmentHalf],
        ],
        [
          [box.right + distance, box.top + box.height / 2 - segmentHalf],
          [box.right + distance, box.top + box.height / 2],
          [box.right + distance, box.top + box.height / 2 + segmentHalf],
        ],
        [
          [box.left + box.width / 2 - segmentHalf, box.top - distance],
          [box.left + box.width / 2, box.top - distance],
          [box.left + box.width / 2 + segmentHalf, box.top - distance],
        ],
        [
          [box.left + box.width / 2 - segmentHalf, box.bottom + distance],
          [box.left + box.width / 2, box.bottom + distance],
          [box.left + box.width / 2 + segmentHalf, box.bottom + distance],
        ],
      ]
      return {
        ...band,
        distance,
        segments,
        visible: segments.some((points) =>
          points.every(([x, y]) => inside(x!, y!) && ringUncovered(x!, y!))
        ),
      }
    })
    const indicatorVisible = ancestorsPaint && bandSamples.some((band) => band.visible)
    return {
      focused: element === document.activeElement,
      focusVisible: element.matches(':focus-visible'),
      seen:
        box.bottom > clip.top &&
        box.top < clip.bottom &&
        box.right > clip.left &&
        box.left < clip.right,
      labelReadable,
      indicatorPaint: bands.length > 0,
      ringColour,
      ringOffset,
      bandSamples,
      indicatorVisible,
      signature: [style.boxShadow, style.outlineStyle, style.outlineWidth, style.outlineColor].join(
        '|'
      ),
      shadow: style.boxShadow,
      box: box.toJSON(),
      clip,
      labels,
    }
  })
}

async function assertFocused(target: Locator, restingSignature: string) {
  const measured = await focusMeasurement(target)
  expect(measured.focused, 'actual keyboard focus').toBe(true)
  expect(measured.focusVisible, 'keyboard focus-visible state').toBe(true)
  expect(measured.seen, 'control not totally clipped by viewport, bars or ancestor').toBe(true)
  expect(measured.labelReadable, 'focus label readable and uncovered').toBe(true)
  expect(measured.indicatorPaint, 'nontransparent focus indicator').toBe(true)
  expect(measured.signature, 'focus-specific indicator differs from resting style').not.toBe(
    restingSignature
  )
  expect(measured.indicatorVisible, 'visible uncovered portion of focus indicator').toBe(true)
  return measured
}

async function tabTo(page: Page, target: Locator) {
  const resting = await focusMeasurement(target)
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((element) => element === document.activeElement)) break
  }
  await assertFocused(target, resting.signature)
  return resting.signature
}

async function proveFocusRefusals(page: Page, target: Locator, restingSignature: string) {
  const before = await assertFocused(target, restingSignature)
  const styleBefore = await target.getAttribute('style')
  const evidence: Record<string, unknown> = { before }
  // Keep the ground/offset layer and every other layer, and hide only the
  // token-colored ring, found by its color rather than its position: Tailwind 4
  // puts two transparent layers ahead of the offset and the ring.
  const ringLayer = before.shadow
    .split(/,(?![^(]*\))/)
    .findIndex((layer) => layer.includes(before.ringColour))
  expect(before.ringColour).not.toBe('')
  expect(ringLayer).toBeGreaterThan(0)
  try {
    await target.evaluate((element, index) => {
      const node = element as HTMLElement
      const shadows = getComputedStyle(node).boxShadow.split(/,(?![^(]*\))/)
      shadows[index] = shadows[index]!.replace(/rgba?\([^)]+\)/, 'rgba(0, 0, 0, 0)')
      node.style.setProperty('box-shadow', shadows.join(','), 'important')
    }, ringLayer)
    const ringOnly = await focusMeasurement(target)
    evidence.ringOnlyTransparent = ringOnly
    await test.info().attach('ring-only-measurement', {
      body: JSON.stringify(ringOnly, null, 2),
      contentType: 'application/json',
    })
    expect(ringOnly.focused).toBe(true)
    expect(ringOnly.labelReadable).toBe(true)
    const layersBefore = before.shadow.split(/,(?![^(]*\))/)
    const layersAfter = ringOnly.shadow.split(/,(?![^(]*\))/)
    expect(layersAfter.filter((_, index) => index !== ringLayer)).toEqual(
      layersBefore.filter((_, index) => index !== ringLayer)
    )
    expect(layersAfter[ringLayer]).not.toBe(layersBefore[ringLayer])
    await expect(assertFocused(target, restingSignature)).rejects.toThrow(
      'nontransparent focus indicator'
    )
  } finally {
    await target.evaluate((element, original) => {
      if (original === null) element.removeAttribute('style')
      else element.setAttribute('style', original)
    }, styleBefore)
  }
  const ringBand = before.bandSamples.find((band) => band.kind === 'ring')!
  expect(ringBand.inner).toBe(before.ringOffset)
  expect(ringBand.inner).toBeGreaterThan(0)
  expect(ringBand.distance).toBeGreaterThan(ringBand.inner)
  expect(ringBand.distance).toBeLessThan(ringBand.outer)
  const ringCover = await page.evaluateHandle(
    ({ box, band }) => {
      const group = document.createElement('div')
      const inner = {
        left: box.left - band.inner,
        right: box.right + band.inner,
        top: box.top - band.inner,
        bottom: box.bottom + band.inner,
      }
      const outer = {
        left: box.left - band.outer,
        right: box.right + band.outer,
        top: box.top - band.outer,
        bottom: box.bottom + band.outer,
      }
      const strips = [
        [outer.left, outer.top, outer.right - outer.left, inner.top - outer.top],
        [outer.left, inner.bottom, outer.right - outer.left, outer.bottom - inner.bottom],
        [outer.left, inner.top, inner.left - outer.left, inner.bottom - inner.top],
        [inner.right, inner.top, outer.right - inner.right, inner.bottom - inner.top],
      ]
      for (const [left, top, width, height] of strips) {
        const strip = document.createElement('div')
        strip.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:2147483647;background:Canvas`
        group.append(strip)
      }
      document.body.append(group)
      return group
    },
    { box: before.box, band: ringBand }
  )
  try {
    const covered = await focusMeasurement(target)
    evidence.ringOnlyCovered = covered
    expect(covered.focused).toBe(true)
    expect(covered.labelReadable).toBe(true)
    expect(covered.shadow).toBe(before.shadow)
    expect(covered.indicatorPaint).toBe(true)
    await expect(assertFocused(target, restingSignature)).rejects.toThrow(
      'visible uncovered portion of focus indicator'
    )
  } finally {
    await ringCover.evaluate((element) => element.remove())
    await ringCover.dispose()
  }
  await assertFocused(target, restingSignature)
  const cover = await page.evaluateHandle(() => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:Canvas'
    document.body.append(overlay)
    return overlay
  })
  try {
    await expect(target).toBeFocused()
    evidence.obscured = await focusMeasurement(target)
    await expect(assertFocused(target, restingSignature)).rejects.toThrow(
      'focus label readable and uncovered'
    )
  } finally {
    await cover.evaluate((element) => element.remove())
    await cover.dispose()
  }
  // A ring drawn in a transparent ring color is no indicator either, however
  // the color reaches it: through the variable a ring-color class sets.
  try {
    await target.evaluate((element) => {
      ;(element as HTMLElement).style.setProperty(
        '--tw-ring-color',
        'rgba(0, 0, 0, 0)',
        'important'
      )
    })
    await expect(target).toBeFocused()
    evidence.transparentRingColour = await focusMeasurement(target)
    await expect(assertFocused(target, restingSignature)).rejects.toThrow(
      'nontransparent focus indicator'
    )
  } finally {
    await target.evaluate((element, original) => {
      if (original === null) element.removeAttribute('style')
      else element.setAttribute('style', original)
    }, styleBefore)
  }
  for (const paint of ['none', '0px 0px 0px 3px rgba(0, 0, 0, 0)']) {
    try {
      await target.evaluate((element, shadow) => {
        const node = element as HTMLElement
        node.style.setProperty('box-shadow', shadow, 'important')
        node.style.setProperty('outline', 'none', 'important')
      }, paint)
      await expect(target).toBeFocused()
      evidence[paint] = await focusMeasurement(target)
      await expect(assertFocused(target, restingSignature)).rejects.toThrow(
        'nontransparent focus indicator'
      )
    } finally {
      await target.evaluate((element, original) => {
        if (original === null) element.removeAttribute('style')
        else element.setAttribute('style', original)
      }, styleBefore)
    }
  }
  // An ancestor clip must also be refused, without moving keyboard focus.
  const parent = target.locator('..')
  const parentStyle = await parent.getAttribute('style')
  try {
    await parent.evaluate((element) => {
      const node = element as HTMLElement
      node.style.setProperty('overflow', 'hidden', 'important')
      node.style.setProperty('max-height', '0px', 'important')
    })
    await expect(target).toBeFocused()
    evidence.clipped = await focusMeasurement(target)
    await expect(assertFocused(target, restingSignature)).rejects.toThrow(
      /control not totally clipped|focus label readable/
    )
  } finally {
    await parent.evaluate((element, original) => {
      if (original === null) element.removeAttribute('style')
      else element.setAttribute('style', original)
    }, parentStyle)
  }
  expect(await target.getAttribute('style')).toBe(styleBefore)
  expect(await parent.getAttribute('style')).toBe(parentStyle)
  evidence.restored = await assertFocused(target, restingSignature)
  await test.info().attach('focus-refusal-and-restoration', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
}

async function expectReadable(page: Page, text: Locator) {
  await expect(text).toBeVisible()
  const lines = await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return Array.from(range.getClientRects()).map((rect) => ({
      left: rect.left,
      right: rect.right,
    }))
  })
  const width = page.viewportSize()!.width
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) {
    expect(line.left).toBeGreaterThanOrEqual(0)
    expect(line.right).toBeLessThanOrEqual(width)
  }
  // Tall feedback may need vertical scrolling; its final text must remain reachable.
  await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const lastLine = Array.from(range.getClientRects()).at(-1)!
    window.scrollBy(0, lastLine.bottom - window.innerHeight / 2)
  })
  expect(
    await text.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const lastLine = Array.from(range.getClientRects()).at(-1)!
      return lastLine.top >= 0 && lastLine.bottom <= window.innerHeight
    })
  ).toBe(true)
}

async function exerciseFeedback(page: Page, state: Feedback, view: View, controls = false) {
  await page.setViewportSize(
    view === 'landscape' ? { width: 844, height: 390 } : { width: 390, height: 844 }
  )
  await activateScenario(page, [
    'shell.single-organisation',
    'order.catalogue-default',
    'home.no-tenant',
    state === 'empty' ? 'order.catalogue-empty' : 'order.catalogue-unavailable',
  ])
  await page.goto('/acme-sa/order')
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/order\/.+\/plan$/)

  await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  expect(await page.evaluate((query) => matchMedia(query).matches, NARROW_LAYOUT_QUERY)).toBe(true)
  await page.evaluate(() => document.fonts.ready)

  const main = page.getByRole('main')
  const title = main.getByRole('heading', { level: 1, name: 'Choisissez votre formule' })
  const feedback =
    state === 'empty'
      ? main.getByRole('heading', {
          level: 2,
          name: /Les formules sont momentanément indisponibles/,
        })
      : main.getByRole('alert').locator('p').first()
  await expect(title).toBeVisible()
  await expect(feedback).toContainText('support@kodera.io')
  if (state === 'empty') {
    await expect(main.getByRole('heading', { level: 3 })).toHaveCount(0)
    await expect(main.getByRole('alert')).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
  } else {
    await expect(main.getByRole('heading', { level: 2 })).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  }
  await expect(main.getByRole('button', { name: 'Continuer', exact: true })).toHaveCount(0)
  await expect(main.getByRole('radio')).toHaveCount(0)

  // Controlled stress fixtures only: no catalogue, production CSS or copy changes.
  if (view === 'enlarged') {
    await main.evaluate((element) => {
      const textElements = Array.from(
        element.querySelectorAll<HTMLElement>('h1, h2, h3, p, a, button, span')
      )
      const sizes = textElements.map((node) => Number.parseFloat(getComputedStyle(node).fontSize))
      textElements.forEach((node, index) => {
        node.style.fontSize = `${sizes[index]! * 2}px`
      })
    })
  }
  if (view === 'long-content') {
    await feedback.evaluate((element) => {
      element.textContent = Array(4).fill(element.textContent).join(' ')
    })
  }
  await expectReadable(page, title)
  await expectReadable(page, feedback)

  if (state === 'error') {
    const retry = main.getByRole('button', { name: 'Réessayer' })
    const restingSignature = await tabTo(page, retry)
    if (controls) await proveFocusRefusals(page, retry, restingSignature)
    const nextCatalogueRead = page.waitForRequest(
      (request) => request.method() === 'GET' && request.url().includes('/catalog/capacity-tiers')
    )
    await page.keyboard.press('Enter')
    await nextCatalogueRead
    await expect(main.getByRole('alert')).toBeVisible()
  }

  // Existing support navigation remains keyboard-reachable. The feedback address
  // is plain text; this test does not invent a mail action or send external mail.
  const help = page.getByRole('link', { name: 'Aide', exact: true }).last()
  await tabTo(page, help)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/acme-sa\/help(?:\?|$)/)
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()
}

test('order/feedback: empty catalogue remains readable in portrait', async ({ page }) => {
  await exerciseFeedback(page, 'empty', 'portrait')
})
test('order/feedback: failed catalogue retains keyboard actions in portrait', async ({ page }) => {
  await exerciseFeedback(page, 'error', 'portrait')
})
test('order/feedback: empty catalogue remains readable in landscape', async ({ page }) => {
  await exerciseFeedback(page, 'empty', 'landscape')
})
test('order/feedback: failed catalogue retains keyboard actions in landscape', async ({ page }) => {
  await exerciseFeedback(page, 'error', 'landscape')
})
test('order/feedback: empty catalogue remains readable with enlarged text', async ({ page }) => {
  await exerciseFeedback(page, 'empty', 'enlarged')
})
test('order/feedback: failed catalogue retains keyboard actions with enlarged text', async ({
  page,
}) => {
  await exerciseFeedback(page, 'error', 'enlarged')
})
test('order/feedback: empty catalogue remains readable with long content', async ({ page }) => {
  await exerciseFeedback(page, 'empty', 'long-content')
})
test('order/feedback: failed catalogue retains keyboard actions with long content', async ({
  page,
}) => {
  await exerciseFeedback(page, 'error', 'long-content')
})

test('order/feedback: focus oracles refuse obscured clipped and unpainted controls', async ({
  page,
}) => {
  await exerciseFeedback(page, 'error', 'portrait', true)
})
