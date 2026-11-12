// Computed style values, set through the CSSOM and never as a `style` attribute.
//
// The static server sends `style-src-attr 'none'` (server/static.mjs): a `style="…"` attribute in
// markup, or one written with `setAttribute('style', …)`, is refused by the browser. A property set
// on `element.style` is not markup, and CSP Level 3 does not govern it. Product code therefore
// never passes a `style` prop (eslint.config.js refuses one in `src/`): a value only known at run
// time — a percentage, a dragged width — goes through one of these, and everything else is a class.

import type { Ref, RefCallback } from 'react'

/**
 * A ref that sets `property` to `value` on the element it is attached to, or removes it when
 * `value` is `undefined`. Safe in a list: it holds no state, and setting a property to the value it
 * already has does not restyle the element.
 */
export function cssProperty<T extends HTMLElement>(
  property: string,
  value: string | undefined
): RefCallback<T> {
  return (element) => {
    if (element === null) return
    if (value === undefined) element.style.removeProperty(property)
    else element.style.setProperty(property, value)
  }
}

/**
 * A ref that gives `property` a starting `value` once, then leaves it to the caller, who moves it
 * on every frame (a microphone meter): re-rendering never puts the starting value back over a live
 * one. `forward` still receives the element.
 */
export function initialCssProperty<T extends HTMLElement>(
  property: string,
  value: string,
  forward?: Ref<T>
): RefCallback<T> {
  return (element) => {
    if (element !== null && element.style.getPropertyValue(property) === '') {
      element.style.setProperty(property, value)
    }
    if (typeof forward === 'function') forward(element)
    else if (forward !== null && forward !== undefined) forward.current = element
  }
}
