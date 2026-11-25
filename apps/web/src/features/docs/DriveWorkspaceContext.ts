import { createContext } from 'react'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'
import type { RoomBoundary } from '../confidential/room-boundary'
import type { ChannelDoc } from './ChannelDocsEditor'

export interface DriveDocumentRequest {
  readonly id: string
  readonly channelId: string
  readonly roomId: string
  readonly sequence: number
}

export interface DriveWorkspaceContextValue {
  readonly navigationRequestKey?: number | undefined
  readonly onDocumentRequestHandled?: ((sequence: number) => void) | undefined
  readonly onUpdateChannelDocument?:
    ((channelId: string, id: string, patch: { title: string; content: string }) => void) | undefined
  readonly canvasMode?: 'docs' | 'files' | undefined
  readonly workspaceId: string
  readonly store: EspaceStoreLike
  readonly snapshot: EspaceSnapshot
  readonly channels: readonly (ChannelSearchEntry & {
    readonly is_confidential?: boolean | undefined
    readonly isConfidential?: boolean | undefined
  })[]
  readonly documents: readonly ChannelDoc[]
  readonly activeChannelId: string | undefined
  readonly roomBoundary: RoomBoundary | undefined
  readonly isConfidential: boolean
  readonly requestedDocument: DriveDocumentRequest | undefined
  readonly onOpenChannel: (channelId: string) => void
  readonly onOpenDirect: (roomId: string) => void
}

export const DriveWorkspaceContext = createContext<DriveWorkspaceContextValue | null>(null)
