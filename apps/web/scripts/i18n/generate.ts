// Generates the runtime i18next catalogues from the message-catalogue markdown
// tables (docs/specs/copy/fr.md, docs/specs/copy/en.md). The markdown is the
// source of truth; the JSON is generated and must never be hand-edited (see
// docs/dev/I18N.md).
//
// Two shapes of the same keys are written:
//
// - `src/i18n/{fr,en}.json`: the whole catalogue. It types `MessageKey`, feeds
//   the unit suite and the build-time recovery markup, and is never part of
//   what a browser downloads.
// - `src/i18n/catalogues/{fr,en}/<namespace>.json`: the same keys, one file
//   per namespace. A key's namespace is its `<area>` segment
//   (`console.people.list.title` -> `people`). These are what the browser
//   loads, a namespace at a time (`src/i18n/index.ts`).
//
// Usage: node scripts/i18n/generate.ts [--fr <path>] [--en <path>] [--out <dir>]
// All paths default to the real catalogues/output and are resolved against
// the current working directory; the --fr/--en/--out overrides exist so the
// selftest (generate.selftest.sh) and the regen-clean unit test can point the
// generator at fixtures without touching the committed files.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export class CatalogueError extends Error {}

// Observed key grammar (docs/specs/copy/{fr,en}.md, 804 rows each): the brief
// describes it as `^console\.[a-z0-9-]+(\.[a-z0-9-]+)+$`, but that is not
// quite what the catalogues contain. `common` is genuinely flat
// (`console.common.<key>`, two segments after `console`); every other area
// is `console.<area>.<screen>.<key>` (three segments), where `<screen>` is
// either a lowercase-dash name or the literal `_` for a string that belongs
// to the area as a whole rather than one screen (e.g.
// `console.shell._.error-load-failed`, `console.order._.title`). No area name
// itself contains a dash. This regex is that shape, not the brief's guess.
export const KEY_SHAPE = /^console\.(common\.[a-z0-9-]+|[a-z]+\.(?:_|[a-z0-9-]+)\.[a-z0-9-]+)$/

export interface CatalogueRow {
  key: string
  raw: string
  line: number
}

// Every row in both files is exactly `| \`console.<key>\` | <text> |` on one
// line: a two-column table, the key in backticks, no multi-line cells, and no
// escaped pipes anywhere in 804 rows per file (verified by inspection). A
// line that starts like a key row but does not match that shape is a
// malformed row and fails the build rather than being silently skipped or
// mis-split.
const ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|$/

export function parseRows(text: string, filename: string): CatalogueRow[] {
  const rows: CatalogueRow[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.startsWith('| `console.')) continue
    const match = ROW_PATTERN.exec(line)
    if (!match) {
      throw new CatalogueError(
        `${filename}:${i + 1}: malformed catalogue row (expected "| \`key\` | text |"): ${line}`
      )
    }
    const key = match[1] ?? ''
    const raw = match[2] ?? ''
    rows.push({ key, raw, line: i + 1 })
  }
  return rows
}

// A value cell that is *entirely* an ICU plural block:
//   {<pivot>, plural, one {<text>} [many {<text>}] other {<text>}}
// The optional `many` category covers French whole multiples of a million.
// The block is always the whole cell, never embedded in a longer sentence.
export interface PluralBlock {
  pivot: string
  one: string
  many?: string
  other: string
}

function extractBraced(source: string, start: number): { body: string; next: number } {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return { body: source.slice(start + 1, i), next: i + 1 }
    }
  }
  throw new CatalogueError(`unbalanced braces from index ${start} in: ${source}`)
}

export function parsePluralBlock(value: string): PluralBlock | null {
  const header = /^\{([a-zA-Z][a-zA-Z0-9]*),\s*plural,\s*/.exec(value)
  if (!header) return null

  let i = header[0].length
  const oneKeyword = /^one\s*/.exec(value.slice(i))
  if (!oneKeyword || value[i + oneKeyword[0].length] !== '{') {
    throw new CatalogueError(`expected "one {...}" after the plural header in: ${value}`)
  }
  i += oneKeyword[0].length
  const one = extractBraced(value, i)
  i = one.next

  const gapAfterOne = /^\s*/.exec(value.slice(i))?.[0] ?? ''
  i += gapAfterOne.length
  let many: string | undefined
  const manyKeyword = /^many\s*/.exec(value.slice(i))
  if (manyKeyword) {
    i += manyKeyword[0].length
    if (value[i] !== '{') {
      throw new CatalogueError(`expected "many {...}" in: ${value}`)
    }
    const block = extractBraced(value, i)
    many = block.body
    i = block.next + (/^\s*/.exec(value.slice(block.next))?.[0].length ?? 0)
  }
  const otherKeyword = /^other\s*/.exec(value.slice(i))
  if (!otherKeyword || value[i + otherKeyword[0].length] !== '{') {
    throw new CatalogueError(`expected "other {...}" after "one {...}" in: ${value}`)
  }
  i += otherKeyword[0].length
  const other = extractBraced(value, i)
  i = other.next

  const gapAfterOther = /^\s*/.exec(value.slice(i))?.[0] ?? ''
  i += gapAfterOther.length
  if (value[i] !== '}') {
    throw new CatalogueError(`expected the plural block to close in: ${value}`)
  }
  i += 1
  if (i !== value.length) {
    throw new CatalogueError(`unexpected content after the plural block in: ${value}`)
  }

  return {
    pivot: header[1] ?? '',
    one: one.body,
    ...(many === undefined ? {} : { many }),
    other: other.body,
  }
}

// i18next's default interpolation is `{{name}}`; the catalogues write
// `{name}` (the design drop's convention, carried through — see
// docs/specs/copy/MAPPING.md). This is the one mechanical rewrite the
// generator applies to every placeholder outside a plural block's own
// `{pivot, plural, ...}` wrapper.
export function convertPlaceholders(value: string): string {
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, '{{$1}}')
}

// One catalogue row becomes one JSON entry, or one per explicit plural
// category (i18next JSON v4: `<key>_one` / `<key>_many` / `<key>_other`). `console.invoices.list
// .status-overdue` pluralises on `{days}`, not `{count}` — i18next only ever
// selects `_one` vs `_other` from the `count` option passed to `t()`, so that
// row's plural selection is unreachable through i18next's own mechanism.
// This is a catalogue defect upstream of this generator, reported by
// `npm run i18n:generate`, not corrected here: the `_one`/`_other` values are
// generated like every other plural row, so the string is not lost, but
// calling code will need to pass a `count` option to select between them.
export function toJsonEntries(key: string, raw: string): [string, string][] {
  const plural = parsePluralBlock(raw)
  if (!plural) return [[key, convertPlaceholders(raw)]]
  return [
    [`${key}_one`, convertPlaceholders(plural.one)],
    ...(plural.many === undefined
      ? []
      : [[`${key}_many`, convertPlaceholders(plural.many)] as [string, string]]),
    [`${key}_other`, convertPlaceholders(plural.other)],
  ]
}

export interface BuildResult {
  entries: Record<string, string>
  pluralKeys: string[]
  nonCountPluralKeys: string[]
}

export function buildCatalogue(rows: CatalogueRow[], filename: string): BuildResult {
  const seen = new Set<string>()
  const entries: Record<string, string> = {}
  const pluralKeys: string[] = []
  const nonCountPluralKeys: string[] = []

  for (const { key, raw, line } of rows) {
    if (!KEY_SHAPE.test(key)) {
      throw new CatalogueError(
        `${filename}:${line}: key does not match console.<area>.<screen>.<key> ` +
          `(or console.common.<key> for the shared area): ${key}`
      )
    }
    if (seen.has(key)) {
      throw new CatalogueError(`${filename}:${line}: duplicate key: ${key}`)
    }
    seen.add(key)

    const plural = parsePluralBlock(raw)
    if (plural) {
      pluralKeys.push(key)
      if (plural.pivot !== 'count') nonCountPluralKeys.push(key)
    }
    for (const [entryKey, entryValue] of toJsonEntries(key, raw)) {
      entries[entryKey] = entryValue
    }
  }

  return { entries, pluralKeys, nonCountPluralKeys }
}

function sortEntries(entries: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = entries[key] ?? ''
  }
  return sorted
}

export interface GenerateResult {
  fr: Record<string, string>
  en: Record<string, string>
  keyCount: number
  pluralKeyCount: number
  nonCountPluralKeys: string[]
}

export function generate(
  frText: string,
  enText: string,
  frFile: string,
  enFile: string
): GenerateResult {
  const frRows = parseRows(frText, frFile)
  const enRows = parseRows(enText, enFile)

  const frKeys = new Set(frRows.map((row) => row.key))
  const enKeys = new Set(enRows.map((row) => row.key))
  const onlyInFr = [...frKeys].filter((key) => !enKeys.has(key)).sort()
  const onlyInEn = [...enKeys].filter((key) => !frKeys.has(key)).sort()
  if (onlyInFr.length > 0 || onlyInEn.length > 0) {
    const problems = [
      ...onlyInFr.map((key) => `key in ${frFile} is missing from ${enFile}: ${key}`),
      ...onlyInEn.map((key) => `key in ${enFile} is missing from ${frFile}: ${key}`),
    ]
    throw new CatalogueError(problems.join('\n'))
  }

  const fr = buildCatalogue(frRows, frFile)
  const en = buildCatalogue(enRows, enFile)

  return {
    fr: sortEntries(fr.entries),
    en: sortEntries(en.entries),
    keyCount: frKeys.size,
    pluralKeyCount: fr.pluralKeys.length,
    nonCountPluralKeys: fr.nonCountPluralKeys,
  }
}

export function serialize(entries: Record<string, string>): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

/** The directory, under the output directory, that holds one catalogue per namespace and locale. */
export const NAMESPACE_DIRECTORY = 'catalogues'

/**
 * The namespace a generated entry belongs to: the `<area>` segment of its key. Read from the key
 * itself, so a plural entry (`console.people.invite.action-send_one`) follows its row.
 */
export function namespaceOf(entryKey: string): string {
  const namespace = /^console\.([a-z]+)\./.exec(entryKey)?.[1]
  if (namespace === undefined) {
    throw new CatalogueError(`key has no namespace segment: ${entryKey}`)
  }
  return namespace
}

/** One catalogue per namespace, namespaces and keys both sorted, every entry in exactly one. */
export function partitionByNamespace(
  entries: Record<string, string>
): Record<string, Record<string, string>> {
  const grouped = new Map<string, Record<string, string>>()
  for (const key of Object.keys(entries).sort()) {
    const namespace = namespaceOf(key)
    const catalogue = grouped.get(namespace) ?? {}
    catalogue[key] = entries[key] ?? ''
    grouped.set(namespace, catalogue)
  }
  const partition: Record<string, Record<string, string>> = {}
  for (const namespace of [...grouped.keys()].sort()) {
    partition[namespace] = grouped.get(namespace) ?? {}
  }
  return partition
}

/**
 * Writes one locale's namespace catalogues and removes any left from an earlier run, so a
 * namespace that lost its last key does not stay behind as a file the runtime could still load.
 */
function writeNamespaceCatalogues(directory: string, entries: Record<string, string>): number {
  const partition = partitionByNamespace(entries)
  mkdirSync(directory, { recursive: true })
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.json') && !Object.hasOwn(partition, name.slice(0, -'.json'.length))) {
      rmSync(join(directory, name))
    }
  }
  for (const [namespace, catalogue] of Object.entries(partition)) {
    writeFileSync(join(directory, `${namespace}.json`), serialize(catalogue))
  }
  return Object.keys(partition).length
}

interface CliArgs {
  fr: string
  en: string
  out: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag?.startsWith('--')) {
      const name = flag.slice(2)
      const value = argv[i + 1]
      if (value === undefined) {
        throw new CatalogueError(`missing value for --${name}`)
      }
      args[name] = value
      i++
    }
  }
  return {
    fr: args.fr ?? 'docs/specs/copy/fr.md',
    en: args.en ?? 'docs/specs/copy/en.md',
    out: args.out ?? 'src/i18n',
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const frText = readFileSync(args.fr, 'utf8')
  const enText = readFileSync(args.en, 'utf8')

  const result = generate(frText, enText, args.fr, args.en)

  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, 'fr.json'), serialize(result.fr))
  writeFileSync(join(args.out, 'en.json'), serialize(result.en))
  const namespaceCount = writeNamespaceCatalogues(
    join(args.out, NAMESPACE_DIRECTORY, 'fr'),
    result.fr
  )
  writeNamespaceCatalogues(join(args.out, NAMESPACE_DIRECTORY, 'en'), result.en)

  console.log(`generated ${result.keyCount} keys per catalogue -> ${args.out}/{fr,en}.json`)
  console.log(
    `split into ${namespaceCount} namespaces -> ${args.out}/${NAMESPACE_DIRECTORY}/{fr,en}/<namespace>.json`
  )
  console.log(`${result.pluralKeyCount} plural rows found`)
  if (result.nonCountPluralKeys.length > 0) {
    console.log(
      `note: plural rows not pivoted on {count} (catalogue defect, not fixed here): ` +
        result.nonCountPluralKeys.join(', ')
    )
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
