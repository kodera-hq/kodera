import { describe, expect, it } from 'vitest'
import { compiled } from './tailwind'

// `narrow:` (src/app/layoutQuery.ts) and `md:` must split the widths between them with no gap and
// no overlap, whatever the reader's default font size. `md:` is in rem (Tailwind's default
// `--breakpoint-md`, which design tokens v0.3.0 adopts as `breakpoint.md`), so the narrow width must be its complement in
// the same unit: in px, a 20 px default font left 768 to 959 px in neither layout. Read from the
// CSS the build ships, not from the source string.
async function mediaOf(className: string): Promise<string> {
  const root = await compiled([className])
  const found: string[] = []
  const selector = `.${className.replace(':', '\\:')}`
  root.walkAtRules('media', (rule) => {
    rule.walkRules((inner) => {
      if (inner.selector === selector) found.push(rule.params)
    })
  })
  expect(found, `one media rule for ${className}`).toHaveLength(1)
  return found[0]!
}

describe('the narrow layout’s width', () => {
  it('is exactly the widths below `md:`, in the same unit', async () => {
    const md = await mediaOf('md:block')
    const narrow = await mediaOf('narrow:hidden')
    expect(md).toMatch(/^\(min-width: [\d.]+rem\)$/)
    const [width, ...rest] = narrow.split(/,\s*/)
    expect(width).toBe(`not all and ${md}`)
    // The phone held sideways stays a second, separate clause.
    expect(rest).toEqual(['(pointer: coarse) and (max-height: 500px)'])
  })
})
