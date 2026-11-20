import {
  lazy,
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
import {
  CollabSessionController,
  maySeedFromMarkdown,
  type CollabSessionSnapshot,
  type ConfidentialCollabPolicy,
  type WebSocketLike,
} from './collabSession'
import {
  DocsDriveExplorer,
  FOLDER_MARKDOWN_MARKER,
  ensureFolderMarker,
  isExplicitFolderMarkdown,
  stripFolderMarker,
  type WorkspaceDriveFileItem,
} from './DocsDriveExplorer'
import { getDocsDriveCopy } from './docsDriveMessages'
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
  readonly parentId: string | null
  readonly title: string
  readonly markdown: string
  readonly role: DocumentAccessRole
  readonly updatedAt: string
  readonly order?: number | undefined
}

export type WorkspaceEditorSurface = 'drive' | 'blocks' | 'markdown' | 'collections'

const LazyDocsCollectionView = lazy(() => import('./DocsCollectionView'))

export interface WorkspaceCollaborativeDocsProps {
  readonly organisationId?: string | undefined
  readonly currentUser?:
    | {
        readonly id: string
        readonly name: string
      }
    | undefined
  readonly members?: readonly CollectionAssigneeMember[] | undefined
  readonly initialSurface?: WorkspaceEditorSurface | undefined
  readonly activeDocumentId?: string | undefined
  readonly onActiveDocumentChange?: ((documentId: string) => void) | undefined
  readonly onDocumentsLoaded?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
  readonly localDocuments?: readonly WorkspacePageRecord[] | undefined
  readonly onLocalDocumentsChange?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
  readonly workspaceFiles?: readonly WorkspaceDriveFileItem[] | undefined
  readonly confidential?: ConfidentialCollabPolicy | undefined
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

  attach(next: CollabSessionController): void {
    this.unsubscribeController?.()
    this.controller = next
    this.cached = { controller: next, session: next.getSnapshot() }
    this.unsubscribeController = next.subscribe(() => {
      if (this.controller !== next) return
      this.cached = { controller: next, session: next.getSnapshot() }
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
  initialSurface = 'blocks',
  activeDocumentId,
  onActiveDocumentChange,
  onDocumentsLoaded,
  localDocuments,
  onLocalDocumentsChange,
  workspaceFiles = [],
  webSocketFactory,
  confidential,
}: WorkspaceCollaborativeDocsProps) {
  const { t, i18n } = useTranslation()
  const collectionCopy = getCollectionCopy(i18n.resolvedLanguage)
  const driveCopy = getDocsDriveCopy(i18n.resolvedLanguage)
  const templateSelectId = useId()
  const parentSelectId = useId()
  const titleInputId = useId()

  const isControlledLocal = localDocuments !== undefined
  const isRemoteMode = Boolean(organisationId) && !isControlledLocal

  const [internalDocs, setInternalDocs] = useState<readonly WorkspacePageRecord[]>(
    () => localDocuments ?? []
  )
  const docs = isControlledLocal ? localDocuments : internalDocs

  const [selectedId, setSelectedId] = useState<string | undefined>(activeDocumentId)
  const [prevActiveDocumentId, setPrevActiveDocumentId] = useState<string | undefined>(
    activeDocumentId
  )
  if (activeDocumentId !== prevActiveDocumentId) {
    setPrevActiveDocumentId(activeDocumentId)
    if (activeDocumentId !== undefined) {
      setSelectedId(activeDocumentId)
    }
  }

  const [templateKey, setTemplateKey] = useState<DocumentTemplateKey>('blank')
  const [editorSurface, setEditorSurface] = useState<WorkspaceEditorSurface>(initialSurface)
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null)
  const [explicitFolderIds, setExplicitFolderIds] = useState<ReadonlySet<string>>(() => new Set())
  const [tocOpen, setTocOpen] = useState(true)
  const [isSavingRemote, setIsSavingRemote] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)

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

  const etagsRef = useRef<Map<string, string>>(new Map())
  // Debounced writes, one per page: editing page B inside the debounce window must not cancel the
  // write page A still owes the server.
  const saveTimersRef = useRef<Map<string, ScheduledSave>>(new Map())
  const writeGenerationsRef = useRef<ReadonlyMap<string, number>>(new Map())
  const docsRef = useRef<readonly WorkspacePageRecord[]>(docs)
  const onDocumentsLoadedRef = useRef(onDocumentsLoaded)
  const protectionRef = useRef(confidential)

  useLayoutEffect(() => {
    protectionRef.current = confidential
    const scheduled = saveTimersRef.current
    if (confidential?.required && scheduled.size > 0) {
      for (const save of scheduled.values()) clearTimeout(save.timer)
      scheduled.clear()
      setIsSavingRemote(false)
    }
  }, [confidential])

  useLayoutEffect(() => {
    docsRef.current = docs
  }, [docs])

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

  const commitDocs = (
    updater: (prev: readonly WorkspacePageRecord[]) => readonly WorkspacePageRecord[]
  ) => {
    if (isControlledLocal) {
      const next = updater(localDocuments)
      onLocalDocumentsChange?.(next)
    } else {
      setInternalDocs((prev) => {
        const next = updater(prev)
        onDocumentsLoadedRef.current?.(next)
        return next
      })
    }
  }

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
        setInternalDocs(mapped)
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
      if (found) return found
    }
    return treeNodes[0]
  }, [selectedId, treeNodes])

  const currentDoc = currentNode?.doc
  const activeDocId = currentDoc?.id
  const activeDocRole = currentDoc?.role
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
  const visibleCurrentMarkdown = currentDoc ? stripFolderMarker(currentDoc.markdown) : ''

  const outlineHeadings = useMemo(
    () => (currentDoc ? extractDocumentOutline(visibleCurrentMarkdown) : []),
    [currentDoc, visibleCurrentMarkdown]
  )

  // Fetch ETag + fresh document + backlinks when switching documents in Core 0.43.0 mode.
  useEffect(() => {
    if (!isRemoteMode || !organisationId || !activeDocId) return
    const abort = new AbortController()

    void getWorkspaceDocument(organisationId, activeDocId, abort.signal)
      .then(({ document: fresh, etag }) => {
        if (abort.signal.aborted) return
        const refused = conflictsRef.current.get(activeDocId)
        if (etag && !refused) etagsRef.current.set(activeDocId, etag)
        setInternalDocs((prev) =>
          prev.map((d) =>
            d.id === activeDocId
              ? {
                  ...d,
                  parentId: fresh.parentId,
                  title: refused ? refused.title : fresh.title,
                  markdown: refused ? refused.markdown : fresh.markdown,
                  role: fresh.role,
                  updatedAt: fresh.updatedAt,
                }
              : d
          )
        )
      })
      .catch(() => {
        // Keep cached list entry if detail read fails transiently.
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
  }, [activeDocId, isRemoteMode, organisationId])

  // Start & tear down Yjs CollabSessionController for the active document.
  useEffect(() => {
    if (!activeDocId || !activeDocRole) return
    const scopeKey = organisationId ?? 'local-workspace'
    const ctrl = new CollabSessionController({
      scopeKey,
      ...(confidential ? { confidential } : {}),
      documentId: activeDocId,
      initialRole: activeDocRole,
      user: {
        id: currentUser.id,
        name: currentUser.name,
      },
      ...(isRemoteMode && organisationId
        ? {
            fetchSession: () => createWorkspaceDocumentCollabSession(organisationId, activeDocId),
          }
        : {}),
      ...(webSocketFactory ? { webSocketFactory } : {}),
    })
    controllerBridge.attach(ctrl)
    if (isRemoteMode && organisationId) {
      void ctrl.connect()
    }
    return () => {
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
    isRemoteMode,
    organisationId,
    webSocketFactory,
  ])

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

  const { controller: sessionController, session: collabSnapshot } = useSyncExternalStore(
    controllerBridge.subscribe,
    controllerBridge.getSnapshot
  )

  const effectiveRole: DocumentAccessRole =
    currentDoc?.role === 'viewer' ||
    collabSnapshot.role === 'viewer' ||
    collabSnapshot.status === 'forbidden'
      ? 'viewer'
      : 'editor'

  const selectDocument = (id: string) => {
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

  const handleCreatePage = async (parentId: string | null, openInEditor = false) => {
    const depthCheck = canCreateDocumentUnderParent(docs, parentId)
    if (!depthCheck.ok) {
      setTreeError(t('console.docs.collab.error-max-depth'))
      return
    }
    setTreeError(null)

    const tpl = getDocumentStarterTemplate(templateKey, i18n.resolvedLanguage)
    const siblingCount = docs.filter((d) => d.parentId === parentId).length
    const defaultTitle =
      siblingCount > 0 ? `${tpl.defaultTitle} ${siblingCount + 1}` : tpl.defaultTitle

    if (isRemoteMode && organisationId) {
      try {
        const { document: created, etag } = await createWorkspaceDocument(organisationId, {
          title: defaultTitle,
          parentId,
          ...(tpl.coreTemplateKey ? { templateKey: tpl.coreTemplateKey } : {}),
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
        selectDocument(record.id)
        if (openInEditor) setEditorSurface('blocks')
      } catch {
        setTreeError(t('console.docs.collab.error-save'))
      }
      return
    }

    const created: WorkspacePageRecord = {
      id: crypto.randomUUID(),
      parentId,
      title: defaultTitle,
      markdown: tpl.markdown,
      role: 'editor',
      updatedAt: new Date().toISOString(),
      order: docs.length,
    }
    commitDocs((prev) => [...prev, created])
    selectDocument(created.id)
    if (openInEditor) setEditorSurface('blocks')
  }

  const handleCreateDriveFolder = async (rawTitle: string, parentId: string | null) => {
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
      try {
        const { document: created, etag } = await createWorkspaceDocument(organisationId, {
          title: trimmed,
          parentId,
        })
        let latestEtag = etag
        let persistedMarkdown = folderMarkdown
        if (!confidential?.required && latestEtag) {
          const updated = await updateWorkspaceDocument(organisationId, created.id, latestEtag, {
            markdown: folderMarkdown,
          })
          if (updated.etag) {
            latestEtag = updated.etag
          }
          if (updated.document.markdown) {
            persistedMarkdown = ensureFolderMarker(updated.document.markdown)
          }
        }
        if (latestEtag) etagsRef.current.set(created.id, latestEtag)
        setExplicitFolderIds((prev) => new Set([...prev, created.id]))
        const record: WorkspacePageRecord = {
          id: created.id,
          parentId: created.parentId,
          title: created.title,
          markdown: persistedMarkdown,
          role: created.role,
          updatedAt: created.updatedAt,
          order: docs.length,
        }
        commitDocs((prev) => [...prev, record])
      } catch {
        setTreeError(t('console.docs.collab.error-save'))
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
    setTreeError(null)
    const tpl = getDocumentStarterTemplate('blank', i18n.resolvedLanguage)

    if (isRemoteMode && organisationId) {
      try {
        const { document: created, etag } = await createWorkspaceDocument(organisationId, {
          title: trimmed,
          parentId: null,
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
      parentId: null,
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

  const writeGenerationOf = (docId: string): number => writeGenerationsRef.current.get(docId) ?? 0

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

  /** The save indicator rests only once no page has a write waiting on its debounce. */
  const settleSavingIndicator = (): void => {
    if (saveTimersRef.current.size === 0) setIsSavingRemote(false)
  }

  const cancelScheduledSave = (documentId: string): void => {
    const scheduled = saveTimersRef.current.get(documentId)
    if (scheduled === undefined) return
    clearTimeout(scheduled.timer)
    saveTimersRef.current.delete(documentId)
    settleSavingIndicator()
  }

  const scheduleRemotePatch = (docId: string, nextPatch: RemotePatch) => {
    if (!isRemoteMode || !organisationId) return
    if (conflictsRef.current.get(docId)?.kind === 'version-conflict') {
      cancelScheduledSave(docId)
      return
    }
    // A newer edit of the same page within the window folds into the write it already owes, so a
    // title typed just before a body edit is not lost to it.
    const pending = saveTimersRef.current.get(docId)
    if (pending !== undefined) clearTimeout(pending.timer)
    const patch: RemotePatch = { ...pending?.patch, ...nextPatch }
    setIsSavingRemote(true)
    const run = () => {
      if (saveTimersRef.current.get(docId)?.run === run) saveTimersRef.current.delete(docId)
      if (protectionRef.current?.required && patch.markdown !== undefined) {
        settleSavingIndicator()
        return
      }
      if (conflictsRef.current.get(docId)?.kind === 'version-conflict') {
        settleSavingIndicator()
        return
      }
      const etag = etagsRef.current.get(docId)
      if (!etag) {
        settleSavingIndicator()
        noteWriteRefusal(docId, 'version-required')
        return
      }
      const generation = supersedeWrites(docId)
      const { markdown, ...metadata } = patch
      const save =
        markdown === undefined
          ? updateWorkspaceDocumentMetadata(organisationId, docId, etag, metadata)
          : updateWorkspaceDocument(organisationId, docId, etag, patch)
      void save
        .then(({ etag: nextEtag }) => {
          if (writeGenerationOf(docId) !== generation) return
          settleSavingIndicator()
          if (nextEtag) etagsRef.current.set(docId, nextEtag)
          forgetConflict(docId)
        })
        .catch((error: unknown) => {
          if (writeGenerationOf(docId) !== generation) return
          settleSavingIndicator()
          reportWriteFailure(docId, error)
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

  const handleMarkdownChange = (nextMarkdown: string) => {
    if (!currentDoc || effectiveRole === 'viewer') return
    const storedMarkdown = isCurrentExplicitFolder ? ensureFolderMarker(nextMarkdown) : nextMarkdown
    if (new TextEncoder().encode(storedMarkdown).length > 262_144) return
    commitDocs((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, markdown: storedMarkdown } : d))
    )
    if (!maySeedFromMarkdown(isRemoteMode, collabSnapshot.status, confidential)) return
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
      const etag = etagsRef.current.get(currentDoc.id)
      if (!etag) {
        noteWriteRefusal(currentDoc.id, 'version-required')
        return
      }
      const generation = supersedeWrites(currentDoc.id)
      try {
        const { etag: nextEtag } = await updateWorkspaceDocumentMetadata(
          organisationId,
          currentDoc.id,
          etag,
          { parentId: nextParentId }
        )
        if (writeGenerationOf(currentDoc.id) !== generation) return
        if (nextEtag) etagsRef.current.set(currentDoc.id, nextEtag)
        forgetConflict(currentDoc.id)
      } catch (error) {
        if (writeGenerationOf(currentDoc.id) !== generation) return
        reportWriteFailure(currentDoc.id, error)
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

  const ydocForEditor = useMemo(() => {
    if (!sessionController) return undefined
    if (effectiveRole === 'viewer') {
      const hasContent = sessionController.ydoc.getXmlFragment('content').length > 0
      return hasContent || collabSnapshot.status === 'synced' ? sessionController.ydoc : undefined
    }
    return sessionController.ydoc
  }, [collabSnapshot.status, effectiveRole, sessionController])

  const bodyReloadEpoch = currentDoc ? (bodyReloadEpochs.get(currentDoc.id) ?? 0) : 0
  const blockEditorKey = currentDoc ? `${currentDoc.id}#${bodyReloadEpoch}` : ''
  const isSinglePageEditorSurface = editorSurface === 'blocks' || editorSurface === 'markdown'

  const surfaceModes: readonly WorkspaceEditorSurface[] = currentDoc
    ? ['drive', 'blocks', 'markdown', 'collections']
    : ['drive', 'blocks', 'collections']

  return (
    <div
      data-testid="workspace-collaborative-docs"
      className="flex min-h-0 flex-1 gap-4 narrow:flex-col"
    >
      <aside
        aria-label={t('console.docs.collab.tree-title')}
        className="flex w-shell-sidebar-width shrink-0 flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-3 narrow:w-full"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-c-ink">
            {t('console.docs.collab.tree-title')}
          </h2>
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
            <Button size="sm" variant="secondary" onClick={() => void handleCreatePage(null)}>
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

        {treeNodes.length === 0 ? (
          <p className="text-xs text-c-ink-3">{t('console.docs.collab.empty-workspace')}</p>
        ) : (
          <nav aria-label={t('console.docs.collab.tree-title')} className="overflow-y-auto">
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
                        selectDocument(node.doc.id)
                        if (!isSinglePageEditorSurface) {
                          setEditorSurface('blocks')
                        }
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
                      setDriveFolderId(null)
                      setEditorSurface('drive')
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
                  {isSavingRemote ? driveCopy.saveStateSaving : driveCopy.saveStateSaved}
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
                          : collectionCopy.modeCollections}
                  </button>
                ))}
              </div>

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

        {/* Active Surface Body */}
        {editorSurface === 'drive' ? (
          <DocsDriveExplorer
            documents={docs}
            treeNodes={treeNodes}
            explicitFolderIds={explicitFolderIds}
            activeFolderId={driveFolderId}
            onNavigateFolder={(folderId) => setDriveFolderId(folderId)}
            onOpenDocument={(docId, parentFolderId) => {
              setDriveFolderId(parentFolderId)
              selectDocument(docId)
              setEditorSurface('blocks')
            }}
            onCreateFolder={handleCreateDriveFolder}
            onCreateDocumentInFolder={(parentId) => handleCreatePage(parentId, true)}
            canEdit={effectiveRole === 'editor'}
            files={workspaceFiles}
          />
        ) : editorSurface === 'collections' ? (
          <Suspense
            fallback={
              <p role="status" className="py-4 text-xs text-c-ink-3">
                {collectionCopy.loadingCollections}
              </p>
            }
          >
            <LazyDocsCollectionView
              organisationId={isRemoteMode ? organisationId : undefined}
              documents={docs.map((d) => ({
                id: d.id,
                title: d.title,
                updatedAt: d.updatedAt,
                role: d.role,
              }))}
              members={effectiveMembers}
              activeDocumentId={currentDoc?.id}
              accessRole={currentDoc ? effectiveRole : 'editor'}
              onOpenDocument={(docId) => {
                selectDocument(docId)
                setEditorSurface('blocks')
              }}
              onCreateDocument={handleCreateCollectionEntry}
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
                  onMarkdownChange={handleMarkdownChange}
                  role={effectiveRole}
                  ydoc={ydocForEditor}
                  seedMarkdown={maySeedFromMarkdown(
                    isRemoteMode,
                    collabSnapshot.status,
                    confidential
                  )}
                  replacesSeededBody={bodyReloadEpoch > 0}
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
                    <textarea
                      aria-label={t('console.docs.collab.mode-markdown')}
                      readOnly={effectiveRole === 'viewer'}
                      value={visibleCurrentMarkdown}
                      onChange={(event) => handleMarkdownChange(event.target.value)}
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
            {t('console.docs.collab.empty-workspace')}
          </p>
        )}
      </div>
    </div>
  )
}

export default WorkspaceCollaborativeDocs
