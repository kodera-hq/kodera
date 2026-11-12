// `npm run i18n:check`: the product code against the catalogues a browser actually loads.
//
// Three checks, all of which must pass:
//
// 1. **The namespace catalogues are sound** (`catalogues.ts`): both locales have the same
//    namespaces and, namespace by namespace, the same keys; every key sits in the namespace its
//    name says; the namespaces add up to the whole catalogue (`src/i18n/{fr,en}.json`) and to the
//    list the runtime knows (`src/i18n/namespaces.ts`).
// 2. **Every key the code names exists**: scans src/**/*.{ts,tsx} for `t('console....')` /
//    `t("console....")` string literals and fails when a referenced key is in no namespace
//    catalogue of either locale. Unlike scripts/check-copy-keys.py (which checks the markdown
//    catalogues against docs/specs/), this checks the *product code* against the generated JSON —
//    the thing that would actually break i18next's missingKeyHandler at runtime. It reads the
//    namespace catalogues, not the whole one: a key the whole catalogue has and no namespace
//    carries is a key no browser would ever be sent.
// 3. **Every route has its namespaces** (`route-namespaces.ts`): no module reads a namespace that
//    is not loaded where the module is reachable.
//
// Usage: node scripts/i18n/check-used-keys.ts [--src <dir>]
//          [--catalogues <dir>] [--fr <path>] [--en <path>] [--namespaces <path>] [--entry <path>]
// Every path defaults to its place under `--src` (`src`); the overrides exist so the self-test
// (check-used-keys.selftest.sh) can point each check at a fixture.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkNamespaceCatalogues, readNamespaceCatalogues, unionOf } from './catalogues.ts'
import { checkRouteNamespaces } from './route-namespaces.ts'

export class UsageCheckError extends Error {}

// A key call is `t(` followed by a single- or double-quoted string starting
// with `console.`. Anything else passed to `t()` — a template literal, a
// variable, a computed key — is out of scope: this is a literal-key check,
// the same class of check the brief asks for, not a full static analyser.
const KEY_CALL_PATTERN = /\bt\(\s*(['"])(console\.[^'"]*)\1/g

export interface KeyUsage {
  key: string
  file: string
}

export function findUsedKeys(source: string, file: string): KeyUsage[] {
  const usages: KeyUsage[] = []
  const pattern = new RegExp(KEY_CALL_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const key = match[2]
    if (key !== undefined) usages.push({ key, file })
  }
  return usages
}

export function walkSourceFiles(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No src/ yet is expected at this stage of the build, not an error.
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

export interface CheckResult {
  checked: number
  filesScanned: number
  missing: KeyUsage[]
}

// A plain-key entry (`key in catalogue`) or a pluralised one
// (`key_other` present, i18next JSON v4) both count as defined.
function isDefined(key: string, catalogue: Record<string, string>): boolean {
  return key in catalogue || `${key}_other` in catalogue
}

export function check(
  sourceDir: string,
  fr: Record<string, string>,
  en: Record<string, string>
): CheckResult {
  const files = walkSourceFiles(sourceDir)
  const missing: KeyUsage[] = []
  let checked = 0

  for (const file of files) {
    if (statSync(file).isFile()) {
      const source = readFileSync(file, 'utf8')
      for (const usage of findUsedKeys(source, file)) {
        checked++
        if (!isDefined(usage.key, fr) || !isDefined(usage.key, en)) {
          missing.push(usage)
        }
      }
    }
  }

  return { checked, filesScanned: files.length, missing }
}

interface CliArgs {
  src: string
  catalogues: string
  fr: string
  en: string
  namespaces: string
  entry: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag?.startsWith('--')) {
      const name = flag.slice(2)
      const value = argv[i + 1]
      if (value === undefined) {
        throw new UsageCheckError(`missing value for --${name}`)
      }
      args[name] = value
      i++
    }
  }
  const src = args.src ?? 'src'
  return {
    src,
    catalogues: args.catalogues ?? join(src, 'i18n', 'catalogues'),
    fr: args.fr ?? join(src, 'i18n', 'fr.json'),
    en: args.en ?? join(src, 'i18n', 'en.json'),
    namespaces: args.namespaces ?? join(src, 'i18n', 'namespaces.ts'),
    entry: args.entry ?? join(src, 'main.tsx'),
  }
}

interface NamespaceLists {
  MESSAGE_NAMESPACES: readonly string[]
  ENTRY_NAMESPACES: readonly string[]
  /** Every list the module exports, by name: a route boundary may name one. */
  named: Record<string, readonly string[]>
}

async function readNamespaceLists(path: string): Promise<NamespaceLists> {
  const lists = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>
  const named: Record<string, readonly string[]> = {}
  for (const [name, value] of Object.entries(lists)) {
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      named[name] = value as string[]
    }
  }
  const { MESSAGE_NAMESPACES, ENTRY_NAMESPACES } = named
  if (MESSAGE_NAMESPACES === undefined || ENTRY_NAMESPACES === undefined) {
    throw new UsageCheckError(`${path} must export MESSAGE_NAMESPACES and ENTRY_NAMESPACES`)
  }
  return { MESSAGE_NAMESPACES, ENTRY_NAMESPACES, named }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const lists = await readNamespaceLists(args.namespaces)
  const catalogues = readNamespaceCatalogues(args.catalogues)
  const problems: string[] = []

  const catalogueProblems = checkNamespaceCatalogues({
    catalogues,
    declared: lists.MESSAGE_NAMESPACES,
    whole: {
      fr: JSON.parse(readFileSync(args.fr, 'utf8')) as Record<string, string>,
      en: JSON.parse(readFileSync(args.en, 'utf8')) as Record<string, string>,
    },
  })
  console.log(
    `checked ${Object.keys(catalogues.fr).length} namespace catalogue(s) per locale under ${args.catalogues}`
  )
  problems.push(...catalogueProblems.map((problem) => `namespace catalogues: ${problem}`))

  const result = check(args.src, unionOf(catalogues.fr), unionOf(catalogues.en))
  console.log(
    `checked ${result.checked} key usage(s) across ${result.filesScanned} file(s) under ${args.src}`
  )
  problems.push(
    ...result.missing.map((usage) => `${usage.file}: unknown message-catalogue key: ${usage.key}`)
  )

  const routes = checkRouteNamespaces({
    srcDir: resolve(args.src),
    entry: resolve(args.entry),
    namespaces: lists.MESSAGE_NAMESPACES,
    entryNamespaces: lists.ENTRY_NAMESPACES,
    namedLists: lists.named,
  })
  console.log(
    `checked the namespaces of ${routes.contexts.length - 1} lazy route(s) and of the entry (${lists.ENTRY_NAMESPACES.join(', ')})`
  )
  for (const context of routes.contexts) {
    if (context.unused.length > 0) {
      console.log(
        `note: ${context.name} names ${context.unused.join(', ')} and nothing behind it reads ${context.unused.length === 1 ? 'it' : 'them'}`
      )
    }
  }
  problems.push(...routes.problems.map((problem) => `route namespaces: ${problem}`))

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`\n${problems.length} problem(s).`)
    process.exit(1)
  }
  console.log(
    'OK — the namespace catalogues are sound, every key used exists, and every route has its namespaces.'
  )
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
