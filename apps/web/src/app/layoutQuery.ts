/**
 * The one definition of "narrow" (docs/specs/00-shell-and-login.md §4.5): below
 * the `md` breakpoint, or a touch screen held sideways — a coarse pointer on a
 * screen at most 500 px tall, where a phone in landscape is 844 or 932 px wide
 * but the wide layout's sidebar and rail cannot fit its height (owner ruling,
 * 2026-09-24).
 *
 * Read by BOTH halves of the layout, so they cannot disagree: the shell's frame
 * choice in script (`useNarrowViewport`) and every screen's CSS through the
 * `narrow:` variant, which `tailwind.config.ts` defines from this same string.
 * A plain module with no imports, since the Tailwind config loads it in Node.
 *
 * The width is the exact complement of `md:`, in its unit: Tailwind's default
 * `--breakpoint-md`, 48rem, which design tokens v0.3.0 adopts as
 * `breakpoint.md` (the console pins v0.2.0, which has no breakpoints). A rem in
 * a media query follows the reader's default font size, so the boundary is
 * 768 px at the usual 16 px and moves with `md:` at any other. In px, the two
 * disagreed: at a 20 px default, `md:` starts at 960 px, and a 800 px window
 * got neither the narrow layout nor a screen's `md:` grids. The height clause
 * stays in px: it is device geometry, not a breakpoint.
 * `tests/unit/ui/narrow-breakpoint.test.ts` holds it to the compiled `md:`.
 */
export const NARROW_LAYOUT_QUERY = '(width < 48rem), (pointer: coarse) and (max-height: 500px)'
