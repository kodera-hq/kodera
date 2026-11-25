import { DriveWorkspaceContext, type DriveDocumentRequest } from '../docs/DriveWorkspaceContext'
import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import { purgeProtectedDocsOfflineDatabases } from '../docs/collabSession'
import { lazy, Suspense, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import type { AudioSettingsCall } from './AudioSettings'
import type { AudioCallLike, CallChannel, CanvasMode, EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot, RoomSummary } from './matrix/store'

// Drawn only once chosen: the hub and its aggregation never weigh on opening a channel, and the
// chunk is fetched on the click that needs it.
const LazyExtensionsCatalogPanel = lazy(() =>
  import('../extensions/ExtensionsCatalogPanel').then((module) => ({
    default: module.ExtensionsCatalogPanel,
  }))
)
const LazyWorkspaceCollaborativeDocs = lazy(() => import('../docs/WorkspaceCollaborativeDocs'))
const LazyCallsSurfaceView = lazy(() =>
  import('./CallsSurfaceView').then((module) => ({ default: module.CallsSurfaceView }))
)
const LazyCalendarSurfaceView = lazy(() =>
  import('../calendar/CalendarSurfaceView').then((module) => ({
    default: module.CalendarSurfaceView,
  }))
)

export interface EspaceCanvasPanesProps {
  roomBoundary?: RoomBoundary | undefined
  isConfidential?: boolean | undefined
  requestedDocument?: DriveDocumentRequest | undefined
  onDocumentRequestHandled?: ((sequence: number) => void) | undefined
  onUpdateChannelDocument?:
    ((channelId: string, id: string, patch: { title: string; content: string }) => void) | undefined
  navigationRequestKey?: number | undefined
  signedOut: boolean
  onReconnect: (() => void) | undefined
  docsEverOpened: boolean
  activeChannel: WorkspaceChannel | null | undefined
  directRoomId: string | null
  docsCanvasSlot: ReactNode | undefined
  effectiveCanvasMode: CanvasMode
  searchEntries: ChannelSearchEntry[]
  activeStore: EspaceStoreLike
  snapshot: EspaceSnapshot
  documents: readonly ChannelDoc[]
  openStudioDocument: ((doc: ChannelDoc) => HTMLElement | null) | undefined
  onOpenDocument: ((doc: ChannelDoc) => void) | undefined
  onSelectTextChannel: (channelId: string) => void
  onSelectDirect: (roomId: string) => void
  workspace: Workspace
  activeCall: AudioCallLike | null
  callChannel: CallChannel | null
  deviceSettings: AudioSettingsCall | null
  onJoinAudioRoom: (
    channel: WorkspaceChannel,
    room: RoomSummary | undefined,
    categoryName: string | undefined
  ) => void
  onOpenCallStage: () => void
}

export function EspaceCanvasPanes({
  roomBoundary,
  isConfidential = false,
  requestedDocument,
  onDocumentRequestHandled,
  onUpdateChannelDocument,
  navigationRequestKey,
  directRoomId,
  signedOut,
  onReconnect,
  docsEverOpened,
  activeChannel,
  docsCanvasSlot,
  effectiveCanvasMode,
  searchEntries,
  activeStore,
  snapshot,
  documents,
  onSelectTextChannel,
  onSelectDirect,
  workspace,
  activeCall,
  callChannel,
  deviceSettings,
  onJoinAudioRoom,
  onOpenCallStage,
}: EspaceCanvasPanesProps) {
  const { t } = useTranslation()
  useEffect(() => {
    const channels = workspace.categories
      .flatMap((category) => category.channels)
      .concat(workspace.uncategorised_channels ?? [])
    const purgeProtectedDocuments = () => {
      const latestSnapshot = activeStore.getSnapshot?.() ?? snapshot
      const protectedDocuments = (
        documents.length > 0 ? documents : (activeStore.getInitialDocuments?.().docs ?? [])
      ).filter((doc) => {
        const channel = channels.find((item) => item.id === doc.channelId)
        const room = latestSnapshot.channels.get(doc.channelId)
        const boundary =
          room?.state === 'resolved'
            ? (activeStore.getRoomBoundary?.(room.roomId) ??
              latestSnapshot.rooms.find((entry) => entry.roomId === room.roomId)?.confidentiality)
            : undefined
        return (
          (channel && 'isConfidential' in channel && channel.isConfidential === true) ||
          channel?.is_confidential ||
          (doc.channelId === activeChannel?.id &&
            (isConfidential || (roomBoundary !== undefined && !permitsPlaintext(roomBoundary)))) ||
          (boundary !== undefined && !permitsPlaintext(boundary))
        )
      })
      for (const doc of protectedDocuments) {
        for (const scopeKey of new Set(['local-workspace', workspace.organisation_id])) {
          if (scopeKey) purgeProtectedDocsOfflineDatabases(scopeKey, `channel:${doc.id}`)
        }
      }
    }
    const unsubscribe = activeStore.subscribe?.(purgeProtectedDocuments)
    purgeProtectedDocuments()
    return unsubscribe
  }, [activeChannel?.id, activeStore, documents, isConfidential, roomBoundary, snapshot, workspace])

  return (
    <>
      {signedOut ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <InlineAlert kind="warning">{t('console.workspace.message.session-expired')}</InlineAlert>
          {onReconnect === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onReconnect}>
              {t('console.workspace.message.action-reconnect')}
            </Button>
          )}
        </div>
      ) : null}

      {!(
        (directRoomId !== null ||
          isConfidential ||
          (roomBoundary !== undefined && !permitsPlaintext(roomBoundary))) &&
        effectiveCanvasMode !== 'docs' &&
        effectiveCanvasMode !== 'files'
      ) &&
      (docsEverOpened || effectiveCanvasMode === 'docs' || effectiveCanvasMode === 'files') ? (
        <div
          hidden={effectiveCanvasMode !== 'docs' && effectiveCanvasMode !== 'files'}
          data-testid="espace-inline-docs-canvas"
          className="canvas-enter flex min-h-0 flex-1 flex-col"
        >
          <DriveWorkspaceContext.Provider
            key={activeChannel?.id ?? 'workspace'}
            value={{
              canvasMode: effectiveCanvasMode === 'files' ? 'files' : 'docs',
              navigationRequestKey,
              onDocumentRequestHandled,
              onUpdateChannelDocument,
              workspaceId: `${workspace.organisation_id}:${workspace.id}`,
              store: activeStore,
              snapshot,
              channels: searchEntries.map((entry) => ({
                ...entry,
                ...workspace.categories
                  .flatMap((category) => category.channels)
                  .concat(workspace.uncategorised_channels ?? [])
                  .find((channel) => channel.id === entry.id),
              })),
              documents:
                documents.length > 0 ? documents : (activeStore.getInitialDocuments?.().docs ?? []),
              activeChannelId: activeChannel?.id,
              roomBoundary,
              isConfidential,
              requestedDocument,
              onOpenChannel: onSelectTextChannel,
              onOpenDirect: onSelectDirect,
            }}
          >
            {docsCanvasSlot ?? (
              <Suspense fallback={<Skeleton shape="block" />}>
                <LazyWorkspaceCollaborativeDocs initialSurface="drive" />
              </Suspense>
            )}
          </DriveWorkspaceContext.Provider>
        </div>
      ) : null}
      {effectiveCanvasMode === 'integrations' ? (
        <Suspense fallback={<Skeleton shape="block" />}>
          <LazyExtensionsCatalogPanel channels={searchEntries} />
        </Suspense>
      ) : null}
      {effectiveCanvasMode === 'calendar' ? (
        <div
          data-testid="espace-calendar-canvas"
          className="canvas-enter flex min-h-0 flex-1 flex-col"
        >
          <Suspense fallback={<Skeleton shape="block" />}>
            <LazyCalendarSurfaceView organisationId={workspace.organisation_id} />
          </Suspense>
        </div>
      ) : null}
      {effectiveCanvasMode === 'calls' ? (
        <div className="canvas-enter flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col gap-3 bg-c-surface p-4">
                <Skeleton shape="text" />
                <Skeleton shape="block" />
              </div>
            }
          >
            <LazyCallsSurfaceView
              workspace={workspace}
              store={activeStore}
              call={activeCall}
              callChannel={callChannel}
              deviceSettings={deviceSettings}
              onJoinRoom={onJoinAudioRoom}
              onOpenStage={onOpenCallStage}
            />
          </Suspense>
        </div>
      ) : null}
    </>
  )
}
