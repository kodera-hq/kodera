import type { DocumentAccessRole } from './pageTree'
import { getCollectionCopy } from './collectionMessages'

export type CollectionPropertyKind =
  | 'status'
  | 'select'
  | 'multi_select'
  | 'assignee'
  | 'due_date'
  | 'priority'
  | 'number'
  | 'checkbox'
  | 'url'
  | 'tags'
  | 'text'

export type WireCollectionPropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'select'
  | 'multi_select'
  | 'person'

export type CollectionViewKind = 'table' | 'board' | 'list'

export type CollectionTagTone = 1 | 2 | 3 | 4 | 5 | 6

export interface CollectionSelectOptionItem {
  readonly id: string
  readonly label: string
  readonly tone?: CollectionTagTone | undefined
  readonly isDone?: boolean | undefined
}

export interface CollectionAssigneeMember {
  readonly id: string
  readonly name: string
}

export interface CollectionPropertyDef {
  readonly id: string
  readonly name: string
  readonly kind: CollectionPropertyKind
  readonly options?: readonly CollectionSelectOptionItem[] | undefined
}

export type CollectionCellValue =
  | { readonly kind: 'status' | 'priority' | 'select'; readonly value: string | null }
  | { readonly kind: 'multi_select' | 'tags'; readonly value: readonly string[] }
  | { readonly kind: 'assignee'; readonly value: string | null }
  | { readonly kind: 'due_date'; readonly value: string | null }
  | { readonly kind: 'number'; readonly value: number | null }
  | { readonly kind: 'checkbox'; readonly value: boolean }
  | { readonly kind: 'url'; readonly value: string | null }
  | { readonly kind: 'text'; readonly value: string | null }

export type CollectionFilterOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'is_empty'
  | 'is_not_empty'

export interface CollectionSortRule {
  readonly propertyId: string
  readonly direction: 'asc' | 'desc'
}

export interface CollectionFilterRule {
  readonly propertyId: string
  readonly operator: CollectionFilterOperator
  readonly value?: CollectionCellValue | undefined
}

export type CollectionViewConfig =
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'table'
      readonly columns: readonly string[]
      readonly filters?: readonly CollectionFilterRule[] | undefined
      readonly sorts?: readonly CollectionSortRule[] | undefined
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'board'
      readonly groupByPropertyId: string
      readonly showEmptyGroups: boolean
      readonly filters?: readonly CollectionFilterRule[] | undefined
      readonly sorts?: readonly CollectionSortRule[] | undefined
    }
  | {
      readonly id: string
      readonly name: string
      readonly kind: 'list'
      readonly titlePropertyId: string
      readonly filters?: readonly CollectionFilterRule[] | undefined
      readonly sorts?: readonly CollectionSortRule[] | undefined
    }

export interface WorkspaceCollectionModel {
  readonly id: string
  readonly title: string
  readonly properties: readonly CollectionPropertyDef[]
  readonly views: readonly CollectionViewConfig[]
  readonly role: DocumentAccessRole
  readonly updatedAt: string
}

export interface WorkspaceCollectionRowModel {
  readonly documentId: string
  readonly values: Readonly<Record<string, CollectionCellValue>>
  readonly updatedAt: string
}

export interface EnrichedCollectionRow {
  readonly documentId: string
  readonly title: string
  readonly updatedAt: string
  readonly role: DocumentAccessRole
  readonly values: Readonly<Record<string, CollectionCellValue>>
}

export interface ActiveCollectionFilterState {
  readonly searchQuery: string
  readonly statusId: string | null
  readonly priorityId: string | null
  readonly assigneeId: string | null
  readonly tagId: string | null
  readonly rules?: readonly CollectionFilterRule[] | undefined
}

export type CollectionValidationReason =
  | 'invalid_url'
  | 'disallowed_protocol'
  | 'credentials_forbidden'
  | 'invalid_date'
  | 'invalid_number'
  | 'invalid_checkbox'
  | 'invalid_text'
  | 'invalid_assignee'
  | 'unknown_option'
  | 'duplicate_property_id'
  | 'duplicate_option_id'
  | 'invalid_property_definition'
  | 'invalid_view_reference'

export type CollectionUrlValidationResult =
  | { readonly ok: true; readonly value: string | null }
  | {
      readonly ok: false
      readonly reason: 'invalid_url' | 'disallowed_protocol' | 'credentials_forbidden'
    }

export type CollectionCellValidationResult =
  | { readonly ok: true; readonly cell: CollectionCellValue }
  | { readonly ok: false; readonly reason: CollectionValidationReason }

export interface CheckboxPropertyRollup {
  readonly propertyId: string
  readonly propertyName: string
  readonly checkedCount: number
  readonly totalCount: number
  readonly checkedPercent: number
}

export interface NumericPropertyRollup {
  readonly propertyId: string
  readonly propertyName: string
  readonly count: number
  readonly sum: number
  readonly avg: number | null
}

export interface CollectionRollupSummary {
  readonly totalCount: number
  readonly filteredCount: number
  readonly hasStatusProperty: boolean
  readonly doneCount: number
  readonly donePercent: number
  readonly checkboxByProperty: Readonly<Record<string, CheckboxPropertyRollup>>
  readonly numericByProperty: Readonly<Record<string, NumericPropertyRollup>>
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const PROPERTY_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

const DONE_STATUS_IDS: ReadonlySet<string> = new Set([
  'done',
  'completed',
  'complete',
  'closed',
  'termine',
  'shipped',
])

/**
 * Validates a collection URL property value.
 * Strictly allows `https://` and `http://` schemes without embedded credentials,
 * refusing `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, and control bytes.
 */
export function validateCollectionUrl(
  raw: string | null | undefined
): CollectionUrlValidationResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_url' }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: true, value: null }
  }
  if (trimmed.length > 2048 || CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, reason: 'invalid_url' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'disallowed_protocol' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials_forbidden' }
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'invalid_url' }
  }

  return { ok: true, value: parsed.toString() }
}

export function validateCollectionDate(
  raw: string | null | undefined
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: 'invalid_date' } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_date' }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: true, value: null }
  }
  const match = ISO_DATE_RE.exec(trimmed)
  if (!match) {
    return { ok: false, reason: 'invalid_date' }
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: 'invalid_date' }
  }
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return { ok: false, reason: 'invalid_date' }
  }
  return { ok: true, value: trimmed }
}

export function validateCollectionPropertyValue(
  property: CollectionPropertyDef,
  rawValue: unknown
): CollectionCellValidationResult {
  const optionIds = new Set((property.options ?? []).map((opt) => opt.id))

  switch (property.kind) {
    case 'status':
    case 'priority':
    case 'select': {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        return { ok: true, cell: { kind: property.kind, value: null } }
      }
      if (typeof rawValue !== 'string' || rawValue.length > 64 || !optionIds.has(rawValue)) {
        return { ok: false, reason: 'unknown_option' }
      }
      return { ok: true, cell: { kind: property.kind, value: rawValue } }
    }

    case 'multi_select':
    case 'tags': {
      if (rawValue === null || rawValue === undefined) {
        return { ok: true, cell: { kind: property.kind, value: [] } }
      }
      if (!Array.isArray(rawValue) || rawValue.length > 100) {
        return { ok: false, reason: 'unknown_option' }
      }
      const deduped: string[] = []
      const seen = new Set<string>()
      for (const item of rawValue) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 64) {
          return { ok: false, reason: 'unknown_option' }
        }
        if (!optionIds.has(item)) {
          return { ok: false, reason: 'unknown_option' }
        }
        if (!seen.has(item)) {
          seen.add(item)
          deduped.push(item)
        }
      }
      return { ok: true, cell: { kind: property.kind, value: deduped } }
    }

    case 'assignee': {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        return { ok: true, cell: { kind: 'assignee', value: null } }
      }
      if (
        typeof rawValue !== 'string' ||
        rawValue.trim().length === 0 ||
        rawValue.length > 128 ||
        CONTROL_CHAR_RE.test(rawValue)
      ) {
        return { ok: false, reason: 'invalid_assignee' }
      }
      return { ok: true, cell: { kind: 'assignee', value: rawValue.trim() } }
    }

    case 'due_date': {
      const checked = validateCollectionDate(
        rawValue as string | null | undefined
      )
      if (!checked.ok) return checked
      return { ok: true, cell: { kind: 'due_date', value: checked.value } }
    }

    case 'number': {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        return { ok: true, cell: { kind: 'number', value: null } }
      }
      const num = typeof rawValue === 'number' ? rawValue : Number(rawValue)
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        return { ok: false, reason: 'invalid_number' }
      }
      return { ok: true, cell: { kind: 'number', value: num } }
    }

    case 'checkbox': {
      if (typeof rawValue !== 'boolean') {
        return { ok: false, reason: 'invalid_checkbox' }
      }
      return { ok: true, cell: { kind: 'checkbox', value: rawValue } }
    }

    case 'url': {
      const checked = validateCollectionUrl(rawValue as string | null | undefined)
      if (!checked.ok) return checked
      return { ok: true, cell: { kind: 'url', value: checked.value } }
    }

    case 'text': {
      if (rawValue === null || rawValue === undefined) {
        return { ok: true, cell: { kind: 'text', value: null } }
      }
      if (typeof rawValue !== 'string' || rawValue.length > 10_000) {
        return { ok: false, reason: 'invalid_text' }
      }
      return { ok: true, cell: { kind: 'text', value: rawValue } }
    }
  }
}

export function validateCollectionSchema(
  properties: readonly CollectionPropertyDef[],
  views: readonly CollectionViewConfig[] = []
): { readonly ok: true } | { readonly ok: false; readonly reason: CollectionValidationReason } {
  const propIds = new Set<string>()
  const propById = new Map<string, CollectionPropertyDef>()

  for (const prop of properties) {
    if (
      !PROPERTY_ID_RE.test(prop.id) ||
      prop.name.trim().length === 0 ||
      prop.name.length > 100
    ) {
      return { ok: false, reason: 'invalid_property_definition' }
    }
    if (propIds.has(prop.id)) {
      return { ok: false, reason: 'duplicate_property_id' }
    }
    propIds.add(prop.id)
    propById.set(prop.id, prop)

    if (
      prop.kind === 'status' ||
      prop.kind === 'priority' ||
      prop.kind === 'select' ||
      prop.kind === 'multi_select' ||
      prop.kind === 'tags'
    ) {
      const seenOpt = new Set<string>()
      for (const opt of prop.options ?? []) {
        if (!PROPERTY_ID_RE.test(opt.id) || opt.label.trim().length === 0) {
          return { ok: false, reason: 'invalid_property_definition' }
        }
        if (seenOpt.has(opt.id)) {
          return { ok: false, reason: 'duplicate_option_id' }
        }
        seenOpt.add(opt.id)
      }
    }
  }

  for (const view of views) {
    if (!PROPERTY_ID_RE.test(view.id) || view.name.trim().length === 0) {
      return { ok: false, reason: 'invalid_view_reference' }
    }
    if (view.kind === 'table') {
      for (const col of view.columns) {
        if (col !== 'title' && !propIds.has(col)) {
          return { ok: false, reason: 'invalid_view_reference' }
        }
      }
    } else if (view.kind === 'board') {
      const groupProp = propById.get(view.groupByPropertyId)
      if (
        !groupProp ||
        (groupProp.kind !== 'status' &&
          groupProp.kind !== 'priority' &&
          groupProp.kind !== 'select')
      ) {
        return { ok: false, reason: 'invalid_view_reference' }
      }
    } else if (view.kind === 'list') {
      if (view.titlePropertyId !== 'title' && !propIds.has(view.titlePropertyId)) {
        return { ok: false, reason: 'invalid_view_reference' }
      }
    }
  }

  return { ok: true }
}

export function defaultCellForProperty(property: CollectionPropertyDef): CollectionCellValue {
  switch (property.kind) {
    case 'status':
      return { kind: 'status', value: property.options?.[0]?.id ?? null }
    case 'priority':
    case 'select':
      return { kind: property.kind, value: null }
    case 'multi_select':
    case 'tags':
      return { kind: property.kind, value: [] }
    case 'assignee':
      return { kind: 'assignee', value: null }
    case 'due_date':
      return { kind: 'due_date', value: null }
    case 'number':
      return { kind: 'number', value: null }
    case 'checkbox':
      return { kind: 'checkbox', value: false }
    case 'url':
      return { kind: 'url', value: null }
    case 'text':
      return { kind: 'text', value: null }
  }
}

export function optionToneForIndex(index: number, option?: CollectionSelectOptionItem): CollectionTagTone {
  if (option?.tone) return option.tone
  const tones: readonly CollectionTagTone[] = [1, 2, 3, 4, 5, 6]
  return tones[Math.abs(index) % tones.length] ?? 1
}

export function isDoneStatusOption(option: CollectionSelectOptionItem): boolean {
  if (option.isDone !== undefined) return option.isDone
  return DONE_STATUS_IDS.has(option.id.toLowerCase())
}

function roundTwoDecimals(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatRollupNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const rounded = roundTwoDecimals(value)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * Computes deterministic rollups (`count`, `done %`, `checked %`, `sum`/`avg`) across rows.
 */
export function computeCollectionRollups(
  filteredRows: readonly EnrichedCollectionRow[],
  totalCount: number,
  properties: readonly CollectionPropertyDef[]
): CollectionRollupSummary {
  const filteredCount = filteredRows.length
  const statusProp = properties.find((p) => p.kind === 'status')
  const doneOptionIds = new Set(
    (statusProp?.options ?? []).filter(isDoneStatusOption).map((opt) => opt.id)
  )

  let doneCount = 0
  if (statusProp) {
    for (const row of filteredRows) {
      const cell = row.values[statusProp.id]
      if (
        cell &&
        (cell.kind === 'status' || cell.kind === 'select' || cell.kind === 'priority') &&
        cell.value !== null &&
        (doneOptionIds.has(cell.value) || DONE_STATUS_IDS.has(cell.value.toLowerCase()))
      ) {
        doneCount += 1
      }
    }
  }
  const donePercent = filteredCount > 0 ? Math.round((doneCount / filteredCount) * 100) : 0

  const checkboxByProperty: Record<string, CheckboxPropertyRollup> = {}
  const numericByProperty: Record<string, NumericPropertyRollup> = {}

  for (const prop of properties) {
    if (prop.kind === 'checkbox') {
      let checkedCount = 0
      for (const row of filteredRows) {
        const cell = row.values[prop.id]
        if (cell?.kind === 'checkbox' && cell.value === true) {
          checkedCount += 1
        }
      }
      checkboxByProperty[prop.id] = {
        propertyId: prop.id,
        propertyName: prop.name,
        checkedCount,
        totalCount: filteredCount,
        checkedPercent:
          filteredCount > 0 ? Math.round((checkedCount / filteredCount) * 100) : 0,
      }
    } else if (prop.kind === 'number') {
      let count = 0
      let rawSum = 0
      for (const row of filteredRows) {
        const cell = row.values[prop.id]
        if (cell?.kind === 'number' && cell.value !== null && Number.isFinite(cell.value)) {
          count += 1
          rawSum += cell.value
        }
      }
      const sum = roundTwoDecimals(rawSum)
      const avg = count > 0 ? roundTwoDecimals(rawSum / count) : null
      numericByProperty[prop.id] = {
        propertyId: prop.id,
        propertyName: prop.name,
        count,
        sum,
        avg,
      }
    }
  }

  return {
    totalCount,
    filteredCount,
    hasStatusProperty: Boolean(statusProp),
    doneCount,
    donePercent,
    checkboxByProperty,
    numericByProperty,
  }
}

function cellTextForSearch(
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
      const label = property.options?.find((o) => o.id === cell.value)?.label ?? cell.value
      return `${cell.value} ${label}`
    }
    case 'multi_select':
    case 'tags': {
      return cell.value
        .map((id) => {
          const label = property.options?.find((o) => o.id === id)?.label ?? id
          return `${id} ${label}`
        })
        .join(' ')
    }
    case 'assignee': {
      if (!cell.value) return ''
      const name = memberById.get(cell.value) ?? ''
      return `${cell.value} ${name}`
    }
    case 'due_date':
    case 'url':
    case 'text':
      return cell.value ?? ''
    case 'number':
      return cell.value !== null ? String(cell.value) : ''
    case 'checkbox':
      return cell.value ? 'true' : 'false'
  }
}

function matchesFilterRule(
  row: EnrichedCollectionRow,
  rule: CollectionFilterRule
): boolean {
  const cell = row.values[rule.propertyId]
  if (rule.operator === 'is_empty') {
    if (!cell) return true
    if (cell.kind === 'multi_select' || cell.kind === 'tags') return cell.value.length === 0
    if (cell.kind === 'checkbox') return cell.value === false
    return cell.value === null || cell.value === ''
  }
  if (rule.operator === 'is_not_empty') {
    if (!cell) return false
    if (cell.kind === 'multi_select' || cell.kind === 'tags') return cell.value.length > 0
    if (cell.kind === 'checkbox') return cell.value === true
    return cell.value !== null && cell.value !== ''
  }
  const expected = rule.value
  if (!expected || !cell) return false

  if (rule.operator === 'contains') {
    if (
      (cell.kind === 'multi_select' || cell.kind === 'tags') &&
      (expected.kind === 'select' || expected.kind === 'text') &&
      expected.value
    ) {
      return cell.value.includes(expected.value)
    }
    if (typeof cell.value === 'string' && typeof expected.value === 'string') {
      return cell.value.toLowerCase().includes(expected.value.toLowerCase())
    }
    return false
  }

  if (rule.operator === 'eq' || rule.operator === 'ne') {
    const equal = JSON.stringify(cell.value) === JSON.stringify(expected.value)
    return rule.operator === 'eq' ? equal : !equal
  }

  if (
    (typeof cell.value === 'number' && typeof expected.value === 'number') ||
    (typeof cell.value === 'string' && typeof expected.value === 'string')
  ) {
    if (rule.operator === 'lt') return cell.value < expected.value
    if (rule.operator === 'lte') return cell.value <= expected.value
    if (rule.operator === 'gt') return cell.value > expected.value
    if (rule.operator === 'gte') return cell.value >= expected.value
  }
  return false
}

function compareCells(
  a: CollectionCellValue | undefined,
  b: CollectionCellValue | undefined,
  property: CollectionPropertyDef,
  direction: 'asc' | 'desc',
  memberById: ReadonlyMap<string, string>
): number {
  const isEmpty = (c: CollectionCellValue | undefined): boolean => {
    if (!c) return true
    if (c.kind === 'multi_select' || c.kind === 'tags') return c.value.length === 0
    if (c.kind === 'checkbox') return false
    return c.value === null || c.value === ''
  }

  const emptyA = isEmpty(a)
  const emptyB = isEmpty(b)
  if (emptyA && emptyB) return 0
  // Empty cells always sink below populated cells for predictable triage.
  if (emptyA) return 1
  if (emptyB) return -1

  const sign = direction === 'asc' ? 1 : -1

  if (property.kind === 'number' && a?.kind === 'number' && b?.kind === 'number') {
    return ((a.value ?? 0) - (b.value ?? 0)) * sign
  }

  if (property.kind === 'checkbox' && a?.kind === 'checkbox' && b?.kind === 'checkbox') {
    const numA = a.value ? 1 : 0
    const numB = b.value ? 1 : 0
    return (numA - numB) * sign
  }

  if (
    (property.kind === 'status' ||
      property.kind === 'priority' ||
      property.kind === 'select') &&
    property.options &&
    property.options.length > 0
  ) {
    const orderById = new Map(property.options.map((opt, idx) => [opt.id, idx]))
    const valA = typeof a?.value === 'string' ? (orderById.get(a.value) ?? 999) : 999
    const valB = typeof b?.value === 'string' ? (orderById.get(b.value) ?? 999) : 999
    if (valA !== valB) return (valA - valB) * sign
  }

  if (property.kind === 'assignee' && a?.kind === 'assignee' && b?.kind === 'assignee') {
    const labelA = a.value ? (memberById.get(a.value) ?? a.value) : ''
    const labelB = b.value ? (memberById.get(b.value) ?? b.value) : ''
    return labelA.localeCompare(labelB) * sign
  }

  const strA = Array.isArray(a?.value) ? a.value.join(',') : String(a?.value ?? '')
  const strB = Array.isArray(b?.value) ? b.value.join(',') : String(b?.value ?? '')
  return strA.localeCompare(strB) * sign
}

/**
 * Deterministically filters and sorts collection rows, breaking ties by `documentId`
 * in line with Core 0.44.0 `CollectionQuery`.
 */
export function filterAndSortCollectionRows(
  rows: readonly EnrichedCollectionRow[],
  properties: readonly CollectionPropertyDef[],
  filters: ActiveCollectionFilterState,
  sort: CollectionSortRule | null,
  members: readonly CollectionAssigneeMember[] = []
): EnrichedCollectionRow[] {
  const memberById = new Map(members.map((m) => [m.id, m.name]))
  const propById = new Map(properties.map((p) => [p.id, p]))
  const statusProp = properties.find((p) => p.kind === 'status')
  const priorityProp = properties.find((p) => p.kind === 'priority')
  const assigneeProp = properties.find((p) => p.kind === 'assignee')
  const tagProps = properties.filter((p) => p.kind === 'tags' || p.kind === 'multi_select')
  const needle = filters.searchQuery.trim().toLowerCase()

  const filtered = rows.filter((row) => {
    if (filters.statusId !== null && statusProp) {
      const cell = row.values[statusProp.id]
      if (!cell || cell.value !== filters.statusId) return false
    }
    if (filters.priorityId !== null && priorityProp) {
      const cell = row.values[priorityProp.id]
      if (!cell || cell.value !== filters.priorityId) return false
    }
    if (filters.assigneeId !== null && assigneeProp) {
      const cell = row.values[assigneeProp.id]
      if (!cell || cell.value !== filters.assigneeId) return false
    }
    if (filters.tagId !== null && tagProps.length > 0) {
      const matchedTag = tagProps.some((tp) => {
        const cell = row.values[tp.id]
        return (
          (cell?.kind === 'tags' || cell?.kind === 'multi_select') &&
          cell.value.includes(filters.tagId!)
        )
      })
      if (!matchedTag) return false
    }
    if (filters.rules) {
      for (const rule of filters.rules) {
        if (!matchesFilterRule(row, rule)) return false
      }
    }
    if (needle.length > 0) {
      if (row.title.toLowerCase().includes(needle)) return true
      for (const prop of properties) {
        const haystack = cellTextForSearch(row.values[prop.id], prop, memberById).toLowerCase()
        if (haystack.includes(needle)) return true
      }
      return false
    }
    return true
  })

  return [...filtered].sort((a, b) => {
    if (sort) {
      const sign = sort.direction === 'asc' ? 1 : -1
      if (sort.propertyId === 'title') {
        const cmp = a.title.localeCompare(b.title) * sign
        if (cmp !== 0) return cmp
      } else if (sort.propertyId === 'updatedAt') {
        const cmp = a.updatedAt.localeCompare(b.updatedAt) * sign
        if (cmp !== 0) return cmp
      } else {
        const prop = propById.get(sort.propertyId)
        if (prop) {
          const cmp = compareCells(
            a.values[prop.id],
            b.values[prop.id],
            prop,
            sort.direction,
            memberById
          )
          if (cmp !== 0) return cmp
        }
      }
    }
    return a.documentId.localeCompare(b.documentId)
  })
}

export function createDefaultCollectionSchema(locale?: string): WorkspaceCollectionModel {
  const copy = getCollectionCopy(locale).defaultSchema
  const properties: readonly CollectionPropertyDef[] = [
    {
      id: 'status',
      name: copy.statusName,
      kind: 'status',
      options: [
        { id: 'todo', label: copy.statusTodo, tone: 1, isDone: false },
        { id: 'in_progress', label: copy.statusInProgress, tone: 2, isDone: false },
        { id: 'review', label: copy.statusReview, tone: 4, isDone: false },
        { id: 'done', label: copy.statusDone, tone: 3, isDone: true },
      ],
    },
    {
      id: 'priority',
      name: copy.priorityName,
      kind: 'priority',
      options: [
        { id: 'low', label: copy.priorityLow, tone: 5 },
        { id: 'medium', label: copy.priorityMedium, tone: 2 },
        { id: 'high', label: copy.priorityHigh, tone: 4 },
        { id: 'urgent', label: copy.priorityUrgent, tone: 6 },
      ],
    },
    {
      id: 'assignee',
      name: copy.assigneeName,
      kind: 'assignee',
    },
    {
      id: 'due_date',
      name: copy.dueDateName,
      kind: 'due_date',
    },
    {
      id: 'verified',
      name: copy.verifiedName,
      kind: 'checkbox',
    },
    {
      id: 'estimate',
      name: copy.estimateName,
      kind: 'number',
    },
    {
      id: 'reference_url',
      name: copy.referenceUrlName,
      kind: 'url',
    },
    {
      id: 'tags',
      name: copy.tagsName,
      kind: 'tags',
      options: [
        { id: 'architecture', label: copy.tagArchitecture, tone: 1 },
        { id: 'security', label: copy.tagSecurity, tone: 6 },
        { id: 'product', label: copy.tagProduct, tone: 2 },
        { id: 'ops', label: copy.tagOperations, tone: 3 },
      ],
    },
  ]

  const views: readonly CollectionViewConfig[] = [
    {
      id: 'table',
      name: getCollectionCopy(locale).viewTable,
      kind: 'table',
      columns: properties.map((p) => p.id),
    },
    {
      id: 'board',
      name: getCollectionCopy(locale).viewBoard,
      kind: 'board',
      groupByPropertyId: 'status',
      showEmptyGroups: true,
    },
    {
      id: 'list',
      name: getCollectionCopy(locale).viewList,
      kind: 'list',
      titlePropertyId: 'status',
    },
  ]

  return {
    id: '00000000-0000-7000-8000-000000000001',
    title: copy.collectionTitle,
    properties,
    views,
    role: 'editor',
    updatedAt: '2026-11-13T12:00:00Z',
  }
}

export interface WireCollectionPropertyPayload {
  readonly id: string
  readonly name: string
  readonly type: WireCollectionPropertyType
  readonly options?: readonly { readonly id: string; readonly label: string }[]
}

export interface WireCollectionValuePayload {
  readonly type: WireCollectionPropertyType
  readonly value: string | number | boolean | readonly string[] | null
}

export interface WireCollectionFilterPayload {
  readonly propertyId: string
  readonly operator: CollectionFilterOperator
  readonly value?: WireCollectionValuePayload
}

export interface WireCollectionViewPayload {
  readonly id: string
  readonly name: string
  readonly type: CollectionViewKind
  readonly columns?: readonly string[]
  readonly groupByPropertyId?: string
  readonly showEmptyGroups?: boolean
  readonly titlePropertyId?: string
  readonly filters?: readonly WireCollectionFilterPayload[]
  readonly sorts?: readonly CollectionSortRule[]
}

export function kindToWirePropertyType(kind: CollectionPropertyKind): WireCollectionPropertyType {
  switch (kind) {
    case 'status':
    case 'priority':
    case 'select':
      return 'select'
    case 'multi_select':
    case 'tags':
      return 'multi_select'
    case 'assignee':
      return 'person'
    case 'due_date':
      return 'date'
    case 'number':
      return 'number'
    case 'checkbox':
      return 'checkbox'
    case 'url':
      return 'url'
    case 'text':
      return 'text'
  }
}

function normalizeWirePropertyType(rawType: string): WireCollectionPropertyType {
  switch (rawType) {
    case 'text':
    case 'CollectionTextProperty':
    case 'CollectionTextValue':
      return 'text'
    case 'number':
    case 'CollectionNumberProperty':
    case 'CollectionNumberValue':
      return 'number'
    case 'checkbox':
    case 'CollectionCheckboxProperty':
    case 'CollectionCheckboxValue':
      return 'checkbox'
    case 'date':
    case 'CollectionDateProperty':
    case 'CollectionDateValue':
      return 'date'
    case 'url':
    case 'CollectionUrlProperty':
    case 'CollectionUrlValue':
      return 'url'
    case 'select':
    case 'CollectionSelectProperty':
    case 'CollectionSelectValue':
      return 'select'
    case 'multi_select':
    case 'CollectionMultiSelectProperty':
    case 'CollectionMultiSelectValue':
      return 'multi_select'
    case 'person':
    case 'CollectionPersonProperty':
    case 'CollectionPersonValue':
      return 'person'
    default:
      return 'text'
  }
}

function inferPropertyKind(id: string, wireType: WireCollectionPropertyType): CollectionPropertyKind {
  const lower = id.toLowerCase()
  switch (wireType) {
    case 'select':
      if (lower === 'status' || lower.endsWith('_status')) return 'status'
      if (lower === 'priority' || lower.endsWith('_priority')) return 'priority'
      return 'select'
    case 'multi_select':
      if (lower === 'tags' || lower === 'tag' || lower.endsWith('_tags')) return 'tags'
      return 'multi_select'
    case 'person':
      return 'assignee'
    case 'date':
      return 'due_date'
    case 'number':
      return 'number'
    case 'checkbox':
      return 'checkbox'
    case 'url':
      return 'url'
    case 'text':
      return 'text'
  }
}

export function toWireCollectionProperty(
  prop: CollectionPropertyDef
): WireCollectionPropertyPayload {
  const type = kindToWirePropertyType(prop.kind)
  if (type === 'select' || type === 'multi_select') {
    return {
      id: prop.id,
      name: prop.name,
      type,
      options: (prop.options ?? []).map((opt) => ({ id: opt.id, label: opt.label })),
    }
  }
  return {
    id: prop.id,
    name: prop.name,
    type,
  }
}

export function fromWireCollectionProperty(raw: {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly options?: readonly { readonly id: string; readonly label: string }[]
}): CollectionPropertyDef {
  const wireType = normalizeWirePropertyType(raw.type)
  const kind = inferPropertyKind(raw.id, wireType)
  if (wireType === 'select' || wireType === 'multi_select') {
    return {
      id: raw.id,
      name: raw.name,
      kind,
      options: (raw.options ?? []).map((opt, idx) => ({
        id: opt.id,
        label: opt.label,
        tone: optionToneForIndex(idx),
        ...(kind === 'status' ? { isDone: DONE_STATUS_IDS.has(opt.id.toLowerCase()) } : {}),
      })),
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    kind,
  }
}

export function toWireCollectionValue(cell: CollectionCellValue): WireCollectionValuePayload {
  return {
    type: kindToWirePropertyType(cell.kind),
    value: cell.value,
  }
}

export function fromWireCollectionValue(
  raw: { readonly type: string; readonly value: unknown },
  property?: CollectionPropertyDef
): CollectionCellValue {
  const wireType = normalizeWirePropertyType(raw.type)
  const kind = property?.kind ?? inferPropertyKind('', wireType)

  switch (kind) {
    case 'status':
    case 'priority':
    case 'select':
      return { kind, value: typeof raw.value === 'string' ? raw.value : null }
    case 'multi_select':
    case 'tags':
      return {
        kind,
        value: Array.isArray(raw.value)
          ? raw.value.filter((item): item is string => typeof item === 'string')
          : [],
      }
    case 'assignee':
      return { kind: 'assignee', value: typeof raw.value === 'string' ? raw.value : null }
    case 'due_date': {
      const checked = validateCollectionDate(typeof raw.value === 'string' ? raw.value : null)
      return { kind: 'due_date', value: checked.ok ? checked.value : null }
    }
    case 'number':
      return {
        kind: 'number',
        value: typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null,
      }
    case 'checkbox':
      return { kind: 'checkbox', value: Boolean(raw.value) }
    case 'url': {
      const checked = validateCollectionUrl(typeof raw.value === 'string' ? raw.value : null)
      return { kind: 'url', value: checked.ok ? checked.value : null }
    }
    case 'text':
      return { kind: 'text', value: typeof raw.value === 'string' ? raw.value : null }
  }
}

export function toWireCollectionView(view: CollectionViewConfig): WireCollectionViewPayload {
  const filters = view.filters?.map((f) => ({
    propertyId: f.propertyId,
    operator: f.operator,
    ...(f.value ? { value: toWireCollectionValue(f.value) } : {}),
  }))
  const base = {
    id: view.id,
    name: view.name,
    ...(filters ? { filters } : {}),
    ...(view.sorts ? { sorts: view.sorts } : {}),
  }
  switch (view.kind) {
    case 'table':
      return { ...base, type: 'table', columns: view.columns }
    case 'board':
      return {
        ...base,
        type: 'board',
        groupByPropertyId: view.groupByPropertyId,
        showEmptyGroups: view.showEmptyGroups,
      }
    case 'list':
      return { ...base, type: 'list', titlePropertyId: view.titlePropertyId }
  }
}

export function fromWireCollectionView(
  raw: {
    readonly id: string
    readonly name: string
    readonly type: string
    readonly columns?: readonly string[]
    readonly groupByPropertyId?: string
    readonly showEmptyGroups?: boolean
    readonly titlePropertyId?: string
    readonly filters?: readonly {
      readonly propertyId: string
      readonly operator: CollectionFilterOperator
      readonly value?: { readonly type: string; readonly value: unknown }
    }[]
    readonly sorts?: readonly CollectionSortRule[]
  },
  properties: readonly CollectionPropertyDef[]
): CollectionViewConfig {
  const propById = new Map(properties.map((p) => [p.id, p]))
  const filters = raw.filters?.map(
    (f): CollectionFilterRule => ({
      propertyId: f.propertyId,
      operator: f.operator,
      ...(f.value ? { value: fromWireCollectionValue(f.value, propById.get(f.propertyId)) } : {}),
    })
  )
  const common = {
    id: raw.id,
    name: raw.name,
    ...(filters ? { filters } : {}),
    ...(raw.sorts ? { sorts: raw.sorts } : {}),
  }
  if (raw.type === 'board' || raw.type === 'CollectionBoardView') {
    return {
      ...common,
      kind: 'board',
      groupByPropertyId: raw.groupByPropertyId ?? 'status',
      showEmptyGroups: raw.showEmptyGroups ?? true,
    }
  }
  if (raw.type === 'list' || raw.type === 'CollectionListView') {
    return {
      ...common,
      kind: 'list',
      titlePropertyId: raw.titlePropertyId ?? 'title',
    }
  }
  return {
    ...common,
    kind: 'table',
    columns: raw.columns ?? properties.map((p) => p.id),
  }
}

export function fromWireWorkspaceCollection(raw: {
  readonly id: string
  readonly title: string
  readonly properties: readonly {
    readonly id: string
    readonly name: string
    readonly type: string
    readonly options?: readonly { readonly id: string; readonly label: string }[]
  }[]
  readonly views: readonly {
    readonly id: string
    readonly name: string
    readonly type: string
    readonly columns?: readonly string[]
    readonly groupByPropertyId?: string
    readonly showEmptyGroups?: boolean
    readonly titlePropertyId?: string
    readonly filters?: readonly {
      readonly propertyId: string
      readonly operator: CollectionFilterOperator
      readonly value?: { readonly type: string; readonly value: unknown }
    }[]
    readonly sorts?: readonly CollectionSortRule[]
  }[]
  readonly role: DocumentAccessRole
  readonly updatedAt: string
}): WorkspaceCollectionModel {
  const properties = raw.properties.map(fromWireCollectionProperty)
  const views = raw.views.map((v) => fromWireCollectionView(v, properties))
  return {
    id: raw.id,
    title: raw.title,
    properties,
    views,
    role: raw.role,
    updatedAt: raw.updatedAt,
  }
}

export function fromWireWorkspaceCollectionRow(
  raw: {
    readonly documentId: string
    readonly values: Readonly<Record<string, { readonly type: string; readonly value: unknown }>>
    readonly updatedAt: string
  },
  properties: readonly CollectionPropertyDef[]
): WorkspaceCollectionRowModel {
  const propById = new Map(properties.map((p) => [p.id, p]))
  const values: Record<string, CollectionCellValue> = {}
  for (const [key, wireCell] of Object.entries(raw.values)) {
    values[key] = fromWireCollectionValue(wireCell, propById.get(key))
  }
  return {
    documentId: raw.documentId,
    values,
    updatedAt: raw.updatedAt,
  }
}

export function toWireWorkspaceCollectionRowValues(
  values: Readonly<Record<string, CollectionCellValue>>
): Record<string, WireCollectionValuePayload> {
  const result: Record<string, WireCollectionValuePayload> = {}
  for (const [key, cell] of Object.entries(values)) {
    result[key] = toWireCollectionValue(cell)
  }
  return result
}
