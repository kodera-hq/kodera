import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { CanvasMode, EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'
import { workspaceFilesOf } from '../espace/workspaceFiles'
import type { ChannelSearchEntry, ChannelSearchProps } from '../workspace/ChannelSearch'
import { useRegisterPalette } from './PaletteContext'
import { paletteCopy } from './messages'
import {
  buildOmniboxIndex,
  foldOmniboxText,
  isRoomSearchPermitted,
  queryOmnibox,
  type ConfidentialChannelFlags,
  type OmniboxCollectionDescriptor,
  type OmniboxRoomSource,
} from './omniboxIndex'

/** The palette lists the newest files only: a long history never slows the search. */
const PALETTE_FILE_LIMIT = 200
const noopSubscribe = () => () => undefined
const noopSnapshot = () => null

export interface WorkspaceOmniboxOptions {
  readonly store: EspaceStoreLike
  readonly snapshot?: EspaceSnapshot | undefined
  readonly entries: ChannelSearchProps['entries']
  readonly channelsById?: ReadonlyMap<string, ConfidentialChannelFlags> | undefined
  readonly documents: readonly ChannelDoc[]
  readonly collections?: readonly OmniboxCollectionDescriptor[] | undefined
  readonly openDocument?: ((doc: ChannelDoc) => unknown) | undefined
  readonly onOpenCollection?: ((id: string) => HTMLElement | null | void) | undefined
  readonly onJumpToMessage?:
    | ((
        roomId: string,
        targetId: string,
        isDirect: boolean,
        eventId: string
      ) => HTMLElement | null | void)
    | undefined
  readonly simulation: boolean
}

function buildLiveOmniboxIndex(options: WorkspaceOmniboxOptions) {
  const {
    store,
    snapshot: propSnapshot,
    entries,
    channelsById,
    documents,
    collections,
    openDocument,
    onOpenCollection,
    simulation,
  } = options
  const liveSnapshot = typeof store.getSnapshot === 'function' ? store.getSnapshot() : propSnapshot
  const effectiveSnapshot = liveSnapshot ?? propSnapshot
  const rooms: OmniboxRoomSource[] = []
  if (typeof store.getTimeline === 'function') {
    if (effectiveSnapshot !== undefined) {
      for (const entry of entries) {
        if (entry.kind !== 'text') continue
        const resolved = effectiveSnapshot.channels.get(entry.id)
        if (resolved?.state !== 'resolved') continue
        rooms.push({
          roomId: resolved.roomId,
          targetId: entry.id,
          isDirect: false,
          label: `#${entry.label}`,
          channel: channelsById?.get(entry.id),
          timeline: store.getTimeline(resolved.roomId),
        })
      }
    }
    if (!simulation && store.getDirects !== undefined) {
      for (const dm of store.getDirects()) {
        rooms.push({
          roomId: dm.roomId,
          targetId: dm.roomId,
          isDirect: true,
          label: `@${dm.name}`,
          timeline: store.getTimeline(dm.roomId),
        })
      }
    }
  }
  const effectiveCollections: readonly OmniboxCollectionDescriptor[] =
    collections ??
    (openDocument !== undefined || onOpenCollection !== undefined
      ? documents.map((doc) => ({
          id: doc.id,
          title: doc.title,
          content: doc.content,
          ...(doc.role ? { propertiesText: doc.role } : {}),
          cacheKey: doc,
        }))
      : [])
  return buildOmniboxIndex({ store, rooms, collections: effectiveCollections })
}

export function useWorkspaceOmniboxDynamicEntries(
  options: WorkspaceOmniboxOptions
): (query: string) => readonly ChannelSearchEntry[] {
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  const storeEpoch = useSyncExternalStore(
    typeof options.store.subscribe === 'function' ? options.store.subscribe : noopSubscribe,
    typeof options.store.getSnapshot === 'function' ? options.store.getSnapshot : noopSnapshot,
    noopSnapshot
  )
  const liveOptionsRef = useRef(options)
  useLayoutEffect(() => {
    liveOptionsRef.current = options
  })

  // Pre-warm WeakMap caches on render while also creating a new callback identity when storeEpoch changes
  // so open dialogs subscribed to PaletteRegistry re-evaluate immediately on sync events.
  const warmIndex = useMemo(
    () => buildLiveOmniboxIndex(options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      options.store,
      options.snapshot,
      storeEpoch,
      options.entries,
      options.channelsById,
      options.documents,
      options.collections,
      options.openDocument,
      options.onOpenCollection,
      options.simulation,
    ]
  )

  return useCallback(
    (query: string): readonly ChannelSearchEntry[] => {
      void warmIndex
      const current = liveOptionsRef.current
      const freshIndex = buildLiveOmniboxIndex(current)
      const { collections: colHits, messages: msgHits } = queryOmnibox(freshIndex, query)
      if (colHits.length === 0 && msgHits.length === 0) return []
      const terms = foldOmniboxText(query).split(' ')
      const results: ChannelSearchEntry[] = []

      for (const hit of colHits) {
        results.push({
          id: `omnibox:collection:${hit.id}`,
          label: hit.title,
          kind: 'command',
          category: copy.collections,
          ...(hit.snippet ? { snippet: hit.snippet } : {}),
          open: () => {
            const latest = liveOptionsRef.current
            if (latest.onOpenCollection !== undefined)
              return latest.onOpenCollection(hit.id) ?? null
            const matched = latest.documents.find((doc) => doc.id === hit.id)
            if (matched !== undefined && latest.openDocument !== undefined) {
              const target = latest.openDocument(matched)
              return target instanceof HTMLElement ? target : null
            }
            return null
          },
        })
      }

      for (const hit of msgHits) {
        const channelFlags = hit.isDirect ? undefined : current.channelsById?.get(hit.targetId)
        if (!isRoomSearchPermitted(current.store, hit.roomId, channelFlags)) continue
        const liveTimeline =
          typeof current.store.getTimeline === 'function'
            ? current.store.getTimeline(hit.roomId)
            : []
        const liveMessage = liveTimeline.find((msg) => msg.eventId === hit.eventId)
        if (
          liveMessage === undefined ||
          liveMessage.redacted ||
          typeof liveMessage.body !== 'string' ||
          liveMessage.body.trim() === ''
        ) {
          continue
        }
        const liveHaystack = foldOmniboxText(
          `${liveMessage.body} ${liveMessage.senderName ?? liveMessage.sender ?? ''} ${hit.roomLabel}`
        )
        if (!terms.every((term) => liveHaystack.includes(term))) continue

        results.push({
          id: hit.id,
          label: `${hit.roomLabel} · ${hit.senderLabel}`,
          kind: 'command',
          category: copy.messages,
          snippet: hit.snippet,
          ...(current.onJumpToMessage === undefined
            ? {}
            : {
                open: () => {
                  const latest = liveOptionsRef.current
                  const flags = hit.isDirect ? undefined : latest.channelsById?.get(hit.targetId)
                  if (!isRoomSearchPermitted(latest.store, hit.roomId, flags)) return null
                  const latestTimeline =
                    typeof latest.store.getTimeline === 'function'
                      ? latest.store.getTimeline(hit.roomId)
                      : []
                  const latestMessage = latestTimeline.find((msg) => msg.eventId === hit.eventId)
                  if (
                    latestMessage === undefined ||
                    latestMessage.redacted ||
                    typeof latestMessage.body !== 'string' ||
                    latestMessage.body.trim() === ''
                  ) {
                    return null
                  }
                  return (
                    latest.onJumpToMessage?.(hit.roomId, hit.targetId, hit.isDirect, hit.eventId) ??
                    null
                  )
                },
              }),
        })
      }
      return results
    },
    [warmIndex, copy.collections, copy.messages]
  )
}

/** The source outlives the phone's drawer, but never its owning workspace view. */
export function WorkspacePaletteRegistration({
  store,
  entries,
  channelsById,
  documents,
  collections,
  openDocument,
  onOpenCollection,
  onJumpToMessage,
  onChoose,
  onSelectDirect,
  onChangeCanvasMode,
  uiMode,
  onToggleUiMode,
  dynamicEntries: providedDynamicEntries,
  simulation,
  snapshot,
}: {
  store: EspaceStoreLike
  entries: ChannelSearchProps['entries']
  channelsById?: ReadonlyMap<string, ConfidentialChannelFlags> | undefined
  documents: readonly ChannelDoc[]
  collections?: readonly OmniboxCollectionDescriptor[] | undefined
  openDocument?: ((doc: ChannelDoc) => unknown) | undefined
  onOpenCollection?: ((id: string) => HTMLElement | null | void) | undefined
  onJumpToMessage?:
    | ((
        roomId: string,
        targetId: string,
        isDirect: boolean,
        eventId: string
      ) => HTMLElement | null | void)
    | undefined
  onChoose: ChannelSearchProps['onChoose']
  onSelectDirect: (roomId: string) => void
  onChangeCanvasMode?: ((mode: CanvasMode) => void) | undefined
  uiMode?: 'pro' | 'messages' | undefined
  onToggleUiMode?: (() => void) | undefined
  dynamicEntries?: ((query: string) => readonly ChannelSearchEntry[]) | undefined
  simulation: boolean
  /** The synced workspace: its files are searchable and open the Files view. */
  snapshot?: EspaceSnapshot | undefined
}) {
  const { i18n } = useTranslation()
  const copy = paletteCopy(i18n.resolvedLanguage)
  const fallbackDynamicEntries = useWorkspaceOmniboxDynamicEntries({
    store,
    snapshot,
    entries,
    channelsById,
    documents,
    collections,
    openDocument,
    onOpenCollection,
    onJumpToMessage,
    simulation,
  })
  const dynamicEntries = providedDynamicEntries ?? fallbackDynamicEntries

  // The names come from messages already synced: nothing is fetched to search them. Documents
  // are listed under their own group, so only files are taken here.
  const files = useMemo(
    () =>
      snapshot === undefined || onChangeCanvasMode === undefined
        ? []
        : workspaceFilesOf(store, snapshot, entries, [])
            .filter((file) => file.document === undefined)
            .slice(0, PALETTE_FILE_LIMIT)
            .map((file) => ({
              id: file.id,
              label: file.name,
              open: () => onChangeCanvasMode('files'),
            })),
    [store, snapshot, entries, onChangeCanvasMode]
  )
  useRegisterPalette(
    {
      entries,
      dynamicEntries,
      onChoose,
      shortcut: false,
      documents: openDocument
        ? documents.map((doc) => ({
            id: doc.id,
            label: doc.title,
            open: () => {
              openDocument(doc)
            },
          }))
        : [],
      files,
      directMessages: simulation
        ? []
        : (store.getDirects?.() ?? []).map((dm) => ({
            id: dm.roomId,
            label: dm.name,
            open: () => onSelectDirect(dm.roomId),
          })),
      actions: [
        ...(onToggleUiMode
          ? [
              {
                id: 'ui-mode',
                label: uiMode === 'messages' ? copy.switchToPro : copy.switchToSimple,
                open: onToggleUiMode,
              },
            ]
          : []),
        ...(onChangeCanvasMode && uiMode !== 'messages'
          ? [
              { id: 'docs', label: copy.docs, open: () => onChangeCanvasMode('docs') },
              { id: 'files', label: copy.files, open: () => onChangeCanvasMode('files') },
              {
                id: 'integrations',
                label: copy.integrations,
                open: () => onChangeCanvasMode('integrations'),
              },
            ]
          : []),
      ],
    },
    -1
  )
  return null
}
