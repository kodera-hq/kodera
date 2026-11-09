import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import type postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { compiled } from './tailwind'

// The Tailwind 4 behaviours `src/index.css` keeps at their Tailwind 3 value
// (docs/specs/tailwind-4-migration.md). Each one, dropped, repaints screens with
// no error: a line in the stylesheet is the only thing holding it, so each is
// compiled here and fails on its own. The default ring colour is held by
// `focus-ring.test.ts`.

/** The at-rules a node sits in, innermost first, as `@name params`. */
function context(node: postcss.Node): string[] {
  const out: string[] = []
  for (let at = node.parent; at !== undefined && at.type !== 'root'; at = at.parent)
    if (at.type === 'atrule')
      out.push(`@${(at as postcss.AtRule).name} ${(at as postcss.AtRule).params}`)
  return out
}

/** Declarations of every rule whose selector names one of `classes`. */
function declarationsOf(root: postcss.Root, className: string): postcss.Declaration[] {
  const escaped = `.${className.replace(/[:[\]/.]/g, (c) => `\\${c}`)}`
  const found: postcss.Declaration[] = []
  root.walkRules((rule) => {
    if (rule.selectors.some((s) => s === escaped || s.startsWith(`${escaped}:`)))
      rule.walkDecls((d) => void found.push(d))
  })
  return found
}

describe('Tailwind 4 kept at Tailwind 3 behaviour', () => {
  it('gives a preset font size no line height of its own', async () => {
    // The preset's sizes are bare lengths; Tailwind 4's own scale would pair
    // `text-sm` with `line-height: calc(1.25 / .875)` and every paragraph would
    // move. The size is all a `text-*` class sets; the line height is inherited.
    const sizes = ['xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'].map(
      (s) => `text-${s}`
    )
    const root = await compiled(sizes)
    for (const size of sizes) {
      const props = declarationsOf(root, size).map((d) => d.prop)
      expect(props, size).toEqual(['font-size'])
    }
  })

  it('times a transition with the default duration the preset names', async () => {
    // Without it `--default-transition-duration` is undefined and every
    // transition without a `duration-*` class takes no time at all.
    const root = await compiled(['transition-colors', 'transition-transform'])
    for (const className of ['transition-colors', 'transition-transform']) {
      const duration = declarationsOf(root, className).find((d) => d.prop === 'transition-duration')
      expect(duration?.value, className).toBe('var(--tw-duration, var(--dur-base))')
    }
  })

  it('applies hover: on every device, as Tailwind 3 did', async () => {
    const root = await compiled(['hover:bg-c-muted'])
    const rules = declarationsOf(root, 'hover:bg-c-muted')
    expect(rules.length).toBeGreaterThan(0)
    for (const d of rules) expect(context(d).join(' ')).not.toMatch(/hover: hover/)
  })

  it("draws a border with no colour class in Tailwind 3's default grey", async () => {
    const root = await compiled([])
    const defaults: string[] = []
    root.walkRules((rule) => {
      if (!rule.selectors.includes('*')) return
      rule.walkDecls('border-color', (d) => void defaults.push(d.value))
    })
    expect(defaults).toEqual(['var(--color-gray-200, currentcolor)'])
    const grey: string[] = []
    root.walkDecls('--color-gray-200', (d) => void grey.push(d.value))
    expect(grey).toHaveLength(1)
  })

  it('shows the pointer on an enabled button, as Tailwind 3 did', async () => {
    const root = await compiled([])
    const pointer: string[] = []
    root.walkRules((rule) => {
      rule.walkDecls('cursor', (d) => {
        if (d.value === 'pointer') pointer.push(...rule.selectors)
      })
    })
    expect(pointer).toEqual(expect.arrayContaining(['button:not(:disabled)']))
  })

  it('shows the default cursor on anything disabled, as Tailwind 3 did', async () => {
    const root = await compiled([])
    const cursors: string[] = []
    root.walkRules((rule) => {
      if (rule.selectors.includes(':disabled'))
        rule.walkDecls('cursor', (d) => void cursors.push(d.value))
    })
    expect(cursors).toEqual(['default'])
  })

  it('declares the layers theme, base, components, utilities, in that order, before any other', async () => {
    // The tokens file is imported into `base` ahead of Tailwind's own layer
    // statement. Without the statement at the top of `src/index.css`, `base` is
    // the first layer named, `theme` comes after it, and Tailwind's theme
    // variables outrank the tokens' custom properties of the same name.
    const root = await compiled([])
    const order: string[] = []
    root.walkAtRules('layer', (at) => {
      for (const name of at.params.split(',').map((n) => n.trim()))
        if (name !== '' && !order.includes(name)) order.push(name)
    })
    expect(order.filter((name) => name !== 'properties')).toEqual([
      'theme',
      'base',
      'components',
      'utilities',
    ])
  })

  it('puts the tokens below the utilities, as source order did under Tailwind 3', async () => {
    // Unlayered CSS beats every cascade layer: left outside, the tokens file
    // would override a utility that sets one of its custom properties.
    const root = await compiled([])
    const where: string[] = []
    root.walkDecls('--c-surface', (d) => void where.push(context(d).join(' ')))
    expect(where.length).toBeGreaterThan(0)
    for (const at of where) expect(at).toMatch(/@layer base/)
  })
})

// `outline-none` is `outline-style: none` under Tailwind 4. Under Tailwind 3
// it was a transparent 2 px outline, which a forced-colours display (Windows
// high contrast) paints, and which is then the only focus indicator left, since
// forced colours drop the box-shadow the ring is drawn with. `outline-hidden`
// keeps that outline where it shows, under forced colours; elsewhere it draws
// none rather than a transparent one. Stylesheets are read too: an
// `@apply outline-none` in `src/index.css` is the same class.
const SRC = join(import.meta.dirname, '..', '..', '..', 'src')
const WITH_CSS = /\.(?:tsx?|jsx?|astro|html|css)$/
const OUTLINE_NONE = /(?<![\w-])outline-none(?![\w-])/g

function outlineNone(source: string): string[] {
  return [...source.matchAll(OUTLINE_NONE)].map((match) => match[0])
}

describe('outline-none', () => {
  it('appears nowhere under src', () => {
    const files = sourceFiles(SRC, { extensions: WITH_CSS })
    expect(files.filter((path) => path.endsWith('.css')).length).toBeGreaterThan(0)
    const found = files.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          outlineNone(line).map(
            (hit) => `${relative(SRC, path).split('\\').join('/')}:${index + 1} ${hit}`
          )
        )
    )
    expect(found).toEqual([])
    // Floor: the walk must have read the source tree, not an empty directory.
    expect(files.length).toBeGreaterThan(167)
  })

  it('can fail: finds it alone and behind a variant, and leaves outline-hidden alone', () => {
    expect(
      outlineNone('"outline-none focus-visible:outline-none outline-hidden focus:outline-hidden"')
    ).toEqual(['outline-none', 'outline-none'])
    expect(outlineNone('  @apply rounded-sm outline-none;')).toEqual(['outline-none'])
  })
})
