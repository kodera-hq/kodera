import { lazy, Suspense } from 'react'
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
const LazyWorkspaceFilesPanel = lazy(() =>
  import('./WorkspaceFilesPanel').then((module) => ({ default: module.WorkspaceFilesPanel }))
)
const LazyCallsSurfaceView = lazy(() =>
  import('./CallsSurfaceView').then((module) => ({ default: module.CallsSurfaceView }))
)

export interface EspaceCanvasPanesProps {
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
  signedOut,
  onReconnect,
  docsEverOpened,
  activeChannel,
  directRoomId,
  docsCanvasSlot,
  effectiveCanvasMode,
  searchEntries,
  activeStore,
  snapshot,
  documents,
  openStudioDocument,
  onOpenDocument,
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

      {docsEverOpened &&
      activeChannel != null &&
      directRoomId === null &&
      docsCanvasSlot !== undefined ? (
        <div
          hidden={effectiveCanvasMode !== 'docs'}
          data-testid="espace-inline-docs-canvas"
          className={
            effectiveCanvasMode === 'docs' ? 'canvas-enter flex min-h-0 flex-1 flex-col' : ''
          }
        >
          {docsCanvasSlot}
        </div>
      ) : null}
      {effectiveCanvasMode === 'integrations' ? (
        <Suspense fallback={<Skeleton shape="block" />}>
          <LazyExtensionsCatalogPanel channels={searchEntries} />
        </Suspense>
      ) : null}
      {effectiveCanvasMode === 'files' ? (
        <div
          data-testid="espace-files-canvas"
          className="canvas-enter flex min-h-0 flex-1 flex-col"
        >
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col gap-3 bg-c-surface p-4">
                <Skeleton shape="text" />
                <Skeleton shape="block" />
              </div>
            }
          >
            <LazyWorkspaceFilesPanel
              activeChannelId={activeChannel?.id}
              store={activeStore}
              snapshot={snapshot}
              searchEntries={searchEntries}
              documents={documents}
              {...(openStudioDocument === undefined ? {} : { onOpenDocument })}
              onOpenChannel={onSelectTextChannel}
              onOpenDirect={onSelectDirect}
            />
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
