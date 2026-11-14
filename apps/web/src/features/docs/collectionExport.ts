import {
  computeCollectionRollups,
  formatRollupNumber,
  validateCollectionUrl,
  type CollectionAssigneeMember,
  type CollectionCellValue,
  type CollectionPropertyDef,
  type EnrichedCollectionRow,
} from './collectionSchema'
import { getCollectionCopy } from './collectionMessages'

export type CollectionExportFormat = 'csv' | 'json' | 'markdown'

export interface CollectionExportInput {
  readonly collectionId: string
  readonly collectionTitle: string
  readonly properties: readonly CollectionPropertyDef[]
  readonly rows: readonly EnrichedCollectionRow[]
  readonly totalCount?: number | undefined
  readonly members?: readonly CollectionAssigneeMember[] | undefined
  readonly locale?: string | undefined
}

const FORMULA_TRIGGER_RE = /^[\t\r\n ]*[=+\-@]|^[\t\r\n]/

/**
 * Neutralizes spreadsheet formula injection (CWE-1236) by prefixing dangerous leading
 * characters (`=`, `+`, `-`, `@`, `\t`, `\r`, `\n`, including whitespace-prefixed variants)
 * with an apostrophe `'`.
 */
export function neutralizeCsvFormula(raw: string): string {
  if (raw.length === 0) return ''
  if (FORMULA_TRIGGER_RE.test(raw)) {
    return `'${raw}`
  }
  return raw
}

/**
 * Formats a single CSV cell per RFC 4180 after formula-injection neutralization.
 */
export function formatCsvCell(raw: string): string {
  const safe = neutralizeCsvFormula(raw)
  if (
    safe.includes(',') ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r') ||
    safe.includes('\t') ||
    safe.startsWith("'") ||
    safe.startsWith(' ') ||
    safe.endsWith(' ')
  ) {
    return `"${safe.replaceAll('"', '""')}"`
  }
  return safe
}

function formatCellAsDisplayString(
  cell: CollectionCellValue | undefined,
  property: CollectionPropertyDef,
  memberById: ReadonlyMap<string, string>
): string {
  if (!cell) return ''
  switch (cell.kind) {
    case 'status':
    case 'priority':
    case 'select': {
      if (!cell.value) return ''
      return property.options?.find((opt) => opt.id === cell.value)?.label ?? cell.value
    }
    case 'multi_select':
    case 'tags': {
      return cell.value
        .map((id) => property.options?.find((opt) => opt.id === id)?.label ?? id)
        .join(', ')
    }
    case 'assignee': {
      if (!cell.value) return ''
      return memberById.get(cell.value) ?? cell.value
    }
    case 'due_date':
    case 'text':
      return cell.value ?? ''
    case 'number':
      return cell.value !== null && Number.isFinite(cell.value) ? String(cell.value) : ''
    case 'checkbox':
      return cell.value ? 'true' : 'false'
    case 'url': {
      const checked = validateCollectionUrl(cell.value)
      return checked.ok && checked.value ? checked.value : ''
    }
  }
}

function sanitizeJsonCellValue(
  cell: CollectionCellValue | undefined,
  property: CollectionPropertyDef
): string | number | boolean | readonly string[] | null {
  if (!cell) {
    if (property.kind === 'checkbox') return false
    if (property.kind === 'multi_select' || property.kind === 'tags') return []
    return null
  }
  if (cell.kind === 'url') {
    const checked = validateCollectionUrl(cell.value)
    return checked.ok ? checked.value : null
  }
  return cell.value
}

export function escapeMarkdownTableCell(raw: string): string {
  return raw
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ')
    .trim()
}

export function exportCollectionToCsv(input: CollectionExportInput): string {
  const copy = getCollectionCopy(input.locale)
  const memberById = new Map((input.members ?? []).map((m) => [m.id, m.name]))
  const headers = [
    formatCsvCell(copy.columnDocument),
    ...input.properties.map((prop) => formatCsvCell(prop.name)),
  ]
  const lines = [headers.join(',')]

  for (const row of input.rows) {
    const cells = [
      formatCsvCell(row.title),
      ...input.properties.map((prop) =>
        formatCsvCell(formatCellAsDisplayString(row.values[prop.id], prop, memberById))
      ),
    ]
    lines.push(cells.join(','))
  }

  return `${lines.join('\n')}\n`
}

export function exportCollectionToJson(input: CollectionExportInput): string {
  const total = input.totalCount ?? input.rows.length
  const rollups = computeCollectionRollups(input.rows, total, input.properties)
  const payload = {
    collectionId: input.collectionId,
    title: input.collectionTitle,
    totalCount: rollups.totalCount,
    exportedCount: rollups.filteredCount,
    rollups: {
      doneCount: rollups.doneCount,
      donePercent: rollups.donePercent,
      checkbox: Object.values(rollups.checkboxByProperty).map((item) => ({
        propertyId: item.propertyId,
        checkedCount: item.checkedCount,
        checkedPercent: item.checkedPercent,
      })),
      numeric: Object.values(rollups.numericByProperty).map((item) => ({
        propertyId: item.propertyId,
        count: item.count,
        sum: item.sum,
        avg: item.avg,
      })),
    },
    properties: input.properties.map((prop) => ({
      id: prop.id,
      name: prop.name,
      kind: prop.kind,
      ...(prop.options
        ? { options: prop.options.map((o) => ({ id: o.id, label: o.label })) }
        : {}),
    })),
    rows: input.rows.map((row) => {
      const propValues: Record<string, string | number | boolean | readonly string[] | null> = {}
      for (const prop of input.properties) {
        propValues[prop.id] = sanitizeJsonCellValue(row.values[prop.id], prop)
      }
      return {
        documentId: row.documentId,
        title: row.title,
        updatedAt: row.updatedAt,
        properties: propValues,
      }
    }),
  }

  return `${JSON.stringify(payload, null, 2)}\n`
}

export function exportCollectionToMarkdownTable(input: CollectionExportInput): string {
  const copy = getCollectionCopy(input.locale)
  const memberById = new Map((input.members ?? []).map((m) => [m.id, m.name]))
  const total = input.totalCount ?? input.rows.length
  const rollups = computeCollectionRollups(input.rows, total, input.properties)

  const headerCells = [
    escapeMarkdownTableCell(copy.columnDocument),
    ...input.properties.map((prop) => escapeMarkdownTableCell(prop.name)),
  ]
  const separatorCells = headerCells.map(() => '---')

  const lines = [
    `# ${input.collectionTitle.replaceAll('\n', ' ').trim()}`,
    '',
    `| ${headerCells.join(' | ')} |`,
    `| ${separatorCells.join(' | ')} |`,
  ]

  for (const row of input.rows) {
    const rowCells = [
      escapeMarkdownTableCell(row.title),
      ...input.properties.map((prop) =>
        escapeMarkdownTableCell(formatCellAsDisplayString(row.values[prop.id], prop, memberById))
      ),
    ]
    lines.push(`| ${rowCells.join(' | ')} |`)
  }

  const rollupParts: string[] = [copy.rollups.count(rollups.filteredCount, rollups.totalCount)]
  if (rollups.hasStatusProperty) {
    rollupParts.push(
      copy.rollups.donePercent(rollups.donePercent, rollups.doneCount, rollups.filteredCount)
    )
  }
  for (const cb of Object.values(rollups.checkboxByProperty)) {
    rollupParts.push(copy.rollups.checkedPercent(cb.propertyName, cb.checkedPercent))
  }
  for (const num of Object.values(rollups.numericByProperty)) {
    rollupParts.push(
      copy.rollups.numericSumAvg(
        num.propertyName,
        formatRollupNumber(num.sum),
        formatRollupNumber(num.avg)
      )
    )
  }

  lines.push('', `> ${rollupParts.join(' · ')}`)
  return `${lines.join('\n')}\n`
}

export function exportCollection(
  format: CollectionExportFormat,
  input: CollectionExportInput
): string {
  switch (format) {
    case 'csv':
      return exportCollectionToCsv(input)
    case 'json':
      return exportCollectionToJson(input)
    case 'markdown':
      return exportCollectionToMarkdownTable(input)
  }
}
