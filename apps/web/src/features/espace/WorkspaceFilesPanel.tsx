// « Fichiers »: everything the workspace holds that is not a message, in one place. Until this
// existed the dock's Fichiers entry opened a short list in a dialog, and that list read
// `message.attachment` — the name a native Matrix message carries — so not one file sent from
// Kodera, which carries `io.kodera.attachments`, ever appeared in it.
//
// Nothing is fetched to draw the list: the name, the type and the size come from the messages
// already synced. Opening a file asks Core for a fresh, short-lived address and follows it in a
// local raster preview or a new tab for other formats (`MessageAttachments.tsx`).

import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../ui/EmptyState/EmptyState'
import { StudioGlyph } from '../../ui/icons/StudioGlyph'
import { TextField } from '../../ui/TextField/TextField'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { FilesUpload } from './FilesUpload'
import { MessageAttachments } from '../messaging/attachments/MessageAttachments'
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
  other: 'console.workspace.files.filter-other',
}

export interface WorkspaceFilesPanelProps {
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

function sizeOf(bytes: number, language: string | undefined): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}

export function WorkspaceFilesPanel({
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
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [filter, setFilter] = useState<WorkspaceFileFilter>('all')
  const [term, setTerm] = useState('')
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
    const held =
      resolved?.state === 'resolved'
        ? snapshot.rooms.find((room) => room.roomId === resolved.roomId)?.names?.[entry.senderId]
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
          <StudioGlyph name={entry.document === undefined ? 'files' : 'docs'} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {entry.ref === undefined ? (
            <button
              type="button"
              onClick={() => openEntry(entry)}
              className={cx(
                'truncate rounded-sm text-left text-sm font-medium text-c-ink',
                'hover:underline focus-visible:ring focus-visible:outline-hidden'
              )}
            >
              {entry.name}
            </button>
          ) : (
            <MessageAttachments refs={[entry.ref]} />
          )}
          <span className="truncate text-xs text-c-ink-3" title={entry.senderId ?? undefined}>
            {[
              `${entry.directRoomId === undefined ? '#' : ''}${entry.channel.label}`,
              senderOf(entry),
              entry.sizeBytes === undefined || entry.ref !== undefined
                ? ''
                : sizeOf(entry.sizeBytes, i18n.resolvedLanguage),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
    </li>
  )

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold text-c-ink">
            {t('console.workspace.files.title')}
          </h2>
          <p className="text-sm text-c-ink-3">
            {t('console.workspace.files.held', {
              count: String(entries.length),
              size: sizeOf(held, i18n.resolvedLanguage),
            })}
          </p>
        </div>
        <div
          role="group"
          aria-label={t('console.workspace.files.label-layout')}
          className="flex gap-2"
        >
          {(['grid', 'list'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
              className={cx(
                'rounded-md border px-3 py-1 text-xs font-medium',
                TOUCH_TARGET,
                'focus-visible:ring focus-visible:outline-hidden',
                'motion-safe:transition-colors motion-safe:duration-150',
                layout === value
                  ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                  : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
              )}
            >
              {t(
                value === 'grid'
                  ? 'console.workspace.files.layout-grid'
                  : 'console.workspace.files.layout-list'
              )}
            </button>
          ))}
        </div>
      </div>

      <TextField
        label={t('console.workspace.files.field-search')}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />

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
            'min-h-0 flex-1 overflow-y-auto',
            layout === 'grid'
              ? 'grid auto-rows-min grid-cols-3 content-start gap-3 md:grid-cols-2 lg:grid-cols-3 narrow:grid-cols-1'
              : 'flex flex-col gap-2'
          )}
        >
          {shown.map(card)}
        </ul>
      )}
      <FilesUpload store={store} snapshot={snapshot} channels={searchEntries} />
    </section>
  )
}
