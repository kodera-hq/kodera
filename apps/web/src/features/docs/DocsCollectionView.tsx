import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/ui/Badge/Badge'
import { Button } from '@/ui/Button/Button'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { StatusPill, type StatusPillState } from '@/ui/StatusPill/StatusPill'
import { cx } from '@/ui/cx'
import { LINK_TEXT } from '@/ui/linkText'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import {
  exportCollection,
  type CollectionExportFormat,
} from './collectionExport'
import { getCollectionCopy, type CollectionCopy } from './collectionMessages'
import {
  computeCollectionRollups,
  createDefaultCollectionSchema,
  defaultCellForProperty,
  filterAndSortCollectionRows,
  formatRollupNumber,
  isDoneStatusOption,
  optionToneForIndex,
  validateCollectionPropertyValue,
  validateCollectionUrl,
  type ActiveCollectionFilterState,
  type CollectionAssigneeMember,
  type CollectionCellValue,
  type CollectionPropertyDef,
  type CollectionSelectOptionItem,
  type CollectionSortRule,
  type CollectionTagTone,
  type CollectionValidationReason,
  type CollectionViewKind,
  type EnrichedCollectionRow,
  type WorkspaceCollectionModel,
  type WorkspaceCollectionRowModel,
} from './collectionSchema'
import type { DocumentAccessRole } from './pageTree'
import {
  getWorkspaceCollection,
  getWorkspaceCollectionRow,
  isCollectionPreconditionFailedError,
  listWorkspaceCollections,
  putWorkspaceCollectionRow,
  queryWorkspaceCollection,
} from './workspaceDocumentsApi'

export interface CollectionDocumentDescriptor {
  readonly id: string
  readonly title: string
  readonly updatedAt: string
  readonly role: DocumentAccessRole
}

export interface DocsCollectionViewProps {
  readonly organisationId?: string | undefined
  readonly documents: readonly CollectionDocumentDescriptor[]
  readonly members?: readonly CollectionAssigneeMember[] | undefined
  readonly activeDocumentId?: string | undefined
  readonly initialCollection?: WorkspaceCollectionModel | undefined
  readonly initialRows?: readonly WorkspaceCollectionRowModel[] | undefined
  readonly initialRowEtags?: Readonly<Record<string, string>> | undefined
  readonly initialView?: CollectionViewKind | undefined
  readonly accessRole?: DocumentAccessRole | undefined
  readonly onOpenDocument?: ((documentId: string) => void) | undefined
  readonly onCreateDocument?: ((title: string) => Promise<string | null> | string | null) | undefined
  readonly onExport?:
    | ((format: CollectionExportFormat, content: string) => void | Promise<void>)
    | undefined
  readonly onRowsChange?: ((rows: readonly WorkspaceCollectionRowModel[]) => void) | undefined
}

const TAG_TONE_CLASS: Readonly<Record<CollectionTagTone, string>> = {
  1: 'bg-c-tag-1-bg text-c-tag-1-fg',
  2: 'bg-c-tag-2-bg text-c-tag-2-fg',
  3: 'bg-c-tag-3-bg text-c-tag-3-fg',
  4: 'bg-c-tag-4-bg text-c-tag-4-fg',
  5: 'bg-c-tag-5-bg text-c-tag-5-fg',
  6: 'bg-c-tag-6-bg text-c-tag-6-fg',
}

function statusPillStateForOption(option: CollectionSelectOptionItem | undefined): StatusPillState {
  if (!option) return 'neutral'
  if (isDoneStatusOption(option)) return 'success'
  const id = option.id.toLowerCase()
  if (id === 'in_progress' || id === 'active' || id === 'doing') return 'info'
  if (id === 'review' || id === 'blocked') return 'warning'
  if (id === 'urgent' || id === 'critical') return 'danger'
  return 'neutral'
}

function validationMessageForReason(
  reason: CollectionValidationReason,
  copy: CollectionCopy
): string {
  switch (reason) {
    case 'invalid_url':
    case 'disallowed_protocol':
    case 'credentials_forbidden':
      return copy.validation.invalidUrl
    case 'invalid_date':
      return copy.validation.invalidDate
    case 'invalid_number':
      return copy.validation.invalidNumber
    default:
      return copy.validation.invalidValue
  }
}

function buildCompleteRowValues(
  properties: readonly CollectionPropertyDef[],
  existing: Readonly<Record<string, CollectionCellValue>> | undefined
): Record<string, CollectionCellValue> {
  const next: Record<string, CollectionCellValue> = {}
  for (const prop of properties) {
    next[prop.id] = existing?.[prop.id] ?? defaultCellForProperty(prop)
  }
  return next
}

const VIEW_ORDER: readonly CollectionViewKind[] = ['table', 'board', 'list']

export function DocsCollectionView({
  organisationId,
  documents,
  members = [],
  activeDocumentId,
  initialCollection,
  initialRows,
  initialRowEtags,
  initialView = 'table',
  accessRole: forcedRole,
  onOpenDocument,
  onCreateDocument,
  onExport,
  onRowsChange,
}: DocsCollectionViewProps) {
  const { i18n } = useTranslation()
  const copy = getCollectionCopy(i18n.resolvedLanguage)
  const searchInputId = useId()
  const statusFilterId = useId()
  const priorityFilterId = useId()
  const assigneeFilterId = useId()
  const tagFilterId = useId()
  const sortSelectId = useId()
  const groupBySelectId = useId()
  const newRowInputId = useId()

  const isControlledLocal = initialCollection !== undefined || initialRows !== undefined
  const [remoteFallbackLocal, setRemoteFallbackLocal] = useState(false)
  const isRemoteMode = Boolean(organisationId) && !isControlledLocal && !remoteFallbackLocal

  const defaultCollection = useMemo(
    () => createDefaultCollectionSchema(i18n.resolvedLanguage),
    [i18n.resolvedLanguage]
  )

  const [remoteCollection, setRemoteCollection] = useState<WorkspaceCollectionModel | null>(null)
  const collection = initialCollection ?? remoteCollection ?? defaultCollection

  const [rowsByDocId, setRowsByDocId] = useState<
    Readonly<Record<string, WorkspaceCollectionRowModel>>
  >(() => {
    const map: Record<string, WorkspaceCollectionRowModel> = {}
    for (const row of initialRows ?? []) {
      map[row.documentId] = row
    }
    return map
  })

  const rowEtagsRef = useRef<Map<string, string>>(
    new Map(Object.entries(initialRowEtags ?? {}))
  )
  const knownRemoteRowsRef = useRef<Set<string>>(
    new Set([...(initialRows ?? []).map((r) => r.documentId), ...Object.keys(initialRowEtags ?? {})])
  )
  const collectionEtagRef = useRef<string | null>(null)
  const onRowsChangeRef = useRef(onRowsChange)

  useEffect(() => {
    onRowsChangeRef.current = onRowsChange
  }, [onRowsChange])

  const [activeView, setActiveView] = useState<CollectionViewKind>(initialView)
  const [boardGroupById, setBoardGroupById] = useState<string>(() => {
    const boardCfg = collection.views.find((v) => v.kind === 'board')
    return boardCfg?.kind === 'board' ? boardCfg.groupByPropertyId : 'status'
  })

  const [filters, setFilters] = useState<ActiveCollectionFilterState>({
    searchQuery: '',
    statusId: null,
    priorityId: null,
    assigneeId: null,
    tagId: null,
  })
  const [sort, setSort] = useState<CollectionSortRule>({
    propertyId: 'title',
    direction: 'asc',
  })

  const [conflictDocId, setConflictDocId] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [newEntryTitle, setNewEntryTitle] = useState('')
  const [draggedDocId, setDraggedDocId] = useState<string | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null)

  const [editingUrlCell, setEditingUrlCell] = useState<{
    readonly docId: string
    readonly propId: string
    readonly draft: string
  } | null>(null)

  const [numberDrafts, setNumberDrafts] = useState<Readonly<Record<string, string>>>({})

  const gridRef = useRef<HTMLTableElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const viewTabRefs = useRef<Record<CollectionViewKind, HTMLButtonElement | null>>({
    table: null,
    board: null,
    list: null,
  })

  // Hydrate remote collection + rows when operating against Core 0.44.0.
  useEffect(() => {
    if (!organisationId || isControlledLocal) return
    const abort = new AbortController()

    void listWorkspaceCollections(organisationId, { signal: abort.signal })
      .then(async (page) => {
        if (abort.signal.aborted) return
        const first = page.collections[0]
        if (!first) {
          setRemoteFallbackLocal(true)
          return
        }
        const detail = await getWorkspaceCollection(organisationId, first.id, abort.signal).catch(
          () => ({ collection: first, etag: page.etag })
        )
        if (abort.signal.aborted) return
        collectionEtagRef.current = detail.etag
        setRemoteCollection(detail.collection)

        const queried = await queryWorkspaceCollection(
          organisationId,
          detail.collection.id,
          {},
          detail.collection.properties,
          { signal: abort.signal }
        )
        if (abort.signal.aborted) return
        const nextMap: Record<string, WorkspaceCollectionRowModel> = {}
        knownRemoteRowsRef.current.clear()
        for (const row of queried.rows) {
          nextMap[row.documentId] = row
          knownRemoteRowsRef.current.add(row.documentId)
        }
        setRowsByDocId(nextMap)
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setRemoteFallbackLocal(true)
        }
      })

    return () => {
      abort.abort()
    }
  }, [isControlledLocal, organisationId])

  const effectiveRole: DocumentAccessRole =
    forcedRole === 'viewer' || collection.role === 'viewer' ? 'viewer' : 'editor'

  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m.name])),
    [members]
  )

  const enrichedRows = useMemo<readonly EnrichedCollectionRow[]>(() => {
    return documents.map((doc) => {
      const stored = rowsByDocId[doc.id]
      const values = buildCompleteRowValues(collection.properties, stored?.values)
      return {
        documentId: doc.id,
        title: doc.title,
        updatedAt: stored?.updatedAt ?? doc.updatedAt,
        role: effectiveRole === 'viewer' || doc.role === 'viewer' ? 'viewer' : 'editor',
        values,
      }
    })
  }, [collection.properties, documents, effectiveRole, rowsByDocId])

  const visibleRows = useMemo(
    () =>
      filterAndSortCollectionRows(
        enrichedRows,
        collection.properties,
        filters,
        sort,
        members
      ),
    [collection.properties, enrichedRows, filters, members, sort]
  )

  const rollups = useMemo(
    () =>
      computeCollectionRollups(
        visibleRows,
        enrichedRows.length,
        collection.properties
      ),
    [collection.properties, enrichedRows.length, visibleRows]
  )

  const statusProperty = useMemo(
    () => collection.properties.find((p) => p.kind === 'status'),
    [collection.properties]
  )
  const priorityProperty = useMemo(
    () => collection.properties.find((p) => p.kind === 'priority'),
    [collection.properties]
  )
  const assigneeProperty = useMemo(
    () => collection.properties.find((p) => p.kind === 'assignee'),
    [collection.properties]
  )
  const tagProperty = useMemo(
    () => collection.properties.find((p) => p.kind === 'tags' || p.kind === 'multi_select'),
    [collection.properties]
  )

  const groupableProperties = useMemo(
    () =>
      collection.properties.filter(
        (p) => p.kind === 'status' || p.kind === 'priority' || p.kind === 'select'
      ),
    [collection.properties]
  )

  const activeBoardProperty = useMemo(
    () =>
      groupableProperties.find((p) => p.id === boardGroupById) ??
      groupableProperties[0] ??
      statusProperty,
    [boardGroupById, groupableProperties, statusProperty]
  )

  const commitRowMap = (
    updater: (
      prev: Readonly<Record<string, WorkspaceCollectionRowModel>>
    ) => Readonly<Record<string, WorkspaceCollectionRowModel>>
  ) => {
    setRowsByDocId((prev) => {
      const next = updater(prev)
      onRowsChangeRef.current?.(Object.values(next))
      return next
    })
  }

  const updateCellValue = async (
    documentId: string,
    property: CollectionPropertyDef,
    rawValue: unknown
  ): Promise<boolean> => {
    const targetDoc = documents.find((d) => d.id === documentId)
    if (!targetDoc || effectiveRole === 'viewer' || targetDoc.role === 'viewer') {
      return false
    }

    const validated = validateCollectionPropertyValue(property, rawValue)
    if (!validated.ok) {
      setValidationError(validationMessageForReason(validated.reason, copy))
      return false
    }

    setValidationError(null)
    const previousRow = rowsByDocId[documentId]
    const baseValues = buildCompleteRowValues(collection.properties, previousRow?.values)
    const nextValues: Record<string, CollectionCellValue> = {
      ...baseValues,
      [property.id]: validated.cell,
    }
    const optimisticRow: WorkspaceCollectionRowModel = {
      documentId,
      values: nextValues,
      updatedAt: new Date().toISOString(),
    }

    commitRowMap((prev) => ({
      ...prev,
      [documentId]: optimisticRow,
    }))

    const shouldSyncRemote =
      Boolean(organisationId) && (!isControlledLocal || initialRowEtags !== undefined) && !remoteFallbackLocal

    if (shouldSyncRemote && organisationId) {
      try {
        const hasExistingRow =
          knownRemoteRowsRef.current.has(documentId) || rowEtagsRef.current.has(documentId)

        if (hasExistingRow) {
          let etag = rowEtagsRef.current.get(documentId) ?? null
          if (!etag) {
            const fetched = await getWorkspaceCollectionRow(
              organisationId,
              collection.id,
              documentId,
              collection.properties
            )
            etag = fetched.etag
            if (etag) rowEtagsRef.current.set(documentId, etag)
          }
          if (!etag) {
            setConflictDocId(documentId)
            return false
          }
          const saved = await putWorkspaceCollectionRow(
            organisationId,
            collection.id,
            documentId,
            nextValues,
            { mode: 'update', ifMatch: etag },
            collection.properties
          )
          knownRemoteRowsRef.current.add(documentId)
          if (saved.etag) {
            rowEtagsRef.current.set(documentId, saved.etag)
          } else {
            rowEtagsRef.current.delete(documentId)
          }
          commitRowMap((prev) => ({
            ...prev,
            [documentId]: saved.row,
          }))
        } else {
          const created = await putWorkspaceCollectionRow(
            organisationId,
            collection.id,
            documentId,
            nextValues,
            { mode: 'create', ifNoneMatch: '*' },
            collection.properties
          )
          knownRemoteRowsRef.current.add(documentId)
          if (created.etag) {
            rowEtagsRef.current.set(documentId, created.etag)
          }
          commitRowMap((prev) => ({
            ...prev,
            [documentId]: created.row,
          }))
        }
      } catch (err) {
        if (isCollectionPreconditionFailedError(err)) {
          // Roll back the stale optimistic write and prompt reload.
          commitRowMap((prev) => {
            const copyMap = { ...prev }
            if (previousRow) copyMap[documentId] = previousRow
            else delete copyMap[documentId]
            return copyMap
          })
          if (err.currentEtag) {
            rowEtagsRef.current.set(documentId, err.currentEtag)
          } else {
            rowEtagsRef.current.delete(documentId)
          }
          setConflictDocId(documentId)
          return false
        }
        setValidationError(copy.validation.invalidValue)
        return false
      }
    }

    return true
  }

  const handleReloadAfterConflict = async () => {
    const targetDocId = conflictDocId
    setConflictDocId(null)
    if (!organisationId) return

    try {
      const freshCollection = await getWorkspaceCollection(organisationId, collection.id).catch(
        () => null
      )
      const activeProps = freshCollection?.collection.properties ?? collection.properties
      if (freshCollection) {
        collectionEtagRef.current = freshCollection.etag
        if (!initialCollection) {
          setRemoteCollection(freshCollection.collection)
        }
      }

      if (targetDocId) {
        const freshRow = await getWorkspaceCollectionRow(
          organisationId,
          collection.id,
          targetDocId,
          activeProps
        )
        knownRemoteRowsRef.current.add(targetDocId)
        if (freshRow.etag) {
          rowEtagsRef.current.set(targetDocId, freshRow.etag)
        }
        commitRowMap((prev) => ({
          ...prev,
          [targetDocId]: freshRow.row,
        }))
      }

      const page = await queryWorkspaceCollection(
        organisationId,
        collection.id,
        {},
        activeProps
      ).catch(() => null)
      if (page) {
        commitRowMap((prev) => {
          const merged = { ...prev }
          for (const row of page.rows) {
            merged[row.documentId] = row
            knownRemoteRowsRef.current.add(row.documentId)
          }
          return merged
        })
      }
    } catch {
      // Keep banner dismissed only when reload succeeded; re-surface if still unreachable.
      setConflictDocId(targetDocId)
    }
  }

  const handleExport = async (format: CollectionExportFormat) => {
    const output = exportCollection(format, {
      collectionId: collection.id,
      collectionTitle: collection.title,
      properties: collection.properties,
      rows: visibleRows,
      totalCount: enrichedRows.length,
      members,
      locale: i18n.resolvedLanguage,
    })
    try {
      if (onExport) {
        await onExport(format, output)
      } else if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(output)
      }
      setExportNotice(copy.exportActions.exportedNotice(format.toUpperCase()))
    } catch {
      setExportNotice(copy.exportActions.exportFailed)
    }
  }

  const handleCreateEntry = async () => {
    const trimmed = newEntryTitle.trim()
    if (!trimmed || !onCreateDocument) return
    const createdDocId = await onCreateDocument(trimmed)
    setNewEntryTitle('')
    if (createdDocId) {
      commitRowMap((prev) => ({
        ...prev,
        [createdDocId]: {
          documentId: createdDocId,
          values: buildCompleteRowValues(collection.properties, undefined),
          updatedAt: new Date().toISOString(),
        },
      }))
    }
  }

  const toggleSortColumn = (propertyId: string) => {
    setSort((prev) => {
      if (prev.propertyId === propertyId) {
        return {
          propertyId,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        }
      }
      return { propertyId, direction: 'asc' }
    })
  }

  const handleViewTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: CollectionViewKind
  ) => {
    const idx = VIEW_ORDER.indexOf(current)
    if (idx < 0) return
    let nextIdx: number | null = null
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % VIEW_ORDER.length
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + VIEW_ORDER.length) % VIEW_ORDER.length
    else if (event.key === 'Home') nextIdx = 0
    else if (event.key === 'End') nextIdx = VIEW_ORDER.length - 1
    if (nextIdx !== null) {
      event.preventDefault()
      const target = VIEW_ORDER[nextIdx]!
      setActiveView(target)
      viewTabRefs.current[target]?.focus()
    }
  }

  const handleGridCellKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const target = event.target as HTMLElement
    const isTextInput =
      target.tagName === 'INPUT' &&
      (target as HTMLInputElement).type !== 'checkbox'

    if (event.key === 'Escape') {
      if (editingUrlCell) {
        event.preventDefault()
        setEditingUrlCell(null)
      }
      if (validationError) {
        setValidationError(null)
      }
      return
    }

    let nextRow = rowIndex
    let nextCol = colIndex

    if (event.key === 'ArrowDown') {
      nextRow = rowIndex + 1
    } else if (event.key === 'ArrowUp') {
      nextRow = rowIndex - 1
    } else if (event.key === 'ArrowRight' && !isTextInput) {
      nextCol = colIndex + 1
    } else if (event.key === 'ArrowLeft' && !isTextInput) {
      nextCol = colIndex - 1
    } else {
      return
    }

    const nextEl = gridRef.current?.querySelector<HTMLElement>(
      `[data-grid-row="${nextRow}"][data-grid-col="${nextCol}"]`
    )
    if (nextEl) {
      event.preventDefault()
      nextEl.focus()
    }
  }

  const activeFilterChips = (() => {
    const chips: {
      readonly key: 'status' | 'priority' | 'assignee' | 'tag' | 'search'
      readonly label: string
      readonly clear: () => void
    }[] = []

    if (filters.statusId && statusProperty) {
      const optLabel =
        statusProperty.options?.find((o) => o.id === filters.statusId)?.label ?? filters.statusId
      chips.push({
        key: 'status',
        label: `${copy.filterStatusLabel}: ${optLabel}`,
        clear: () => setFilters((prev) => ({ ...prev, statusId: null })),
      })
    }
    if (filters.priorityId && priorityProperty) {
      const optLabel =
        priorityProperty.options?.find((o) => o.id === filters.priorityId)?.label ??
        filters.priorityId
      chips.push({
        key: 'priority',
        label: `${copy.filterPriorityLabel}: ${optLabel}`,
        clear: () => setFilters((prev) => ({ ...prev, priorityId: null })),
      })
    }
    if (filters.assigneeId) {
      const assigneeName = memberById.get(filters.assigneeId) ?? filters.assigneeId
      chips.push({
        key: 'assignee',
        label: `${copy.filterAssigneeLabel}: ${assigneeName}`,
        clear: () => setFilters((prev) => ({ ...prev, assigneeId: null })),
      })
    }
    if (filters.tagId && tagProperty) {
      const tagLabel =
        tagProperty.options?.find((o) => o.id === filters.tagId)?.label ?? filters.tagId
      chips.push({
        key: 'tag',
        label: `${copy.filterTagLabel}: ${tagLabel}`,
        clear: () => setFilters((prev) => ({ ...prev, tagId: null })),
      })
    }
    if (filters.searchQuery.trim().length > 0) {
      chips.push({
        key: 'search',
        label: `"${filters.searchQuery.trim()}"`,
        clear: () => setFilters((prev) => ({ ...prev, searchQuery: '' })),
      })
    }
    return chips
  })()

  const boardColumns = (() => {
    if (!activeBoardProperty) return []
    const options = activeBoardProperty.options ?? []
    const cols: {
      readonly id: string | null
      readonly label: string
      readonly option?: CollectionSelectOptionItem | undefined
      readonly rows: EnrichedCollectionRow[]
    }[] = options.map((opt) => ({
      id: opt.id,
      label: opt.label,
      option: opt,
      rows: [],
    }))

    const unsetRows: EnrichedCollectionRow[] = []
    const colById = new Map(cols.map((c) => [c.id, c]))

    for (const row of visibleRows) {
      const cell = row.values[activeBoardProperty.id]
      const val = typeof cell?.value === 'string' ? cell.value : null
      const bucket = val !== null ? colById.get(val) : undefined
      if (bucket) {
        bucket.rows.push(row)
      } else {
        unsetRows.push(row)
      }
    }

    if (unsetRows.length > 0) {
      cols.push({
        id: null,
        label: copy.emptyGroupHeading,
        rows: unsetRows,
      })
    }

    return cols
  })()

  const renderTableCell = (
    row: EnrichedCollectionRow,
    prop: CollectionPropertyDef,
    rowIndex: number,
    colIndex: number
  ) => {
    const cell = row.values[prop.id]
    const canEdit = row.role === 'editor'
    const label = copy.editCellLabel(row.title, prop.name)

    switch (prop.kind) {
      case 'status':
      case 'priority':
      case 'select': {
        const selectedVal =
          cell && (cell.kind === 'status' || cell.kind === 'priority' || cell.kind === 'select')
            ? (cell.value ?? '')
            : ''
        if (!canEdit) {
          const opt = prop.options?.find((o) => o.id === selectedVal)
          return prop.kind === 'status' ? (
            <StatusPill state={statusPillStateForOption(opt)}>
              {opt?.label ?? copy.unsetOption}
            </StatusPill>
          ) : (
            <Badge variant="neutral">{opt?.label ?? copy.unsetOption}</Badge>
          )
        }
        return (
          <select
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            value={selectedVal}
            onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
            onChange={(e) => {
              void updateCellValue(row.documentId, prop, e.target.value || null)
            }}
            className="h-8 max-w-[160px] rounded-sm border border-c-border-input bg-c-surface px-2 text-xs font-medium text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          >
            <option value="">{copy.unsetOption}</option>
            {(prop.options ?? []).map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        )
      }

      case 'checkbox': {
        const checked = cell?.kind === 'checkbox' ? cell.value : false
        return (
          <input
            type="checkbox"
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            checked={checked}
            disabled={!canEdit}
            onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
            onChange={(e) => {
              void updateCellValue(row.documentId, prop, e.target.checked)
            }}
            className="h-4 w-4 rounded-sm border border-c-border-input accent-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
        )
      }

      case 'due_date': {
        const dateVal = cell?.kind === 'due_date' ? (cell.value ?? '') : ''
        if (!canEdit) {
          return <span className="font-mono text-xs text-c-ink-2">{dateVal || '—'}</span>
        }
        return (
          <input
            type="date"
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            value={dateVal}
            onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
            onChange={(e) => {
              void updateCellValue(row.documentId, prop, e.target.value || null)
            }}
            className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
        )
      }

      case 'assignee': {
        const assigneeVal = cell?.kind === 'assignee' ? (cell.value ?? '') : ''
        if (!canEdit) {
          return (
            <span className="text-xs text-c-ink-2">
              {assigneeVal ? (memberById.get(assigneeVal) ?? assigneeVal) : copy.unassignedOption}
            </span>
          )
        }
        return (
          <select
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            value={assigneeVal}
            onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
            onChange={(e) => {
              void updateCellValue(row.documentId, prop, e.target.value || null)
            }}
            className="h-8 max-w-[160px] rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          >
            <option value="">{copy.unassignedOption}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        )
      }

      case 'number': {
        const draftKey = `${row.documentId}:${prop.id}`
        const committed =
          cell?.kind === 'number' && cell.value !== null ? String(cell.value) : ''
        const displayValue = numberDrafts[draftKey] ?? committed
        if (!canEdit) {
          return <span className="font-mono text-xs text-c-ink">{committed || '—'}</span>
        }
        const commitNumber = (raw: string) => {
          setNumberDrafts((prev) => {
            const copyDrafts = { ...prev }
            delete copyDrafts[draftKey]
            return copyDrafts
          })
          const trimmed = raw.trim()
          if (trimmed === committed) return
          void updateCellValue(row.documentId, prop, trimmed === '' ? null : Number(trimmed))
        }
        return (
          <input
            type="number"
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            value={displayValue}
            onChange={(e) =>
              setNumberDrafts((prev) => ({ ...prev, [draftKey]: e.target.value }))
            }
            onBlur={(e) => commitNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitNumber((e.target as HTMLInputElement).value)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setNumberDrafts((prev) => {
                  const copyDrafts = { ...prev }
                  delete copyDrafts[draftKey]
                  return copyDrafts
                })
                return
              }
              handleGridCellKeyDown(e, rowIndex, colIndex)
            }}
            className="h-8 w-[88px] rounded-sm border border-c-border-input bg-c-surface px-2 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
        )
      }

      case 'url': {
        const storedUrl = cell?.kind === 'url' ? cell.value : null
        const urlValidation = validateCollectionUrl(storedUrl)
        const safeHref = urlValidation.ok ? urlValidation.value : null
        const isEditingThis =
          editingUrlCell?.docId === row.documentId && editingUrlCell.propId === prop.id

        if (isEditingThis && canEdit) {
          return (
            <div className="flex items-center gap-1">
              <input
                type="url"
                aria-label={label}
                data-grid-row={rowIndex}
                data-grid-col={colIndex}
                data-testid={`collection-url-input-${row.documentId}-${prop.id}`}
                placeholder={copy.urlPlaceholder}
                value={editingUrlCell.draft}
                onChange={(e) =>
                  setEditingUrlCell({
                    docId: row.documentId,
                    propId: prop.id,
                    draft: e.target.value,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void updateCellValue(
                      row.documentId,
                      prop,
                      editingUrlCell.draft.trim() || null
                    ).then((ok) => {
                      if (ok) setEditingUrlCell(null)
                    })
                    return
                  }
                  handleGridCellKeyDown(e, rowIndex, colIndex)
                }}
                className="h-8 min-w-[160px] rounded-sm border border-c-border-input bg-c-surface px-2 font-mono text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void updateCellValue(
                    row.documentId,
                    prop,
                    editingUrlCell.draft.trim() || null
                  ).then((ok) => {
                    if (ok) setEditingUrlCell(null)
                  })
                }}
              >
                {copy.saveUrlAction}
              </Button>
            </div>
          )
        }

        return (
          <div className="flex flex-wrap items-center gap-2">
            {safeHref ? (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={copy.openExternalUrlNamed(row.title, prop.name)}
                className={cx('max-w-[160px] truncate font-mono text-xs', LINK_TEXT.standalone)}
              >
                {safeHref}
              </a>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                aria-label={label}
                data-grid-row={rowIndex}
                data-grid-col={colIndex}
                data-testid={`collection-cell-${row.documentId}-${prop.id}`}
                onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
                onClick={() =>
                  setEditingUrlCell({
                    docId: row.documentId,
                    propId: prop.id,
                    draft: safeHref ?? '',
                  })
                }
                className="inline-flex min-h-6 items-center rounded-sm border border-c-border bg-c-surface px-2 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
              >
                {safeHref ? '✎' : '+ URL'}
              </button>
            ) : !safeHref ? (
              <span className="text-xs text-c-ink-3">—</span>
            ) : null}
          </div>
        )
      }

      case 'multi_select':
      case 'tags': {
        const selectedIds =
          cell && (cell.kind === 'multi_select' || cell.kind === 'tags') ? cell.value : []
        return (
          <div className="flex flex-wrap items-center gap-1">
            {(prop.options ?? []).map((opt, idx) => {
              const isSelected = selectedIds.includes(opt.id)
              const tone = optionToneForIndex(idx, opt)
              if (!canEdit) {
                return isSelected ? (
                  <span
                    key={opt.id}
                    className={cx(
                      'inline-flex items-center rounded-full px-2 py-[2px] text-xs font-medium',
                      TAG_TONE_CLASS[tone]
                    )}
                  >
                    {opt.label}
                  </span>
                ) : null
              }
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={copy.toggleTagLabel(row.title, prop.name, opt.label)}
                  {...(idx === 0
                    ? { 'data-grid-row': rowIndex, 'data-grid-col': colIndex }
                    : {})}
                  onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
                  onClick={() => {
                    const next = isSelected
                      ? selectedIds.filter((id) => id !== opt.id)
                      : [...selectedIds, opt.id]
                    void updateCellValue(row.documentId, prop, next)
                  }}
                  className={cx(
                    'inline-flex items-center rounded-full border px-2 py-[2px] text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                    isSelected
                      ? cx('border-transparent', TAG_TONE_CLASS[tone])
                      : 'border-c-border bg-c-surface text-c-ink-3 hover:bg-c-muted'
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        )
      }

      case 'text': {
        const textVal = cell?.kind === 'text' ? (cell.value ?? '') : ''
        if (!canEdit) {
          return <span className="text-xs text-c-ink">{textVal || '—'}</span>
        }
        return (
          <input
            type="text"
            aria-label={label}
            data-grid-row={rowIndex}
            data-grid-col={colIndex}
            data-testid={`collection-cell-${row.documentId}-${prop.id}`}
            value={textVal}
            onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, colIndex)}
            onChange={(e) => {
              void updateCellValue(row.documentId, prop, e.target.value || null)
            }}
            className="h-8 min-w-[120px] rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
        )
      }
    }
  }

  const moveCardToColumnOffset = (row: EnrichedCollectionRow, offset: -1 | 1) => {
    if (!activeBoardProperty || row.role === 'viewer') return
    const options = activeBoardProperty.options ?? []
    if (options.length === 0) return
    const currentCell = row.values[activeBoardProperty.id]
    const currentVal = typeof currentCell?.value === 'string' ? currentCell.value : null
    const currentIdx = options.findIndex((o) => o.id === currentVal)
    const targetIdx =
      currentIdx < 0
        ? offset > 0
          ? 0
          : options.length - 1
        : Math.min(options.length - 1, Math.max(0, currentIdx + offset))
    const targetOption = options[targetIdx]
    if (targetOption && targetOption.id !== currentVal) {
      void updateCellValue(row.documentId, activeBoardProperty, targetOption.id)
    }
  }

  return (
    <section
      aria-label={copy.regionLabel}
      data-testid="docs-collection-view"
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      {/* Header + View Switcher + Export Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-c-border-soft pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-md font-semibold text-c-ink">{collection.title}</h3>
          {!isRemoteMode ? (
            <StatusPill state="neutral" data-testid="collection-local-badge">
              {copy.localBadge}
            </StatusPill>
          ) : null}
          {effectiveRole === 'viewer' ? (
            <StatusPill state="info" data-testid="collection-readonly-badge">
              {copy.readOnlyBadge}
            </StatusPill>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label={copy.viewsGroupLabel}
            className="flex items-center gap-1 rounded-md border border-c-border-soft bg-c-sunken p-1"
          >
            {VIEW_ORDER.map((mode) => {
              const isSelected = activeView === mode
              const label =
                mode === 'table'
                  ? copy.viewTable
                  : mode === 'board'
                    ? copy.viewBoard
                    : copy.viewList
              return (
                <button
                  key={mode}
                  ref={(el) => {
                    viewTabRefs.current[mode] = el
                  }}
                  type="button"
                  role="tab"
                  data-testid={`collection-view-tab-${mode}`}
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  onKeyDown={(e) => handleViewTabKeyDown(e, mode)}
                  onClick={() => setActiveView(mode)}
                  className={cx(
                    'inline-flex min-h-8 items-center justify-center rounded-sm border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    isSelected
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                      : 'border-transparent bg-transparent text-c-ink-2 hover:bg-c-surface'
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <div
            role="group"
            aria-label={copy.exportActions.groupLabel}
            className="flex flex-wrap items-center gap-1"
          >
            <Button
              size="sm"
              variant="secondary"
              data-testid="collection-export-csv"
              onClick={() => void handleExport('csv')}
            >
              {copy.exportActions.csv}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="collection-export-json"
              onClick={() => void handleExport('json')}
            >
              {copy.exportActions.json}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="collection-export-markdown"
              onClick={() => void handleExport('markdown')}
            >
              {copy.exportActions.markdown}
            </Button>
          </div>
        </div>
      </div>

      {/* 412 Concurrency Conflict Banner */}
      {conflictDocId !== null ? (
        <div
          role="alert"
          data-testid="collection-conflict-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-sm font-medium text-c-bad-ink"
        >
          <span>{copy.conflict.message}</span>
          <Button
            size="sm"
            variant="secondary"
            data-testid="collection-conflict-reload"
            onClick={() => void handleReloadAfterConflict()}
          >
            {copy.conflict.reloadAction}
          </Button>
        </div>
      ) : null}

      {/* Schema Validation Error Alert */}
      {validationError !== null ? (
        <div data-testid="collection-validation-error" className="flex items-center justify-between gap-2">
          <InlineAlert kind="error" className="flex-1">
            {validationError}
          </InlineAlert>
          <Button
            size="sm"
            variant="tertiary"
            onClick={() => setValidationError(null)}
          >
            {copy.validation.dismissAction}
          </Button>
        </div>
      ) : null}

      {/* Polite Export Notice */}
      <div aria-live="polite" className={exportNotice ? 'block' : 'sr-only'}>
        {exportNotice ? (
          <InlineAlert kind="success" inLiveRegion data-testid="collection-export-notice">
            {exportNotice}
          </InlineAlert>
        ) : null}
      </div>

      {/* Filter, Search, Group-By & Sort Bar */}
      <div className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[180px] flex-1 flex-col gap-1">
            <label htmlFor={searchInputId} className="text-xs font-medium text-c-ink-2">
              {copy.searchLabel}
            </label>
            <input
              id={searchInputId}
              type="search"
              data-testid="collection-search-input"
              value={filters.searchQuery}
              placeholder={copy.searchPlaceholder}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filters.searchQuery.length > 0) {
                  e.preventDefault()
                  setFilters((prev) => ({ ...prev, searchQuery: '' }))
                }
              }}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, searchQuery: e.target.value }))
              }
              className="h-8 rounded-sm border border-c-border-input bg-c-surface px-3 text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>

          {statusProperty ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={statusFilterId} className="text-xs font-medium text-c-ink-2">
                {copy.filterStatusLabel}
              </label>
              <select
                id={statusFilterId}
                data-testid="collection-filter-status"
                value={filters.statusId ?? ''}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, statusId: e.target.value || null }))
                }
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.filterAllOption}</option>
                {(statusProperty.options ?? []).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {priorityProperty ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={priorityFilterId} className="text-xs font-medium text-c-ink-2">
                {copy.filterPriorityLabel}
              </label>
              <select
                id={priorityFilterId}
                data-testid="collection-filter-priority"
                value={filters.priorityId ?? ''}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, priorityId: e.target.value || null }))
                }
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.filterAllOption}</option>
                {(priorityProperty.options ?? []).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {assigneeProperty && members.length > 0 ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={assigneeFilterId} className="text-xs font-medium text-c-ink-2">
                {copy.filterAssigneeLabel}
              </label>
              <select
                id={assigneeFilterId}
                data-testid="collection-filter-assignee"
                value={filters.assigneeId ?? ''}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, assigneeId: e.target.value || null }))
                }
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.filterAllOption}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {tagProperty ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={tagFilterId} className="text-xs font-medium text-c-ink-2">
                {copy.filterTagLabel}
              </label>
              <select
                id={tagFilterId}
                data-testid="collection-filter-tag"
                value={filters.tagId ?? ''}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, tagId: e.target.value || null }))
                }
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.filterAllOption}</option>
                {(tagProperty.options ?? []).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="flex items-end gap-1">
            <div className="flex flex-col gap-1">
              <label htmlFor={sortSelectId} className="text-xs font-medium text-c-ink-2">
                {copy.sortPropertyLabel}
              </label>
              <select
                id={sortSelectId}
                data-testid="collection-sort-property"
                value={sort.propertyId}
                onChange={(e) =>
                  setSort((prev) => ({ ...prev, propertyId: e.target.value }))
                }
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="title">{copy.sortByTitle}</option>
                <option value="updatedAt">{copy.sortByUpdated}</option>
                {collection.properties.map((prop) => (
                  <option key={prop.id} value={prop.id}>
                    {prop.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              variant="secondary"
              data-testid="collection-sort-direction"
              aria-label={
                sort.direction === 'asc' ? copy.sortDirectionAsc : copy.sortDirectionDesc
              }
              onClick={() =>
                setSort((prev) => ({
                  ...prev,
                  direction: prev.direction === 'asc' ? 'desc' : 'asc',
                }))
              }
            >
              {sort.direction === 'asc' ? '↑' : '↓'}
            </Button>
          </div>

          {activeView === 'board' && groupableProperties.length > 1 ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={groupBySelectId} className="text-xs font-medium text-c-ink-2">
                {copy.groupByLabel}
              </label>
              <select
                id={groupBySelectId}
                data-testid="collection-board-groupby"
                value={activeBoardProperty?.id ?? ''}
                onChange={(e) => setBoardGroupById(e.target.value)}
                className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                {groupableProperties.map((prop) => (
                  <option key={prop.id} value={prop.id}>
                    {prop.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        {/* Active Multi-Chip Filter Bar */}
        {activeFilterChips.length > 0 ? (
          <div
            role="region"
            aria-label={copy.activeFiltersLabel}
            data-testid="collection-active-filter-chips"
            className="flex flex-wrap items-center gap-2 pt-1"
          >
            {activeFilterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                aria-label={copy.removeFilterChip(chip.label)}
                onClick={chip.clear}
                className="inline-flex min-h-6 items-center gap-1 rounded-full border border-c-accent-ink bg-c-accent-soft px-3 py-[2px] text-xs font-medium text-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <span>{chip.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <Button
              size="sm"
              variant="tertiary"
              data-testid="collection-clear-filters"
              onClick={() =>
                setFilters({
                  searchQuery: '',
                  statusId: null,
                  priorityId: null,
                  assigneeId: null,
                  tagId: null,
                })
              }
            >
              {copy.clearFilters}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Active View Body */}
      {enrichedRows.length === 0 ? (
        <p
          data-testid="collection-empty-state"
          className="rounded-md border border-c-border-soft bg-c-surface p-6 text-center text-sm text-c-ink-3"
        >
          {copy.emptyCollection}
        </p>
      ) : visibleRows.length === 0 ? (
        <p
          data-testid="collection-empty-filtered"
          className="rounded-md border border-c-border-soft bg-c-surface p-6 text-center text-sm text-c-ink-3"
        >
          {copy.emptyFiltered}
        </p>
      ) : activeView === 'table' ? (
        <div className="overflow-x-auto rounded-md border border-c-border-soft bg-c-surface">
          <table
            ref={gridRef}
            role="grid"
            aria-label={collection.title}
            data-testid="collection-table-grid"
            className="w-full border-collapse text-left text-xs"
          >
            <thead>
              <tr className="border-b border-c-border-soft bg-c-sunken">
                <th
                  scope="col"
                  aria-sort={
                    sort.propertyId === 'title'
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className="px-3 py-2 font-semibold text-c-ink-2"
                >
                  <button
                    type="button"
                    onClick={() => toggleSortColumn('title')}
                    className="inline-flex items-center gap-1 font-semibold text-c-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
                  >
                    <span>{copy.columnDocument}</span>
                    {sort.propertyId === 'title' ? (
                      <span aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</span>
                    ) : null}
                  </button>
                </th>
                {collection.properties.map((prop) => {
                  const isSorted = sort.propertyId === prop.id
                  return (
                    <th
                      key={prop.id}
                      scope="col"
                      aria-sort={
                        isSorted
                          ? sort.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                      className="px-3 py-2 font-semibold text-c-ink-2"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSortColumn(prop.id)}
                        className="inline-flex items-center gap-1 font-semibold text-c-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
                      >
                        <span>{prop.name}</span>
                        {isSorted ? (
                          <span aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</span>
                        ) : null}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => {
                const isActive = row.documentId === activeDocumentId
                return (
                  <tr
                    key={row.documentId}
                    data-testid={`collection-table-row-${row.documentId}`}
                    className={cx(
                      'border-b border-c-hairline',
                      isActive ? 'bg-c-accent-soft' : 'bg-c-surface hover:bg-c-sunken'
                    )}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        data-grid-row={rowIndex}
                        data-grid-col={0}
                        data-testid={`collection-open-doc-${row.documentId}`}
                        aria-label={copy.openPageNamed(row.title)}
                        onKeyDown={(e) => handleGridCellKeyDown(e, rowIndex, 0)}
                        onClick={() => onOpenDocument?.(row.documentId)}
                        className={cx(
                          'inline-flex min-h-8 items-center gap-2 rounded-sm px-1 text-left text-sm font-semibold',
                          LINK_TEXT.standalone
                        )}
                      >
                        <span>{row.title}</span>
                      </button>
                    </td>
                    {collection.properties.map((prop, propIdx) => (
                      <td key={prop.id} className="px-3 py-2 align-middle">
                        {renderTableCell(row, prop, rowIndex, propIdx + 1)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr
                data-testid="collection-table-footer"
                className="border-t border-c-border bg-c-sunken text-xs font-medium text-c-ink-2"
              >
                <td className="px-3 py-2 font-mono font-medium text-c-ink">
                  {copy.rollups.footerTotal(rollups.filteredCount)}
                </td>
                {collection.properties.map((prop) => {
                  if (prop.kind === 'status') {
                    return (
                      <td key={prop.id} className="px-3 py-2 font-mono text-c-ink-2">
                        {copy.rollups.footerDone(rollups.donePercent)}
                      </td>
                    )
                  }
                  if (prop.kind === 'checkbox') {
                    const cb = rollups.checkboxByProperty[prop.id]
                    return (
                      <td key={prop.id} className="px-3 py-2 font-mono text-c-ink-2">
                        {copy.rollups.footerChecked(cb?.checkedPercent ?? 0)}
                      </td>
                    )
                  }
                  if (prop.kind === 'number') {
                    const num = rollups.numericByProperty[prop.id]
                    return (
                      <td key={prop.id} className="px-3 py-2 font-mono text-c-ink-2">
                        {copy.rollups.footerSumAvg(
                          formatRollupNumber(num?.sum ?? 0),
                          formatRollupNumber(num?.avg ?? null)
                        )}
                      </td>
                    )
                  }
                  return (
                    <td key={prop.id} className="px-3 py-2 text-c-ink-3">
                      —
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : activeView === 'board' ? (
        <div
          data-testid="collection-board-view"
          className="flex gap-3 overflow-x-auto pb-2 narrow:flex-col"
        >
          {boardColumns.map((col) => {
            const colKey = col.id ?? '__unset__'
            const isDropTarget = dragOverColumnId === colKey
            return (
              <section
                key={colKey}
                aria-label={copy.boardColumnLabel(col.label, col.rows.length)}
                data-testid={`collection-board-column-${colKey}`}
                onDragOver={(e) => {
                  if (effectiveRole === 'viewer' || !activeBoardProperty) return
                  e.preventDefault()
                  setDragOverColumnId(colKey)
                }}
                onDragLeave={() => {
                  if (dragOverColumnId === colKey) setDragOverColumnId(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOverColumnId(null)
                  const droppedId = e.dataTransfer?.getData('text/plain') || draggedDocId
                  setDraggedDocId(null)
                  if (droppedId && activeBoardProperty) {
                    void updateCellValue(droppedId, activeBoardProperty, col.id)
                  }
                }}
                className={cx(
                  'flex min-w-[240px] flex-1 flex-col gap-2 rounded-md border p-3',
                  isDropTarget
                    ? 'border-c-accent-ink bg-c-accent-soft'
                    : 'border-c-border-soft bg-c-sunken'
                )}
              >
                <header className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-c-ink">{col.label}</span>
                  <Badge variant="neutral" data-testid={`collection-board-count-${colKey}`}>
                    {col.rows.length}
                  </Badge>
                </header>

                <ul aria-label={col.label} className="flex flex-col gap-2">
                  {col.rows.map((row, cardIdx) => {
                    const canMove = row.role === 'editor' && Boolean(activeBoardProperty)
                    const dueDateCell = row.values['due_date']
                    const priorityCell = priorityProperty
                      ? row.values[priorityProperty.id]
                      : undefined
                    const priorityOpt =
                      priorityProperty && typeof priorityCell?.value === 'string'
                        ? priorityProperty.options?.find((o) => o.id === priorityCell.value)
                        : undefined
                    const assigneeCell = assigneeProperty
                      ? row.values[assigneeProperty.id]
                      : undefined
                    const assigneeLabel =
                      assigneeCell?.kind === 'assignee' && assigneeCell.value
                        ? (memberById.get(assigneeCell.value) ?? assigneeCell.value)
                        : null

                    return (
                      <li
                        key={row.documentId}
                        data-testid={`collection-board-card-${row.documentId}`}
                        className="flex flex-col gap-2 rounded-md border border-c-border bg-c-surface p-3 shadow-card"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            draggable={canMove}
                            data-board-col={colKey}
                            data-board-idx={cardIdx}
                            data-testid={`collection-board-open-${row.documentId}`}
                            aria-label={copy.openPageNamed(row.title)}
                            onDragStart={(e) => {
                              setDraggedDocId(row.documentId)
                              e.dataTransfer?.setData('text/plain', row.documentId)
                            }}
                            onDragEnd={() => {
                              setDraggedDocId(null)
                              setDragOverColumnId(null)
                            }}
                            onKeyDown={(e) => {
                              if (e.altKey && e.key === 'ArrowRight') {
                                e.preventDefault()
                                moveCardToColumnOffset(row, 1)
                                return
                              }
                              if (e.altKey && e.key === 'ArrowLeft') {
                                e.preventDefault()
                                moveCardToColumnOffset(row, -1)
                                return
                              }
                              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                const targetIdx = e.key === 'ArrowDown' ? cardIdx + 1 : cardIdx - 1
                                const sibling = document.querySelector<HTMLElement>(
                                  `[data-board-col="${colKey}"][data-board-idx="${targetIdx}"]`
                                )
                                if (sibling) {
                                  e.preventDefault()
                                  sibling.focus()
                                }
                              }
                            }}
                            onClick={() => onOpenDocument?.(row.documentId)}
                            className={cx('text-left text-sm font-semibold', LINK_TEXT.standalone)}
                          >
                            {row.title}
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          {priorityOpt && activeBoardProperty?.id !== priorityProperty?.id ? (
                            <Badge variant="accent">{priorityOpt.label}</Badge>
                          ) : null}
                          {dueDateCell?.kind === 'due_date' && dueDateCell.value ? (
                            <span className="rounded-sm bg-c-muted px-2 py-[2px] font-mono text-xs text-c-ink-2">
                              {dueDateCell.value}
                            </span>
                          ) : null}
                          {assigneeLabel ? (
                            <Badge variant="neutral">{assigneeLabel}</Badge>
                          ) : null}
                        </div>

                        {canMove && activeBoardProperty ? (
                          <div className="flex items-center justify-between gap-1 border-t border-c-hairline pt-2">
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={copy.cardMoveLeft(row.title)}
                                onClick={() => moveCardToColumnOffset(row, -1)}
                              >
                                ←
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={copy.cardMoveRight(row.title)}
                                onClick={() => moveCardToColumnOffset(row, 1)}
                              >
                                →
                              </Button>
                            </div>
                            <select
                              aria-label={copy.cardMoveToColumn(row.title)}
                              data-testid={`collection-board-move-${row.documentId}`}
                              value={col.id ?? ''}
                              onChange={(e) => {
                                void updateCellValue(
                                  row.documentId,
                                  activeBoardProperty,
                                  e.target.value || null
                                )
                              }}
                              className="h-8 max-w-[136px] rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                            >
                              <option value="">{copy.unsetOption}</option>
                              {(activeBoardProperty.options ?? []).map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      ) : (
        <ul
          ref={listRef}
          aria-label={collection.title}
          data-testid="collection-list-view"
          className="flex flex-col gap-2"
        >
          {visibleRows.map((row, listIdx) => {
            const statusCell = statusProperty ? row.values[statusProperty.id] : undefined
            const statusOpt =
              statusProperty && typeof statusCell?.value === 'string'
                ? statusProperty.options?.find((o) => o.id === statusCell.value)
                : undefined
            const priorityCell = priorityProperty ? row.values[priorityProperty.id] : undefined
            const priorityOpt =
              priorityProperty && typeof priorityCell?.value === 'string'
                ? priorityProperty.options?.find((o) => o.id === priorityCell.value)
                : undefined
            const assigneeCell = assigneeProperty ? row.values[assigneeProperty.id] : undefined
            const assigneeLabel =
              assigneeCell?.kind === 'assignee' && assigneeCell.value
                ? (memberById.get(assigneeCell.value) ?? assigneeCell.value)
                : null
            const dueDateCell = row.values['due_date']
            const tagsCell = tagProperty ? row.values[tagProperty.id] : undefined
            const selectedTagIds =
              tagsCell && (tagsCell.kind === 'tags' || tagsCell.kind === 'multi_select')
                ? tagsCell.value
                : []

            return (
              <li
                key={row.documentId}
                data-testid={`collection-list-item-${row.documentId}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 hover:bg-c-sunken"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    data-list-idx={listIdx}
                    data-testid={`collection-list-open-${row.documentId}`}
                    aria-label={copy.openPageNamed(row.title)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        const targetIdx = e.key === 'ArrowDown' ? listIdx + 1 : listIdx - 1
                        const nextBtn = listRef.current?.querySelector<HTMLElement>(
                          `[data-list-idx="${targetIdx}"]`
                        )
                        if (nextBtn) {
                          e.preventDefault()
                          nextBtn.focus()
                        }
                      }
                    }}
                    onClick={() => onOpenDocument?.(row.documentId)}
                    className={cx('truncate text-sm font-semibold', LINK_TEXT.standalone)}
                  >
                    {row.title}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {statusOpt ? (
                    <StatusPill state={statusPillStateForOption(statusOpt)}>
                      {statusOpt.label}
                    </StatusPill>
                  ) : null}
                  {priorityOpt ? <Badge variant="accent">{priorityOpt.label}</Badge> : null}
                  {assigneeLabel ? <Badge variant="neutral">{assigneeLabel}</Badge> : null}
                  {dueDateCell?.kind === 'due_date' && dueDateCell.value ? (
                    <span className="rounded-sm bg-c-muted px-2 py-[2px] font-mono text-xs text-c-ink-2">
                      {dueDateCell.value}
                    </span>
                  ) : null}
                  {tagProperty
                    ? selectedTagIds.map((tagId) => {
                        const optIdx =
                          tagProperty.options?.findIndex((o) => o.id === tagId) ?? 0
                        const opt = tagProperty.options?.[optIdx]
                        const tone = optionToneForIndex(optIdx >= 0 ? optIdx : 0, opt)
                        return (
                          <span
                            key={tagId}
                            className={cx(
                              'inline-flex items-center rounded-full px-2 py-[2px] text-xs font-medium',
                              TAG_TONE_CLASS[tone]
                            )}
                          >
                            {opt?.label ?? tagId}
                          </span>
                        )
                      })
                    : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Deterministic Summary / Rollup Footer Strip */}
      <footer
        role="region"
        aria-label={copy.rollups.summaryRegion}
        data-testid="collection-rollup-summary"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs text-c-ink-2"
      >
        <div className="flex flex-wrap items-center gap-3 font-mono">
          <span data-testid="collection-rollup-count" className="font-medium text-c-ink">
            {copy.rollups.count(rollups.filteredCount, rollups.totalCount)}
          </span>
          {rollups.hasStatusProperty ? (
            <span data-testid="collection-rollup-done">
              {copy.rollups.donePercent(
                rollups.donePercent,
                rollups.doneCount,
                rollups.filteredCount
              )}
            </span>
          ) : null}
          {Object.values(rollups.checkboxByProperty).map((cb) => (
            <span key={cb.propertyId} data-testid={`collection-rollup-checkbox-${cb.propertyId}`}>
              {copy.rollups.checkedPercent(cb.propertyName, cb.checkedPercent)}
            </span>
          ))}
          {Object.values(rollups.numericByProperty).map((num) => (
            <span key={num.propertyId} data-testid={`collection-rollup-number-${num.propertyId}`}>
              {copy.rollups.numericSumAvg(
                num.propertyName,
                formatRollupNumber(num.sum),
                formatRollupNumber(num.avg)
              )}
            </span>
          ))}
        </div>

        {onCreateDocument && effectiveRole === 'editor' ? (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={newRowInputId} className="sr-only">
              {copy.newRowLabel}
            </label>
            <input
              id={newRowInputId}
              type="text"
              data-testid="collection-new-entry-input"
              maxLength={120}
              value={newEntryTitle}
              placeholder={copy.newRowTitlePlaceholder}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newEntryTitle.trim().length > 0) {
                  e.preventDefault()
                  void handleCreateEntry()
                }
              }}
              onChange={(e) => setNewEntryTitle(e.target.value)}
              className="h-8 rounded-sm border border-c-border-input bg-c-surface px-2 text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
            <Button
              size="sm"
              variant="secondary"
              data-testid="collection-new-entry-submit"
              disabled={newEntryTitle.trim().length === 0}
              onClick={() => void handleCreateEntry()}
            >
              {copy.addRowAction}
            </Button>
          </div>
        ) : null}
      </footer>
    </section>
  )
}

export default DocsCollectionView
