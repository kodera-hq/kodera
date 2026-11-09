/** Anything a conditional class expression can evaluate to. */
export type ClassValue = string | false | null | undefined

/**
 * Join class names, dropping everything falsy.
 *
 * This is the whole of the "cva-style" helper `src/ui/README.md` allows. A
 * variant map here is a plain `Record<Variant, string>` looked up by key, which
 * TypeScript checks for exhaustiveness on its own; `class-variance-authority`
 * would add a dependency to do the same thing behind a builder API, and its
 * `cx` would still be this function.
 *
 * It does NOT merge conflicting Tailwind utilities the way `tailwind-merge`
 * does, and the order it writes them in decides nothing. The `class` attribute
 * is a set: which of `px-4` and `px-6` wins is fixed by the order of the two
 * rules in the generated stylesheet, which is Tailwind's, not ours. Putting the
 * caller's `className` last is only tidiness.
 *
 * So: a caller extends a primitive with classes that do not conflict — layout,
 * `w-full`, a grid placement — and two utilities that fight are undefined
 * behaviour and a bug in the variant map. If overriding a primitive's own
 * appearance ever becomes a real requirement, it is answered with a recorded
 * decision (`tailwind-merge`, and what it costs), never by relying on this.
 */
export function cx(...values: ClassValue[]): string {
  return values.filter((value): value is string => Boolean(value)).join(' ')
}
