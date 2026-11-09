import { readFileSync } from 'node:fs'
import type { KoderaTailwindPreset } from '@kodera/design-tokens/tailwind-preset'

// The colour guard (tokens.test.ts) judges one axis: a `bg-/text-/border-/…`
// class naming a colour family that resolves to no token emits no CSS and no
// error. Spacing and font weight fail a different way, and a quieter one: a
// Tailwind class outside the preset's spacing scale (`h-9`, `py-2.5`, `w-24`,
// `gap-1.5`, `w-80`…) still resolves — Tailwind ships its own rem-based scale
// as a fallback, so a real rule is emitted, on a size that is off our px grid
// by construction. `font-normal` is the same shape on font weight: it is a
// real Tailwind utility naming a weight the preset never named. Nothing here
// is red until someone puts two of these side by side and notices they do not
// line up.

/** The families this guard judges, in the order tried — longer names first so
 * `min-w-*` is consumed whole rather than leaving a bare `w-*` behind for a
 * second, wrong match to pick up. `inset-x`/`inset-y` are their own entries
 * for the same reason `gap-x`/`gap-y` and `space-x`/`space-y` are: without
 * them, bare `inset` matches first and swallows the axis into the value
 * (`inset-y-0` reads as prefix `inset`, value `y-0`, which resolves to
 * nothing and is wrongly rejected). */
const SPACING_PREFIXES = [
  'min-h',
  'min-w',
  'max-h',
  'max-w',
  'gap-x',
  'gap-y',
  'space-x',
  'space-y',
  'inset-x',
  'inset-y',
  'inset',
  'top',
  'left',
  'right',
  'bottom',
  'size',
  'px',
  'py',
  'pt',
  'pb',
  'pl',
  'pr',
  'p',
  'mx',
  'my',
  'mt',
  'mb',
  'ml',
  'mr',
  'm',
  'gap',
  'h',
  'w',
].sort((a, b) => b.length - a.length)

/** Values every one of the families above may carry without naming a preset
 * step: a keyword Tailwind defines outside the numeric scale, never a size in
 * disguise. `none` (`max-w-none`) removes a constraint and `reverse`
 * (`space-y-reverse`) flips an axis — neither is a length, so neither has a
 * step to name. */
const SPACING_KEYWORDS = new Set([
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
])

const FRACTION = /^\d+\/\d+$/

// A bracket value that ends directly in a length unit: `[6px]`, `[120px]`,
// `[90%]`.
const ARBITRARY_PX_OR_PERCENT = /^\[.+(?:px|%)\]$/

// `calc(...)` inside a bracket value is accepted only when every length
// literal inside it uses one of these units — `calc(100%-32px)` is a layout
// expression made of the same units the rest of this guard already allows;
// `calc(100%-2rem)` reaches for Tailwind's rem scale through the back door,
// which is exactly what this whole guard exists to stop.
const CALC_ALLOWED_UNITS = new Set(['px', '%', 'vw', 'vh'])
const CALC_LENGTH = /[\d.]+(px|%|vw|vh|rem|em|pt|pc|in|cm|mm|ex|ch|vmin|vmax)/gi

// Prefix + the separating `-`, nothing else — the value is parsed by hand
// below so a bracket value can carry balanced parens (`calc(100%-32px)`)
// instead of being cut at the first character a flat regex does not allow.
// A leading `-` (negative utilities, `-mt-2`) and variant prefixes
// (`sm:`, `hover:`, `focus-visible:`) both fall out for free: `\b` still
// holds at the boundary since `:` and `-` are non-word characters next to
// the word-char prefix.
const SPACING_PREFIX_RE = new RegExp(String.raw`(-)?\b(${SPACING_PREFIXES.join('|')})-`, 'g')

// `font-` weight utilities. `font-sans` / `font-mono` name a font FAMILY, not
// a weight, and are excluded below by checking the family keys first — this
// regex alone cannot tell the two apart. Only a bare word value is matched;
// an arbitrary `font-[…]` is out of this guard's scope, same as it always
// was.
const FONT_WEIGHT_CLASS_RE = /\bfont-([a-zA-Z][a-zA-Z0-9-]*)/g

export interface Violation {
  file: string
  line: number
  className: string
  allowed: string
}

export interface ScanResult {
  files: number
  matched: number
  violations: Violation[]
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/** What the mask was still inside when it ran out of source. `null` means it
 * ended cleanly, in code or in a line comment — both legal at end of file. */
type UnclosedState = 'block comment' | 'template literal' | null

interface LiteralMask {
  mask: Uint8Array
  unclosed: UnclosedState
}

// Marks every index that sits inside a single-quoted, double-quoted or
// template-literal STRING — never inside `//`/`/* */`/JSDoc, and never in
// bare code. A Tailwind class only ever reaches an element from one of
// those; prose that happens to spell `right-side` or `px-exact` in a comment
// is not markup and must never be judged as if it were.
//
// Deliberately not a full JS parser, and the price of that is exact: it does
// not recognise a REGEX literal, which is the one place a lone quote
// character legitimately stands on its own. `/["]/` opened a string state
// here that nothing ever closed, and the mask then ran inverted for the rest
// of the file — real markup read as bare code and never judged, a silent
// blindness no whole-run floor in `assertScaleResolves` can see. Two facts
// about the language bound it, and both are enforced below:
//
//  - A single- or double-quoted string cannot contain a raw newline. Meeting
//    one means the opening quote was never a string, so the mask resyncs to
//    `code` and a bad guess can never outlive the line it was made on.
//  - A template literal CAN contain a newline, so it gets no such resync. A
//    stray backtick therefore swallows the rest of the file, which is the
//    same blindness by another door — so a mask that ends inside one is
//    reported (`unclosed`) and `scanSource` refuses to return a verdict it
//    did not actually reach. Same for an unterminated block comment.
function stringLiteralMask(source: string): LiteralMask {
  const mask = new Uint8Array(source.length)
  type State = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'
  let state: State = 'code'
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment'
          i += 2
        } else if (c === '/' && next === '*') {
          state = 'block-comment'
          i += 2
        } else if (c === "'") {
          state = 'single'
          i += 1
        } else if (c === '"') {
          state = 'double'
          i += 1
        } else if (c === '`') {
          state = 'template'
          i += 1
        } else {
          i += 1
        }
        break
      case 'line-comment':
        if (c === '\n') state = 'code'
        i += 1
        break
      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code'
          i += 2
        } else {
          i += 1
        }
        break
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"'
        if (c === '\\') {
          // A backslash escapes whatever follows, a line continuation
          // included — so this branch must be tried before the newline one.
          i += 2
        } else if (c === '\n') {
          state = 'code'
          i += 1
        } else if (c === quote) {
          state = 'code'
          i += 1
        } else {
          mask[i] = 1
          i += 1
        }
        break
      }
      case 'template':
        if (c === '\\') {
          i += 2
        } else if (c === '`') {
          state = 'code'
          i += 1
        } else {
          mask[i] = 1
          i += 1
        }
        break
    }
  }

  const unclosed: UnclosedState =
    state === 'template' ? 'template literal' : state === 'block-comment' ? 'block comment' : null
  return { mask, unclosed }
}

function spacingKeysOf(preset: KoderaTailwindPreset): Set<string> {
  const spacing = preset.theme.extend.spacing
  if (!spacing || Object.keys(spacing).length === 0) {
    throw new Error(
      'the preset carries no theme.extend.spacing — nothing could ever be judged against it'
    )
  }
  return new Set(Object.keys(spacing))
}

function fontWeightKeysOf(preset: KoderaTailwindPreset): Set<string> {
  const weights = preset.theme.extend.fontWeight
  if (!weights || Object.keys(weights).length === 0) {
    throw new Error(
      'the preset carries no theme.extend.fontWeight — nothing could ever be judged against it'
    )
  }
  return new Set(Object.keys(weights))
}

function fontFamilyKeysOf(preset: KoderaTailwindPreset): Set<string> {
  const families = preset.theme.extend.fontFamily
  return new Set(families ? Object.keys(families) : [])
}

/**
 * The value after `prefix-`, parsed by hand rather than by a single flat
 * regex. A bracket value is read up to its OWN matching `]`, tracking
 * bracket depth, so `[calc(100%-32px)]` comes back as one token instead of
 * being cut at `calc`, the first character a plain `[\w...]` class does not
 * allow.
 */
function readValue(source: string, start: number): string {
  if (source[start] === '[') {
    let depth = 0
    let j = start
    for (; j < source.length; j++) {
      if (source[j] === '[') depth++
      else if (source[j] === ']') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    return source.slice(start, j)
  }
  const match = /^[A-Za-z0-9./%-]+/.exec(source.slice(start))
  return match ? match[0] : ''
}

/** Is `value` (a bracket value, brackets included) one this guard allows? */
function isAllowedBracket(value: string): boolean {
  if (ARBITRARY_PX_OR_PERCENT.test(value)) return true

  const inner = value.slice(1, -1)
  if (!/^calc\(.*\)$/.test(inner)) return false

  const units = [...inner.matchAll(CALC_LENGTH)].map((m) => m[1]?.toLowerCase())
  // No length literal at all is not a `calc()` this guard recognises as a
  // layout expression — reject rather than guess.
  if (units.length === 0) return false
  return units.every((unit) => unit !== undefined && CALC_ALLOWED_UNITS.has(unit))
}

function isAllowedSpacingValue(value: string, spacingKeys: Set<string>): boolean {
  if (value.startsWith('[')) return isAllowedBracket(value)
  return spacingKeys.has(value) || SPACING_KEYWORDS.has(value) || FRACTION.test(value)
}

function describeSpacingScale(spacingKeys: Set<string>): string {
  // Both lists are read from the constants above rather than restated in
  // prose: a message that names a value the guard no longer accepts, or omits
  // one it does, sends the next author to fix the wrong thing.
  return (
    `a preset spacing step (${[...spacingKeys].sort((a, b) => Number(a) - Number(b)).join(', ')}), ` +
    `a keyword (${[...SPACING_KEYWORDS].map((keyword) => `\`${keyword}\``).join(', ')}), ` +
    'a fraction (`1/2`), a bracket value ending in `px` or `%` (`h-[6px]`), or a bracket ' +
    '`calc(...)` whose lengths are all `px`, `%`, `vw` or `vh` (`w-[calc(100%-32px)]`)'
  )
}

function describeFontWeights(fontWeightKeys: Set<string>): string {
  return `a preset font weight (${[...fontWeightKeys].join(', ')})`
}

/**
 * Scan one file's source for spacing/size and font-weight utilities and
 * report every class that lands outside the preset. Only classes written
 * inside a string or template literal are judged — a comment or JSDoc block
 * that merely mentions a class-shaped word is not markup and is skipped by
 * construction.
 */
export function scanSource(
  file: string,
  source: string,
  preset: KoderaTailwindPreset
): { matched: number; violations: Violation[] } {
  const spacingKeys = spacingKeysOf(preset)
  const fontWeightKeys = fontWeightKeysOf(preset)
  const fontFamilyKeys = fontFamilyKeysOf(preset)
  const { mask: inLiteral, unclosed } = stringLiteralMask(source)
  // The mask never came back to code, so everything after the opening token
  // was read as one long literal and nothing after it was judged on its
  // merits. Reporting zero violations from that state would be a pass this
  // scan did not earn — the exact silent success the guard exists to prevent.
  if (unclosed !== null) {
    throw new Error(
      `${file}: the string mask reached end of file still inside an unterminated ${unclosed}, so ` +
        'the source after it was never judged. A lone backtick outside a string — one inside a ' +
        'regex character class, say — is the usual cause.'
    )
  }

  let matched = 0
  const violations: Violation[] = []

  for (const match of source.matchAll(SPACING_PREFIX_RE)) {
    if (inLiteral[match.index] !== 1) continue

    const sign = match[1] ?? ''
    const prefix = match[2]
    if (prefix === undefined) continue
    const valueStart = match.index + match[0].length
    const value = readValue(source, valueStart)
    if (value === '') continue

    matched++
    if (!isAllowedSpacingValue(value, spacingKeys)) {
      violations.push({
        file,
        line: lineAt(source, match.index),
        className: `${sign}${prefix}-${value}`,
        allowed: describeSpacingScale(spacingKeys),
      })
    }
  }

  for (const match of source.matchAll(FONT_WEIGHT_CLASS_RE)) {
    if (inLiteral[match.index] !== 1) continue

    const value = match[1]
    if (value === undefined) continue
    // Names a font FAMILY (`font-sans`, `font-mono`), not a weight — none of
    // this guard's business.
    if (fontFamilyKeys.has(value)) continue
    matched++
    if (!fontWeightKeys.has(value)) {
      violations.push({
        file,
        line: lineAt(source, match.index),
        className: `font-${value}`,
        allowed: describeFontWeights(fontWeightKeys),
      })
    }
  }

  return { matched, violations }
}

/**
 * Scan `files` and throw when any spacing/size or font-weight class falls off
 * the preset's scale.
 */
export function assertScaleResolves({
  files,
  preset,
  minFiles = 1,
  minMatches = 1,
}: {
  files: string[]
  preset: KoderaTailwindPreset
  minFiles?: number
  minMatches?: number
}): ScanResult {
  // Both floors are about the guard itself. A walker that returns nothing, or
  // a matcher that matches nothing, makes every assertion below pass
  // vacuously — the same silent success this guard exists to prevent.
  if (files.length < minFiles) {
    throw new Error(
      `spacing guard scanned ${files.length} file(s), expected at least ${minFiles} — the file walker is not reaching the source`
    )
  }

  let matched = 0
  const violations: Violation[] = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const result = scanSource(file, source, preset)
    matched += result.matched
    violations.push(...result.violations)
  }

  if (matched < minMatches) {
    throw new Error(
      `spacing guard matched ${matched} class(es), expected at least ${minMatches} — the matcher is silently matching nothing`
    )
  }

  if (violations.length) {
    throw new Error(
      `${violations.length} Tailwind class(es) fall off the design-token scale. Each still ` +
        "resolves to a real rule — Tailwind's own fallback scale — on a size or weight the " +
        'preset never named:\n  ' +
        violations
          .map((v) => `${v.file}:${v.line}: \`${v.className}\` — allowed: ${v.allowed}`)
          .join('\n  ')
    )
  }

  return { files: files.length, matched, violations }
}
