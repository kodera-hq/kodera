# `src/ui` — the primitives

Local, shadcn-style copies (ADR-0004): behaviour from Radix Primitives,
appearance from `@kodera/design-tokens`. The copies are ours, so a
focus-ring fix is a pull request, never a fork — CODEOWNERS asks a second
reviewer here, since every screen inherits this focus and keyboard behaviour.

## Layout

One directory per primitive, three files, no barrel:

```
src/ui/Button/Button.tsx
src/ui/Button/Button.stories.tsx
src/ui/Button/Button.test.tsx
```

Import by path — `import { Button } from '@/ui/Button/Button'`. A barrel pulls
the whole inventory into a screen that needed one control, and hides where a
symbol lives.

## Rules

- **Appearance is Tailwind classes over the preset, nothing else.**
  `tests/unit/ui/tokens.test.ts` fails on four things, each carrying its own
  mutation fixture: a class naming one of our colour families that resolves to
  no token — the failure that otherwise emits no CSS and no error; an inline hex
  anywhere under `src/`, including one written into a `style` prop, which no
  class scanner can see; a class naming one of Tailwind's own colour families,
  which stay live beside ours because the preset extends the palette rather than
  replacing it; and an arbitrary value on a colour utility, `bg-[…]`, which the
  resolution scanner stops short of by construction. A `style` prop carrying a
  size or a font is scanned for none of this — keep those in classes too.
- **Variants are plain records**, `Record<Variant, string>`, joined with `cx`
  from `src/ui/cx.ts` — the whole of the cva-style helper. TypeScript checks the
  map is exhaustive; `class-variance-authority` would be a dependency for that.
- **A caller extends, it does not override.** Class order has no effect on the
  cascade — rule order in the stylesheet decides. Non-conflicting classes only
  (layout, `w-full`); real overriding is a recorded decision (`tailwind-merge`).
- **Spacing steps are the preset's px scale.** Tailwind's rem defaults are off
  that grid by construction: `h-9`, `p-1.5`, `gap-7` are not allowed, and
  `tests/unit/ui/spacing-guard.test.ts` rejects them by name — the same for a
  `font-*` weight the preset never declared. Both still emit a real rule, off
  our grid, so nothing else catches them. What that guard accepts is exactly
  four things: a preset spacing step; one of the keywords that carries no
  length (`px`, `0`, `auto`, `full`, `screen`, `min`, `max`, `fit`, `none`,
  `reverse`); a fraction (`w-1/2`); or a bracket value in `px` or `%`,
  `calc()` included when every length inside it is `px`, `%`, `vw` or `vh`.
  The bracket form is a deliberate escape hatch and the guard cannot tell a
  considered one from a lazy one — so it is for a one-off length that is not a
  design step at all (a story's demo container, `w-[320px]`), it is annotated
  where it is written, and when the value really is a step, the step goes into
  the tokens package instead. That last part is a review rule, not something
  the guard can enforce.
- **Link text comes from `LINK_TEXT` (`src/ui/linkText.ts`).** A link that
  stands on its own — a tertiary `Button` or `LinkButton`, a retry after an
  alert, a table cell — uses `c-ink`, underlines on hover and keyboard focus, and keeps the canonical focus ring. A link
  inside running text is `LinkButton inline`: underlined at rest, because its
  colour alone would not tell it from the sentence (WCAG 1.4.1).
  `tests/unit/ui/action-roles.test.ts` refuses an at-rest `underline` class
  anywhere else.
- **One colour class per property per element.** Two `border-c-…` classes on
  one element are decided by stylesheet order, not by which one the code
  wrote last. Write a state as one choice among exclusive branches, or with a
  variant (`data-[highlighted]:…`). `tests/unit/ui/class-conflicts.test.ts`
  reads every element under `src/` and refuses a pair.
- **`focus-visible:ring` on a control, `focus-within:ring` on a composite
  field.** A control draws its own ring; a control-plus-suffix draws one ring
  around the pair, on the wrapper. Half a ring reads as a different widget.
- **`forwardRef`** — a form library, a focus manager or a popover anchor needs
  the node. **An accessible name is required, always**; an icon-only control
  takes `aria-label` from the caller.
- **A state under `asChild` (`disabled`, `loading`) is chosen in TypeScript
  via the variant maps, never a `disabled:`/pseudo-class variant** — spread
  `{...rest}` before the state attributes so a caller cannot take it back off.
- **No string a customer reads lives here.** Labels, help and error text are
  props, rendered by the catalogues; stories may use placeholder French.
- **Radix packages arrive one at a time**, with the primitive that needs them.

## Stories

One story per state that applies: default, disabled, loading, error, empty,
skeleton, and every variant and size. Hover and active are CSS states this
inventory cannot enter on its own — checked by hand and in the Playwright pass
(docs/dev/TESTING.md §3). Put the keyboard map in the story description: which
key reaches the control, which activates it, what `Escape` does — nobody
rediscovers that by reading the markup.

`src/ui/stories-a11y.test.tsx` renders every story headlessly on `npm test`,
runs its `play` first so an interactive state is judged in that state, and fails
the build on an axe violation.
