// Scans src/**/*.{ts,tsx} for `t('console....')` / `t("console....")` string
// literals and fails when a referenced key is absent from either generated
// catalogue. Unlike scripts/check-copy-keys.py (which checks the markdown
// catalogues against docs/specs/), this checks the *product code* against the
// generated JSON — the thing that would actually break i18next's
// missingKeyHandler at runtime.
//
// Usage: node scripts/i18n/check-used-keys.ts [--src <dir>] [--fr <path>] [--en <path>]
// There is no product code under src/ yet (see docs/dev/BASELINE.md), so this
// is exercised against fixtures — see check-used-keys.selftest.sh.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  fr: string
  en: string
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
  return {
    src: args.src ?? 'src',
    fr: args.fr ?? 'src/i18n/fr.json',
    en: args.en ?? 'src/i18n/en.json',
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const fr = JSON.parse(readFileSync(args.fr, 'utf8')) as Record<string, string>
  const en = JSON.parse(readFileSync(args.en, 'utf8')) as Record<string, string>

  const result = check(args.src, fr, en)

  console.log(
    `checked ${result.checked} key usage(s) across ${result.filesScanned} file(s) under ${args.src}`
  )

  if (result.missing.length > 0) {
    for (const usage of result.missing) {
      console.error(`${usage.file}: unknown message-catalogue key: ${usage.key}`)
    }
    console.error(`\n${result.missing.length} unknown key(s).`)
    process.exit(1)
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
