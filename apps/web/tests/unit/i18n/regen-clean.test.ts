// Regenerating from the committed markdown must reproduce the committed JSON
// exactly. If this test fails, either the markdown catalogues changed
// without running `npm run i18n:generate`, or the JSON was hand-edited —
// both forbidden by docs/dev/I18N.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { generate, serialize } from '../../../scripts/i18n/generate.ts'

// `import.meta.dirname`, not `new URL(..., import.meta.url)`: under jsdom the
// URL constructor resolves relative specifiers against the document's base
// (http://localhost:3000/) rather than the filesystem — see the same note in
// tests/unit/toolchain.test.ts.
const root = join(import.meta.dirname, '..', '..', '..')
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

const frMarkdownPath = 'docs/specs/copy/fr.md'
const enMarkdownPath = 'docs/specs/copy/en.md'
const frJsonPath = 'src/i18n/fr.json'
const enJsonPath = 'src/i18n/en.json'

describe('generated catalogues', () => {
  const frMarkdown = read(frMarkdownPath)
  const enMarkdown = read(enMarkdownPath)
  const result = generate(frMarkdown, enMarkdown, frMarkdownPath, enMarkdownPath)

  it('preserves an explicit many category for million-count French plurals', () => {
    const key = 'console.login.realm.error-rate-limited'
    const row = `| \`${key}\` | {count, plural, one {Wait {count} second.} many {Wait {count} million-category seconds.} other {Wait {count} seconds.}} |`
    const generated = generate(row, row, 'fr.md', 'en.md')
    expect(generated.fr[`${key}_many`]).toBe('Wait {{count}} million-category seconds.')
    expect(generated.en[`${key}_many`]).toBe('Wait {{count}} million-category seconds.')
  })

  it('rejects a malformed optional many category', () => {
    const row =
      '| `console.login.realm.error-rate-limited` | {count, plural, one {Wait.} many Wait. other {Wait.}} |'
    expect(() => generate(row, row, 'fr.md', 'en.md')).toThrow('expected "many {...}"')
  })

  it('rejects trailing content after a plural block', () => {
    const row =
      '| `console.login.realm.error-rate-limited` | {count, plural, one {Wait.} other {Wait.}} trailing |'
    expect(() => generate(row, row, 'fr.md', 'en.md')).toThrow(
      'unexpected content after the plural block'
    )
  })

  it('matches the committed fr.json exactly (regeneration is clean)', () => {
    expect(serialize(result.fr)).toBe(read(frJsonPath))
  })

  it('matches the committed en.json exactly (regeneration is clean)', () => {
    expect(serialize(result.en)).toBe(read(enJsonPath))
  })

  it('turns every key row of the markdown into exactly one key', () => {
    // Derived from the catalogue, never a literal: a pinned row count had to
    // be bumped by every branch that adds copy, so it was the one line every
    // pair of branches conflicted on, and it proved nothing the other
    // assertions here do not. What a count can still catch — the generator
    // silently dropping a row, or a key defined twice — this keeps checking,
    // against the markdown's own key rows (the same `| \`console.` prefix
    // `parseRows` keys on).
    const keyRows = (markdown: string) =>
      markdown.split('\n').filter((line) => line.startsWith('| `console.')).length
    expect(result.keyCount).toBe(keyRows(frMarkdown))
    expect(result.keyCount).toBe(keyRows(enMarkdown))
  })

  it('has parity: fr.json and en.json define exactly the same keys', () => {
    expect(Object.keys(result.fr).sort()).toEqual(Object.keys(result.en).sort())
  })

  it('is idempotent: regenerating twice from the same markdown is unchanged', () => {
    const again = generate(frMarkdown, enMarkdown, frMarkdownPath, enMarkdownPath)
    expect(serialize(again.fr)).toBe(serialize(result.fr))
    expect(serialize(again.en)).toBe(serialize(result.en))
  })
})
