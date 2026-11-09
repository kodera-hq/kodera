// Pure helpers for the CSV import (docs/specs/03-people.md §4.3): the first
// guess at which column holds what, and the two files the console builds
// itself — the template and the failed rows. Neither ever asks the server:
// the API keeps no second export of a customer's address book.

import type { MemberImport } from './queries'
import type { ColumnMapping } from './memberImport'

export type ImportField = 'email' | 'given_name' | 'family_name' | 'role'
export type FieldChoice = ImportField | 'ignore'

/** Column index → the field it feeds. */
export type Mapping = Record<number, FieldChoice>

export const IMPORT_FIELDS: readonly ImportField[] = ['email', 'given_name', 'family_name', 'role']

function normalise(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function guessField(header: string | null, sample: string | null): ImportField | null {
  const name = normalise(header ?? '')
  if (/mail|courriel/.test(name)) return 'email'
  // "Prénom" contains "nom": the given name is tested first.
  if (/prenom|first|given/.test(name)) return 'given_name'
  if (/\bnom\b|last|family|surname/.test(name)) return 'family_name'
  if (/\brole\b/.test(name)) return 'role'
  if (header === null && sample !== null && sample.includes('@')) return 'email'
  return null
}

/** A first guess from the headers; each field is given to one column at most. */
export function guessMapping(columns: MemberImport['detected_columns']): Mapping {
  const taken = new Set<ImportField>()
  const mapping: Mapping = {}
  for (const column of columns) {
    const field = guessField(column.header ?? null, column.sample ?? null)
    if (field === null || taken.has(field)) {
      mapping[column.index] = 'ignore'
    } else {
      taken.add(field)
      mapping[column.index] = field
    }
  }
  return mapping
}

/** The mapping the server already holds, read back after a reload. */
export function mappingFrom(
  columns: MemberImport['detected_columns'],
  saved: ColumnMapping
): Mapping {
  const mapping: Mapping = {}
  for (const column of columns) mapping[column.index] = 'ignore'
  for (const field of IMPORT_FIELDS) {
    const index = saved[field]
    if (typeof index === 'number') mapping[index] = field
  }
  return mapping
}

/** Choosing a field for one column takes it away from any other column. */
export function assign(mapping: Mapping, index: number, choice: FieldChoice): Mapping {
  const next: Mapping = {}
  for (const [key, value] of Object.entries(mapping)) {
    next[Number(key)] = choice !== 'ignore' && value === choice ? 'ignore' : value
  }
  next[index] = choice
  return next
}

/** The contract's shape, or `null` while no column carries the email. */
export function toColumnMapping(mapping: Mapping): ColumnMapping | null {
  const indexOf = (field: ImportField) => {
    const found = Object.entries(mapping).find(([, value]) => value === field)
    return found === undefined ? null : Number(found[0])
  }
  const email = indexOf('email')
  if (email === null) return null
  return {
    email,
    given_name: indexOf('given_name'),
    family_name: indexOf('family_name'),
    role: indexOf('role'),
  }
}

export function sameMapping(a: ColumnMapping | null | undefined, b: ColumnMapping): boolean {
  if (a === null || a === undefined) return false
  return IMPORT_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null))
}

/**
 * A cell a spreadsheet may run as a formula: one whose first visible character
 * is `=`, `+`, `-` or `@` (spreadsheets skip leading whitespace and control
 * characters before deciding), or one starting with a tab or a carriage return.
 */
const FORMULA_START = /^(?:[\t\r]|[\s\p{Cc}]*[=+\-@])/u
const NEEDS_QUOTES = ['"', ';', '\n', '\r']

function cell(value: string): string {
  // The failed rows echo addresses typed by someone else, so a formula is
  // neutralised as text with a leading apostrophe.
  const safe = FORMULA_START.test(value) ? "'" + value : value
  return NEEDS_QUOTES.some((mark) => safe.includes(mark))
    ? '"' + safe.replaceAll('"', '""') + '"'
    : safe
}

/**
 * Semicolon-separated with a byte-order mark: what a French spreadsheet opens
 * without an import wizard. The server detects the delimiter either way.
 */
export function buildCsv(rows: readonly (readonly string[])[]): string {
  return '﻿' + rows.map((row) => row.map(cell).join(';')).join('\n') + '\n'
}

export function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * The source line a `validation-error` names, read from a field error's
 * `pointer` or `code` — never from `title` or `detail`, which are staff prose.
 */
export function failedLine(errors: readonly { pointer: string; code: string }[]): number | null {
  for (const error of errors) {
    const match = /(\d+)/.exec(error.pointer) ?? /(\d+)/.exec(error.code)
    if (match !== null) return Number(match[1])
  }
  return null
}
