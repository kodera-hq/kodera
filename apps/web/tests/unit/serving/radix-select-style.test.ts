// @vitest-environment node
// `style-src 'self'` admits no inline style element (server/static.mjs), and @radix-ui/react-select
// renders one: its viewport writes a constant `<style>` on every open list. The build removes that
// element (scripts/vite/radixSelectViewportStyle.ts) and the rule ships in `src/index.css`. This
// test holds the plugin to the package actually installed — an upgrade that changes the element
// fails here, not as a refused stylesheet in a member's browser — and the stylesheet to the rule.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RADIX_SELECT_VIEWPORT_RULE,
  radixSelectViewportStylePlugin,
  stripRadixSelectViewportStyle,
} from '../../../scripts/vite/radixSelectViewportStyle'

const packageDirectory = dirname(
  dirname(createRequire(import.meta.url).resolve('@radix-ui/react-select'))
)
const MODULE = join(packageDirectory, 'dist/index.mjs')
const bundle = readFileSync(MODULE, 'utf8')
const STYLESHEET = readFileSync(resolve(import.meta.dirname, '../../../src/index.css'), 'utf8')

/** Every text the package renders through `dangerouslySetInnerHTML`. */
function inlineRules(code: string): string[] {
  return [...code.matchAll(/dangerouslySetInnerHTML:\s*\{\s*__html:\s*`([^`]*)`/g)].map(
    (match) => match[1]!
  )
}

/** `selector { a: b; c: d }` as `selector{a:b;c:d;}`, the package's own spelling. */
function compact(css: string): string {
  return css
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .replace(/;?}/g, ';}')
}

describe('the inline style element Radix Select renders', () => {
  it('is the one rule the plugin knows, exactly once in the installed package', () => {
    expect(inlineRules(bundle)).toEqual([RADIX_SELECT_VIEWPORT_RULE])
  })

  it('is gone from the bundled package, and the viewport itself is not', () => {
    const plugin = radixSelectViewportStylePlugin()
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null
    const result = transform.call({}, bundle, MODULE)
    expect(result).not.toBeNull()
    expect(inlineRules(result!.code)).toEqual([])
    expect(result!.code).not.toContain('"style"')
    expect(result!.code).toContain('"data-radix-select-viewport": ""')
    // Any other module passes through untouched.
    expect(transform.call({}, bundle, '/node_modules/other/dist/index.mjs')).toBeNull()
  })

  it('fails the build when a release no longer renders the element it removes', () => {
    expect(() =>
      stripRadixSelectViewportStyle(bundle.replace('scrollbar-width:none', 'x'))
    ).toThrow(/exactly once, found 0/)
  })

  it('fails the build when a release renders another inline element', () => {
    const another = `${bundle}\njsx("style", { dangerouslySetInnerHTML: { __html: \`a{b:c}\` } })`
    expect(() => stripRadixSelectViewportStyle(another)).toThrow(/another inline element/)
  })

  it('ships as a static rule in the stylesheet the policy admits', () => {
    const rules = [
      ...STYLESHEET.matchAll(
        /(\[data-radix-select-viewport\](?:::-webkit-scrollbar)?)\s*\{([^}]*)\}/g
      ),
    ].map((match) => compact(`${match[1]}{${match[2]!.replace(/\/\*[\s\S]*?\*\//g, '')}}`))
    expect(rules.join('')).toBe(RADIX_SELECT_VIEWPORT_RULE.replace(/}$/, ';}'))
  })
})
