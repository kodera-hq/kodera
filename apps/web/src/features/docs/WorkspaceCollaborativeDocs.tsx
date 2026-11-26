import { ApiProblem } from '@/api/client'
import { NARROW_LAYOUT_QUERY } from '@/app/layoutQuery'
import { DriveWorkspaceContext } from './DriveWorkspaceContext'
import {
  CHANNEL_ATTACHMENTS_FOLDER_ID,
  DOCUMENT_KIND_MARKERS,
  driveDocumentKind,
  ensureDriveKindMarker,
  preserveDocumentKind,
  readDriveCollectionRows,
  writeDriveCollectionRows,
  stripDocumentKind,
  type DriveDocumentKind,
} from './driveKinds'
import { workspaceFilesOf } from '../espace/workspaceFiles'
import { FilesUpload } from '../espace/FilesUpload'
import { Dialog } from '@/ui/Dialog/Dialog'
import { KoderaIcon } from '@/ui/icons/KoderaIcons'
import type { ChannelDoc } from './ChannelDocsEditor'
import { createDefaultCollectionSchema, type WorkspaceCollectionRowModel } from './collectionSchema'
import type { JSONContent } from '@tiptap/core'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import {
  lazy,
  useContext,
  useCallback,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { BacklinksFooter } from './BacklinksFooter'
import { CollaborativeBlockEditor } from './CollaborativeBlockEditor'
import { CollaboratorPresence } from './CollaboratorPresence'
import { getCollectionCopy } from './collectionMessages'
import type { CollectionAssigneeMember } from './collectionSchema'
import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import {
  CollabSessionController,
  collabSessionOwnsBody,
  maySeedFromMarkdown,
  OFFLINE_CACHE_ORIGIN,
  REMOTE_SYNC_ORIGIN,
  purgeProtectedDocsOfflineDatabases,
  type CollabSessionSnapshot,
  type ConfidentialCollabPolicy,
  type WebSocketLike,
} from './collabSession'
import { tiptapDocToMarkdown } from './markdownBlocks'
import {
  DocsDriveExplorer,
  FOLDER_MARKDOWN_MARKER,
  ensureFolderMarker,
  isExplicitFolderMarkdown,
  stripFolderMarker,
  type WorkspaceDriveFileItem,
} from './DocsDriveExplorer'
import { getDocsDriveCopy } from './docsDriveMessages'
import { DocumentSubteamShare } from './DocumentSubteamShare'
import {
  ALL_STARTER_TEMPLATE_KEYS,
  buildDocumentTree,
  canCreateDocumentUnderParent,
  canDeleteDocument,
  canReparentDocument,
  deleteLeafDocument,
  getDocumentStarterTemplate,
  reorderSiblingDocument,
  reparentDocument,
  type DocumentAccessRole,
  type DocumentTemplateKey,
} from './pageTree'
import { slugifyDocsSegment } from './url'
import {
  computeLocalBacklinks,
  resolveWikilinkTarget,
  type DocumentBacklinkItem,
} from './wikilinks'
import {
  createWorkspaceDocument,
  createWorkspaceDocumentCollabSession,
  deleteWorkspaceDocument,
  getWorkspaceDocument,
  isNonEmptyParentDeleteError,
  isPreconditionFailedError,
  isPreconditionRequiredError,
  listWorkspaceDocumentBacklinks,
  listWorkspaceDocuments,
  updateWorkspaceDocument,
  updateWorkspaceDocumentMetadata,
} from './workspaceDocumentsApi'

export interface WorkspacePageRecord {
  readonly id: string
  readonly sourceDocumentId?: string | undefined
  readonly sourceChannelId?: string | undefined
  readonly sourceRoomId?: string | undefined
  readonly parentId: string | null
  readonly title: string
  readonly markdown: string
  readonly role: DocumentAccessRole
  readonly updatedAt: string
  readonly order?: number | undefined
}

export type WorkspaceEditorSurface =
  'drive' | 'blocks' | 'markdown' | 'whiteboard' | 'collections' | 'core-collections'

const LazyFileLightboxModal = lazy(() =>
  import('../espace/FileLightboxModal').then((m) => ({ default: m.FileLightboxModal }))
)
const LazyDocsCollectionView = lazy(() => import('./DocsCollectionView'))
const LazyWhiteboardCanvas = lazy(() =>
  import('@/features/whiteboard/WhiteboardCanvas').then((m) => ({ default: m.WhiteboardCanvas }))
)

const LIVE_COLLAB_MARKDOWN_READONLY_COPY: Readonly<Record<'fr' | 'en', string>> = {
  fr: 'Aperçu Markdown en lecture seule : la synchronisation collaborative en direct gère le contenu enrichi de cette page. Passez à l’éditeur de blocs pour modifier le document.',
  en: 'Read-only Markdown preview: live collaborative rich-text sync owns this page’s body. Switch to the block editor to edit the document.',
}

export interface WorkspaceCollaborativeDocsProps {
  readonly organisationId?: string | undefined
  readonly currentUser?:
    | {
        readonly id: string
        readonly name: string
      }
    | undefined
  readonly members?: readonly CollectionAssigneeMember[] | undefined
  readonly surfaceRequestKey?: number | undefined
  readonly initialSurface?: WorkspaceEditorSurface | undefined
  readonly activeDocumentId?: string | undefined
  readonly onActiveDocumentChange?: ((documentId: string) => void) | undefined
  readonly onDocumentsLoaded?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
  readonly localDocuments?: readonly WorkspacePageRecord[] | undefined
  readonly onLocalDocumentsChange?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
  readonly workspaceFiles?: readonly WorkspaceDriveFileItem[] | undefined
  readonly onPublishToChannel?: ((document: WorkspacePageRecord) => Promise<void>) | undefined
  readonly onUploadFiles?: ((files: readonly File[]) => void) | undefined
  readonly confidential?: ConfidentialCollabPolicy | undefined
  readonly roomBoundary?: RoomBoundary | undefined
  readonly webSocketFactory?: ((url: string) => WebSocketLike) | undefined
}

const TREE_INDENT_BY_DEPTH: Readonly<Record<number, string>> = {
  1: 'pl-2',
  2: 'pl-4',
  3: 'pl-6',
  4: 'pl-8',
  5: 'pl-10',
  6: 'pl-12',
}

function treeIndentClass(depth: number): string {
  return TREE_INDENT_BY_DEPTH[Math.min(6, Math.max(1, depth))] ?? 'pl-12'
}

export interface DocumentOutlineHeading {
  readonly index: number
  readonly level: 1 | 2 | 3
  readonly text: string
}

export function extractDocumentOutline(markdown: string): readonly DocumentOutlineHeading[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const items: DocumentOutlineHeading[] = []
  let inFence = false
  let headingCounter = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (!match?.[1] || !match[2]) continue
    const level = match[1].length as 1 | 2 | 3
    const text = match[2]
      .replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_m, target: string, alias?: string) => alias || target
      )
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~\x60]/g, '')
      .trim()
    if (text.length > 0) {
      items.push({ index: headingCounter, level, text })
      headingCounter += 1
    }
  }
  return items
}

export function downloadDocumentAsMarkdown(title: string, markdown: string): void {
  const cleanBody = markdown
    .replaceAll(`${FOLDER_MARKDOWN_MARKER}\n\n`, '')
    .replaceAll(FOLDER_MARKDOWN_MARKER, '')
  const content = cleanBody.trimStart().startsWith('# ')
    ? cleanBody
    : `# ${title.trim() || 'Document'}\n\n${cleanBody}`
  const slug = slugifyDocsSegment(title) || 'document'
  const href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = `${slug}.md`
  anchor.click()
  URL.revokeObjectURL(href)
}

interface PageWriteConflict {
  readonly kind: 'version-conflict' | 'version-required'
  readonly title: string
  readonly markdown: string
}

type RemotePatch = { title?: string; markdown?: string; parentId?: string | null }

/** One page's debounced write: its timer, the fields it carries, and the write itself. */
interface ScheduledSave {
  readonly timer: ReturnType<typeof setTimeout>
  readonly patch: RemotePatch
  /** Sends the write now (the timer firing, or a flush when the surface unmounts). */
  readonly run: () => void
}

const MAX_PRESERVED_CONFLICTS = 8
const MAX_TRACKED_DOCUMENTS = 64
const inFlightTypedCreations = new Map<
  string,
  {
    promise: Promise<{
      result: Awaited<ReturnType<typeof createWorkspaceDocument>>
      acknowledge: () => void
    }>
    participants: Set<() => boolean>
  }
>()
let pendingTypedCreations: ReadonlyMap<string, string> | null = null
const unpersistedTypedCreations = new Map<string, { docId: string; remove: boolean }>()

function withNewestEntry<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V,
  cap: number
): ReadonlyMap<string, V> {
  const next = new Map(map)
  next.delete(key)
  next.set(key, value)
  while (next.size > cap) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

const NO_CONFLICTS: ReadonlyMap<string, PageWriteConflict> = new Map()

function withoutEntry<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

function conflictKindOf(error: unknown): PageWriteConflict['kind'] | null {
  if (isPreconditionRequiredError(error)) return 'version-required'
  if (isPreconditionFailedError(error)) return 'version-conflict'
  return null
}

interface CollabControllerBridgeSnapshot {
  readonly documentId: string | undefined
  readonly controller: CollabSessionController | null
  readonly session: CollabSessionSnapshot
}

const IDLE_SESSION: CollabSessionSnapshot = {
  status: 'local',
  role: 'editor',
  peers: [],
  offlineSynced: false,
  reconnectAttempt: 0,
}

const IDLE_BRIDGE_SNAPSHOT: CollabControllerBridgeSnapshot = {
  documentId: undefined,
  controller: null,
  session: IDLE_SESSION,
}

class CollabControllerBridge {
  private controller: CollabSessionController | null = null
  private unsubscribeController: (() => void) | null = null
  private cached: CollabControllerBridgeSnapshot = IDLE_BRIDGE_SNAPSHOT
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): CollabControllerBridgeSnapshot => this.cached

  attach(next: CollabSessionController, documentId: string): void {
    this.unsubscribeController?.()
    this.controller = next
    this.cached = { documentId, controller: next, session: next.getSnapshot() }
    this.unsubscribeController = next.subscribe(() => {
      if (this.controller !== next) return
      this.cached = { documentId, controller: next, session: next.getSnapshot() }
      this.emit()
    })
    this.emit()
  }

  detach(expected: CollabSessionController): void {
    if (this.controller !== expected) return
    this.unsubscribeController?.()
    this.unsubscribeController = null
    this.controller = null
    this.cached = IDLE_BRIDGE_SNAPSHOT
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export function WorkspaceCollaborativeDocs({
  organisationId,
  currentUser = { id: 'local-member', name: 'Member' },
  members = [],
  initialSurface = 'drive',
  surfaceRequestKey,
  activeDocumentId,
  onActiveDocumentChange,
  onDocumentsLoaded,
  localDocuments,
  onLocalDocumentsChange,
  workspaceFiles = [],
  webSocketFactory,
  confidential,
  roomBoundary: suppliedRoomBoundary,
  onPublishToChannel,
  onUploadFiles,
}: WorkspaceCollaborativeDocsProps) {
  const driveContext = useContext(DriveWorkspaceContext)
  const candidateBoundary = suppliedRoomBoundary ?? driveContext?.roomBoundary
  const roomBoundary =
    driveContext?.isConfidential &&
    (candidateBoundary === undefined || permitsPlaintext(candidateBoundary))
      ? 'confidential-unavailable'
      : candidateBoundary
  const plaintextBlocked =
    Boolean(confidential?.required) ||
    Boolean(driveContext?.isConfidential) ||
    (roomBoundary !== undefined && !permitsPlaintext(roomBoundary))
  const [shareOpen, setShareOpen] = useState(false)
  const [shareFeedback, setShareFeedback] = useState('')
  const [publishFeedback, setPublishFeedback] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [treeOpen, setTreeOpen] = useState(
    () => !(window.matchMedia?.(NARROW_LAYOUT_QUERY).matches ?? false)
  )
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const lightboxReturnFocus = useRef<HTMLElement | null>(null)
  const [importedDocs, setImportedDocs] = useState<readonly WorkspacePageRecord[]>([])
  const sourceRoom = driveContext?.activeChannelId
    ? driveContext.snapshot.channels.get(driveContext.activeChannelId)
    : undefined
  const sourceKey = JSON.stringify([
    driveContext?.workspaceId,
    driveContext?.activeChannelId,
    sourceRoom?.state === 'resolved' ? sourceRoom.roomId : null,
    plaintextBlocked,
  ])
  const [importSourceKey, setImportSourceKey] = useState(sourceKey)
  if (sourceKey !== importSourceKey) {
    setImportSourceKey(sourceKey)
    setImportedDocs([])
  }
  const [collectionRows, setCollectionRows] = useState<
    Readonly<Record<string, readonly WorkspaceCollectionRowModel[]>>
  >({})
  const { t, i18n } = useTranslation()
  const collectionCopy = getCollectionCopy(i18n.resolvedLanguage)
  const driveCopy = getDocsDriveCopy(i18n.resolvedLanguage)
  const templateSelectId = useId()
  const parentSelectId = useId()
  const titleInputId = useId()

  const isControlledLocal = localDocuments !== undefined
  const isRemoteMode = Boolean(organisationId) && !isControlledLocal

  const entries = useMemo(
    () =>
      driveContext
        ? workspaceFilesOf(
            driveContext.store,
            driveContext.snapshot,
            driveContext.channels,
            driveContext.documents
          )
        : [],
    [driveContext]
  )
  const [internalDocs, setInternalDocs] = useState<readonly WorkspacePageRecord[]>(
    () => localDocuments ?? []
  )
  const ownedDocs = isControlledLocal ? localDocuments : internalDocs
  const docs = useMemo(
    () => [
      ...ownedDocs,
      ...importedDocs.filter(
        (doc) =>
          !ownedDocs.some((owned) => owned.id === doc.id) &&
          entries.some(
            (entry) =>
              entry.document?.id === doc.sourceDocumentId &&
              entry.channel.id === doc.sourceChannelId &&
              (doc.sourceChannelId === '' ||
                (driveContext?.snapshot.channels.get(entry.channel.id)?.state === 'resolved' &&
                  (driveContext.snapshot.channels.get(entry.channel.id) as { roomId: string })
                    .roomId === doc.sourceRoomId))
          )
      ),
    ],
    [ownedDocs, importedDocs, entries, driveContext]
  )

  const [selectedId, setSelectedId] = useState<string | undefined>(
    () =>
      activeDocumentId ?? new URLSearchParams(window.location.search).get('document') ?? undefined
  )
  const [prevActiveDocumentId, setPrevActiveDocumentId] = useState<string | undefined>(
    activeDocumentId
  )
  const [templateKey, setTemplateKey] = useState<DocumentTemplateKey>('blank')
  const [editorSurface, setEditorSurface] = useState<WorkspaceEditorSurface>(() => {
    const doc = docs.find((doc) => doc.id === selectedId)
    const kind = driveDocumentKind(doc?.markdown ?? '')
    if (initialSurface === 'core-collections') return initialSurface
    return selectedId
      ? kind === 'base'
        ? 'collections'
        : kind === 'whiteboard'
          ? 'whiteboard'
          : initialSurface === 'drive'
            ? 'blocks'
            : initialSurface
      : initialSurface
  })
  if (activeDocumentId !== prevActiveDocumentId) {
    setPrevActiveDocumentId(activeDocumentId)
    if (activeDocumentId !== undefined) {
      setSelectedId(activeDocumentId)
      const kind = driveDocumentKind(
        docs.find((doc) => doc.id === activeDocumentId)?.markdown ?? ''
      )
      setEditorSurface(
        kind === 'base' ? 'collections' : kind === 'whiteboard' ? 'whiteboard' : 'blocks'
      )
    }
  }

  const [previousSurfaceRequest, setPreviousSurfaceRequest] = useState(surfaceRequestKey)
  if (surfaceRequestKey !== previousSurfaceRequest) {
    setPreviousSurfaceRequest(surfaceRequestKey)
    setEditorSurface(initialSurface)
  }
  const [treeError, setTreeError] = useState<string | null>(null)
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null)
  const [unavailableDocumentId, setUnavailableDocumentId] = useState<string | null>(null)
  const resetDriveRoot = () => {
    setSelectedId(undefined)
    setTreeError(null)
    setDriveFolderId(null)
    setEditorSurface('drive')
  }
  const [previousNavigationRequest, setPreviousNavigationRequest] = useState(
    driveContext?.navigationRequestKey
  )
  if (driveContext?.navigationRequestKey !== previousNavigationRequest) {
    setPreviousNavigationRequest(driveContext?.navigationRequestKey)
    resetDriveRoot()
  }
  const [previousCanvasMode, setPreviousCanvasMode] = useState(driveContext?.canvasMode)
  if (driveContext?.canvasMode !== previousCanvasMode) {
    setPreviousCanvasMode(driveContext?.canvasMode)
    if (driveContext?.canvasMode === 'files') resetDriveRoot()
  }
  const [explicitFolderIds, setExplicitFolderIds] = useState<ReadonlySet<string>>(() => new Set())
  const [tocOpen, setTocOpen] = useState(true)
  const [isSavingRemote, setIsSavingRemote] = useState(false)

  const editorRegionRef = useRef<HTMLDivElement | null>(null)
  const conflictsRef = useRef<ReadonlyMap<string, PageWriteConflict>>(NO_CONFLICTS)
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, PageWriteConflict>>(NO_CONFLICTS)
  const [bodyReloadEpochs, setBodyReloadEpochs] = useState<ReadonlyMap<string, number>>(
    () => new Map()
  )
  const [draftCopiedTo, setDraftCopiedTo] = useState<string | null>(null)
  const [remoteBacklinksEntry, setRemoteBacklinksEntry] = useState<{
    readonly docId: string
    readonly items: readonly DocumentBacklinkItem[]
  } | null>(null)
  const [controllerBridge] = useState(() => new CollabControllerBridge())

  // Failed writes still own their drafts after the pending request markers clear.
  const dirtyPatchesRef = useRef<Map<string, RemotePatch>>(new Map())
  const etagsRef = useRef<Map<string, string>>(new Map())
  // Debounced writes, one per page: editing page B inside the debounce window must not cancel the
  // write page A still owes the server.
  const saveTimersRef = useRef<Map<string, ScheduledSave>>(new Map())
  const inFlightSavesRef = useRef<Map<symbol, string>>(new Map())
  const writeGenerationsRef = useRef<ReadonlyMap<string, number>>(new Map())
  const docsRef = useRef<readonly WorkspacePageRecord[]>(docs)
  const onDocumentsLoadedRef = useRef(onDocumentsLoaded)
  const protectionRef = useRef(confidential)
  const roomBoundaryRef = useRef(roomBoundary)
  const driveContextRef = useRef(driveContext)
  useLayoutEffect(() => {
    driveContextRef.current = driveContext
  }, [driveContext])

  const permitsRemoteBodyWrite = () =>
    !protectionRef.current?.required &&
    (roomBoundaryRef.current === undefined || permitsPlaintext(roomBoundaryRef.current))

  useLayoutEffect(() => {
    protectionRef.current = confidential
    roomBoundaryRef.current = roomBoundary
    const scheduled = saveTimersRef.current
    const blockedPlaintext =
      Boolean(confidential?.required) ||
      (roomBoundary !== undefined && !permitsPlaintext(roomBoundary))
    if (blockedPlaintext && scheduled.size > 0) {
      for (const save of scheduled.values()) clearTimeout(save.timer)
      scheduled.clear()
      if (inFlightSavesRef.current.size === 0) setIsSavingRemote(false)
    }
  }, [confidential, roomBoundary])

  useLayoutEffect(() => {
    // Revoke the source cache before filtering detaches its controller.
    for (const previous of docsRef.current) {
      if (!previous.sourceChannelId || !previous.sourceRoomId || !driveContext) continue
      const channel = driveContext.channels.find((item) => item.id === previous.sourceChannelId)
      const boundary =
        driveContext.store.getRoomBoundary?.(previous.sourceRoomId) ??
        driveContext.snapshot.rooms.find((room) => room.roomId === previous.sourceRoomId)
          ?.confidentiality
      const sourceIsActive = previous.sourceChannelId === driveContext.activeChannelId
      const activeSourceProtected =
        sourceIsActive &&
        (driveContext.isConfidential ||
          (driveContext.roomBoundary !== undefined && !permitsPlaintext(driveContext.roomBoundary)))
      if (
        activeSourceProtected ||
        channel?.is_confidential ||
        channel?.isConfidential ||
        (boundary !== undefined && !permitsPlaintext(boundary))
      ) {
        const attached = controllerBridge.getSnapshot()
        if (attached.documentId === previous.id && attached.controller)
          attached.controller.setRoomBoundary('confidential-unavailable')
        else purgeProtectedDocsOfflineDatabases(organisationId ?? 'local-workspace', previous.id)
      }
    }
    docsRef.current = docs
  }, [controllerBridge, docs, driveContext, organisationId])

  useLayoutEffect(() => {
    const held = conflictsRef.current
    if (held.size === 0) return
    let next: Map<string, PageWriteConflict> | null = null
    for (const doc of docs) {
      const refused = held.get(doc.id)
      if (!refused) continue
      if (refused.title === doc.title && refused.markdown === doc.markdown) continue
      next ??= new Map(held)
      next.set(doc.id, { kind: refused.kind, title: doc.title, markdown: doc.markdown })
    }
    if (next === null) return
    conflictsRef.current = next
    setConflicts(next)
  }, [docs])

  useEffect(() => {
    onDocumentsLoadedRef.current = onDocumentsLoaded
  }, [onDocumentsLoaded])

  const commitDocs = useCallback(
    (updater: (prev: readonly WorkspacePageRecord[]) => readonly WorkspacePageRecord[]) => {
      const previous = docsRef.current
      const next = updater(previous)
      if (next.length === previous.length && next.every((doc, index) => doc === previous[index]))
        return
      for (const doc of next) {
        if (!doc.sourceChannelId || plaintextBlocked) continue
        const source = entries.find(
          (entry) =>
            entry.document?.id === doc.id.slice('channel:'.length) &&
            entry.channel.id === doc.sourceChannelId
        )
        if (!source?.document) continue
        if (doc.title !== source.document.title || doc.markdown !== source.document.content) {
          driveContext?.onUpdateChannelDocument?.(doc.sourceChannelId, source.document.id, {
            title: doc.title,
            content: doc.markdown,
          })
        }
      }
      docsRef.current = next
      const importedIds = new Set(importedDocs.map((doc) => doc.id))
      if (importedIds.size > 0) setImportedDocs(next.filter((doc) => importedIds.has(doc.id)))
      const nextOwned = next.filter((doc) => !importedIds.has(doc.id))
      if (isControlledLocal) onLocalDocumentsChange?.(nextOwned)
      else {
        setInternalDocs(nextOwned)
        onDocumentsLoadedRef.current?.(nextOwned)
      }
    },
    [
      driveContext,
      entries,
      importedDocs,
      isControlledLocal,
      onLocalDocumentsChange,
      plaintextBlocked,
    ]
  )

  // Initial list load in Core 0.43.0 mode.
  useEffect(() => {
    if (!isRemoteMode || !organisationId) return
    const controller = new AbortController()
    void listWorkspaceDocuments(organisationId, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        const mapped: WorkspacePageRecord[] = items.map((item, idx) => ({
          id: item.id,
          parentId: item.parentId,
          title: item.title,
          markdown: item.markdown,
          role: item.role,
          updatedAt: item.updatedAt,
          order: idx,
        }))
        setInternalDocs((prev) => {
          const loaded = new Map(prev.map((doc) => [doc.id, doc]))
          return [
            ...mapped.map((doc) => loaded.get(doc.id) ?? doc),
            ...prev.filter((doc) => !mapped.some((item) => item.id === doc.id)),
          ]
        })
        onDocumentsLoadedRef.current?.(mapped)
        setSelectedId((prev) => prev ?? mapped[0]?.id)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTreeError(t('console.docs.collab.error-save'))
        }
      })
    return () => {
      controller.abort()
    }
  }, [isRemoteMode, organisationId, t])

  const treeNodes = useMemo(() => buildDocumentTree(docs), [docs])
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs])

  const currentNode = useMemo(() => {
    if (selectedId) {
      const found = treeNodes.find((node) => node.doc.id === selectedId)
      return found
    }
    return treeNodes[0]
  }, [selectedId, treeNodes])

  const currentDoc = currentNode?.doc
  if (currentDoc && editorSurface !== 'drive' && editorSurface !== 'core-collections') {
    const kind = driveDocumentKind(currentDoc.markdown)
    if (kind === 'base' && editorSurface !== 'collections') setEditorSurface('collections')
    if (kind === 'whiteboard' && editorSurface !== 'whiteboard') setEditorSurface('whiteboard')
  }
  const activeDocId = currentDoc?.id
  const activeDocRole = currentDoc?.role
  // Sidebar room boundaries block plaintext actions, but only document protection owns its cache.
  const sessionBoundary = activeDocId?.startsWith('channel:') ? roomBoundary : suppliedRoomBoundary
  const sessionBoundaryRef = useRef(sessionBoundary)
  useLayoutEffect(() => {
    sessionBoundaryRef.current = sessionBoundary
  }, [sessionBoundary])
  const detailDocumentId = activeDocId ?? selectedId
  const [detailRequestEpoch, setDetailRequestEpoch] = useState(0)
  const activeConflict = activeDocId ? conflicts.get(activeDocId) : undefined

  const ancestorFolders = useMemo(() => {
    if (!currentDoc) return []
    const ancestors: WorkspacePageRecord[] = []
    const visited = new Set<string>([currentDoc.id])
    let cursor = currentDoc.parentId
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor)
      const parent = docById.get(cursor)
      if (!parent) break
      ancestors.unshift(parent)
      cursor = parent.parentId
    }
    return ancestors
  }, [currentDoc, docById])

  const isCurrentExplicitFolder =
    currentDoc !== undefined &&
    (explicitFolderIds.has(currentDoc.id) || isExplicitFolderMarkdown(currentDoc.markdown))
  const visibleCurrentMarkdown = currentDoc
    ? stripDocumentKind(stripFolderMarker(currentDoc.markdown))
    : ''

  const outlineHeadings = useMemo(
    () => (currentDoc ? extractDocumentOutline(visibleCurrentMarkdown) : []),
    [currentDoc, visibleCurrentMarkdown]
  )

  const writeGenerationOf = (docId: string): number => writeGenerationsRef.current.get(docId) ?? 0

  // Fetch ETag + fresh document + backlinks when switching documents in Core 0.43.0 mode.
  useEffect(() => {
    if (
      !isRemoteMode ||
      !organisationId ||
      !detailDocumentId ||
      detailDocumentId.startsWith('channel:')
    )
      return
    const activeDocId = detailDocumentId
    const abort = new AbortController()
    const readWriteGeneration = writeGenerationOf(detailDocumentId)
    const hadInFlightWriteAtReadStart = [...inFlightSavesRef.current.values()].includes(detailDocumentId)

    void getWorkspaceDocument(organisationId, activeDocId, abort.signal)
      .then(({ document: fresh, etag }) => {
        if (abort.signal.aborted) return
        setUnavailableDocumentId(null)
        if (hadInFlightWriteAtReadStart || writeGenerationOf(activeDocId) !== readWriteGeneration) {
          if (fresh.role === 'viewer')
            setInternalDocs((prev) =>
              prev.map((d) => (d.id === activeDocId ? { ...d, role: 'viewer' } : d))
            )
          return
        }
        const refused = conflictsRef.current.get(activeDocId)
        const hasLocalWrite =
          saveTimersRef.current.has(activeDocId) ||
          [...inFlightSavesRef.current.values()].includes(activeDocId)
        const dirty = dirtyPatchesRef.current.get(activeDocId)
        if (
          !hasLocalWrite &&
          !refused &&
          dirty?.markdown === undefined &&
          driveDocumentKind(fresh.markdown) === 'base'
        ) {
          const rows = readDriveCollectionRows(fresh.markdown)
          setCollectionRows((prev) => ({ ...prev, [activeDocId]: rows }))
          const previousBody = docsRef.current.find((doc) => doc.id === activeDocId)?.markdown ?? ''
          if (JSON.stringify(readDriveCollectionRows(previousBody)) !== JSON.stringify(rows))
            setBodyReloadEpochs((prev) =>
              withNewestEntry(
                prev,
                activeDocId,
                (prev.get(activeDocId) ?? 0) + 1,
                MAX_TRACKED_DOCUMENTS
              )
            )
        }
        if (etag && !refused && !hasLocalWrite && (!dirty || !etagsRef.current.has(activeDocId)))
          etagsRef.current.set(activeDocId, etag)
        setInternalDocs((prev) =>
          (prev.some((doc) => doc.id === activeDocId) ? prev : [...prev, fresh]).map((d) =>
            d.id === activeDocId
              ? {
                  ...d,
                  parentId: dirty?.parentId !== undefined ? d.parentId : fresh.parentId,
                  title: refused
                    ? refused.title
                    : dirty?.title !== undefined
                      ? d.title
                      : fresh.title,
                  markdown: refused
                    ? refused.markdown
                    : dirty?.markdown !== undefined
                      ? d.markdown
                      : fresh.markdown,
                  role: fresh.role,
                  updatedAt: fresh.updatedAt,
                }
              : d
          )
        )
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted && error instanceof ApiProblem && error.status === 404)
          setUnavailableDocumentId(activeDocId)
      })

    void listWorkspaceDocumentBacklinks(organisationId, activeDocId, abort.signal)
      .then((items) => {
        if (abort.signal.aborted) return
        setRemoteBacklinksEntry({ docId: activeDocId, items })
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setRemoteBacklinksEntry(null)
        }
      })

    return () => {
      abort.abort()
    }
  }, [detailDocumentId, detailRequestEpoch, isRemoteMode, organisationId])

  const [shareClassification, setShareClassification] = useState<{
    controller: CollabSessionController
    plaintext: boolean
  } | null>(null)

  // Start & tear down Yjs CollabSessionController for the active document.
  useEffect(() => {
    if (!activeDocId || !activeDocRole) return
    const scopeKey = organisationId ?? 'local-workspace'
    const initialBoundary = sessionBoundaryRef.current
    const source = docsRef.current.find((doc) => doc.id === activeDocId)
    const sourceStore = driveContext?.store
    let retired = false
    const ctrl = new CollabSessionController({
      scopeKey,
      ...(confidential ? { confidential } : {}),
      ...(initialBoundary !== undefined ? { roomBoundary: initialBoundary } : {}),
      documentId: activeDocId,
      initialRole: activeDocRole,
      user: {
        id: currentUser.id,
        name: currentUser.name,
      },
      ...(isRemoteMode && organisationId && !activeDocId.startsWith('channel:')
        ? {
            fetchSession: async () => {
              const grant = await createWorkspaceDocumentCollabSession(organisationId, activeDocId)
              if (!retired)
                setShareClassification({
                  controller: ctrl,
                  plaintext: grant.confidential === false,
                })
              return grant
            },
          }
        : {}),
      ...(webSocketFactory ? { webSocketFactory } : {}),
    })
    controllerBridge.attach(ctrl, activeDocId)
    if (
      isRemoteMode &&
      !activeDocId.startsWith('channel:') &&
      organisationId &&
      (Boolean(confidential) || initialBoundary === undefined || permitsPlaintext(initialBoundary))
    ) {
      void ctrl.connect()
    }
    return () => {
      retired = true
      const boundary = source?.sourceRoomId
        ? sourceStore?.getRoomBoundary?.(source.sourceRoomId)
        : undefined
      const context = driveContextRef.current
      const channel = context?.channels.find((item) => item.id === source?.sourceChannelId)
      if (
        channel?.isConfidential ||
        channel?.is_confidential ||
        (source?.sourceChannelId &&
          source.sourceChannelId === context?.activeChannelId &&
          context?.isConfidential)
      )
        ctrl.setRoomBoundary('confidential-unavailable')
      else if (boundary !== undefined && !permitsPlaintext(boundary)) ctrl.setRoomBoundary(boundary)
      controllerBridge.detach(ctrl)
      ctrl.destroy()
    }
  }, [
    activeDocId,
    activeDocRole,
    controllerBridge,
    confidential,
    currentUser.id,
    currentUser.name,
    driveContext?.workspaceId,
    driveContext?.store,
    isRemoteMode,
    organisationId,
    webSocketFactory,
  ])

  const bridgeSnapshot = useSyncExternalStore(
    controllerBridge.subscribe,
    controllerBridge.getSnapshot
  )
  const sessionController =
    bridgeSnapshot.documentId === activeDocId ? bridgeSnapshot.controller : null
  const collabSnapshot =
    bridgeSnapshot.documentId === activeDocId ? bridgeSnapshot.session : IDLE_SESSION

  useLayoutEffect(() => {
    if (!sessionController) return
    const wasForbidden = sessionController.getSnapshot().status === 'forbidden'
    sessionController.setRoomBoundary(sessionBoundary)
    if (
      wasForbidden &&
      isRemoteMode &&
      organisationId &&
      !confidential &&
      (sessionBoundary === undefined || permitsPlaintext(sessionBoundary)) &&
      sessionController.getSnapshot().status !== 'forbidden'
    ) {
      void sessionController.connect()
    }
  }, [confidential, isRemoteMode, organisationId, sessionBoundary, sessionController])

  useEffect(() => {
    const scheduled = saveTimersRef.current
    return () => {
      // Leaving the surface inside the debounce window sends what is owed instead of dropping it.
      // Each write still runs its own guards (confidential body, open conflict, missing version).
      const owed = [...scheduled.values()]
      scheduled.clear()
      for (const save of owed) {
        clearTimeout(save.timer)
        save.run()
      }
    }
  }, [])

  const shareBlocked =
    plaintextBlocked ||
    Boolean(confidential?.required) ||
    collabSnapshot.status === 'forbidden' ||
    (isRemoteMode &&
      Boolean(
        activeDocId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(activeDocId)
      ) &&
      (!sessionController ||
        shareClassification?.controller !== sessionController ||
        !shareClassification.plaintext))

  const effectiveRole: DocumentAccessRole =
    plaintextBlocked ||
    currentDoc?.role === 'viewer' ||
    Boolean(currentDoc?.sourceChannelId && !driveContext?.onUpdateChannelDocument) ||
    collabSnapshot.role === 'viewer' ||
    collabSnapshot.status === 'forbidden'
      ? 'viewer'
      : 'editor'

  const canSeedRestMarkdown = maySeedFromMarkdown(
    isRemoteMode,
    collabSnapshot.status,
    confidential,
    roomBoundary
  )
  const liveYjsOwnsBody =
    Boolean(sessionController) &&
    collabSessionOwnsBody(isRemoteMode, collabSnapshot.status, confidential, roomBoundary)
  const isMarkdownBodyReadOnly = effectiveRole === 'viewer' || liveYjsOwnsBody
  const markdownReadOnlyBanner =
    effectiveRole === 'viewer'
      ? t('console.docs.collab.banner-readonly')
      : LIVE_COLLAB_MARKDOWN_READONLY_COPY[i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr']

  // Keep raw Markdown state synchronized with remote/offline Yjs updates when the block editor is unmounted.
  useEffect(() => {
    if (!sessionController || !activeDocId || editorSurface === 'blocks') return
    const ydoc = sessionController.ydoc
    const applyFromYdoc = () => {
      const fragment = ydoc.getXmlFragment('content')
      if (fragment.length === 0) return
      const serialized = tiptapDocToMarkdown(yXmlFragmentToProsemirrorJSON(fragment) as JSONContent)
      commitDocs((prev) =>
        prev.map((doc) => {
          if (doc.id !== activeDocId) return doc
          const markdown =
            explicitFolderIds.has(doc.id) || isExplicitFolderMarkdown(doc.markdown)
              ? ensureFolderMarker(serialized)
              : preserveDocumentKind(doc.markdown, serialized)
          return doc.markdown === markdown ? doc : { ...doc, markdown }
        })
      )
    }
    if (collabSnapshot.status === 'synced') {
      applyFromYdoc()
    }
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_SYNC_ORIGIN || origin === OFFLINE_CACHE_ORIGIN) {
        applyFromYdoc()
      }
    }
    ydoc.on('update', onUpdate)
    return () => {
      ydoc.off('update', onUpdate)
    }
  }, [
    activeDocId,
    commitDocs,
    collabSnapshot.status,
    editorSurface,
    explicitFolderIds,
    isControlledLocal,
    onLocalDocumentsChange,
    sessionController,
  ])

  const selectDocument = (id: string) => {
    // A Drive reset can retain the same first-item fallback; every explicit open revalidates it.
    setDetailRequestEpoch((epoch) => epoch + 1)
    const target = docsRef.current.find((doc) => doc.id === id)
    const kind = driveDocumentKind(target?.markdown ?? '')
    setEditorSurface(
      kind === 'base'
        ? 'collections'
        : kind === 'whiteboard'
          ? 'whiteboard'
          : editorSurface === 'markdown'
            ? 'markdown'
            : 'blocks'
    )
    setSelectedId(id)
    setTreeError(null)
    setDraftCopiedTo(null)
    onActiveDocumentChange?.(id)
  }

  const templateOptionLabel = (key: DocumentTemplateKey): string => {
    switch (key) {
      case 'blank':
        return t('console.docs.collab.template-blank')
      case 'spec':
        return t('console.docs.collab.template-spec')
      case 'adr':
        return t('console.docs.collab.template-adr')
      case 'meeting_notes':
        return t('console.docs.collab.template-meeting-notes')
      case 'runbook':
        return t('console.docs.collab.template-runbook')
    }
  }

  const inFlightCreationRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const createTypedDocument = async (title: string, parentId: string | null, markdown: string) => {
    if (!organisationId || !permitsRemoteBodyWrite()) throw new Error('The room is protected')
    const storageKey = 'kodera.docs.pending-typed-creation'
    const kind = isExplicitFolderMarkdown(markdown) ? 'folder' : driveDocumentKind(markdown)
    const key = JSON.stringify([
      organisationId,
      driveContext?.workspaceId ?? 'workspace',
      parentId ?? 'root',
      kind,
      ...(kind === 'folder' ? [title] : []),
    ])
    const inFlight = inFlightTypedCreations.get(key)
    if (inFlight) {
      inFlight.participants.add(() => mountedRef.current && permitsRemoteBodyWrite())
      const existing = await inFlight.promise
      if (!mountedRef.current || !permitsRemoteBodyWrite()) throw new Error(driveCopy.shareRefused)
      return existing
    }
    const participants = new Set([() => mountedRef.current && permitsRemoteBodyWrite()])
    const permitsSharedWrite = () => [...participants].some((permitsWrite) => permitsWrite())
    const creation = (async () => {
      const readPendingCreations = () => {
        let restored: ReadonlyMap<string, string> = new Map(pendingTypedCreations)
        try {
          const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')
          if (Array.isArray(stored)) {
            const entries = new Map<string, string>()
            for (const entry of stored.slice(-MAX_TRACKED_DOCUMENTS)) {
              if (
                Array.isArray(entry) &&
                typeof entry[0] === 'string' &&
                typeof entry[1] === 'string'
              ) {
                entries.set(entry[0], entry[1])
              }
            }
            restored = entries
          }
        } catch {
          // Restricted session storage still permits in-memory retries.
        }
        // Merge only failed storage writes; old snapshots must not resurrect another mount's deletions.
        for (const [intent, { docId, remove }] of unpersistedTypedCreations) {
          if (!remove) restored = withNewestEntry(restored, intent, docId, MAX_TRACKED_DOCUMENTS)
          else if (restored.get(intent) === docId) restored = withoutEntry(restored, intent)
        }
        pendingTypedCreations = restored
        return restored
      }
      const pendingCreations = readPendingCreations()
      const pendingId = pendingCreations.get(key)
      const trackedIntents = new Set([
        ...pendingCreations.keys(),
        ...unpersistedTypedCreations.keys(),
        ...inFlightTypedCreations.keys(),
      ])
      if (!trackedIntents.has(key) && trackedIntents.size >= MAX_TRACKED_DOCUMENTS)
        throw new Error('Pending document creations must be resolved before creating another')
      const rememberPending = (docId: string | null, expectedDocId = docId) => {
        if (docId === null && unpersistedTypedCreations.get(key)?.docId === expectedDocId)
          unpersistedTypedCreations.delete(key)
        const next = new Map(readPendingCreations())
        if (docId) next.set(key, docId)
        else if (expectedDocId && next.get(key) === expectedDocId) next.delete(key)
        else return
        pendingTypedCreations = next
        try {
          // Persist a bounded map of intents and IDs, without document bodies or generated titles.
          if (next.size > 0) sessionStorage.setItem(storageKey, JSON.stringify([...next]))
          else sessionStorage.removeItem(storageKey)
          unpersistedTypedCreations.clear()
        } catch {
          // Retain the in-memory IDs if session storage is unavailable.
          unpersistedTypedCreations.set(key, {
            docId: (docId ?? expectedDocId)!,
            remove: docId === null,
          })
        }
      }
      const readPending = async (docId: string) => {
        try {
          return await getWorkspaceDocument(organisationId, docId)
        } catch (error) {
          if (error instanceof ApiProblem && error.status === 404) rememberPending(null, docId)
          throw error
        }
      }
      let pending = pendingId
        ? await readPending(pendingId)
        : await createWorkspaceDocument(organisationId, { title, parentId })
      rememberPending(pending.document.id)
      if (!permitsSharedWrite()) throw new Error('The room is protected')
      const hasPersistedKind = (body: string) =>
        isExplicitFolderMarkdown(markdown)
          ? isExplicitFolderMarkdown(body)
          : driveDocumentKind(body) === driveDocumentKind(markdown)
      if (hasPersistedKind(pending.document.markdown)) {
        return {
          result: pending,
          acknowledge: () => rememberPending(null, pending.document.id),
        }
      }
      if (!pending.etag) {
        pending = await readPending(pending.document.id)
        rememberPending(pending.document.id)
      }
      const version = pending.etag
      if (!version) throw new Error('A version is required to persist the document kind')
      if (!permitsSharedWrite()) throw new Error('The room is protected')
      const saved = await updateWorkspaceDocument(organisationId, pending.document.id, version, {
        markdown: isExplicitFolderMarkdown(markdown)
          ? ensureFolderMarker(pending.document.markdown)
          : ensureDriveKindMarker(pending.document.markdown, driveDocumentKind(markdown)),
      })
      if (!hasPersistedKind(saved.document.markdown))
        throw new Error('The document kind was not persisted')
      return {
        result: saved,
        acknowledge: () => rememberPending(null, saved.document.id),
      }
    })().finally(() => {
      inFlightTypedCreations.delete(key)
    })
    inFlightTypedCreations.set(key, { promise: creation, participants })
    return creation
  }

  const handleCreatePage = async (
    parentId: string | null,
    openInEditor = true,
    kind: DriveDocumentKind = 'page'
  ) => {
    if (plaintextBlocked) {
      setTreeError(driveCopy.shareRefused)
      return
    }
    const depthCheck = canCreateDocumentUnderParent(docs, parentId)
    if (!depthCheck.ok) {
      setTreeError(t('console.docs.collab.error-max-depth'))
      return
    }
    setTreeError(null)

    const tpl = getDocumentStarterTemplate(templateKey, i18n.resolvedLanguage)
    const siblingCount = docs.filter((d) => d.parentId === parentId).length
    const kindTitle =
      kind === 'base'
        ? driveCopy.newBase
        : kind === 'whiteboard'
          ? driveCopy.newWhiteboard
          : tpl.defaultTitle
    const defaultTitle = siblingCount > 0 ? `${kindTitle} ${siblingCount + 1}` : kindTitle
    const initialMarkdown = kind === 'page' ? tpl.markdown : `${DOCUMENT_KIND_MARKERS[kind]}\n`
    const nextSurface =
      kind === 'base' ? 'collections' : kind === 'whiteboard' ? 'whiteboard' : 'blocks'

    if (isRemoteMode && organisationId) {
      const key = JSON.stringify([organisationId, driveContext?.workspaceId, parentId, kind])
      if (inFlightCreationRef.current.has(key)) return
      inFlightCreationRef.current.add(key)
      try {
        const { result, acknowledge } =
          kind === 'page'
            ? {
                result: await createWorkspaceDocument(organisationId, {
                  title: defaultTitle,
                  parentId,
                  ...(tpl.coreTemplateKey ? { templateKey: tpl.coreTemplateKey } : {}),
                }),
                acknowledge: undefined,
              }
            : await createTypedDocument(defaultTitle, parentId, initialMarkdown)
        if (!mountedRef.current || !permitsRemoteBodyWrite()) {
          setTreeError(driveCopy.shareRefused)
          return
        }
        acknowledge?.()
        const { document: created, etag } = result
        if (etag) etagsRef.current.set(created.id, etag)
        const record: WorkspacePageRecord = {
          id: created.id,
          parentId: created.parentId,
          title: created.title,
          markdown: kind === 'page' ? created.markdown || tpl.markdown : created.markdown,
          role: created.role,
          updatedAt: created.updatedAt,
          order: docs.length,
        }
        commitDocs((prev) => [...prev.filter((doc) => doc.id !== record.id), record])
        selectDocument(record.id)
        if (openInEditor) setEditorSurface(nextSurface)
      } catch {
        setTreeError(
          permitsRemoteBodyWrite() ? t('console.docs.collab.error-save') : driveCopy.shareRefused
        )
      } finally {
        inFlightCreationRef.current.delete(key)
      }
      return
    }

    const created: WorkspacePageRecord = {
      id: crypto.randomUUID(),
      parentId,
      title: defaultTitle,
      markdown: initialMarkdown,
      role: 'editor',
      updatedAt: new Date().toISOString(),
      order: docs.length,
    }
    commitDocs((prev) => [...prev, created])
    selectDocument(created.id)
    if (openInEditor) setEditorSurface(nextSurface)
  }

  const handleCreateDriveFolder = async (rawTitle: string, parentId: string | null) => {
    if (plaintextBlocked) {
      setTreeError(driveCopy.shareRefused)
      return
    }
    const trimmed = rawTitle.trim()
    if (trimmed.length === 0 || trimmed.length > 120) return
    const depthCheck = canCreateDocumentUnderParent(docs, parentId)
    if (!depthCheck.ok) {
      setTreeError(t('console.docs.collab.error-max-depth'))
      return
    }
    setTreeError(null)
    const folderMarkdown = `${FOLDER_MARKDOWN_MARKER}\n\n## ${trimmed}\n`

    if (isRemoteMode && organisationId) {
      const key = JSON.stringify([organisationId, driveContext?.workspaceId, parentId, 'folder'])
      if (inFlightCreationRef.current.has(key)) return
      inFlightCreationRef.current.add(key)
      try {
        const { result, acknowledge } = await createTypedDocument(trimmed, parentId, folderMarkdown)
        if (!mountedRef.current || !permitsRemoteBodyWrite()) {
          setTreeError(driveCopy.shareRefused)
          return
        }
        acknowledge()
        const { document: created, etag } = result
        if (etag) etagsRef.current.set(created.id, etag)
        setExplicitFolderIds((prev) => new Set([...prev, created.id]))
        const record: WorkspacePageRecord = {
          id: created.id,
          parentId: created.parentId,
          title: created.title,
          markdown: created.markdown,
          role: created.role,
          updatedAt: created.updatedAt,
          order: docs.length,
        }
        commitDocs((prev) => [...prev.filter((doc) => doc.id !== record.id), record])
      } catch {
        setTreeError(
          permitsRemoteBodyWrite() ? t('console.docs.collab.error-save') : driveCopy.shareRefused
        )
      } finally {
        inFlightCreationRef.current.delete(key)
      }
      return
    }

    const createdId = crypto.randomUUID()
    setExplicitFolderIds((prev) => new Set([...prev, createdId]))
    const created: WorkspacePageRecord = {
      id: createdId,
      parentId,
      title: trimmed,
      markdown: folderMarkdown,
      role: 'editor',
      updatedAt: new Date().toISOString(),
      order: docs.length,
    }
    commitDocs((prev) => [...prev, created])
  }

  const handleCreateCollectionEntry = async (rawTitle: string): Promise<string | null> => {
    const trimmed = rawTitle.trim()
    if (trimmed.length === 0 || trimmed.length > 120) return null
    if (plaintextBlocked) return null
    const parentId =
      currentDoc && driveDocumentKind(currentDoc.markdown) === 'base' ? currentDoc.id : null
    setTreeError(null)
    const tpl = getDocumentStarterTemplate('blank', i18n.resolvedLanguage)

    if (isRemoteMode && organisationId) {
      try {
        const { document: created, etag } = await createWorkspaceDocument(organisationId, {
          title: trimmed,
          parentId,
        })
        if (etag) etagsRef.current.set(created.id, etag)
        const record: WorkspacePageRecord = {
          id: created.id,
          parentId: created.parentId,
          title: created.title,
          markdown: created.markdown || tpl.markdown,
          role: created.role,
          updatedAt: created.updatedAt,
          order: docs.length,
        }
        commitDocs((prev) => [...prev, record])
        if (!selectedId) setSelectedId(record.id)
        return record.id
      } catch {
        setTreeError(t('console.docs.collab.error-save'))
        return null
      }
    }

    const created: WorkspacePageRecord = {
      id: crypto.randomUUID(),
      parentId,
      title: trimmed,
      markdown: tpl.markdown,
      role: 'editor',
      updatedAt: new Date().toISOString(),
      order: docs.length,
    }
    commitDocs((prev) => [...prev, created])
    if (!selectedId) setSelectedId(created.id)
    return created.id
  }

  const effectiveMembers = useMemo<readonly CollectionAssigneeMember[]>(() => {
    const seen = new Set<string>()
    const merged: CollectionAssigneeMember[] = []
    for (const candidate of [{ id: currentUser.id, name: currentUser.name }, ...members]) {
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id)
        merged.push(candidate)
      }
    }
    return merged
  }, [currentUser.id, currentUser.name, members])

  const commitConflicts = (next: ReadonlyMap<string, PageWriteConflict>): void => {
    conflictsRef.current = next
    setConflicts(next)
  }

  const draftOf = (docId: string): { readonly title: string; readonly markdown: string } => {
    const held = docsRef.current.find((d) => d.id === docId)
    return { title: held?.title ?? '', markdown: held?.markdown ?? '' }
  }

  const setConflictKind = (docId: string, kind: PageWriteConflict['kind']): void => {
    commitConflicts(
      withNewestEntry(
        conflictsRef.current,
        docId,
        { kind, ...draftOf(docId) },
        MAX_PRESERVED_CONFLICTS
      )
    )
  }

  const noteWriteRefusal = (docId: string, kind: PageWriteConflict['kind']): void => {
    const previous = conflictsRef.current.get(docId)
    setConflictKind(docId, previous?.kind === 'version-conflict' ? 'version-conflict' : kind)
  }

  const forgetConflict = (docId: string): void => {
    if (!conflictsRef.current.has(docId)) return
    commitConflicts(withoutEntry(conflictsRef.current, docId))
  }

  const supersedeWrites = (docId: string): number => {
    const next = writeGenerationOf(docId) + 1
    writeGenerationsRef.current = withNewestEntry(
      writeGenerationsRef.current,
      docId,
      next,
      MAX_TRACKED_DOCUMENTS
    )
    return next
  }

  const reportWriteFailure = (docId: string, error: unknown): void => {
    const kind = conflictKindOf(error)
    if (!kind) {
      setTreeError(t('console.docs.collab.error-save'))
      return
    }
    etagsRef.current.delete(docId)
    setTreeError(null)
    noteWriteRefusal(docId, kind)
  }

  const hasPendingOrInFlightSaves = (): boolean =>
    saveTimersRef.current.size > 0 || inFlightSavesRef.current.size > 0

  /** The save indicator rests only once no page has a write waiting on its debounce or in flight. */
  const settleSavingIndicator = (): void => {
    if (!hasPendingOrInFlightSaves()) setIsSavingRemote(false)
  }

  const cancelScheduledSave = (documentId: string): void => {
    const scheduled = saveTimersRef.current.get(documentId)
    if (scheduled === undefined) return
    clearTimeout(scheduled.timer)
    saveTimersRef.current.delete(documentId)
    settleSavingIndicator()
  }

  const scheduleRemotePatch = (docId: string, nextPatch: RemotePatch) => {
    if (!isRemoteMode || !organisationId || docId.startsWith('channel:')) return
    if (conflictsRef.current.get(docId)?.kind === 'version-conflict') {
      cancelScheduledSave(docId)
      return
    }
    // A newer edit of the same page within the window folds into the write it already owes, so a
    // title typed just before a body edit is not lost to it.
    const pending = saveTimersRef.current.get(docId)
    if (pending !== undefined) clearTimeout(pending.timer)
    const patch: RemotePatch = {
      ...pending?.patch,
      ...nextPatch,
    }
    dirtyPatchesRef.current.set(docId, { ...dirtyPatchesRef.current.get(docId), ...patch })
    setIsSavingRemote(true)
    const run = () => {
      if (saveTimersRef.current.get(docId)?.run === run) saveTimersRef.current.delete(docId)
      const boundaryBlocked =
        roomBoundaryRef.current !== undefined && !permitsPlaintext(roomBoundaryRef.current)
      if ((protectionRef.current?.required || boundaryBlocked) && patch.markdown !== undefined) {
        settleSavingIndicator()
        return
      }
      if (conflictsRef.current.get(docId)?.kind === 'version-conflict') {
        settleSavingIndicator()
        return
      }
      const etag = etagsRef.current.get(docId)
      const dirtyParentId = dirtyPatchesRef.current.get(docId)?.parentId
      if (dirtyParentId !== undefined) patch.parentId = dirtyParentId
      else delete patch.parentId
      if (!etag) {
        settleSavingIndicator()
        noteWriteRefusal(docId, 'version-required')
        return
      }
      const generation = supersedeWrites(docId)
      const { markdown, ...metadata } = patch
      const saveToken = Symbol(docId)
      inFlightSavesRef.current.set(saveToken, docId)
      let save: ReturnType<typeof updateWorkspaceDocument>
      try {
        save =
          markdown === undefined
            ? updateWorkspaceDocumentMetadata(organisationId, docId, etag, metadata)
            : updateWorkspaceDocument(organisationId, docId, etag, patch)
      } catch (error) {
        inFlightSavesRef.current.delete(saveToken)
        settleSavingIndicator()
        if (writeGenerationOf(docId) === generation) reportWriteFailure(docId, error)
        return
      }
      void save
        .then(({ etag: nextEtag }) => {
          if (writeGenerationOf(docId) !== generation) return
          if (nextEtag) etagsRef.current.set(docId, nextEtag)
          const dirty = dirtyPatchesRef.current.get(docId)
          if (dirty) {
            const remaining = { ...dirty }
            for (const field of ['title', 'markdown', 'parentId'] as const) {
              if (remaining[field] === patch[field]) delete remaining[field]
            }
            if (Object.keys(remaining).length) dirtyPatchesRef.current.set(docId, remaining)
            else dirtyPatchesRef.current.delete(docId)
          }
          forgetConflict(docId)
        })
        .catch((error: unknown) => {
          if (writeGenerationOf(docId) !== generation) return
          reportWriteFailure(docId, error)
        })
        .finally(() => {
          if (writeGenerationOf(docId) === generation) supersedeWrites(docId)
          inFlightSavesRef.current.delete(saveToken)
          settleSavingIndicator()
        })
    }
    const timer = setTimeout(run, 350)
    saveTimersRef.current.set(docId, { timer, patch, run })
  }

  const resetSeededBody = (docId: string): void => {
    setBodyReloadEpochs((prev) =>
      withNewestEntry(prev, docId, (prev.get(docId) ?? 0) + 1, MAX_TRACKED_DOCUMENTS)
    )
  }

  const handleReloadLatestVersion = async () => {
    const docId = activeDocId
    if (!docId || !activeConflict || !organisationId) return
    cancelScheduledSave(docId)
    const generation = supersedeWrites(docId)

    try {
      const { document: fresh, etag } = await getWorkspaceDocument(organisationId, docId)
      if (writeGenerationOf(docId) !== generation) return
      if (!etag) {
        etagsRef.current.delete(docId)
        setConflictKind(docId, 'version-required')
        return
      }
      etagsRef.current.set(docId, etag)
      dirtyPatchesRef.current.delete(docId)
      commitDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                parentId: fresh.parentId,
                title: fresh.title,
                markdown: fresh.markdown,
                role: fresh.role,
                updatedAt: fresh.updatedAt,
              }
            : d
        )
      )
      setCollectionRows((prev) => ({ ...prev, [docId]: readDriveCollectionRows(fresh.markdown) }))
      forgetConflict(docId)
      setTreeError(null)
      resetSeededBody(docId)
    } catch {
      setTreeError(t('console.docs.collab.error-save'))
    }
  }

  const handleSaveDraftAsNewPage = async () => {
    const docId = activeDocId
    const draft = docId ? docs.find((d) => d.id === docId) : undefined
    if (!docId || !activeConflict || !draft || !organisationId) return
    const savedDraft = { title: draft.title, markdown: draft.markdown }
    cancelScheduledSave(docId)
    supersedeWrites(docId)

    try {
      const { document: created, etag } = await createWorkspaceDocument(organisationId, {
        title: savedDraft.title.trim(),
        parentId: draft.parentId,
      })
      let version = etag
      if (savedDraft.markdown.length > 0) {
        if (!version) {
          throw new RangeError('A created page carried no version to write its body with.')
        }
        const generation = supersedeWrites(created.id)
        version = (
          await updateWorkspaceDocument(organisationId, created.id, version, {
            markdown: savedDraft.markdown,
          })
        ).etag
        if (writeGenerationOf(created.id) !== generation) return
      }
      if (version) etagsRef.current.set(created.id, version)
      commitDocs((prev) => [
        ...prev,
        {
          id: created.id,
          parentId: created.parentId,
          title: created.title,
          markdown: savedDraft.markdown,
          role: created.role,
          updatedAt: created.updatedAt,
          order: prev.length,
        },
      ])
      const currentDraft = draftOf(docId)
      if (
        currentDraft.title === savedDraft.title &&
        currentDraft.markdown === savedDraft.markdown
      ) {
        dirtyPatchesRef.current.delete(docId)
        forgetConflict(docId)
      }
      selectDocument(created.id)
      setDraftCopiedTo(created.title)
    } catch {
      setTreeError(t('console.docs.collab.error-save'))
    }
  }

  const handleTitleChange = (nextTitle: string) => {
    if (!currentDoc || effectiveRole === 'viewer') return
    if (nextTitle.length > 120) return
    setTreeError(null)
    commitDocs((prev) => prev.map((d) => (d.id === currentDoc.id ? { ...d, title: nextTitle } : d)))
    if (nextTitle.trim().length > 0) {
      scheduleRemotePatch(currentDoc.id, { title: nextTitle })
    }
  }

  const handleBlockMarkdownChange = (nextMarkdown: string) => {
    if (!currentDoc || effectiveRole === 'viewer') return
    const storedMarkdown = preserveDocumentKind(
      currentDoc.markdown,
      isCurrentExplicitFolder ? ensureFolderMarker(nextMarkdown) : nextMarkdown
    )
    if (new TextEncoder().encode(storedMarkdown).length > 262_144) return
    commitDocs((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, markdown: storedMarkdown } : d))
    )
    if (!canSeedRestMarkdown) return
    scheduleRemotePatch(currentDoc.id, { markdown: storedMarkdown })
  }

  const handleRawMarkdownChange = (nextMarkdown: string) => {
    if (!currentDoc || isMarkdownBodyReadOnly) return
    const storedMarkdown = preserveDocumentKind(
      currentDoc.markdown,
      isCurrentExplicitFolder ? ensureFolderMarker(nextMarkdown) : nextMarkdown
    )
    if (new TextEncoder().encode(storedMarkdown).length > 262_144) return
    commitDocs((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, markdown: storedMarkdown } : d))
    )
    if (!canSeedRestMarkdown) return
    resetSeededBody(currentDoc.id)
    scheduleRemotePatch(currentDoc.id, { markdown: storedMarkdown })
  }

  const handleReparent = async (nextParentId: string | null) => {
    if (!currentDoc || effectiveRole === 'viewer') return
    const check = canReparentDocument(docs, currentDoc.id, nextParentId)
    if (!check.ok) {
      setTreeError(
        check.reason === 'cycle_detected'
          ? t('console.docs.collab.error-cycle')
          : t('console.docs.collab.error-max-depth')
      )
      return
    }
    const mutated = reparentDocument(docs, currentDoc.id, nextParentId)
    if (!mutated.ok) return
    setTreeError(null)
    commitDocs(() => mutated.docs)

    if (isRemoteMode && organisationId) {
      const generation = supersedeWrites(currentDoc.id)
      dirtyPatchesRef.current.set(currentDoc.id, {
        ...dirtyPatchesRef.current.get(currentDoc.id),
        parentId: nextParentId,
      })
      const etag = etagsRef.current.get(currentDoc.id)
      if (!etag) {
        noteWriteRefusal(currentDoc.id, 'version-required')
        return
      }
      const saveToken = Symbol(currentDoc.id)
      inFlightSavesRef.current.set(saveToken, currentDoc.id)
      setIsSavingRemote(true)
      try {
        const { document: saved, etag: nextEtag } = await updateWorkspaceDocumentMetadata(
          organisationId,
          currentDoc.id,
          etag,
          { parentId: nextParentId }
        )
        if (writeGenerationOf(currentDoc.id) !== generation) return
        if (nextEtag) etagsRef.current.set(currentDoc.id, nextEtag)
        const remaining = { ...dirtyPatchesRef.current.get(currentDoc.id) }
        delete remaining.parentId
        if (Object.keys(remaining).length) dirtyPatchesRef.current.set(currentDoc.id, remaining)
        else dirtyPatchesRef.current.delete(currentDoc.id)
        const scheduled = saveTimersRef.current.get(currentDoc.id)
        if (scheduled) delete scheduled.patch.parentId
        commitDocs((prev) =>
          prev.map((d) => (d.id === currentDoc.id ? { ...d, parentId: saved.parentId } : d))
        )
        forgetConflict(currentDoc.id)
      } catch (error) {
        if (writeGenerationOf(currentDoc.id) !== generation) return
        reportWriteFailure(currentDoc.id, error)
      } finally {
        if (writeGenerationOf(currentDoc.id) === generation) supersedeWrites(currentDoc.id)
        inFlightSavesRef.current.delete(saveToken)
        settleSavingIndicator()
      }
    }
  }

  const handleReorder = (direction: 'up' | 'down') => {
    if (!currentDoc || effectiveRole === 'viewer') return
    const mutated = reorderSiblingDocument(docs, currentDoc.id, direction)
    if (!mutated.ok) return
    setTreeError(null)
    commitDocs(() => mutated.docs)
  }

  const handleDelete = async () => {
    if (!currentDoc || effectiveRole === 'viewer') return
    const check = canDeleteDocument(docs, currentDoc.id)
    if (!check.ok) {
      if (check.reason === 'has_children') {
        setTreeError(t('console.docs.collab.error-delete-has-children'))
      }
      return
    }

    if (isRemoteMode && organisationId) {
      try {
        await deleteWorkspaceDocument(organisationId, currentDoc.id)
      } catch (err) {
        setTreeError(
          isNonEmptyParentDeleteError(err)
            ? t('console.docs.collab.error-delete-has-children')
            : t('console.docs.collab.error-save')
        )
        return
      }
    }

    const mutated = deleteLeafDocument(docs, currentDoc.id)
    if (!mutated.ok) return
    setTreeError(null)
    commitDocs(() => mutated.docs)
    const fallback = mutated.docs[0]?.id
    if (fallback) selectDocument(fallback)
  }

  const scrollToHeadingIndex = (headingIdx: number) => {
    const container = editorRegionRef.current
    if (!container) return
    const headings = container.querySelectorAll(
      '[data-testid="docs-collab-prosemirror"] h1, [data-testid="docs-collab-prosemirror"] h2, [data-testid="docs-collab-prosemirror"] h3'
    )
    const target = headings[headingIdx]
    if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }

  const localBacklinks = useMemo(() => {
    if (!currentDoc) return []
    return computeLocalBacklinks(
      docs.map((d) => ({ id: d.id, title: d.title, content: d.markdown })),
      currentDoc.id
    )
  }, [currentDoc, docs])

  const remoteBacklinks =
    isRemoteMode && activeDocId && remoteBacklinksEntry?.docId === activeDocId
      ? remoteBacklinksEntry.items
      : null

  const effectiveBacklinks = useMemo<readonly DocumentBacklinkItem[]>(() => {
    if (!remoteBacklinks) return localBacklinks
    const byId = new Map<string, DocumentBacklinkItem>()
    for (const item of remoteBacklinks) byId.set(item.documentId, item)
    for (const item of localBacklinks) {
      if (!byId.has(item.documentId)) byId.set(item.documentId, item)
    }
    return [...byId.values()]
  }, [localBacklinks, remoteBacklinks])

  const mayCopyDraftToNewPage =
    activeConflict?.kind === 'version-conflict' &&
    !confidential?.required &&
    effectiveRole === 'editor' &&
    currentDoc !== undefined &&
    currentDoc.title.trim().length > 0

  const offlineCacheReady =
    !sessionController || collabSnapshot.offlineSynced || sessionController.offlineCacheReady
  const ydocForEditor = useMemo(() => {
    if (!sessionController) return undefined
    if (!isRemoteMode && !offlineCacheReady) return undefined
    if (effectiveRole === 'viewer') {
      const hasContent = sessionController.ydoc.getXmlFragment('content').length > 0
      return hasContent || collabSnapshot.status === 'synced' ? sessionController.ydoc : undefined
    }
    return sessionController.ydoc
  }, [collabSnapshot.status, offlineCacheReady, effectiveRole, isRemoteMode, sessionController])

  const bodyReloadEpoch = currentDoc ? (bodyReloadEpochs.get(currentDoc.id) ?? 0) : 0
  const blockEditorKey = currentDoc ? `${currentDoc.id}#${bodyReloadEpoch}` : ''
  const isSinglePageEditorSurface =
    editorSurface === 'blocks' ||
    editorSurface === 'markdown' ||
    editorSurface === 'whiteboard' ||
    editorSurface === 'collections'
  const whiteboardTabLabel = i18n.resolvedLanguage === 'en' ? 'Whiteboard' : 'Tableau blanc'
  const isWhiteboardConfidentialBlocked =
    plaintextBlocked ||
    collabSnapshot.status === 'forbidden' ||
    (roomBoundary !== undefined && !permitsPlaintext(roomBoundary) && !confidential)

  const surfaceModes: readonly WorkspaceEditorSurface[] =
    currentDoc && isSinglePageEditorSurface && driveDocumentKind(currentDoc.markdown) === 'page'
      ? ['blocks', 'markdown', 'whiteboard']
      : []
  const channelPages = entries.flatMap((entry): WorkspacePageRecord[] =>
    entry.document
      ? [
          {
            id: `channel:${entry.id}`,
            parentId: CHANNEL_ATTACHMENTS_FOLDER_ID,
            title: entry.name,
            markdown: entry.document.content,
            role: entry.document.role ?? 'editor',
            updatedAt: '',
          },
        ]
      : []
  )
  const virtualFolder: WorkspacePageRecord = {
    id: CHANNEL_ATTACHMENTS_FOLDER_ID,
    parentId: null,
    title: driveCopy.attachmentsFolder,
    markdown: FOLDER_MARKDOWN_MARKER,
    role: 'viewer',
    updatedAt: '',
  }
  const explorerDocs = [...ownedDocs, virtualFolder, ...channelPages]
  const explorerTree = buildDocumentTree(explorerDocs)
  const importChannelDocument = (document: ChannelDoc) => {
    if (
      plaintextBlocked ||
      !entries.some(
        (entry) => entry.document?.id === document.id && entry.channel.id === document.channelId
      )
    )
      return
    const id = document.id.startsWith('workspace-page:')
      ? document.id.slice('workspace-page:'.length)
      : `channel:${document.id}`
    if (!docs.some((doc) => doc.id === id)) {
      const record: WorkspacePageRecord = {
        id,
        sourceDocumentId: document.id,
        sourceChannelId: document.channelId,
        sourceRoomId: (() => {
          const room = driveContext?.snapshot.channels.get(document.channelId)
          return room?.state === 'resolved' ? room.roomId : undefined
        })(),
        parentId: null,
        title: document.title,
        markdown: document.content,
        role: document.id.startsWith('workspace-page:') ? 'viewer' : (document.role ?? 'editor'),
        updatedAt: '',
      }
      setImportedDocs((previous) => [...previous.filter((doc) => doc.id !== id), record])
    }
    setDetailRequestEpoch((epoch) => epoch + 1)
    setSelectedId(id)
    const kind = driveDocumentKind(document.content)
    setEditorSurface(
      kind === 'base' ? 'collections' : kind === 'whiteboard' ? 'whiteboard' : 'blocks'
    )
  }
  const sharedDocumentId =
    activeDocumentId ?? new URLSearchParams(window.location.search).get('document')
  const request = driveContext?.requestedDocument
  const [lastRequestedSequence, setLastRequestedSequence] = useState<number | undefined>()
  const [lastSharedDocument, setLastSharedDocument] = useState<string | null>(null)
  if (request && request.sequence !== lastRequestedSequence) {
    setLastRequestedSequence(request.sequence)
    const resolved = driveContext?.snapshot.channels.get(request.channelId)
    const source = entries.find(
      (entry) =>
        entry.document?.id === request.id &&
        (entry.channel.id === request.channelId || request.id.startsWith('workspace-page:'))
    )
    if (
      !plaintextBlocked &&
      resolved?.state === 'resolved' &&
      resolved.roomId === request.roomId &&
      driveContext?.activeChannelId === request.channelId &&
      source?.document
    )
      importChannelDocument(source.document)
  }
  if (sharedDocumentId && sharedDocumentId !== lastSharedDocument) {
    const source = entries.find(
      (entry) => entry.document && `channel:${entry.document.id}` === sharedDocumentId
    )
    if (!plaintextBlocked && source?.document) {
      setLastSharedDocument(sharedDocumentId)
      importChannelDocument(source.document)
    }
  }
  const onDocumentRequestHandled = driveContext?.onDocumentRequestHandled
  useEffect(() => {
    if (lastRequestedSequence !== undefined) onDocumentRequestHandled?.(lastRequestedSequence)
  }, [lastRequestedSequence, onDocumentRequestHandled])
  const currentKind = driveDocumentKind(currentDoc?.markdown ?? '')
  const isBaseCollection = currentKind === 'base' && editorSurface !== 'core-collections'
  const collectionDocumentId = currentDoc?.id
  const collectionDocumentTitle = currentDoc?.title
  const collectionTitle = collectionDocumentTitle ?? driveCopy.modeBase
  const collectionLanguage = i18n.resolvedLanguage
  const currentCollection = {
    ...createDefaultCollectionSchema(collectionLanguage),
    id: collectionDocumentId ?? 'local-drive',
    title: collectionTitle,
  }
  const canPublish = Boolean(
    onPublishToChannel || (driveContext?.activeChannelId && driveContext.store.publishDocument)
  )
  async function publishDocument() {
    if (!currentDoc || plaintextBlocked || publishing) return
    setPublishing(true)
    try {
      if (onPublishToChannel) await onPublishToChannel(currentDoc)
      else if (driveContext?.activeChannelId) {
        const state = driveContext.store.getSnapshot().channels.get(driveContext.activeChannelId)
        if (state?.state !== 'resolved') throw new Error('The channel is unavailable')
        const boundary = driveContext.store.getRoomBoundary?.(state.roomId)
        if (boundary !== undefined && !permitsPlaintext(boundary))
          throw new Error('The channel is protected')
        await driveContext.store.publishDocument?.(state.roomId, {
          id: currentDoc.id.startsWith('channel:')
            ? currentDoc.id.slice(8)
            : `workspace-page:${currentDoc.id}`,
          channelId: driveContext.activeChannelId,
          title: currentDoc.title,
          content: currentDoc.markdown,
        })
      }
      setPublishFeedback(driveCopy.published)
    } catch {
      setPublishFeedback(driveCopy.publishFailed)
    } finally {
      setPublishing(false)
    }
  }
  const uploadSlot =
    driveContext && !plaintextBlocked ? (
      <FilesUpload
        store={driveContext.store}
        snapshot={driveContext.snapshot}
        channels={driveContext.channels}
        activeChannelId={driveContext.activeChannelId}
      >
        {({ trigger, controls }) => (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-c-border-input bg-c-sunken p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-c-ink-3">
              <span>{driveCopy.dropFiles}</span>
              {trigger}
            </div>
            {controls}
          </div>
        )}
      </FilesUpload>
    ) : undefined

  return (
    <div
      data-testid="workspace-collaborative-docs"
      className="flex min-h-0 flex-1 gap-4 narrow:flex-col"
    >
      {treeOpen ? (
        <aside
          aria-label={driveCopy.treeTitle}
          className="flex w-shell-sidebar-width shrink-0 flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-3 narrow:w-full"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-c-ink">{driveCopy.treeTitle}</h2>
            <Button
              size="sm"
              variant="secondary"
              aria-label={driveCopy.collapseTree}
              onClick={() => setTreeOpen(false)}
            >
              <KoderaIcon name="left" />
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={templateSelectId} className="sr-only">
              {t('console.docs.collab.action-new-page')}
            </label>
            <select
              id={templateSelectId}
              data-testid="docs-template-select"
              value={templateKey}
              onChange={(event) => setTemplateKey(event.target.value as DocumentTemplateKey)}
              className="h-8 rounded-md border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            >
              {ALL_STARTER_TEMPLATE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {templateOptionLabel(key)}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={plaintextBlocked}
                onClick={() =>
                  void handleCreatePage(
                    driveFolderId === CHANNEL_ATTACHMENTS_FOLDER_ID ? null : driveFolderId
                  )
                }
              >
                {t('console.docs.collab.action-new-page')}
              </Button>
              {currentDoc && effectiveRole === 'editor' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleCreatePage(currentDoc.id)}
                >
                  {t('console.docs.collab.action-new-subpage')}
                </Button>
              ) : null}
            </div>
          </div>

          <Button
            data-testid="docs-surface-drive"
            size="sm"
            variant="secondary"
            aria-current={editorSurface === 'drive' && driveFolderId === null ? 'page' : undefined}
            onClick={() => {
              resetDriveRoot()
            }}
          >
            <KoderaIcon name="drive" />
            {driveCopy.driveRoot}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-current={
              editorSurface === 'drive' && driveFolderId === CHANNEL_ATTACHMENTS_FOLDER_ID
                ? 'page'
                : undefined
            }
            onClick={() => {
              setDriveFolderId(CHANNEL_ATTACHMENTS_FOLDER_ID)
              setEditorSurface('drive')
            }}
          >
            <KoderaIcon name="files" />
            {driveCopy.attachmentsFolder}
          </Button>
          {treeNodes.length === 0 ? (
            selectedId ? null : (
              <p className="text-xs text-c-ink-3">{t('console.docs.collab.empty-workspace')}</p>
            )
          ) : (
            <nav aria-label={driveCopy.treeTitle} className="overflow-y-auto">
              <ul className="flex flex-col gap-1">
                {treeNodes.map((node) => {
                  const isSelected = node.doc.id === currentDoc?.id && isSinglePageEditorSurface
                  return (
                    <li key={node.doc.id}>
                      <button
                        type="button"
                        data-testid={`docs-tree-item-${node.doc.id}`}
                        data-depth={node.depth}
                        aria-current={isSelected ? 'page' : undefined}
                        onClick={() => {
                          if (isExplicitFolderMarkdown(node.doc.markdown)) {
                            setDriveFolderId(node.doc.id)
                            setEditorSurface('drive')
                          } else selectDocument(node.doc.id)
                        }}
                        className={cx(
                          'flex min-h-8 w-full items-center justify-between gap-2 rounded-md py-1 pr-2 text-left text-xs focus-visible:ring focus-visible:outline-hidden',
                          TOUCH_TARGET,
                          treeIndentClass(node.depth),
                          isSelected
                            ? 'bg-c-accent-soft font-semibold text-c-accent-ink'
                            : 'font-medium text-c-ink hover:bg-c-muted'
                        )}
                      >
                        <KoderaIcon
                          name={
                            isExplicitFolderMarkdown(node.doc.markdown)
                              ? 'files'
                              : driveDocumentKind(node.doc.markdown) === 'base'
                                ? 'grid'
                                : driveDocumentKind(node.doc.markdown) === 'whiteboard'
                                  ? 'workspace'
                                  : 'docs'
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{node.doc.title}</span>
                        {node.depth > 1 ? (
                          <span className="shrink-0 font-mono text-xs text-c-ink-3">
                            L{node.depth}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
        </aside>
      ) : null}

      <div
        ref={editorRegionRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-md border border-c-border-soft bg-c-surface p-4"
      >
        {treeError ? (
          <div role="alert" data-testid="docs-tree-error">
            <InlineAlert kind="error">{treeError}</InlineAlert>
          </div>
        ) : null}

        {activeConflict !== undefined && isSinglePageEditorSurface ? (
          <div className="flex flex-col gap-2">
            <InlineAlert
              kind="error"
              data-testid="page-conflict-banner"
              data-conflict-kind={activeConflict.kind}
            >
              {activeConflict.kind === 'version-required'
                ? t('console.docs.collab.error-version-required')
                : t('console.docs.collab.error-version-conflict')}
            </InlineAlert>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="page-conflict-reload"
                onClick={() => void handleReloadLatestVersion()}
              >
                {t('console.docs.collab.action-reload-latest')}
              </Button>
              {mayCopyDraftToNewPage ? (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="page-conflict-save-draft"
                  onClick={() => void handleSaveDraftAsNewPage()}
                >
                  {t('console.docs.collab.action-save-draft-as-page')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div role="status">
          {draftCopiedTo !== null ? (
            <InlineAlert kind="success" inLiveRegion data-testid="page-conflict-draft-saved">
              {t('console.docs.collab.notice-draft-saved-as-page', { title: draftCopiedTo })}
            </InlineAlert>
          ) : null}
        </div>

        {/* Top Surface Switcher + Document Header */}
        <header className="flex flex-col gap-3 border-b border-c-border-soft pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {!treeOpen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={driveCopy.expandTree}
                  onClick={() => setTreeOpen(true)}
                >
                  <KoderaIcon name="list" />
                </Button>
              ) : null}
              <h1
                tabIndex={-1}
                className="flex items-center gap-2 text-md font-semibold text-c-ink"
              >
                <KoderaIcon name="drive" />
                {driveCopy.workspaceTitle}
              </h1>
              <span className="rounded-full bg-c-muted px-2 py-1 text-xs text-c-ink-2">
                {editorSurface === 'drive'
                  ? driveCopy.modeDrive
                  : editorSurface === 'collections'
                    ? driveCopy.modeBase
                    : editorSurface === 'whiteboard'
                      ? driveCopy.modeWhiteboard
                      : driveCopy.modeEditor}
              </span>
              {plaintextBlocked ? (
                <span className="rounded-full bg-c-warn-soft px-2 py-1 text-xs text-c-warn-ink">
                  {driveCopy.confidentialRoom}
                </span>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setShareFeedback('')
                setShareOpen(true)
              }}
            >
              {driveCopy.share}
            </Button>
          </div>
          {plaintextBlocked ? (
            <p className="text-xs text-c-warn-ink">{driveCopy.confidentialNotice}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {currentDoc && isSinglePageEditorSurface ? (
              <div className="flex flex-wrap items-center gap-3">
                {/* Interactive Drive / Parent Folder / Title Breadcrumb */}
                <nav
                  aria-label={driveCopy.modeDrive}
                  data-testid="docs-editor-breadcrumb"
                  className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
                >
                  <button
                    type="button"
                    data-testid="docs-breadcrumb-drive-root"
                    onClick={() => {
                      resetDriveRoot()
                    }}
                    className={cx(
                      'inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 font-medium text-c-ink-2 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
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
                        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
                      />
                    </svg>
                    <span>{driveCopy.driveRoot}</span>
                  </button>
                  {ancestorFolders.map((folder) => (
                    <span key={folder.id} className="inline-flex items-center gap-1">
                      <span aria-hidden="true" className="text-c-ink-3">
                        /
                      </span>
                      <button
                        type="button"
                        data-testid={`docs-breadcrumb-folder-${folder.id}`}
                        onClick={() => {
                          setDriveFolderId(folder.id)
                          setEditorSurface('drive')
                        }}
                        className={cx(
                          'inline-flex min-h-8 max-w-[160px] items-center truncate rounded-md px-2 py-1 font-medium text-c-ink-2 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                          TOUCH_TARGET
                        )}
                      >
                        <span className="truncate">{folder.title}</span>
                      </button>
                    </span>
                  ))}
                  <span aria-hidden="true" className="text-c-ink-3">
                    /
                  </span>
                  <span className="max-w-[200px] truncate px-1 font-semibold text-c-ink">
                    {currentDoc.title}
                  </span>
                </nav>

                <CollaboratorPresence
                  status={collabSnapshot.status}
                  role={effectiveRole}
                  peers={collabSnapshot.peers}
                />

                <span data-testid="docs-save-state" className="font-mono text-xs text-c-ink-3">
                  {isSavingRemote
                    ? driveCopy.saveStateSaving
                    : !canSeedRestMarkdown && isRemoteMode
                      ? collabSnapshot.status === 'synced'
                        ? driveCopy.saveStateSaved
                        : collabSnapshot.status === 'offline-buffered'
                          ? t('console.docs.collab.status-offline')
                          : collabSnapshot.status === 'reconnecting'
                            ? t('console.docs.collab.status-reconnecting')
                            : collabSnapshot.status === 'forbidden'
                              ? t('console.docs.collab.status-readonly')
                              : t('console.docs.collab.status-connecting')
                      : driveCopy.saveStateSaved}
                </span>
              </div>
            ) : (
              <div />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                className="flex flex-wrap items-center gap-1 rounded-md border border-c-border-soft bg-c-sunken p-1"
              >
                {surfaceModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`docs-surface-${mode}`}
                    aria-pressed={editorSurface === mode}
                    onClick={() => setEditorSurface(mode)}
                    className={cx(
                      'inline-flex min-h-8 items-center justify-center gap-1 rounded-sm border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                      TOUCH_TARGET,
                      editorSurface === mode
                        ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                        : 'border-transparent bg-transparent text-c-ink-2 hover:bg-c-surface hover:text-c-ink'
                    )}
                  >
                    {mode === 'drive'
                      ? driveCopy.modeDrive
                      : mode === 'blocks'
                        ? t('console.docs.collab.mode-blocks')
                        : mode === 'markdown'
                          ? t('console.docs.collab.mode-markdown')
                          : mode === 'whiteboard'
                            ? whiteboardTabLabel
                            : collectionCopy.modeCollections}
                  </button>
                ))}
              </div>

              {currentDoc && isSinglePageEditorSurface && canPublish ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={plaintextBlocked || publishing || effectiveRole === 'viewer'}
                  onClick={() => void publishDocument()}
                >
                  {driveCopy.publish}
                </Button>
              ) : null}
              {currentDoc && isSinglePageEditorSurface ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="docs-export-markdown"
                    aria-label={driveCopy.exportMarkdown}
                    title={driveCopy.exportMarkdown}
                    onClick={() =>
                      downloadDocumentAsMarkdown(currentDoc.title, visibleCurrentMarkdown)
                    }
                    className={cx(
                      'inline-flex h-8 w-8 items-center justify-center rounded-md border border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                      TOUCH_TARGET
                    )}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8 2.5v7m0 0-2.5-2.5M8 9.5 10.5 7M3 12.5h10"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-testid="docs-toc-toggle"
                    aria-label={driveCopy.outlineToggle}
                    title={driveCopy.outlineToggle}
                    aria-expanded={tocOpen}
                    onClick={() => setTocOpen((prev) => !prev)}
                    className={cx(
                      'inline-flex h-8 w-8 items-center justify-center rounded-md border text-xs focus-visible:ring focus-visible:outline-hidden narrow:hidden',
                      TOUCH_TARGET,
                      tocOpen
                        ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                        : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted hover:text-c-ink'
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
                      <path strokeLinecap="round" d="M3 4h10M5 8h8M7 12h6" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {/* Single-page parent/reorder/delete controls ONLY on single-page editor surfaces (hidden on Drive & Collections) */}
          {currentDoc && currentNode && isSinglePageEditorSurface && effectiveRole === 'editor' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={parentSelectId} className="text-xs font-medium text-c-ink-2">
                  {t('console.docs.collab.label-parent-page')}
                </label>
                <select
                  id={parentSelectId}
                  data-testid="docs-parent-select"
                  value={currentDoc.parentId ?? ''}
                  onChange={(event) => void handleReparent(event.target.value || null)}
                  className="h-8 max-w-[200px] rounded-md border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                >
                  <option value="">{t('console.docs.collab.option-root-page')}</option>
                  {treeNodes
                    .filter((node) => node.doc.id !== currentDoc.id)
                    .map((node) => (
                      <option key={node.doc.id} value={node.doc.id}>
                        {node.pathTitles.join(' / ')}
                      </option>
                    ))}
                </select>

                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={currentNode.siblingIndex === 0}
                    aria-label={t('console.docs.collab.action-move-up')}
                    onClick={() => handleReorder('up')}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={currentNode.siblingIndex >= currentNode.siblingCount - 1}
                    aria-label={t('console.docs.collab.action-move-down')}
                    onClick={() => handleReorder('down')}
                  >
                    ↓
                  </Button>
                </div>
              </div>

              {/* Destructive delete tucked safely away from reorder arrows */}
              <div className="border-l border-c-border-soft pl-3">
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={t('console.docs.collab.action-delete-page')}
                  onClick={() => void handleDelete()}
                >
                  {t('console.docs.collab.action-delete-page')}
                </Button>
              </div>
            </div>
          ) : null}
        </header>

        {publishFeedback ? (
          <p role="status" className="text-xs text-c-ink-2">
            {publishFeedback}
          </p>
        ) : null}
        <Dialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          title={driveCopy.share}
          closeLabel={driveCopy.close}
        >
          <div className="flex max-h-[calc(75vh)] flex-col gap-4 overflow-y-auto text-sm text-c-ink-2">
            <p>{currentDoc?.title ?? driveCopy.driveRoot}</p>
            <p>{effectiveRole === 'viewer' ? driveCopy.roleViewer : driveCopy.roleEditor}</p>
            <p>{driveCopy.inheritance}</p>
            <p>{driveCopy.shareAccess}</p>
            {shareBlocked ? (
              <p role="alert" className="text-c-warn-ink">
                {driveCopy.shareRefused}
              </p>
            ) : null}
            {shareOpen && unavailableDocumentId !== activeDocId ? (
              <DocumentSubteamShare
                key={currentUser.id}
                organisationId={organisationId}
                documentId={activeDocId}
                remote={isRemoteMode}
                plaintextBlocked={shareBlocked}
                canManageSharing={activeDocRole !== 'viewer' && effectiveRole !== 'viewer'}
              />
            ) : null}
            <Button
              disabled={shareBlocked || !currentDoc}
              onClick={() => {
                if (shareBlocked || !currentDoc) return
                const link = new URL(window.location.href)
                link.searchParams.set('document', currentDoc.id)
                if (!navigator.clipboard) {
                  setShareFeedback(driveCopy.copyFailed)
                  return
                }
                void navigator.clipboard
                  .writeText(link.href)
                  .then(() => setShareFeedback(driveCopy.linkCopied))
                  .catch(() => setShareFeedback(driveCopy.copyFailed))
              }}
            >
              {driveCopy.copyInternalLink}
            </Button>
            <p role="status">{shareFeedback}</p>
          </div>
        </Dialog>
        {selectedFileId && driveContext ? (
          <Suspense fallback={null}>
            <LazyFileLightboxModal
              entries={entries.filter((entry) => !entry.document)}
              selectedId={selectedFileId}
              onSelect={setSelectedFileId}
              onClose={() => setSelectedFileId(null)}
              returnFocusTo={lightboxReturnFocus}
              onOpenChannel={(entry) => {
                setSelectedFileId(null)
                if (entry.directRoomId) driveContext.onOpenDirect(entry.directRoomId)
                else driveContext.onOpenChannel(entry.channel.id)
              }}
            />
          </Suspense>
        ) : null}
        {/* Active Surface Body */}
        {editorSurface !== 'drive' && selectedId && unavailableDocumentId === selectedId ? (
          <p role="alert" className="py-8 text-center text-sm text-c-ink-3">
            {driveCopy.documentUnavailable}
          </p>
        ) : editorSurface === 'drive' ? (
          <DocsDriveExplorer
            documents={explorerDocs}
            treeNodes={explorerTree}
            explicitFolderIds={explicitFolderIds}
            activeFolderId={driveFolderId}
            onNavigateFolder={(folderId) => setDriveFolderId(folderId)}
            onOpenDocument={(docId, parentFolderId) => {
              setDriveFolderId(parentFolderId)
              const entry = entries.find((entry) => `channel:${entry.id}` === docId)
              if (entry?.document) importChannelDocument(entry.document)
              else selectDocument(docId)
            }}
            onCreateFolder={handleCreateDriveFolder}
            onCreateDocumentInFolder={(parentId) => handleCreatePage(parentId, true)}
            canEdit={
              !plaintextBlocked &&
              (driveFolderId === null || docById.get(driveFolderId)?.role !== 'viewer') &&
              driveFolderId !== CHANNEL_ATTACHMENTS_FOLDER_ID
            }
            onCreateKind={(kind, parentId) => handleCreatePage(parentId, true, kind)}
            uploadSlot={uploadSlot}
            onUploadFiles={plaintextBlocked ? undefined : onUploadFiles}
            onOpenFile={(file) => {
              if (!entries.some((entry) => entry.id === file.id)) return
              lightboxReturnFocus.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null
              setSelectedFileId(file.id)
            }}
            files={[
              ...workspaceFiles,
              ...entries
                .filter((entry) => !entry.document)
                .map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  previewable: true,
                  sizeBytes: entry.sizeBytes,
                  updatedAt: new Date(entry.ts).toISOString(),
                  folderId: CHANNEL_ATTACHMENTS_FOLDER_ID,
                })),
            ]}
          />
        ) : editorSurface === 'collections' || editorSurface === 'core-collections' ? (
          <Suspense
            fallback={
              <p role="status" className="py-4 text-xs text-c-ink-3">
                {collectionCopy.loadingCollections}
              </p>
            }
          >
            <LazyDocsCollectionView
              key={`${blockEditorKey}:${isBaseCollection ? 'base' : 'core-collections'}`}
              organisationId={
                isRemoteMode && !plaintextBlocked && !isBaseCollection ? organisationId : undefined
              }
              initialCollection={isBaseCollection ? currentCollection : undefined}
              initialRows={
                isBaseCollection && currentDoc
                  ? (collectionRows[currentDoc.id] ?? readDriveCollectionRows(currentDoc.markdown))
                  : undefined
              }
              validateRows={
                isBaseCollection && currentDoc
                  ? (rows) => {
                      try {
                        writeDriveCollectionRows(currentDoc.markdown, rows)
                        return true
                      } catch {
                        return false
                      }
                    }
                  : undefined
              }
              onRowsChange={
                isBaseCollection
                  ? (rows) => {
                      if (!currentDoc || plaintextBlocked) return
                      const markdown = writeDriveCollectionRows(currentDoc.markdown, rows)
                      setCollectionRows((prev) => ({ ...prev, [currentDoc.id]: rows }))
                      commitDocs((prev) =>
                        prev.map((doc) => (doc.id === currentDoc.id ? { ...doc, markdown } : doc))
                      )
                      scheduleRemotePatch(currentDoc.id, { markdown })
                    }
                  : undefined
              }
              documents={docs
                .filter(
                  (doc) =>
                    !isBaseCollection ||
                    (doc.parentId === currentDoc?.id &&
                      driveDocumentKind(doc.markdown) === 'page' &&
                      !isExplicitFolderMarkdown(doc.markdown))
                )
                .map((d) => ({
                  id: d.id,
                  title: d.title,
                  updatedAt: d.updatedAt,
                  role: d.role,
                }))}
              members={effectiveMembers}
              activeDocumentId={currentDoc?.id}
              accessRole={plaintextBlocked ? 'viewer' : currentDoc ? effectiveRole : 'editor'}
              onOpenDocument={(docId) => {
                selectDocument(docId)
              }}
              onCreateDocument={plaintextBlocked ? undefined : handleCreateCollectionEntry}
            />
          </Suspense>
        ) : currentDoc && currentNode ? (
          <div className="flex min-h-0 flex-1 items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {editorSurface === 'blocks' ? (
                <CollaborativeBlockEditor
                  key={blockEditorKey}
                  documentId={currentDoc.id}
                  markdown={visibleCurrentMarkdown}
                  onMarkdownChange={handleBlockMarkdownChange}
                  role={effectiveRole}
                  ydoc={ydocForEditor}
                  seedMarkdown={
                    canSeedRestMarkdown && (sessionController?.offlineCacheReady ?? true)
                  }
                  replacesSeededBody={bodyReloadEpoch > 0 || !isRemoteMode}
                  peers={collabSnapshot.peers}
                  onSelectionChange={(sel) => sessionController?.updateSelection(sel)}
                  availablePages={docs.map((d) => ({
                    id: d.id,
                    title: d.title,
                    content: d.markdown,
                  }))}
                  onNavigateWikilink={(targetTitle) => {
                    const resolved = resolveWikilinkTarget(docs, targetTitle)
                    if (resolved) selectDocument(resolved.id)
                  }}
                  onExportMarkdown={() =>
                    downloadDocumentAsMarkdown(currentDoc.title, visibleCurrentMarkdown)
                  }
                  paperHeaderSlot={
                    <div className="border-b border-c-border-soft pb-3">
                      <label htmlFor={titleInputId} className="sr-only">
                        {currentDoc.title}
                      </label>
                      <input
                        id={titleInputId}
                        data-testid="docs-page-title-input"
                        type="text"
                        maxLength={120}
                        readOnly={effectiveRole === 'viewer'}
                        value={currentDoc.title}
                        onChange={(event) => handleTitleChange(event.target.value)}
                        className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-2xl font-bold text-c-ink read-only:text-c-ink-2 hover:border-c-border-soft focus-visible:border-c-accent-ink focus-visible:bg-c-surface focus-visible:px-2 focus-visible:ring focus-visible:outline-hidden"
                      />
                    </div>
                  }
                  paperFooterSlot={
                    <BacklinksFooter
                      backlinks={effectiveBacklinks}
                      onSelectDocument={(docId) => selectDocument(docId)}
                    />
                  }
                />
              ) : editorSurface === 'whiteboard' ? (
                isWhiteboardConfidentialBlocked ? (
                  <div data-testid="whiteboard-confidential-refused">
                    <InlineAlert kind="error">
                      {t('console.docs.collab.status-readonly')}
                    </InlineAlert>
                  </div>
                ) : sessionController ? (
                  <Suspense
                    fallback={
                      <p role="status" className="py-4 text-xs text-c-ink-3">
                        {whiteboardTabLabel}
                      </p>
                    }
                  >
                    <LazyWhiteboardCanvas
                      key={currentDoc.id}
                      doc={sessionController.ydoc}
                      awareness={sessionController?.awareness}
                      participantId={currentUser.id}
                      participantName={currentUser.name}
                      readOnly={effectiveRole === 'viewer'}
                    />
                  </Suspense>
                ) : null
              ) : (
                <div className="w-full rounded-xl bg-c-page px-4 py-6 narrow:px-2 narrow:py-3">
                  <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 rounded-xl border border-c-border bg-c-surface p-8 shadow-card narrow:p-4">
                    <div className="border-b border-c-border-soft pb-3">
                      <label htmlFor={titleInputId} className="sr-only">
                        {currentDoc.title}
                      </label>
                      <input
                        id={titleInputId}
                        data-testid="docs-page-title-input"
                        type="text"
                        maxLength={120}
                        readOnly={effectiveRole === 'viewer'}
                        value={currentDoc.title}
                        onChange={(event) => handleTitleChange(event.target.value)}
                        className="w-full rounded-md border border-c-border-input bg-c-surface px-3 py-2 text-xl font-bold text-c-ink read-only:bg-c-sunken read-only:text-c-ink-2 focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                      />
                    </div>
                    {isMarkdownBodyReadOnly ? (
                      <div data-testid="docs-readonly-banner">
                        <InlineAlert kind="info">{markdownReadOnlyBanner}</InlineAlert>
                      </div>
                    ) : null}
                    <textarea
                      aria-label={t('console.docs.collab.mode-markdown')}
                      readOnly={isMarkdownBodyReadOnly}
                      aria-readonly={isMarkdownBodyReadOnly ? 'true' : 'false'}
                      value={visibleCurrentMarkdown}
                      onChange={(event) => handleRawMarkdownChange(event.target.value)}
                      rows={16}
                      className="w-full rounded-md border border-c-border-input bg-c-sunken p-4 font-mono text-xs leading-relaxed text-c-ink read-only:text-c-ink-2 focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                    />
                    <BacklinksFooter
                      backlinks={effectiveBacklinks}
                      onSelectDocument={(docId) => selectDocument(docId)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible Right-Hand Page Outline (Plan de la page / TOC) */}
            {tocOpen ? (
              <aside
                aria-label={driveCopy.outlineTitle}
                data-testid="docs-page-toc"
                className="sticky top-4 flex w-[216px] shrink-0 flex-col gap-2 rounded-lg border border-c-border-soft bg-c-sunken p-3 narrow:hidden"
              >
                <span className="text-xs font-semibold text-c-ink">{driveCopy.outlineTitle}</span>
                {outlineHeadings.length === 0 ? (
                  <p className="text-xs text-c-ink-3">{driveCopy.outlineEmpty}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {outlineHeadings.map((item) => (
                      <li key={`${item.index}-${item.text}`}>
                        <button
                          type="button"
                          data-testid={`docs-toc-item-${item.index}`}
                          onClick={() => scrollToHeadingIndex(item.index)}
                          className={cx(
                            'flex w-full items-center truncate rounded-sm py-1 pr-2 text-left text-xs hover:bg-c-surface hover:text-c-accent-ink focus-visible:ring focus-visible:outline-hidden',
                            item.level === 1
                              ? 'pl-1 font-semibold text-c-ink'
                              : item.level === 2
                                ? 'pl-3 font-medium text-c-ink-2'
                                : 'pl-5 font-regular text-c-ink-3'
                          )}
                        >
                          <span className="truncate">{item.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            ) : null}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-c-ink-3">
            {selectedId
              ? !isRemoteMode || unavailableDocumentId === selectedId
                ? driveCopy.documentUnavailable
                : t('console.docs.collab.editor-loading')
              : t('console.docs.collab.empty-workspace')}
          </p>
        )}
      </div>
    </div>
  )
}

export default WorkspaceCollaborativeDocs
