import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { compiled } from './tailwind'

// The keyboard focus ring is `focus-visible:ring` with no colour class: it
// draws `--tw-ring-color` when a ring colour class sets one, and otherwise the
// default ring colour. That default is `var(--focus-ring-color)`, one value per
// `[data-theme]`, which the preset names as `ringColor.DEFAULT` and
// `src/index.css` hands Tailwind 4 as `--default-ring-color`. Without it the
// ring draws in `currentcolor` — silently, since the ring still draws; under
// Tailwind 3 the same silence came from a 0.5 default opacity replacing a
// `var()` colour with `rgb(147 197 253 / 0.5)`. A class assertion cannot see
// either; the compiled CSS can.
async function ringShadows(): Promise<string[]> {
  const root = await compiled(['focus-visible:ring'])
  const shadows: string[] = []
  root.walkRules((rule) => {
    if (!rule.selector.includes('focus-visible\\:ring:focus-visible')) return
    rule.walkDecls('--tw-ring-shadow', (declaration) => {
      shadows.push(declaration.value)
    })
  })
  return shadows
}

describe('the default focus ring', () => {
  it('draws the themed ring colour, opaque, when no class sets one', async () => {
    const colours = (await ringShadows()).map(
      (shadow) => /var\(--tw-ring-color, (.+)\)$/.exec(shadow)?.[1]
    )
    expect(colours).toEqual(['var(--focus-ring-color)'])
    // Nothing gives every element a ring colour of its own: one would replace
    // the default above everywhere, which is how the Tailwind 3 opacity hid.
    const root = await compiled(['focus-visible:ring'])
    const set: string[] = []
    root.walkDecls('--tw-ring-color', (declaration) => {
      // `@layer properties` is Tailwind's stand-in for `@property` where a
      // browser lacks it: `initial`, i.e. unset, which leaves the default.
      let at: postcss.Node | undefined = declaration.parent
      while (
        at !== undefined &&
        !(at.type === 'atrule' && (at as postcss.AtRule).params === 'properties')
      )
        at = at.parent
      if (at === undefined) set.push(declaration.value)
    })
    expect(set).toEqual([])
  })

  it('draws the preset ring width', async () => {
    expect(await ringShadows()).toEqual([
      'var(--tw-ring-inset, ) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, var(--focus-ring-color))',
    ])
  })
})

// The ratios the ring is drawn for (docs/specs/00-shell-and-login.md §10: 3:1
// against both surfaces it touches), read from the pinned `tokens.css`.
const TOKENS_CSS = createRequire(import.meta.url).resolve('@kodera/design-tokens/tokens.css')
const THEMES = {
  light: ':root, [data-theme="light"] {',
  dark: '[data-theme="dark"] {',
  black: '[data-theme="black"] {',
} as const
type Theme = keyof typeof THEMES

function properties(theme: Theme): Map<string, string> {
  const css = readFileSync(TOKENS_CSS, 'utf8')
  const start = css.indexOf(THEMES[theme])
  if (start === -1) throw new Error(`no ${theme} block in tokens.css`)
  const block = css.slice(start, css.indexOf('}', start))
  const found = new Map<string, string>()
  for (const [, name = '', value = ''] of block.matchAll(/--([\w-]+):\s*([^;]+);/g))
    found.set(name, value.trim())
  const stops = found.get('c-page-grad')?.match(/#[0-9a-f]{6}/gi) ?? []
  stops.forEach((stop, index) => found.set(`c-page-grad-${index}`, stop))
  return found
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const GROUNDS = [
  'surface',
  'muted',
  'sunken',
  'elevated',
  'page-grad-0',
  'page-grad-1',
  'page-grad-2',
]

// [where, ring, the colours on either side of it]
const EDGES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  // A control with no box, and a box's offset gap (`--focus-ring-ground`, the
  // surface) on the inside with the ground it sits on outside.
  ['default ring and its offset gap', 'focus-ring-color', GROUNDS],
  // `focus-ground-inverse` and `focus-ground-bad` (`src/index.css`), and the rail.
  ['on-inverse ring', 'focus-ring-on-inverse-color', ['inverse', 'inverse-2', 'bad']],
]

describe('the focus ring against both of its neighbours', () => {
  for (const theme of Object.keys(THEMES) as Theme[]) {
    it(`clears 3:1 on every ground it is drawn on in ${theme}`, () => {
      const values = properties(theme)
      const short: string[] = []
      for (const [where, ring, grounds] of EDGES) {
        for (const ground of grounds) {
          const fg = values.get(ring)
          const bg = values.get(`c-${ground}`)
          if (fg === undefined || bg === undefined) {
            short.push(`${where}: ${ring} on ${ground} has no ${theme} value`)
            continue
          }
          const measured = ratio(fg, bg)
          if (measured < 3) short.push(`${where}: on ${ground} ${measured.toFixed(2)} < 3`)
        }
      }
      expect(short).toEqual([])
    })
  }

  it('measures the flush ring on the light primary fill as the failure the offset exists for', () => {
    // If the tokens ever lift these, the offset can be reconsidered.
    const light = properties('light')
    const ring = light.get('focus-ring-color') ?? ''
    expect(ratio(ring, light.get('c-action') ?? '')).toBeCloseTo(1.2, 2)
    expect(ratio(ring, light.get('c-action-hover') ?? '')).toBeCloseTo(1.0, 2)
    expect(ratio(ring, light.get('c-inverse') ?? '')).toBeCloseTo(2.2, 2)
  })
})
