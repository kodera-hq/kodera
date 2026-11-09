import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import preset from '@kodera/design-tokens/tailwind-preset'
import {
  DEFAULT_PREFIXES,
  assertClassesResolve,
  familiesOf,
  sourceFiles,
} from '@kodera/design-tokens/token-test'
import { describe, expect, it } from 'vitest'
import { COLOUR_FAMILIES } from './tailwind'

// The guard ADR-0004 calls the one that outranks the rest, because its failure
// is completely silent: a Tailwind class naming a token that does not exist
// emits NO CSS rule and NO error. The class stays in the markup and the element
// falls back to preflight — for `border-*`, `border: 0 solid #e5e7eb`, a light
// grey line. kodera-web shipped exactly that on two membership cards.
//
// The implementation is the one the tokens package publishes, so the hub and
// the console judge their markup with the same scanner against the same preset.
//
// That scanner answers one question — "does a class naming one of OUR families
// resolve?" — and ADR-0004 asks for more than one. Three ways of writing a
// colour walk straight past it, each emitting a real CSS rule rather than none,
// so not even the silent-failure symptom shows up:
//
//   - `bg-[#ff0000]`   the scanner's character class stops at `[` by
//                      construction, so an arbitrary value is never matched;
//   - `bg-blue-500`    `theme.extend.colors` EXTENDS, so every family Tailwind
//                      ships stays live beside ours, and a family that is not
//                      ours is skipped rather than judged;
//   - `#ff0000`        written into a `style` prop or anywhere else in a source
//                      file, which no class scanner looks at at all.
//
// The three checks below close those, on the same file walk. Together with the
// resolution check they are what makes "never inline a colour" (AGENTS.md) a
// gate rather than a habit.

// `import.meta.dirname`, not a relative path: the working directory of a Vitest
// run is not something this test should depend on, and a walker pointed at a
// directory that does not exist would fail with ENOENT rather than with
// anything that reads like a token problem.
const SRC = join(import.meta.dirname, '..', '..', '..', 'src')
const FIXTURES = join(import.meta.dirname, 'fixtures')

// `sourceFiles` lists `.ts .tsx .js .jsx .astro .html` and therefore never
// reaches `src/index.css`, the one stylesheet in the repo. Its Tailwind classes
// are judged by `tests/unit/ui/index-css.test.ts`; a raw hex is not a class, so
// it is added to the hex walk here instead of being checked in a second place.
const INDEX_CSS = join(SRC, 'index.css')

// Both floors are about the guard itself rather than about the markup. A file
// walker that returns nothing, or a matcher that matches nothing, makes every
// assertion below pass vacuously — the same silent success the guard exists to
// prevent. Measured at 209 files / 407 colour classes; set at roughly 80% of
// that so deleting the UI or breaking the scanner is loud, but adding a
// primitive is not. Raise when a wave adds screens.
const MIN_FILES = 167
const MIN_MATCHES = 325

/** One thing a file should not contain, and the file it was found in. */
interface Finding {
  file: string
  found: string
}

/** What a failing assertion prints: the file, then the offending text. */
const report = (findings: Finding[]): string[] =>
  findings.map(({ file, found }) => `${file}: ${found}`)

/** Every source file a colour could be written into. */
const scanned = (): string[] => [...sourceFiles(SRC), INDEX_CSS]

// The types `npm run api:generate` writes from the pinned Core contract carry the contract's own
// prose as doc comments, verbatim: contract 0.14.0 cites « kodera-core #164 », which the hex
// pattern reads as a three-digit colour. The file is never hand-edited (docs/dev/API_CLIENT.md),
// renders nothing, and the contract is not this repository's to reword — so it is left out of the
// hex walk, and only that one. Every other check still reads it, and the exclusion is held to a
// file the walk really reaches, so it cannot quietly cover a path that has moved.
const CONTRACT_TYPES = join(SRC, 'api', 'schema.d.ts')
const scannedForHex = (): string[] => scanned().filter((file) => file !== CONTRACT_TYPES)

// ---------------------------------------------------------------------------

// The regex `tests/unit/toolchain.test.ts` already applies to
// `tailwind.config.ts`, pointed at the source tree as well — the half that was
// missing. The config could not name a colour; every component still could, and
// a hex in a `style` prop is the one way of writing a colour that no amount of
// class scanning will ever see.
//
// Comments are NOT stripped first, deliberately: stripping them needs either a
// parser or a regex that eats the `//` in a URL and with it anything after it on
// that line, which turns a false positive into a false negative. Writing a hex
// in a comment costs a rewording; missing one in code costs a palette.
const INLINE_HEX = /#[0-9a-fA-F]{3,8}\b/g

function inlineHex(files: string[]): Finding[] {
  const findings: Finding[] = []
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(INLINE_HEX)) {
      findings.push({ file, found: match[0] })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------

// The colour families Tailwind would emit for this repo's own config, minus the
// ones the tokens package owns. Derived rather than listed: the day the package
// publishes a family, it leaves this set on its own, and the day someone stops
// extending and starts replacing `theme.colors`, the set empties and the floor
// below says so.
//
// `transparent`, `current` and `inherit` stay out of it: they are CSS keywords
// that carry no colour value, and `bg-transparent` / `border-current` are how a
// primitive turns a colour OFF. Banning them would push people back to a hex.
const KEYWORD_COLOURS = new Set(['transparent', 'current', 'inherit'])
const OUR_FAMILIES = familiesOf(preset)
const FOREIGN_FAMILIES = new Set(
  [...COLOUR_FAMILIES].filter((family) => !OUR_FAMILIES.has(family) && !KEYWORD_COLOURS.has(family))
)

// Same shape as the package's own scanner, and the same prefixes, but the
// opposite verdict: it skips a family it does not recognise, this reports one.
// A class whose first segment is not a colour family at all (`text-center`,
// `border-l`, `text-md`) is in neither set and is matched by neither.
function foreignPalette(files: string[]): Finding[] {
  const findings: Finding[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const prefix of DEFAULT_PREFIXES) {
      const utility = new RegExp(String.raw`\b${prefix}-([a-z][a-z0-9-]*)`, 'g')
      for (const match of source.matchAll(utility)) {
        const rest = match[1] ?? ''
        if (FOREIGN_FAMILIES.has(rest.split('-')[0] ?? '')) {
          findings.push({ file, found: `${prefix}-${rest}` })
        }
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------

// `bg-[#ff0000]`, `text-[rgb(255,0,0)]`, `ring-[var(--whatever)]`. Tailwind
// emits a real rule for each, and the resolution scanner cannot see any of them:
// its character class stops at `[`. A value that has to be written by hand is a
// value the tokens package is missing, and that is where it is added.
const ARBITRARY_COLOUR = new RegExp(
  String.raw`\b(?:${DEFAULT_PREFIXES.join('|')})-\[[^\]\n]*\]`,
  'g'
)

function arbitraryColour(files: string[]): Finding[] {
  const findings: Finding[] = []
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(ARBITRARY_COLOUR)) {
      findings.push({ file, found: match[0] })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------

describe('design tokens', () => {
  it('every colour class in src/ names a token the preset actually declares', () => {
    const result = assertClassesResolve({
      files: sourceFiles(SRC),
      preset,
      minFiles: MIN_FILES,
      minMatches: MIN_MATCHES,
    })

    expect(result.unresolved).toEqual([])
  })

  it('fails when a class names a colour family and resolves to nothing', () => {
    // The mutation test TESTING.md §4 asks for: a guard nobody has watched fail
    // is a decoration. `bg-cobalt-450` is the exact shape of the bug — a real
    // family, a step that does not exist — and it must be reported, not skipped.
    expect(() =>
      assertClassesResolve({
        files: [join(FIXTURES, 'unresolved-token.tsx.fixture')],
        preset,
        // The fixture is one file and carries one class; the floors that guard
        // the guard would otherwise reject the mutation before it is judged.
        minFiles: 1,
        minMatches: 1,
      })
    ).toThrow(/bg-cobalt-450/)
  })

  it('walks enough files for the three checks below to mean anything', () => {
    // The floor `assertClassesResolve` applies to itself, applied to the walk
    // the checks below share. Without it an empty walk passes all three.
    expect(scanned().length).toBeGreaterThanOrEqual(MIN_FILES)
  })

  it('no source file carries an inline hex colour', () => {
    expect(report(inlineHex(scannedForHex()))).toEqual([])
  })

  it('leaves exactly one file out of the hex walk: the generated contract types', () => {
    // One walk each: `scannedForHex` walks the source tree, so calling it per file is quadratic.
    const all = scanned()
    const kept = new Set(scannedForHex())
    expect(all).toContain(CONTRACT_TYPES)
    expect(all.filter((file) => !kept.has(file))).toEqual([CONTRACT_TYPES])
  })

  it('reports an inline hex, including one in a style prop no class scanner reads', () => {
    const fixture = join(FIXTURES, 'inline-hex.tsx.fixture')
    expect(inlineHex([fixture]).map(({ found }) => found)).toEqual(['#ff0000'])
  })

  it('knows which colour families are Tailwind stock rather than ours', () => {
    // `theme.extend.colors` extends, so the whole stock palette stays live and
    // `bg-blue-500` emits `rgb(59 130 246)`. These assertions are what keeps the
    // set honest: our own families must never land in it, and a set that has
    // quietly emptied would let every check below pass on anything.
    expect(FOREIGN_FAMILIES.has('blue')).toBe(true)
    expect(FOREIGN_FAMILIES.has('emerald')).toBe(true)
    expect(FOREIGN_FAMILIES.has('cobalt')).toBe(false)
    expect(FOREIGN_FAMILIES.has('slate')).toBe(false)
    expect(FOREIGN_FAMILIES.has('transparent')).toBe(false)
    expect(FOREIGN_FAMILIES.size).toBeGreaterThanOrEqual(18)
  })

  it('no source file uses a colour family outside the preset', () => {
    expect(report(foreignPalette(scanned()))).toEqual([])
  })

  it('reports a stock Tailwind colour family the preset never declared', () => {
    const fixture = join(FIXTURES, 'foreign-palette.tsx.fixture')
    expect(foreignPalette([fixture]).map(({ found }) => found)).toEqual([
      'bg-blue-500',
      'text-emerald-600',
    ])
  })

  it('no source file carries an arbitrary value on a colour utility', () => {
    expect(report(arbitraryColour(scanned()))).toEqual([])
  })

  it('reports an arbitrary colour value the resolution scanner stops short of', () => {
    const fixture = join(FIXTURES, 'arbitrary-colour.tsx.fixture')
    expect(arbitraryColour([fixture]).map(({ found }) => found)).toEqual([
      'bg-[#ff0000]',
      'text-[#00ff00]',
    ])
  })
})
