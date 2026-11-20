// « Fichiers »: everything the workspace holds that is not a message, in one place. Until this
// existed the dock's Fichiers entry opened a short list in a dialog, and that list read
// `message.attachment` — the name a native Matrix message carries — so not one file sent from
// Kodera, which carries `io.kodera.attachments`, ever appeared in it.
//
// Nothing is fetched to draw the list: the name, the type and the size come from the messages
// already synced. Opening a file asks Core for a fresh, short-lived address and follows it in a
// local raster preview; other formats retain their metadata and explicit download action.

import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { IconButton } from '../../ui/IconButton'
import { formatBytes } from '../../ui/formatBytes'
import { FileLightboxModal } from './FileLightboxModal'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { FilesUpload } from './FilesUpload'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { MessageKey } from '../../i18n'
import type { EspaceSnapshot } from './matrix/store'
import { safeDisplayName, type EspaceStoreLike } from './liveViewModel'
import {
  filterWorkspaceFiles,
  workspaceFilesBytes,
  workspaceFilesOf,
  WORKSPACE_FILE_FILTERS,
  type WorkspaceFileEntry,
  type WorkspaceFileFilter,
} from './workspaceFiles'

const FILTER_LABEL: Record<WorkspaceFileFilter, MessageKey> = {
  all: 'console.workspace.files.filter-all',
  image: 'console.workspace.files.filter-images',
  document: 'console.workspace.files.filter-documents',
  page: 'console.workspace.files.filter-pages',
  media: 'console.workspace.files.filter-media',
  other: 'console.workspace.files.filter-other',
}

export interface WorkspaceFilesPanelProps {
  readonly activeChannelId?: string | undefined
  readonly store: EspaceStoreLike
  readonly snapshot: EspaceSnapshot
  readonly searchEntries: readonly ChannelSearchEntry[]
  readonly documents: readonly ChannelDoc[]
  /** Opens a document in the documents canvas; absent where this view cannot open one. */
  readonly onOpenDocument?: ((doc: ChannelDoc) => void) | undefined
  /** Opens the channel a file was sent in. */
  readonly onOpenDirect?: ((roomId: string) => void) | undefined
  readonly onOpenChannel: (channelId: string) => void
}

export function WorkspaceFilesPanel({
  activeChannelId,
  store,
  snapshot,
  searchEntries,
  documents,
  onOpenDocument,
  onOpenChannel,
  onOpenDirect,
}: WorkspaceFilesPanelProps) {
  const { t, i18n } = useTranslation()
  const headingId = useId()
  const searchInput = useRef<HTMLInputElement>(null)
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [filter, setFilter] = useState<WorkspaceFileFilter>('all')
  const [term, setTerm] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const lightboxReturnFocus = useRef<HTMLButtonElement | null>(null)
  const entries = useMemo(
    () => workspaceFilesOf(store, snapshot, searchEntries, documents),
    [store, snapshot, searchEntries, documents]
  )
  const shown = useMemo(() => filterWorkspaceFiles(entries, filter, term), [entries, filter, term])
  const held = workspaceFilesBytes(entries)
  const unnamed = t('console.workspace.members.unnamed')

  /**
   * The sender's name as the file's own room holds it — not as the first room that happens to
   * hold one, which another room's member could have set. A display name is whatever someone set
   * for themselves, so its control and direction-override characters are stripped (`cleanText`),
   * and the id it belongs to is kept on the row's title.
   */
  const senderOf = (entry: WorkspaceFileEntry) => {
    if (entry.senderId === undefined) return ''
    const resolved = snapshot.channels.get(entry.channel.id)
    const roomId =
      entry.directRoomId ?? (resolved?.state === 'resolved' ? resolved.roomId : undefined)
    const held =
      roomId !== undefined
        ? snapshot.rooms.find((room) => room.roomId === roomId)?.names?.[entry.senderId]
        : undefined
    return safeDisplayName(held, entry.senderId, unnamed)
  }

  function openEntry(entry: WorkspaceFileEntry) {
    if (entry.document !== undefined) {
      onOpenDocument?.(entry.document)
      return
    }
    if (entry.directRoomId !== undefined) onOpenDirect?.(entry.directRoomId)
    else onOpenChannel(entry.channel.id)
  }

  const card = (entry: WorkspaceFileEntry) => (
    <li key={entry.id} className={layout === 'grid' ? 'min-w-0' : ''}>
      <div
        className={cx(
          'flex h-full min-w-0 gap-3 rounded-lg border border-c-border bg-c-surface p-3',
          'hover:shadow-card hover:shadow-c-shadow-1 motion-safe:transition-shadow motion-safe:duration-150',
          layout === 'grid' ? 'flex-col' : 'flex-row items-center'
        )}
      >
        <span aria-hidden="true" className="shrink-0 text-c-ink-3">
          <KoderaIcon name={entry.document === undefined ? 'files' : 'docs'} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={(event) => {
              if (entry.document) openEntry(entry)
              else {
                lightboxReturnFocus.current = event.currentTarget
                setSelectedId(entry.id)
              }
            }}
            className="truncate rounded-sm text-left text-sm font-medium text-c-ink hover:underline focus-visible:ring focus-visible:outline-hidden"
          >
            {entry.name}
          </button>
          <span className="truncate text-xs text-c-ink-3" title={entry.senderId ?? undefined}>
            {[
              entry.channel.id === ''
                ? entry.channel.label
                : `${entry.directRoomId === undefined ? '#' : ''}${entry.channel.label}`,
              senderOf(entry),
              entry.sizeBytes === undefined
                ? ''
                : formatBytes(entry.sizeBytes, i18n.resolvedLanguage),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
    </li>
  )

  return (
    <FilesUpload
      store={store}
      snapshot={snapshot}
      channels={searchEntries}
      activeChannelId={activeChannelId}
    >
      {({ trigger, controls }) => (
        <section
          aria-label={t('console.workspace.files.title')}
          className="flex min-h-0 flex-1 flex-col gap-4 narrow:overflow-y-auto"
        >
          <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-c-border-soft narrow:h-auto narrow:flex-wrap narrow:py-2">
            <KoderaIcon name="files" />
            <h1 id={headingId} className="shrink-0 text-md font-semibold text-c-ink">
              {t('console.workspace.canvas.mode-files')}
            </h1>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-c-muted px-3 py-2 text-c-ink-3">
              <KoderaIcon name="search" />
              <input
                ref={searchInput}
                type="text"
                aria-label={t('console.workspace.files.field-search')}
                placeholder={t('console.workspace.files.field-search')}
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-c-ink outline-hidden placeholder:text-c-placeholder"
              />
              {term !== '' ? (
                <IconButton
                  icon="close"
                  label={t('console.people.list.action-clear-search')}
                  onClick={() => {
                    setTerm('')
                    searchInput.current?.focus()
                  }}
                />
              ) : null}
            </div>
            <div
              role="group"
              aria-label={t('console.workspace.files.label-layout')}
              className="flex gap-1"
            >
              {(['grid', 'list'] as const).map((value) => (
                <IconButton
                  key={value}
                  icon={value}
                  label={t(
                    value === 'grid'
                      ? 'console.workspace.files.layout-grid'
                      : 'console.workspace.files.layout-list'
                  )}
                  aria-pressed={layout === value}
                  onClick={() => setLayout(value)}
                  className={layout === value ? 'bg-c-accent-soft text-c-accent-ink' : ''}
                />
              ))}
            </div>
            {trigger}
          </header>
          <p className="text-xs text-c-ink-3">
            {t('console.workspace.files.held', {
              count: entries.length,
              size: formatBytes(held, i18n.resolvedLanguage),
            })}
          </p>

          <div
            role="group"
            aria-label={t('console.workspace.files.label-filter')}
            className="flex flex-wrap gap-2"
          >
            {WORKSPACE_FILE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  TOUCH_TARGET,
                  'focus-visible:ring focus-visible:outline-hidden',
                  'motion-safe:transition-colors motion-safe:duration-150',
                  filter === value
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border-soft bg-c-surface text-c-ink-2 hover:bg-c-muted'
                )}
              >
                {t(FILTER_LABEL[value])}
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title={t(
                entries.length === 0
                  ? 'console.workspace.files.empty-title'
                  : 'console.workspace.files.empty-search-title'
              )}
              body={t(
                entries.length === 0
                  ? 'console.workspace.files.empty-body'
                  : 'console.workspace.files.empty-search-body'
              )}
            />
          ) : (
            <ul
              aria-label={t('console.workspace.files.label-list')}
              className={cx(
                'min-h-0 flex-1 overflow-y-auto narrow:flex-none narrow:overflow-visible',
                layout === 'grid'
                  ? 'grid auto-rows-min grid-cols-3 content-start gap-3 md:grid-cols-2 lg:grid-cols-3 narrow:grid-cols-1'
                  : 'flex flex-col gap-2'
              )}
            >
              {shown.map(card)}
            </ul>
          )}
          {controls}
          {selectedId === null ? null : (
            <FileLightboxModal
              returnFocusTo={lightboxReturnFocus}
              entries={shown.filter((entry) => !entry.document)}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onClose={() => setSelectedId(null)}
              onOpenChannel={(entry) => {
                setSelectedId(null)
                openEntry(entry)
              }}
            />
          )}
        </section>
      )}
    </FilesUpload>
  )
}
