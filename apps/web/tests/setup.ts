// Runs before every unit test file (see `setupFiles` in vitest.config.ts).
//
// `@testing-library/jest-dom` adds the DOM matchers the suite leans on
// (`toBeVisible`, `toHaveAccessibleName`, `toBeDisabled`). Without this import
// those matchers are simply `undefined`, and `expect(el).toHaveAccessibleName()`
// throws a confusing type error rather than failing on the assertion.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom is shared across test files in a worker; a component left mounted by
// one test is still in the document for the next one, where a query that
// should have found nothing finds the leftover and the test passes wrongly.
afterEach(() => {
  cleanup()
})

// jsdom implements neither the Pointer Events capture methods nor
// `scrollIntoView` — real gaps in jsdom, not a choice either library made.
// Radix's `Select`, `Combobox`'s `Popover` and every later popover-based
// primitive (`Dialog`, `DropdownMenu`, `Tooltip`, …) call these unconditionally
// on pointer interaction and on the option a keyboard move highlights; without
// a stand-in the call throws `TypeError: target.hasPointerCapture is not a
// function` out of a React event handler, which `userEvent` cannot recover
// from. No-ops are correct here: this suite never asserts on capture state or
// scroll position, only on what is in the accessibility tree.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}

// jsdom has no layout engine, so it never implements `ResizeObserver` either.
// Radix's Popper-positioned content (`Tooltip`'s and `Popover`'s `Arrow`,
// `DropdownMenu`'s `Content`) observes its own size to place itself, via
// `@radix-ui/react-use-size`; without a stand-in the constructor call throws
// `ReferenceError: ResizeObserver is not defined` out of a layout effect. A
// no-op observer is correct here: this suite asserts on the accessibility
// tree, never on a measured pixel position jsdom cannot produce anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver
}
