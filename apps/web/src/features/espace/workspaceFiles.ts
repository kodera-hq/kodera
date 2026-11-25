import { permitsPlaintext } from '../confidential/room-boundary'
// Everything the workspace holds that is not a message: the files its channels carry and the
// documents written in them, gathered across every resolved room into one list
// (docs/specs/messaging-media-and-notifications.md).
//
// A message carries its files in two shapes, and both are read here:
//   - `attachments`, the references Core issued under `io.kodera.attachments` — every file sent
//     from this product. They carry a type and a size.
//   - `attachment`, the name a native Matrix message (`m.file`, `m.image`, `m.audio`, `m.video`)
//     carries — what another client sent. A name only: no type, no size.
// Reading only the second, as the sidebar's own list once did, hides every file this product sent.

import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { AttachmentRef } from '../messaging/attachments/attachmentRefs'
import type { AttachmentType } from '../messaging/attachments/uploadPreflight'
import type { EspaceSnapshot } from './matrix/store'
import { cleanText } from '../../ui/safeText'
import type { EspaceStoreLike } from './liveViewModel'

/** What a file is sorted under. `page` is a collaborative document, which is not a file at all. */
export type WorkspaceFileKind = 'image' | 'document' | 'other' | 'page'

/** The chips the hub filters by, in the order they are drawn. */
export const WORKSPACE_FILE_FILTERS = ['all', 'image', 'document', 'media'] as const
export type WorkspaceFileFilter = 'all' | WorkspaceFileKind | 'media'

export interface WorkspaceFileEntry {
  readonly id: string
  readonly name: string
  readonly kind: WorkspaceFileKind
  /** Absent for a name-only attachment from another client, and for a document. */
  readonly sizeBytes?: number | undefined
  /** Milliseconds since the epoch; `0` for a document, which carries no time here. */
  readonly ts: number
  readonly senderId?: string | undefined
  readonly directRoomId?: string | undefined
  readonly channel: ChannelSearchEntry
  /** The reference to ask Core for a download address with; absent for the other two shapes. */
  readonly ref?: AttachmentRef | undefined
  /** The document to open; absent for a file. */
  readonly document?: ChannelDoc | undefined
}

/** Which chip a Core attachment falls under, by the type the contract accepts. */
function fileKindOf(contentType: AttachmentType): WorkspaceFileKind {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType === 'application/pdf' || contentType === 'text/plain') return 'document'
  return 'other'
}

/**
 * Every file and document the member can reach, newest first, documents last. `searchEntries` names
 * the channels to look in; only a channel whose room is resolved holds anything.
 */
export function workspaceFilesOf(
  store: EspaceStoreLike,
  snapshot: EspaceSnapshot,
  searchEntries: readonly ChannelSearchEntry[],
  documents: readonly ChannelDoc[]
): readonly WorkspaceFileEntry[] {
  const files: WorkspaceFileEntry[] = []
  const pages: WorkspaceFileEntry[] = []
  const directs = store.getDirects?.() ?? []
  const directById = new Map(directs.map((direct) => [direct.roomId, direct]))
  const sources: readonly ChannelSearchEntry[] = [
    ...searchEntries,
    ...directs
      .filter(
        (direct) =>
          !searchEntries.some(
            (entry) =>
              snapshot.channels.get(entry.id)?.state === 'resolved' &&
              (snapshot.channels.get(entry.id) as { roomId: string }).roomId === direct.roomId
          )
      )
      .map((direct) => ({
        id: direct.roomId,
        label: cleanText(direct.name, 120),
        kind: 'text' as const,
      })),
  ]
  for (const channel of sources) {
    const direct = directById.get(channel.id)
    const resolved =
      direct === undefined
        ? snapshot.channels.get(channel.id)
        : { state: 'resolved' as const, roomId: direct.roomId }
    const flags = channel as ChannelSearchEntry & {
      isConfidential?: boolean
      is_confidential?: boolean
    }
    if (flags.isConfidential || flags.is_confidential) continue
    if (resolved?.state !== 'resolved') continue
    const room = snapshot.rooms.find((entry) => entry.roomId === resolved.roomId)
    const boundary = store.getRoomBoundary?.(resolved.roomId) ?? room?.confidentiality
    if (boundary === undefined || !permitsPlaintext(boundary)) continue
    if (resolved?.state === 'resolved') {
      for (const message of store.getTimeline(resolved.roomId)) {
        if (message.redacted) continue
        for (const ref of message.attachments ?? []) {
          files.push({
            id: `${channel.id}:${message.eventId}:${ref.id}`,
            name: cleanText(ref.filename, 120),
            kind: fileKindOf(ref.contentType),
            sizeBytes: ref.sizeBytes,
            ts: message.ts,
            senderId: message.sender,
            channel,
            ...(direct === undefined ? {} : { directRoomId: direct.roomId }),
            ref,
          })
        }
        // A native Matrix attachment: its name, and nothing else this client can ask for.
        if (message.attachment !== undefined && (message.attachments ?? []).length === 0) {
          files.push({
            id: `${channel.id}:${message.eventId}`,
            // Another client's file name, as it arrived: untrusted text drawn in a list.
            name: cleanText(message.attachment.name, 120),
            kind: 'other',
            ts: message.ts,
            senderId: message.sender,
            channel,
            ...(direct === undefined ? {} : { directRoomId: direct.roomId }),
          })
        }
      }
    }
    for (const document of documents) {
      if (document.channelId !== channel.id || document.id.startsWith('workspace-page:')) continue
      pages.push({
        id: document.id,
        name: cleanText(document.title, 120),
        kind: 'page',
        ts: 0,
        channel,
        document,
      })
    }
  }
  for (const document of documents.filter((doc) => doc.id.startsWith('workspace-page:'))) {
    pages.push({
      id: document.id,
      name: cleanText(document.title, 120),
      kind: 'page',
      ts: 0,
      channel: { id: '', label: 'Docs', kind: 'text' },
      document,
    })
  }
  files.sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name))
  return [...files, ...pages]
}

/** The entries a chip and a search term leave; the term is matched on the name and the channel. */
export function filterWorkspaceFiles(
  entries: readonly WorkspaceFileEntry[],
  filter: WorkspaceFileFilter,
  term: string
): readonly WorkspaceFileEntry[] {
  const needle = term.trim().toLocaleLowerCase()
  return entries.filter(
    (entry) =>
      (filter === 'all' ||
        entry.kind === filter ||
        (filter === 'document' && entry.kind === 'page') ||
        (filter === 'media' && /^(audio|video)\//.test(entry.ref?.contentType ?? ''))) &&
      (needle === '' ||
        entry.name.toLocaleLowerCase().includes(needle) ||
        entry.channel.label.toLocaleLowerCase().includes(needle))
  )
}

/** How much of the workspace's room the files take: the bytes the entries know the size of. */
export function workspaceFilesBytes(entries: readonly WorkspaceFileEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0)
}
