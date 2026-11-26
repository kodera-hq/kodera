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
// Toast pointer events and the roving-focus root outline are also fixed library rules.
// They become static classes, with the same exact-signature upgrade checks.
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

/** The toast region's pointer-event state belongs in a static class as well. */
export function stripRadixToastViewportStyle(code: string): string {
  const style = /style: \{ pointerEvents: hasToasts \? void 0 : "none" \}/g
  if ((code.match(style)?.length ?? 0) !== 1)
    throw new Error('Expected exactly one toast viewport pointer-event style.')
  return code.replace(style, 'className: hasToasts ? void 0 : "csp-toast-empty"')
}

/** Roving focus keeps keyboard focus on its children, without an inline outline rule. */
export function stripRadixRovingFocusStyle(code: string): string {
  const style = /style: \{ outline: "none", \.\.\.props.style \}/g
  if ((code.match(style)?.length ?? 0) !== 1)
    throw new Error('Expected exactly one roving focus outline style.')
  return code.replace(
    style,
    'className: [groupProps.className, "csp-roving-focus"].filter(Boolean).join(" ")'
  )
}

export function radixSelectViewportStylePlugin(): Plugin {
  return {
    name: 'kodera-radix-select-viewport-style',
    enforce: 'pre',
    transform(code, id) {
      const moduleId = id.split('?')[0]!
      if (MODULE.test(moduleId)) return { code: stripRadixSelectViewportStyle(code, id), map: null }
      if (/[\\/]@radix-ui[\\/]react-toast[\\/]dist[\\/]index\.m?js$/.test(moduleId))
        return { code: stripRadixToastViewportStyle(code), map: null }
      if (/[\\/]@radix-ui[\\/]react-roving-focus[\\/]dist[\\/]index\.m?js$/.test(moduleId))
        return { code: stripRadixRovingFocusStyle(code), map: null }
      return null
    },
  }
}
