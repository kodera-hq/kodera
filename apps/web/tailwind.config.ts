import koderaPreset from '@kodera/design-tokens/tailwind-preset'
import type { Config } from 'tailwindcss'
import { NARROW_LAYOUT_QUERY } from './src/app/layoutQuery'

// The console declares NO colour, spacing, radius or type value of its own.
//
// Every one of those comes from `@kodera/design-tokens` (ADR-0004): one
// package publishing `tokens.json` (W3C DTCG), a generated `tokens.css`, and
// the Tailwind preset imported above, consumed by this repo and by
// kodera-web. A value re-declared here would be a second source of truth,
// and the two would drift the way a copied file always does — silently, since
// nothing renders differently until someone compares two screenshots.
//
// `theme` stays empty on purpose and `tests/unit/toolchain.test.ts` fails if it
// gains a colour. The preset is judged by `tests/unit/ui/tokens.test.ts`, which
// is the only thing that makes the real failure loud: a Tailwind colour class
// naming a token that does not exist emits NO CSS rule and NO error — the class
// stays in the markup and the element falls back to preflight (for `border-*`,
// to `border: 0 solid #e5e7eb`, a light grey line on a pale page). No inline
// hex, ever — see AGENTS.md.
//
// Tailwind 4 reads this file because `src/index.css` names it with `@config`.
// It does not take the preset's `ringColor.DEFAULT` and
// `transitionDuration.DEFAULT` from here; `src/index.css` hands both to it
// from the tokens' custom properties, and `tests/unit/ui/focus-ring.test.ts`
// compiles a focused control and fails if the ring loses its colour.
export default {
  presets: [koderaPreset as Partial<Config>],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // `narrow:` — the narrow layout's variant, from the same query the shell's
  // frame choice reads (`src/app/layoutQuery.ts`), so a screen's phone classes
  // and the shell's phone frame always switch together. Not a size: a raw
  // media query, which also covers a phone held sideways.
  theme: { extend: { screens: { narrow: { raw: NARROW_LAYOUT_QUERY } } } },
  plugins: [],
} satisfies Config
