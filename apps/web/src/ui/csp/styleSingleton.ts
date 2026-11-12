// The stylesheet Radix's scroll lock asks for, adopted through the CSSOM instead of injected as a
// `<style>` element.
//
// Radix's modal primitives (Dialog, and DropdownMenu, Popover and Select while modal) lock the
// page's scroll through `react-remove-scroll`, whose `react-remove-scroll-bar` writes its rules with
// `react-style-singleton`: a `<style>` element appended to `<head>`. The static server's policy is
// `style-src 'self'`, so that element is refused (`style-src-elem`, a `securitypolicyviolation` on
// every modal) and the lock silently does nothing. An adopted constructable stylesheet is CSSOM, not
// markup, and CSP Level 3 does not govern it: the same rules apply, with no exemption in the policy.
//
// `vite.config.ts` and `vitest.config.ts` alias `react-style-singleton` to this module, which keeps
// the package's three exports and their counting semantics: the rules are added when the first user
// mounts and removed when the last one unmounts. A browser without `adoptedStyleSheets` (none the
// console supports) keeps the page scrollable behind the modal rather than break the policy.

import { useEffect } from 'react'

function makeSheet(): CSSStyleSheet | null {
  if (
    typeof document === 'undefined' ||
    typeof CSSStyleSheet === 'undefined' ||
    !('adoptedStyleSheets' in document) ||
    typeof CSSStyleSheet.prototype.replaceSync !== 'function'
  )
    return null
  try {
    return new CSSStyleSheet()
  } catch {
    return null
  }
}

export interface StyleSheetSingleton {
  add(style: string): void
  remove(): void
}

export function stylesheetSingleton(): StyleSheetSingleton {
  let counter = 0
  let sheet: CSSStyleSheet | null = null
  return {
    add(style) {
      if (counter === 0) {
        sheet = makeSheet()
        if (sheet !== null) {
          sheet.replaceSync(style)
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        }
      }
      counter += 1
    },
    remove() {
      counter -= 1
      if (counter === 0 && sheet !== null) {
        const adopted = sheet
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (candidate) => candidate !== adopted
        )
        sheet = null
      }
    },
  }
}

export function styleHookSingleton(): (styles: string, isDynamic?: boolean) => void {
  const sheet = stylesheetSingleton()
  return (styles, isDynamic) => {
    useEffect(() => {
      sheet.add(styles)
      return () => sheet.remove()
      // The package's own dependency: the styles are re-added only when they are dynamic.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [styles && isDynamic])
  }
}

export function styleSingleton(): (props: { styles: string; dynamic?: boolean }) => null {
  const useStyle = styleHookSingleton()
  return function Sheet({ styles, dynamic }) {
    useStyle(styles, dynamic)
    return null
  }
}
