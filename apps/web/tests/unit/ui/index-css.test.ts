import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import preset from '@kodera/design-tokens/tailwind-preset'
import { familiesOf, resolvesInPreset, scanClasses } from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'

// `tests/unit/ui/tokens.test.ts` walks the tokens package's `sourceFiles(src)`, which
// only lists `.ts .tsx .js .jsx .astro .html`.
// `src/index.css`, the one file in this repo that carries `@apply`, is
// invisible to that walk. This test closes the gap with the same scanner and
// the same preset, restricted to the classes `@apply` actually applies.
const INDEX_CSS = join(import.meta.dirname, '..', '..', '..', 'src', 'index.css')

// `backgroundImage['c-page-gradient']` is a real, resolvable token — the themed
// gradient `body { @apply bg-c-page-gradient ... }` draws the page ground with.
// But the guard's family scan only looks at `theme.extend.colors`, where `c` is
// the family of every themed role, so `resolvesInPreset` reports
// `bg-c-page-gradient` unresolved even though it works — the same false positive
// `bg-frost` was before the ground followed the theme. Tracked upstream:
// kodera-hq/kodera#5, item 1 (exclude `backgroundImage`
// keys). This is the one and only exemption below; the second assertion is
// written to fail the day that ships, which is when this entry should come out.
const EXEMPT = new Set(['bg-c-page-gradient'])

describe('index.css @apply classes', () => {
  it('every @apply class names a token the preset actually declares', () => {
    const source = readFileSync(INDEX_CSS, 'utf8')
    const applyBodies = [...source.matchAll(/@apply\s+([^;]+);/g)].map((match) => match[1])

    // Same floor as tokens.test.ts: no @apply line found means the extractor
    // broke, not that index.css stopped applying anything.
    expect(applyBodies.length).toBeGreaterThan(0)

    const families = familiesOf(preset)
    const found = scanClasses(applyBodies.join(' '), { families })
    expect(found.length).toBeGreaterThan(0)

    const unresolved = found
      .filter(({ className }) => !EXEMPT.has(className))
      .filter(({ rest }) => !resolvesInPreset(preset, rest))
      .map(({ className }) => className)

    expect(unresolved).toEqual([])
  })

  it('keeps the bg-c-page-gradient exemption honest: it must still be the guard false positive it claims to be', () => {
    const source = readFileSync(INDEX_CSS, 'utf8')
    const applyBodies = [...source.matchAll(/@apply\s+([^;]+);/g)].map((match) => match[1])
    const families = familiesOf(preset)
    const found = scanClasses(applyBodies.join(' '), { families })

    for (const className of EXEMPT) {
      const entry = found.find((candidate) => candidate.className === className)
      // The exemption names a class @apply no longer carries — remove it.
      expect(
        entry,
        `${className} is exempted but no longer appears in an @apply line`
      ).toBeDefined()
      // The moment kodera-design-tokens#5 ships, this starts resolving and
      // this assertion fails — which is the signal to delete the exemption.
      expect(
        entry && resolvesInPreset(preset, entry.rest),
        `${className} now resolves — kodera-design-tokens#5 shipped, remove the exemption`
      ).toBe(false)
    }
  })
})
