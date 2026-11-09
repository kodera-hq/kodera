import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'

// `tailwind.config.ts` adds the `narrow:` screen as a RAW media query
// (`src/app/layoutQuery.ts`). Tailwind 3 cannot order a raw screen against the
// width screens, so it turns the `max-sm:` … `max-2xl:` variants off for the
// whole config — silently: `max-md:p-4` stays in the markup and emits no CSS
// rule and no error (measured on this config). A phone class written that way
// was simply not there. Tailwind 4 compiles them again (`max-md:` is
// `not all and (min-width: 48rem)`, the tokens' `breakpoint.md`), which is a
// width query only: it misses a phone held sideways, and a screen would follow
// two definitions of "narrow". The narrow layout's variant is `narrow:`; this
// refuses the others anywhere under `src/`.
const SRC = join(import.meta.dirname, '..', '..', '..', 'src')

/** A `max-<screen>:` variant, alone or stacked (`hover:max-md:`, `max-md:hover:`),
 * not a `max-w-*`/`max-h-*` utility and not text that merely contains one. */
const DEAD_VARIANT = /(?<![\w-])max-(?:sm|md|lg|xl|2xl):/g

function deadVariants(source: string): string[] {
  return [...source.matchAll(DEAD_VARIANT)].map((match) => match[0])
}

describe('max-* screen variants', () => {
  it('appear nowhere under src: `narrow:` is the one phone variant', () => {
    const files = sourceFiles(SRC)
    const found = files.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          deadVariants(line).map(
            (variant) => `${relative(SRC, path).split('\\').join('/')}:${index + 1} ${variant}`
          )
        )
    )
    expect(found).toEqual([])
    // Floor: the walk must have read the source tree, not an empty directory.
    expect(files.length).toBeGreaterThan(167)
  })

  it('can fail: finds each dead variant, alone or stacked, and leaves the live ones alone', () => {
    expect(
      deadVariants(
        [
          'className="max-md:p-4"',
          "cx('flex', 'hover:max-sm:underline')",
          '`max-lg:grid-cols-1 max-xl:hidden max-2xl:block`',
        ].join('\n')
      )
    ).toEqual(['max-md:', 'max-sm:', 'max-lg:', 'max-xl:', 'max-2xl:'])
    expect(
      deadVariants(
        'className="max-w-[320px] max-h-full narrow:p-4 md:grid-cols-3 lg:max-w-[768px] min-max-md"'
      )
    ).toEqual([])
  })
})
