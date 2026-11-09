// Ties the copy catalogues' percent typography to what `formatPercent`
// actually emits, so the two cannot drift the way they did before the fix in
// commit e65d038 (a plain space where the formatter renders a no-break
// space). Reads the separator from the formatter itself rather than
// hard-coding it — docs/dev/I18N.md's point about `Intl` over hand-rolled
// typography applies to this test too.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { formatPercent } from '@/i18n/format'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

// The character `formatPercent` places between the digits and the `%`, or
// `''` when it places none (English).
function separatorBeforePercent(locale: 'fr' | 'en'): string {
  const formatted = formatPercent(92, locale)
  const percentIndex = formatted.indexOf('%')
  const charBefore = formatted[percentIndex - 1]
  if (charBefore === undefined || /\d/u.test(charBefore)) return ''
  return charBefore
}

interface PercentRow {
  source: string
  separator: string
  excerpt: string
}

// Every place in `text` where a digit is immediately followed by `%`
// (`separator: ''`) or by one character then `%` (`separator` is that
// character). Code spans are stripped first so a literal `%` inside a
// `` `...` `` example isn't mistaken for prose. Matches are found by walking
// codepoints rather than a single regexp so a percentage can be identified
// (digit before `%`) independently of how wide its separator is.
function findPercentRows(text: string, source: string): PercentRow[] {
  const withoutCodeSpans = text.replace(/`[^`]*`/gu, '')
  const chars = [...withoutCodeSpans]
  const rows: PercentRow[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '%') continue
    const excerpt = chars.slice(Math.max(0, i - 24), i + 1).join('')
    const before = chars[i - 1]
    if (before !== undefined && /\d/u.test(before)) {
      rows.push({ source, separator: '', excerpt })
    } else if (before !== undefined && /\d/u.test(chars[i - 2] ?? '')) {
      rows.push({ source, separator: before, excerpt })
    }
  }
  return rows
}

function assertConsistent(rows: PercentRow[], expected: string, minRows: number): void {
  console.log(
    `percent-separator: checked ${rows.length} row(s): ${rows.map((r) => r.source).join(', ')}`
  )
  expect(rows.length).toBeGreaterThanOrEqual(minRows)
  for (const row of rows) {
    expect(row.separator, `${row.source} — ".${row.excerpt}"`).toBe(expected)
  }
}

describe('percent separator consistency', () => {
  const frSeparator = separatorBeforePercent('fr')
  const enSeparator = separatorBeforePercent('en')

  it("formatPercent('fr') separates the digits from % with a no-break space", () => {
    expect(frSeparator).toBe(' ')
  })

  it("formatPercent('en') puts no separator before %", () => {
    expect(enSeparator).toBe('')
  })

  it("every French percentage in fr.md and fr.json uses the formatter's separator", () => {
    const rows = [
      ...findPercentRows(read('docs/specs/copy/fr.md'), 'docs/specs/copy/fr.md'),
      ...findPercentRows(read('src/i18n/fr.json'), 'src/i18n/fr.json'),
    ]
    // ≥ 10 so this cannot pass by vacuously finding nothing to check.
    assertConsistent(rows, frSeparator, 10)
  })

  it('every English percentage in en.md and en.json has no separator before %', () => {
    const rows = [
      ...findPercentRows(read('docs/specs/copy/en.md'), 'docs/specs/copy/en.md'),
      ...findPercentRows(read('src/i18n/en.json'), 'src/i18n/en.json'),
    ]
    assertConsistent(rows, enSeparator, 10)
  })

  // Permanent fixture: a row using a plain space (not the no-break space
  // formatPercent emits) must be caught, so the checks above cannot be
  // silently vacuous or broken.
  it('the scanner flags a plain-space fixture as inconsistent', () => {
    const fixture = 'Alerte à 92 % du quota (espace normale, pas insécable)'
    const rows = findPercentRows(fixture, 'fixture')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.separator).toBe(' ')
    expect(rows[0]?.separator).not.toBe(frSeparator)
  })
})
