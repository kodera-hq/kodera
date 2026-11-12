// Regenerating from the committed markdown must reproduce the committed JSON
// exactly. If this test fails, either the markdown catalogues changed
// without running `npm run i18n:generate`, or the JSON was hand-edited —
// both forbidden by docs/dev/I18N.md.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  NAMESPACE_DIRECTORY,
  generate,
  namespaceOf,
  partitionByNamespace,
  serialize,
} from '../../../scripts/i18n/generate.ts'
import { MESSAGE_NAMESPACES } from '../../../src/i18n/namespaces.ts'

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

  // What a browser loads is the same catalogue, one file per namespace
  // (`src/i18n/catalogues/<locale>/<namespace>.json`). A markdown edit that
  // regenerated only by hand, or a merge that kept one side's whole catalogue
  // and the other's namespace files, shows up here and nowhere else: the rest
  // of this suite renders from the whole catalogue.
  describe.each([
    ['fr', () => result.fr],
    ['en', () => result.en],
  ] as const)('the %s namespace catalogues', (locale, entries) => {
    const directory = join('src', 'i18n', NAMESPACE_DIRECTORY, locale)

    it('are exactly the namespaces the catalogue has, no file more and none less', () => {
      const files = readdirSync(join(root, directory)).sort()
      const expected = Object.keys(partitionByNamespace(entries())).map((name) => `${name}.json`)
      expect(files).toEqual(expected)
      expect(files.map((name) => name.slice(0, -'.json'.length))).toEqual([...MESSAGE_NAMESPACES])
    })

    it('match what regeneration writes, file by file', () => {
      for (const [namespace, catalogue] of Object.entries(partitionByNamespace(entries()))) {
        expect(read(join(directory, `${namespace}.json`)), `${locale}/${namespace}.json`).toBe(
          serialize(catalogue)
        )
      }
    })
  })

  it('files every entry under the namespace its key names, plural entries with their row', () => {
    const partition = partitionByNamespace({
      'console.people.invite.action-send_one': 'a',
      'console.people.invite.action-send_other': 'b',
      'console.common.action-continue': 'c',
    })
    expect(Object.keys(partition)).toEqual(['common', 'people'])
    expect(Object.keys(partition['people'] ?? {})).toEqual([
      'console.people.invite.action-send_one',
      'console.people.invite.action-send_other',
    ])
    expect(namespaceOf('console.common.action-continue')).toBe('common')
    expect(() => namespaceOf('not-a-key')).toThrow('key has no namespace segment')
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
