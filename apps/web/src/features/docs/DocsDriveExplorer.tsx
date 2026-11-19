import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/ui/Badge/Badge'
import { Button } from '@/ui/Button/Button'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { getDocsDriveCopy } from './docsDriveMessages'
import { safeDocumentLink } from './markdownCommands'
import type { DocumentAccessRole, DocumentTreeNode } from './pageTree'

export interface DriveDocumentItem {
  readonly id: string
  readonly parentId: string | null
  readonly title: string
  readonly markdown: string
  readonly role: DocumentAccessRole
  readonly updatedAt: string
}

export interface WorkspaceDriveFileItem {
  readonly id: string
  readonly name: string
  readonly mimeType?: string | undefined
  readonly sizeBytes?: number | undefined
  readonly updatedAt?: string | undefined
  readonly folderId?: string | null | undefined
  readonly href?: string | undefined
}

export type DriveViewMode = 'grid' | 'list'
export type DriveFilterKind = 'all' | 'folders' | 'documents' | 'files'
export type DriveSortField = 'name' | 'updatedAt'

export const FOLDER_MARKDOWN_MARKER = '<!-- kodera:drive-folder -->'

export function isExplicitFolderMarkdown(markdown: string): boolean {
  return markdown.includes(FOLDER_MARKDOWN_MARKER)
}

export function stripFolderMarker(markdown: string): string {
  return markdown
    .replace(/^\s*<!-- kodera:drive-folder -->\s*\r?\n?/, '')
    .replaceAll(FOLDER_MARKDOWN_MARKER, '')
}

export function ensureFolderMarker(markdown: string): string {
  const body = stripFolderMarker(markdown)
  return body.trim().length > 0
    ? `${FOLDER_MARKDOWN_MARKER}\n\n${body}`
    : `${FOLDER_MARKDOWN_MARKER}\n`
}

function hasUnsafeControlChars(value: string): boolean {
  for (let idx = 0; idx < value.length; idx += 1) {
    const code = value.charCodeAt(idx)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function safeDriveFileHref(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || hasUnsafeControlChars(trimmed) || /[\s<>]/.test(trimmed)) return null
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null
    return trimmed
  }
  if (trimmed.toLowerCase().startsWith('mailto:')) {
    try {
      const parsed = new URL(trimmed)
      return parsed.protocol === 'mailto:' && !/["'()]/.test(trimmed) ? parsed.href : null
    } catch {
      return null
    }
  }
  return safeDocumentLink(trimmed)
}

function stripMarkdownPreview(markdown: string): string {
  const cleaned = markdown
    .replaceAll(FOLDER_MARKDOWN_MARKER, '')
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*(\[![A-Z]+\])?\s*/gm, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias || target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~\x60]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 180)
}

function formatDriveDate(iso: string | undefined, locale: string | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat(locale?.startsWith('en') ? 'en-GB' : 'fr-FR', {
      dateStyle: 'medium',
    }).format(parsed)
  } catch {
    return iso.slice(0, 10)
  }
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

export interface DocsDriveExplorerProps {
  readonly documents: readonly DriveDocumentItem[]
  readonly treeNodes: readonly DocumentTreeNode<DriveDocumentItem>[]
  readonly explicitFolderIds: ReadonlySet<string>
  readonly activeFolderId: string | null
  readonly onNavigateFolder: (folderId: string | null) => void
  readonly onOpenDocument: (documentId: string, parentFolderId: string | null) => void
  readonly onCreateFolder: (title: string, parentId: string | null) => Promise<void> | void
  readonly onCreateDocumentInFolder: (parentId: string | null) => Promise<void> | void
  readonly canEdit: boolean
  readonly files?: readonly WorkspaceDriveFileItem[] | undefined
}

export function DocsDriveExplorer({
  documents,
  treeNodes,
  explicitFolderIds,
  activeFolderId,
  onNavigateFolder,
  onOpenDocument,
  onCreateFolder,
  onCreateDocumentInFolder,
  canEdit,
  files = [],
}: DocsDriveExplorerProps) {
  const { i18n } = useTranslation()
  const copy = getDocsDriveCopy(i18n.resolvedLanguage)
  const searchInputId = useId()
  const folderInputId = useId()
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  const [viewMode, setViewMode] = useState<DriveViewMode>('grid')
  const [filterKind, setFilterKind] = useState<DriveFilterKind>('all')
  const [sortField, setSortField] = useState<DriveSortField>('updatedAt')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [searchQuery, setSearchQuery] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')

  const nodeById = useMemo(
    () => new Map(treeNodes.map((node) => [node.doc.id, node])),
    [treeNodes]
  )

  const docById = useMemo(
    () => new Map(documents.map((doc) => [doc.id, doc])),
    [documents]
  )

  const resolvedFolderId =
    activeFolderId !== null && docById.has(activeFolderId) ? activeFolderId : null

  const isFolderDoc = useMemo(() => {
    const folderSet = new Set<string>()
    for (const node of treeNodes) {
      if (
        node.hasChildren ||
        explicitFolderIds.has(node.doc.id) ||
        isExplicitFolderMarkdown(node.doc.markdown)
      ) {
        folderSet.add(node.doc.id)
      }
    }
    return (docId: string) => folderSet.has(docId)
  }, [explicitFolderIds, treeNodes])

  const breadcrumbs = useMemo(() => {
    const trail: { readonly id: string | null; readonly title: string }[] = [
      { id: null, title: copy.driveRoot },
    ]
    if (resolvedFolderId === null) return trail
    const chain: { readonly id: string; readonly title: string }[] = []
    const visited = new Set<string>()
    let cursor: string | null = resolvedFolderId
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor)
      const doc = docById.get(cursor)
      if (!doc) break
      chain.unshift({ id: doc.id, title: doc.title })
      cursor = doc.parentId && docById.has(doc.parentId) ? doc.parentId : null
    }
    return [...trail, ...chain]
  }, [copy.driveRoot, docById, resolvedFolderId])

  const locationLabelOf = (parentId: string | null | undefined): string => {
    if (!parentId) return copy.locationRoot
    const parentNode = nodeById.get(parentId)
    if (!parentNode) return copy.locationRoot
    return parentNode.pathTitles.join(' / ')
  }

  const normalizedNeedle = searchQuery
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim()

  const { visibleFolders, visibleDocs, visibleFiles } = useMemo(() => {
    const matchesNeedle = (value: string): boolean => {
      if (!normalizedNeedle) return true
      return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase()
        .includes(normalizedNeedle)
    }

    const compareItems = <T extends { readonly title: string; readonly updatedAt: string }>(
      a: T,
      b: T
    ): number => {
      const factor = sortDirection === 'asc' ? 1 : -1
      if (sortField === 'name') {
        return factor * a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      }
      const timeCmp = a.updatedAt.localeCompare(b.updatedAt)
      if (timeCmp !== 0) return factor * timeCmp
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }

    const scopedNodes = treeNodes.filter((node) => {
      if (normalizedNeedle) {
        return matchesNeedle(node.doc.title) || matchesNeedle(node.doc.markdown)
      }
      const effectiveParent =
        node.doc.parentId && docById.has(node.doc.parentId) && node.doc.parentId !== node.doc.id
          ? node.doc.parentId
          : null
      return effectiveParent === resolvedFolderId
    })

    const folders =
      filterKind === 'documents' || filterKind === 'files'
        ? []
        : scopedNodes
            .filter((node) => isFolderDoc(node.doc.id))
            .map((node) => ({
              node,
              title: node.doc.title,
              updatedAt: node.doc.updatedAt,
            }))
            .sort(compareItems)
            .map((entry) => entry.node)

    const docs =
      filterKind === 'folders' || filterKind === 'files'
        ? []
        : scopedNodes
            .filter((node) => !isFolderDoc(node.doc.id))
            .map((node) => ({
              node,
              title: node.doc.title,
              updatedAt: node.doc.updatedAt,
            }))
            .sort(compareItems)
            .map((entry) => entry.node)

    const matchedFiles =
      filterKind === 'folders' || filterKind === 'documents'
        ? []
        : files
            .filter((file) => {
              if (normalizedNeedle) return matchesNeedle(file.name)
              return (file.folderId ?? null) === resolvedFolderId
            })
            .sort((a, b) =>
              compareItems(
                { title: a.name, updatedAt: a.updatedAt ?? '' },
                { title: b.name, updatedAt: b.updatedAt ?? '' }
              )
            )

    return { visibleFolders: folders, visibleDocs: docs, visibleFiles: matchedFiles }
  }, [
    docById,
    files,
    filterKind,
    isFolderDoc,
    normalizedNeedle,
    resolvedFolderId,
    sortDirection,
    sortField,
    treeNodes,
  ])

  const submitNewFolder = async () => {
    const trimmed = folderDraft.trim()
    if (!trimmed) return
    setFolderDraft('')
    setCreatingFolder(false)
    await onCreateFolder(trimmed, resolvedFolderId)
  }

  const toggleSort = (field: DriveSortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'name' ? 'asc' : 'desc')
    }
  }

  const totalVisible = visibleFolders.length + visibleDocs.length + visibleFiles.length

  return (
    <section
      aria-label={copy.modeDrive}
      data-testid="docs-drive-explorer"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      {/* Top Drive Breadcrumb + Folder/Document Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-c-border-soft bg-c-sunken px-4 py-3">
        <nav
          aria-label={copy.modeDrive}
          data-testid="drive-breadcrumbs"
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
        >
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1
            return (
              <span key={crumb.id ?? '__root__'} className="inline-flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <span aria-hidden="true" className="px-1 text-xs text-c-ink-3">
                    ›
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={
                    crumb.id === null ? 'drive-crumb-root' : `drive-crumb-${crumb.id}`
                  }
                  aria-current={isLast ? 'location' : undefined}
                  onClick={() => onNavigateFolder(crumb.id)}
                  className={cx(
                    'inline-flex min-h-8 max-w-[220px] items-center gap-2 truncate rounded-md px-2 py-1 text-xs focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    isLast
                      ? 'bg-c-surface font-semibold text-c-ink shadow-card'
                      : 'font-medium text-c-ink-2 hover:bg-c-surface hover:text-c-ink'
                  )}
                >
                  {crumb.id === null ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className="h-4 w-4 shrink-0 text-c-accent-ink"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
                      />
                    </svg>
                  ) : null}
                  <span className="truncate">{crumb.title}</span>
                </button>
              </span>
            )
          })}
        </nav>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid="drive-new-folder-btn"
              icon={
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Zm6 2.5v4m-2-2h4"
                  />
                </svg>
              }
              onClick={() => {
                setCreatingFolder(true)
                requestAnimationFrame(() => folderInputRef.current?.focus())
              }}
            >
              {copy.newFolder}
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="drive-new-doc-btn"
              icon={
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v10M3 8h10" />
                </svg>
              }
              onClick={() => void onCreateDocumentInFolder(resolvedFolderId)}
            >
              {copy.newDocHere}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Inline New Folder Creation Bar */}
      {creatingFolder && canEdit ? (
        <form
          data-testid="drive-new-folder-form"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-c-accent-ink bg-c-accent-soft p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submitNewFolder()
          }}
        >
          <label htmlFor={folderInputId} className="sr-only">
            {copy.newFolderLabel}
          </label>
          <input
            ref={folderInputRef}
            id={folderInputId}
            type="text"
            data-testid="drive-new-folder-input"
            maxLength={120}
            value={folderDraft}
            placeholder={copy.newFolderPlaceholder}
            onChange={(event) => setFolderDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setCreatingFolder(false)
                setFolderDraft('')
              }
            }}
            className="h-8 min-w-[220px] flex-1 rounded-md border border-c-border-input bg-c-surface px-3 text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            data-testid="drive-new-folder-submit"
            disabled={folderDraft.trim().length === 0}
          >
            {copy.createFolderConfirm}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setCreatingFolder(false)
              setFolderDraft('')
            }}
          >
            {copy.cancelAction}
          </Button>
        </form>
      ) : null}

      {/* Instant Search, Filter Pills & Grid/List View Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[240px] flex-1">
          <label htmlFor={searchInputId} className="sr-only">
            {copy.searchLabel}
          </label>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-c-ink-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path strokeLinecap="round" d="m10.5 10.5 3 3" />
          </svg>
          <input
            id={searchInputId}
            type="search"
            data-testid="drive-search-input"
            value={searchQuery}
            placeholder={copy.searchPlaceholder}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchQuery.length > 0) {
                event.preventDefault()
                setSearchQuery('')
              }
            }}
            className="h-10 w-full rounded-md border border-c-border-input bg-c-surface pr-3 pl-10 text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={copy.filterGroupLabel}
            className="flex flex-wrap items-center gap-1"
          >
            {(
              [
                { id: 'all', label: copy.filterAll },
                { id: 'folders', label: copy.filterFolders },
                { id: 'documents', label: copy.filterDocuments },
                ...(files.length > 0 ? [{ id: 'files' as const, label: copy.filterFiles }] : []),
              ] as const
            ).map((pill) => {
              const active = filterKind === pill.id
              return (
                <button
                  key={pill.id}
                  type="button"
                  data-testid={`drive-filter-${pill.id}`}
                  aria-pressed={active}
                  onClick={() => setFilterKind(pill.id)}
                  className={cx(
                    'inline-flex min-h-8 items-center rounded-full border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    active
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                      : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                  )}
                >
                  {pill.label}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-1 rounded-md border border-c-border-soft bg-c-sunken p-1">
            <button
              type="button"
              data-testid="drive-sort-name"
              aria-label={copy.sortByName}
              title={copy.sortByName}
              aria-pressed={sortField === 'name'}
              onClick={() => toggleSort('name')}
              className={cx(
                'inline-flex h-8 items-center gap-1 rounded-sm px-2 text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET,
                sortField === 'name'
                  ? 'bg-c-surface font-semibold text-c-accent-ink shadow-card'
                  : 'text-c-ink-2 hover:text-c-ink'
              )}
            >
              <span>A–Z</span>
              {sortField === 'name' ? (
                <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>
              ) : null}
            </button>
            <button
              type="button"
              data-testid="drive-sort-updated"
              aria-label={copy.sortByUpdated}
              title={copy.sortByUpdated}
              aria-pressed={sortField === 'updatedAt'}
              onClick={() => toggleSort('updatedAt')}
              className={cx(
                'inline-flex h-8 items-center gap-1 rounded-sm px-2 text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET,
                sortField === 'updatedAt'
                  ? 'bg-c-surface font-semibold text-c-accent-ink shadow-card'
                  : 'text-c-ink-2 hover:text-c-ink'
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="8" cy="8" r="5.5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v3.2l2.2 1.3" />
              </svg>
              {sortField === 'updatedAt' ? (
                <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>
              ) : null}
            </button>
          </div>

          <div
            role="group"
            aria-label={copy.modeDrive}
            className="flex items-center gap-1 rounded-md border border-c-border-soft bg-c-sunken p-1"
          >
            <button
              type="button"
              data-testid="drive-view-grid"
              aria-label={copy.viewGrid}
              title={copy.viewGrid}
              aria-pressed={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              className={cx(
                'inline-flex h-8 w-8 items-center justify-center rounded-sm focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET,
                viewMode === 'grid'
                  ? 'bg-c-surface text-c-accent-ink shadow-card'
                  : 'text-c-ink-2 hover:text-c-ink'
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="9" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="5" rx="1" />
                <rect x="9" y="9" width="5" height="5" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              data-testid="drive-view-list"
              aria-label={copy.viewList}
              title={copy.viewList}
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              className={cx(
                'inline-flex h-8 w-8 items-center justify-center rounded-sm focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET,
                viewMode === 'list'
                  ? 'bg-c-surface text-c-accent-ink shadow-card'
                  : 'text-c-ink-2 hover:text-c-ink'
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path strokeLinecap="round" d="M3 4h10M3 8h10M3 12h10" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Empty States */}
      {totalVisible === 0 ? (
        <div
          data-testid="drive-empty-state"
          className="flex flex-col items-center justify-center gap-2 rounded-xl border border-c-border-soft bg-c-page p-8 text-center"
        >
          <p className="text-sm font-medium text-c-ink-2">
            {normalizedNeedle || filterKind !== 'all'
              ? copy.emptySearch
              : documents.length === 0
                ? copy.emptyDrive
                : copy.emptyFolder}
          </p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="flex flex-col gap-6" data-testid="drive-grid-container">
          {/* Folders Grid */}
          {visibleFolders.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-c-ink-2">{copy.foldersHeading}</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleFolders.map((node) => (
                  <div
                    key={node.doc.id}
                    data-testid={`drive-folder-card-${node.doc.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-c-border bg-c-surface p-3 shadow-card transition-colors hover:bg-c-muted"
                  >
                    <button
                      type="button"
                      data-testid={`drive-open-folder-${node.doc.id}`}
                      aria-label={copy.openFolderNamed(node.doc.title)}
                      onClick={() => onNavigateFolder(node.doc.id)}
                      className={cx(
                        'flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-c-accent-soft text-c-accent-ink">
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 16 16"
                          className="h-4 w-4"
                          fill="currentColor"
                        >
                          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3.1a1.5 1.5 0 0 1 1.06.44l.9.9H12.5A1.5 1.5 0 0 1 14 5.84v5.66A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
                        </svg>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-semibold text-c-ink">
                          {node.doc.title}
                        </span>
                        <span className="truncate text-xs text-c-ink-3">
                          {copy.folderCount(node.childCount)}
                          {normalizedNeedle ? ` · ${locationLabelOf(node.doc.parentId)}` : ''}
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      data-testid={`drive-edit-folder-note-${node.doc.id}`}
                      aria-label={copy.openFolderIndexNamed(node.doc.title)}
                      title={copy.openFolderIndexNamed(node.doc.title)}
                      onClick={() => onOpenDocument(node.doc.id, node.doc.parentId)}
                      className={cx(
                        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-c-ink-3 hover:bg-c-surface hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 .8.8-3 7.7-7.3Z"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Documents Preview Grid */}
          {visibleDocs.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-c-ink-2">{copy.documentsHeading}</h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleDocs.map((node) => {
                  const snippet = stripMarkdownPreview(node.doc.markdown)
                  return (
                    <button
                      key={node.doc.id}
                      type="button"
                      data-testid={`drive-doc-card-${node.doc.id}`}
                      aria-label={copy.openDocumentNamed(node.doc.title)}
                      onClick={() => onOpenDocument(node.doc.id, node.doc.parentId)}
                      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-c-border bg-c-surface text-left shadow-card transition-colors hover:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                    >
                      <div className="flex h-[108px] w-full flex-col gap-1 overflow-hidden border-b border-c-border-soft bg-c-page p-3">
                        <div className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-md border border-c-border-soft bg-c-surface p-2">
                          <span className="truncate text-xs font-semibold text-c-ink">
                            {node.doc.title}
                          </span>
                          <p className="line-clamp-3 text-xs leading-relaxed text-c-ink-3">
                            {snippet || '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 p-3">
                        <div className="flex items-center gap-2">
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            className="h-4 w-4 shrink-0 text-c-accent-ink"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
                            />
                            <path strokeLinecap="round" d="M9 2.5V6h3.5M5.5 9h5M5.5 11.5h3.5" />
                          </svg>
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-c-ink">
                            {node.doc.title}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-c-ink-3">
                          <span className="truncate">{locationLabelOf(node.doc.parentId)}</span>
                          <span className="shrink-0 font-mono">
                            {formatDriveDate(node.doc.updatedAt, i18n.resolvedLanguage)}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* Optional Workspace Files Grid */}
          {visibleFiles.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-c-ink-2">{copy.filesHeading}</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleFiles.map((file) => {
                  const safeHref = safeDriveFileHref(file.href)
                  return (
                    <div
                      key={file.id}
                      data-testid={`drive-file-card-${file.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-c-border bg-c-surface p-3 shadow-card"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm font-semibold text-c-ink">
                          {file.name}
                        </span>
                        <span className="font-mono text-xs text-c-ink-3">
                          {[
                            formatFileSize(file.sizeBytes),
                            formatDriveDate(file.updatedAt, i18n.resolvedLanguage),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      {safeHref !== null &&
                      (safeHref.startsWith('https://') ||
                        safeHref.startsWith('http://') ||
                        safeHref.startsWith('mailto:') ||
                        (safeHref.startsWith('/') && !safeHref.startsWith('//'))) ? (
                        <a
                          href={safeHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={file.name}
                          data-testid={`drive-file-open-${file.id}`}
                          className={cx(
                            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-c-border bg-c-sunken text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                            TOUCH_TARGET
                          )}
                        >
                          ↗
                        </a>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        /* List View */
        <div
          data-testid="drive-list-container"
          className="overflow-x-auto rounded-lg border border-c-border bg-c-surface"
        >
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-c-border-soft bg-c-sunken text-c-ink-2">
                <th
                  scope="col"
                  aria-sort={
                    sortField === 'name'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className="px-4 py-3 font-semibold"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort('name')}
                    className="inline-flex items-center gap-1 font-semibold text-c-ink hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  >
                    <span>{copy.columnName}</span>
                    {sortField === 'name' ? (
                      <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    ) : null}
                  </button>
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {copy.columnLocation}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  {copy.columnRole}
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortField === 'updatedAt'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className="px-4 py-3 font-semibold"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort('updatedAt')}
                    className="inline-flex items-center gap-1 font-semibold text-c-ink hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  >
                    <span>{copy.columnUpdated}</span>
                    {sortField === 'updatedAt' ? (
                      <span aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    ) : null}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleFolders.map((node) => (
                <tr
                  key={`folder-${node.doc.id}`}
                  data-testid={`drive-list-folder-${node.doc.id}`}
                  className="border-b border-c-hairline hover:bg-c-sunken"
                >
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => onNavigateFolder(node.doc.id)}
                      aria-label={copy.openFolderNamed(node.doc.title)}
                      className={cx(
                        'inline-flex min-h-8 items-center gap-2 rounded-sm font-semibold text-c-ink hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="h-4 w-4 shrink-0 text-c-accent-ink"
                        fill="currentColor"
                      >
                        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3.1a1.5 1.5 0 0 1 1.06.44l.9.9H12.5A1.5 1.5 0 0 1 14 5.84v5.66A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
                      </svg>
                      <span>{node.doc.title}</span>
                      <span className="font-regular text-c-ink-3">
                        ({copy.folderCount(node.childCount)})
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-c-ink-2">{locationLabelOf(node.doc.parentId)}</td>
                  <td className="px-4 py-2">
                    <Badge variant="neutral">
                      {node.doc.role === 'viewer' ? copy.roleViewer : copy.roleEditor}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 font-mono text-c-ink-2">
                    {formatDriveDate(node.doc.updatedAt, i18n.resolvedLanguage)}
                  </td>
                </tr>
              ))}
              {visibleDocs.map((node) => (
                <tr
                  key={`doc-${node.doc.id}`}
                  data-testid={`drive-list-doc-${node.doc.id}`}
                  className="border-b border-c-hairline hover:bg-c-sunken"
                >
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      data-testid={`drive-list-open-${node.doc.id}`}
                      onClick={() => onOpenDocument(node.doc.id, node.doc.parentId)}
                      aria-label={copy.openDocumentNamed(node.doc.title)}
                      className={cx(
                        'inline-flex min-h-8 items-center gap-2 rounded-sm font-semibold text-c-ink hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET
                      )}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="h-4 w-4 shrink-0 text-c-accent-ink"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
                        />
                        <path strokeLinecap="round" d="M9 2.5V6h3.5" />
                      </svg>
                      <span>{node.doc.title}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2 text-c-ink-2">{locationLabelOf(node.doc.parentId)}</td>
                  <td className="px-4 py-2">
                    <Badge variant="neutral">
                      {node.doc.role === 'viewer' ? copy.roleViewer : copy.roleEditor}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 font-mono text-c-ink-2">
                    {formatDriveDate(node.doc.updatedAt, i18n.resolvedLanguage)}
                  </td>
                </tr>
              ))}
              {visibleFiles.map((file) => {
                const safeHref = safeDriveFileHref(file.href)
                return (
                  <tr
                    key={`file-${file.id}`}
                    data-testid={`drive-list-file-${file.id}`}
                    className="border-b border-c-hairline hover:bg-c-sunken"
                  >
                    <td className="px-4 py-2 font-semibold text-c-ink">
                      {safeHref !== null &&
                      (safeHref.startsWith('https://') ||
                        safeHref.startsWith('http://') ||
                        safeHref.startsWith('mailto:') ||
                        (safeHref.startsWith('/') && !safeHref.startsWith('//'))) ? (
                        <a
                          href={safeHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={file.name}
                          data-testid={`drive-list-file-open-${file.id}`}
                          className={cx(
                            'inline-flex min-h-8 items-center gap-2 rounded-sm font-semibold text-c-ink hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden',
                            TOUCH_TARGET
                          )}
                        >
                          <span>{file.name}</span>
                          <span aria-hidden="true" className="text-c-ink-3">
                            ↗
                          </span>
                        </a>
                      ) : (
                        file.name
                      )}
                    </td>
                    <td className="px-4 py-2 text-c-ink-2">{locationLabelOf(file.folderId)}</td>
                    <td className="px-4 py-2">
                      <Badge variant="neutral">{copy.filterFiles}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-c-ink-2">
                      {formatDriveDate(file.updatedAt, i18n.resolvedLanguage)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
