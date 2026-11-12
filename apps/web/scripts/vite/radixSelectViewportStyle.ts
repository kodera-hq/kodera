// The console ships no inline style element: the static server sends `style-src 'self'` with no
// hash and no nonce (server/static.mjs). @radix-ui/react-select's viewport is the one dependency
// that renders one — a constant `<style>` hiding the list's own scrollbar, written on every open
// list, which that policy refuses and reports.
//
// This plugin removes that element from the package as it is bundled, and `src/index.css` carries
// the same rule as a static stylesheet the policy admits. The match is exact: a Radix release that
// changes the element, or stops rendering it, fails the build here instead of shipping a refused
// stylesheet. tests/unit/serving/radix-select-style.test.ts holds the plugin to the installed
// package and the stylesheet to the rule.
//
// Dependency pre-bundling in `vite dev` does not run it; the dev server sends no policy, and the
// production build — the only bundle the strict server serves — does.

import type { Plugin } from 'vite'

/** The rule the viewport writes, as the installed package spells it. */
export const RADIX_SELECT_VIEWPORT_RULE =
  '[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}'

const MODULE = /[\\/]@radix-ui[\\/]react-select[\\/]dist[\\/]index\.m?js$/

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `jsx("style", { dangerouslySetInnerHTML: { __html: `<rule>` }, nonce })`, comments allowed. */
const STYLE_ELEMENT = new RegExp(
  String.raw`(?:/\*\s*@__PURE__\s*\*/\s*)?jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*` +
    '`' +
    escape(RADIX_SELECT_VIEWPORT_RULE) +
    '`' +
    String.raw`\s*\},\s*nonce\s*\}\s*\)`,
  'g'
)

/** The package's source with the viewport's style element replaced by nothing. */
export function stripRadixSelectViewportStyle(code: string, id = '@radix-ui/react-select'): string {
  const found = code.match(STYLE_ELEMENT)?.length ?? 0
  if (found !== 1) {
    throw new Error(
      `${id}: expected the select viewport's inline <style> exactly once, found ${found}. ` +
        'The strict style-src policy refuses it: update scripts/vite/radixSelectViewportStyle.ts ' +
        'and the static rule in src/index.css to the installed release.'
    )
  }
  if (/dangerouslySetInnerHTML/.test(code.replace(STYLE_ELEMENT, ''))) {
    throw new Error(`${id}: renders another inline element the strict policy would refuse`)
  }
  return code.replace(STYLE_ELEMENT, 'null')
}

export function radixSelectViewportStylePlugin(): Plugin {
  return {
    name: 'kodera-radix-select-viewport-style',
    enforce: 'pre',
    transform(code, id) {
      if (!MODULE.test(id.split('?')[0]!)) return null
      return { code: stripRadixSelectViewportStyle(code, id), map: null }
    },
  }
}
