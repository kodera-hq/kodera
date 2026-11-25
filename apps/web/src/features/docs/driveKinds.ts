export type DriveDocumentKind = 'page' | 'base' | 'whiteboard'
export const DOCUMENT_KIND_MARKERS = {
  base: '<!-- kodera:doc-kind:base -->',
  whiteboard: '<!-- kodera:doc-kind:whiteboard -->',
} as const

export function driveDocumentKind(markdown: string): DriveDocumentKind {
  if (markdown.trimStart().startsWith(DOCUMENT_KIND_MARKERS.base)) return 'base'
  if (markdown.trimStart().startsWith(DOCUMENT_KIND_MARKERS.whiteboard)) return 'whiteboard'
  return 'page'
}

export function stripDocumentKind(markdown: string): string {
  return markdown.replace(/^\s*<!-- kodera:doc-kind:(?:base|whiteboard) -->\s*/, '')
}

export function ensureDriveKindMarker(markdown: string, kind: DriveDocumentKind): string {
  return kind === 'page'
    ? markdown
    : `${DOCUMENT_KIND_MARKERS[kind]}\n\n${stripDocumentKind(markdown)}`
}

export function preserveDocumentKind(previous: string, markdown: string): string {
  const kind = driveDocumentKind(previous)
  return kind === 'page'
    ? markdown
    : `${DOCUMENT_KIND_MARKERS[kind]}\n\n${stripDocumentKind(markdown)}`
}

export const CHANNEL_ATTACHMENTS_FOLDER_ID = 'virtual:channel-attachments'

import type { CollectionCellValue, WorkspaceCollectionRowModel } from './collectionSchema'

export const MAX_DRIVE_COLLECTION_ROWS = 500
export const MAX_DRIVE_MARKDOWN_BYTES = 262_144

const COLLECTION_ROWS = /<!-- kodera:collection-rows:v1 ([\s\S]*?) -->/g
const EMPTY_ROWS: readonly WorkspaceCollectionRowModel[] = []

function isCell(value: unknown): value is CollectionCellValue {
  if (value === null || typeof value !== 'object' || !('kind' in value) || !('value' in value))
    return false
  switch (value.kind) {
    case 'checkbox':
      return typeof value.value === 'boolean'
    case 'number':
      return (
        value.value === null || (typeof value.value === 'number' && Number.isFinite(value.value))
      )
    case 'tags':
    case 'multi_select':
      return Array.isArray(value.value) && value.value.every((item) => typeof item === 'string')
    case 'status':
    case 'priority':
    case 'select':
    case 'assignee':
    case 'due_date':
    case 'url':
    case 'text':
      return value.value === null || typeof value.value === 'string'
    default:
      return false
  }
}

export function readDriveCollectionRows(markdown: string): readonly WorkspaceCollectionRowModel[] {
  const encoded = [...markdown.matchAll(COLLECTION_ROWS)][0]?.[1]
  if (!encoded || encoded.length > MAX_DRIVE_MARKDOWN_BYTES) return EMPTY_ROWS
  try {
    const rows: unknown = JSON.parse(decodeURIComponent(encoded))
    if (!Array.isArray(rows) || rows.length > MAX_DRIVE_COLLECTION_ROWS) return EMPTY_ROWS
    return rows.flatMap((row): WorkspaceCollectionRowModel[] => {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.documentId !== 'string' ||
        typeof row.updatedAt !== 'string' ||
        !row.values ||
        typeof row.values !== 'object' ||
        Array.isArray(row.values)
      )
        return []
      const cells = Object.entries(row.values).filter(
        (entry): entry is [string, CollectionCellValue] => isCell(entry[1])
      )
      return [
        { documentId: row.documentId, updatedAt: row.updatedAt, values: Object.fromEntries(cells) },
      ]
    })
  } catch {
    return EMPTY_ROWS
  }
}

export function writeDriveCollectionRows(
  markdown: string,
  rows: readonly WorkspaceCollectionRowModel[]
): string {
  if (rows.length > MAX_DRIVE_COLLECTION_ROWS) throw new RangeError('Collection row limit exceeded')
  const ordered = [...rows]
    .sort((a, b) => a.documentId.localeCompare(b.documentId))
    .map((row) => ({
      ...row,
      values: Object.fromEntries(Object.entries(row.values).sort(([a], [b]) => a.localeCompare(b))),
    }))
  const encoded = encodeURIComponent(JSON.stringify(ordered)).replace(
    /[!'()*_.~-]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  const result = `${markdown.replace(COLLECTION_ROWS, '').trimEnd()}\n\n<!-- kodera:collection-rows:v1 ${encoded} -->\n`
  if (new TextEncoder().encode(result).length > MAX_DRIVE_MARKDOWN_BYTES)
    throw new RangeError('Document byte limit exceeded')
  return result
}
