import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import preset from '@kodera/design-tokens/tailwind-preset'
import { sourceFiles } from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'
import { assertScaleResolves, scanSource } from './spacing-guard'

// tokens.test.ts judges colour. This guard judges the two axes that guard
// leaves alone: spacing/size utilities (`h-9`, `py-2.5`, `w-24`, `gap-1.5`,
// `w-80`…) and `font-` weight utilities (`font-normal`) that name no key in
// the preset. Unlike an unresolved colour, these still emit a real CSS rule —
// Tailwind's own rem-based scale is right there as a silent fallback — on a
// size or weight that is simply off our grid. Two units already shipped a
// `w-80` demo container before this guard existed; see f3-report.md.

const SRC = join(import.meta.dirname, '..', '..', '..', 'src')

// Both floors are about the guard itself rather than about the markup — see
// tokens.test.ts for why. Measured at 209 files / 459 spacing and font-weight
// classes; set at roughly 80% of that. Raise when a wave adds screens.
const MIN_FILES = 167
const MIN_MATCHES = 367

describe('spacing and font-weight guard', () => {
  it('every spacing/size and font-weight class in src/ names a step the preset actually declares', () => {
    const result = assertScaleResolves({
      files: sourceFiles(SRC),
      preset,
      minFiles: MIN_FILES,
      minMatches: MIN_MATCHES,
    })

    expect(result.violations).toEqual([])
  })

  it('fails when a class falls off the preset spacing scale or font-weight names, and says where', () => {
    // The mutation TESTING.md §4 asks for: a guard nobody has watched fail is
    // a decoration. `h-9` and `font-normal` are the exact shape of the bug —
    // real Tailwind utilities that resolve to a real, silent rule outside the
    // preset — and the guard must name the file, the line, the class, and the
    // allowed forms, not just fail.
    const fixture = join(import.meta.dirname, 'fixtures', 'unresolved-spacing.tsx.fixture')
    const run = () =>
      assertScaleResolves({
        files: [fixture],
        preset,
        // One file, two offending classes; the floors that guard the guard
        // would otherwise reject the mutation before it is judged.
        minFiles: 1,
        minMatches: 1,
      })

    expect(run).toThrow()
    try {
      run()
      expect.unreachable('assertScaleResolves should have thrown on the fixture')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // file:line, the offending class, and the allowed forms — precise
      // enough that a sibling unit can fix its own hit without reading this
      // guard's source.
      expect(message).toMatch(`${fixture}:13: \`h-9\` — allowed:`)
      expect(message).toMatch(`${fixture}:14: \`font-normal\` — allowed:`)
      expect(message).toContain('preset spacing step')
      expect(message).toContain('preset font weight')
    }
  })

  it('does not mistake inset-x/inset-y for a bare inset with the axis swallowed as the value', () => {
    // A review finding on this guard: only bare `inset` was in the prefix
    // list, so `inset-y-0` matched as prefix `inset` with value `y-0` — not a
    // preset step, not a keyword, not a fraction — and was wrongly rejected.
    // `inset-x` / `inset-y` are their own families, same as `gap-x`/`gap-y`
    // and `space-x`/`space-y` already are.
    const accepted = scanSource(
      'fixture.tsx',
      'const c = "inset-y-0 inset-x-4 sm:inset-x-0"',
      preset
    )
    expect(accepted.violations).toEqual([])

    const rejected = scanSource('fixture.tsx', 'const c = "inset-y-7"', preset)
    expect(rejected.violations).toHaveLength(1)
    expect(rejected.violations[0]?.className).toBe('inset-y-7')
  })

  // A review finding on this guard, from the sibling units rebasing onto it:
  // a scanner that reads the whole file as text cannot tell a `className`
  // string apart from prose that merely spells the same shape — `right-side`
  // and `px-exact` in a comment are not markup. Two permanent fixtures prove
  // the fix stays fixed, the same way unresolved-token.tsx.fixture proves the
  // colour guard's mutation stays caught: one class-shaped word that MUST
  // trip the guard because it sits in a string literal, and the same words
  // that MUST NOT because they sit only in `//`, `/* */` and JSDoc comments.
  describe('judges string and template literals only, never comments or JSDoc', () => {
    it('trips on a raw rem-scale key sitting inside a string literal', () => {
      const fixture = join(import.meta.dirname, 'fixtures', 'unresolved-spacing.tsx.fixture')
      const source = readFileSync(fixture, 'utf8')

      const { violations } = scanSource(fixture, source, preset)

      expect(violations.map((v) => v.className)).toEqual(
        expect.arrayContaining(['h-9', 'font-normal'])
      )
    })

    it('does not trip when the same class-shaped words sit only in // and /* */ comments and JSDoc', () => {
      const fixture = join(import.meta.dirname, 'fixtures', 'spacing-only-in-comments.tsx.fixture')
      const source = readFileSync(fixture, 'utf8')

      const { matched, violations } = scanSource(fixture, source, preset)

      expect(violations).toEqual([])
      // Not merely "resolved fine" — genuinely never looked at: `h-9`,
      // `px-exact` and `right-side` in the comments contribute nothing to the
      // match count either. The one match this file has is the real
      // `gap-2` in the component's own className.
      expect(matched).toBe(1)
    })

    // A review finding on this guard, and the one that mattered most: the
    // mask read the `"` inside a regex character class as the start of a
    // string, nothing ever closed it, and from there the mask ran inverted —
    // real markup read as bare code and never judged. Silent, and local: both
    // floors in `assertScaleResolves` are whole-run counts, so the other
    // matches in `src/` keep them satisfied while one file goes blind. The
    // third permanent fixture exists for exactly this, beside the two above.
    it('judges the markup below a regex literal holding a lone quote character', () => {
      const fixture = join(
        import.meta.dirname,
        'fixtures',
        'spacing-after-regex-literal.tsx.fixture'
      )
      const source = readFileSync(fixture, 'utf8')

      const { matched, violations } = scanSource(fixture, source, preset)

      // Measured on the guard before the fix: `matched=0, violations=[]`.
      // Both numbers below are the point — the count proves the markup is
      // LOOKED AT, which no assertion about violations alone can do.
      expect(matched).toBe(2)
      expect(violations.map((v) => `${v.line}:${v.className}`)).toEqual([
        '27:h-9',
        '28:font-normal',
      ])
    })

    it('resynchronises at the newline no single- or double-quoted string can hold', () => {
      // The same defect at its smallest. A quoted string cannot contain a raw
      // newline, so meeting one proves the opening quote was never a string.
      // All three of these must read identically; before the fix the second
      // returned `matched=0` while the first returned `matched=1`.
      const markup = 'export const B = () => <div className="h-9" />'
      const cases = {
        plain: markup,
        afterDoubleQuoteRegex: `const QUOTE = /["]/\n${markup}`,
        afterSingleQuoteRegex: `const QUOTE = /[']/\n${markup}`,
      }

      for (const [name, source] of Object.entries(cases)) {
        const { matched, violations } = scanSource('fixture.tsx', source, preset)

        expect(matched, name).toBe(1)
        expect(
          violations.map((v) => v.className),
          name
        ).toEqual(['h-9'])
      }
    })

    it('refuses a verdict when a stray backtick leaves the mask inside a template literal', () => {
      // A template literal MAY hold a newline, so it gets no newline resync
      // and a stray backtick swallows the rest of the file — the same
      // blindness by another door. There is no cheap way to tell that
      // backtick from a real one without parsing regex literals, so the mask
      // reports that it lost sync and the scan refuses to return a count it
      // never reached. Loud beats silent.
      const source = 'const QUOTE = /[`]/\nexport const B = () => <div className="h-9" />'

      expect(() => scanSource('fixture.tsx', source, preset)).toThrow(
        /fixture\.tsx: the string mask reached end of file still inside an unterminated template literal/
      )
    })
  })

  it('accepts the keywords that remove or flip a constraint rather than naming a length', () => {
    // A review finding on this guard: `max-w-none` and `space-y-reverse` are
    // real Tailwind utilities carrying no size at all, and the guard turned
    // red on both — the first false alarm a screen would have hit. They are
    // not steps and there is no step for them to name.
    const { matched, violations } = scanSource(
      'fixture.tsx',
      'const c = "max-w-none space-y-reverse"',
      preset
    )

    expect(matched).toBe(2)
    expect(violations).toEqual([])
  })

  it('names every value it accepts, read from the guard rather than restated in prose', () => {
    // The failure message is the whole interface for the author who trips
    // this guard. A message that omits an accepted value, or names one the
    // guard dropped, sends them to fix the wrong thing.
    const { violations } = scanSource('fixture.tsx', 'const c = "h-9"', preset)

    const allowed = violations[0]?.allowed ?? ''
    for (const keyword of [
      'px',
      '0',
      'auto',
      'full',
      'screen',
      'min',
      'max',
      'fit',
      'none',
      'reverse',
    ]) {
      expect(allowed, keyword).toContain(`\`${keyword}\``)
    }
    expect(allowed).toContain('a fraction (`1/2`)')
    expect(allowed).toContain('h-[6px]')
    expect(allowed).toContain('w-[calc(100%-32px)]')
  })

  describe('a bracket value with calc()', () => {
    it('accepts calc() when every length inside is px, %, vw or vh', () => {
      const { violations } = scanSource('fixture.tsx', 'const c = "w-[calc(100%-32px)]"', preset)

      expect(violations).toEqual([])
    })

    it("rejects calc() the moment one length reaches for a unit off this guard's scale, like rem", () => {
      const { violations } = scanSource('fixture.tsx', 'const c = "w-[calc(100%-2rem)]"', preset)

      expect(violations).toHaveLength(1)
      expect(violations[0]?.className).toBe('w-[calc(100%-2rem)]')
    })
  })
})
