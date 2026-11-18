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

export type WorkspaceEditorSurface = 'blocks' | 'markdown' | 'collections'

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

/**
 * A page write Core refused on its precondition, and which of the two it was — the same pair the
 * structured collection reports (`DocsCollectionView.tsx`), for the same contract
 * (`src/api/generated/problems.ts`), with one difference that shapes everything here: what was
 * refused is a draft somebody is still typing, not a single cell.
 *
 * `version-conflict` is `precondition-failed` (the version sent was stale — a collaborator or the
 * collaboration server committed first). `version-required` is `precondition-required`, and also
 * the case where this tab holds no version for the page at all: a write would then have to go out
 * with no `If-Match`, so it is refused before it is sent rather than sent unconditionally over
 * somebody else's text.
 *
 * Neither state touches the draft in the editor. Nothing is rolled back, nothing is re-read
 * behind the person's back and nothing is retried: the title and the Markdown they have not saved
 * stay exactly as they typed them, and the two recovery actions are theirs to choose.
 *
 * It is held per document, and only those two actions end it. Opening another page and coming
 * back is not one of them: the refusal and the draft it refused both come back with the page,
 * because a version read on the way in says nothing about the draft the member never saved.
 */
interface PageWriteConflict {
  readonly kind: 'version-conflict' | 'version-required'
  /**
   * The draft as the write left it, and as it has been typed since — the text that must come
   * back with the page, and that 'keep my draft as a new page' must save.
   */
  readonly title: string
  readonly markdown: string
}

/** The single debounced save waiting to go out, and the document it would write. */
interface ScheduledSave {
  readonly documentId: string
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * How many refused drafts are kept. Each holds a page body, so the number is bounded rather than
 * left to grow with a long session; a member holding more than a handful of unresolved refusals
 * at once has a screen to clear before they have memory to worry about, and the oldest of them is
 * the one they are least likely to come back to.
 */
const MAX_PRESERVED_CONFLICTS = 8

/** Counters are an integer each, so more documents can carry one than can carry a draft. */
const MAX_TRACKED_DOCUMENTS = 64

/**
 * The entry, as the newest. Insertion order is recency — the key is re-inserted last — so what is
 * dropped when the map is full is the document touched longest ago, never the one being written.
 */
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

/** Shared so that the state and the ref start as the same empty map, without reading either. */
const NO_CONFLICTS: ReadonlyMap<string, PageWriteConflict> = new Map()

function withoutEntry<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

/** The refused write a page conflict is, read off the problem Core answered with. */
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
  webSocketFactory,
  confidential,
}: WorkspaceCollaborativeDocsProps) {
  const { t, i18n } = useTranslation()
  const collectionCopy = getCollectionCopy(i18n.resolvedLanguage)
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
  const [treeError, setTreeError] = useState<string | null>(null)
  /**
   * One refused write per document, with the draft it refused. The ref is what a callback created
   * in an earlier render reads — a settled fetch, a debounced save — and the state is what the
   * banner renders; `commitConflicts` moves both at once, so no path reads one without the other.
   */
  const conflictsRef = useRef<ReadonlyMap<string, PageWriteConflict>>(NO_CONFLICTS)
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, PageWriteConflict>>(NO_CONFLICTS)
  /** How many times each document's body has been re-read, which is the block editor's identity. */
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
  const saveTimerRef = useRef<ScheduledSave | null>(null)
  /**
   * Each document's latest write or explicit resolution. Every dispatched `PATCH` advances it,
   * so an older response cannot replace the version or conflict belonging to a newer write.
   * Re-reading and forking also advance it: cancelling a timer cannot recall an in-flight write.
   */
  const writeGenerationsRef = useRef<ReadonlyMap<string, number>>(new Map())
  /** The pages as the editor holds them, for a callback that settles after a later render. */
  const docsRef = useRef<readonly WorkspacePageRecord[]>(docs)
  const onDocumentsLoadedRef = useRef(onDocumentsLoaded)
  const protectionRef = useRef(confidential)
  useLayoutEffect(() => {
    protectionRef.current = confidential
    if (confidential?.required && saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current.timer)
      saveTimerRef.current = null
    }
  }, [confidential])

  useLayoutEffect(() => {
    docsRef.current = docs
  }, [docs])

  /**
   * Each refused document's remembered draft, kept in step with the editor. The member goes on
   * typing into a draft no write will take until they resolve the conflict, and the text that has
   * to come back when they return to the page — and that 'keep my draft as a new page' has to
   * save — is the one they typed last, not the one the refused write happened to carry.
   */
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
  /** The refused write the open page is holding, if it is holding one. */
  const activeConflict = activeDocId ? conflicts.get(activeDocId) : undefined

  // Fetch ETag + fresh document + backlinks when switching documents in Core 0.43.0 mode.
  useEffect(() => {
    if (!isRemoteMode || !organisationId || !activeDocId) return
    const abort = new AbortController()

    void getWorkspaceDocument(organisationId, activeDocId, abort.signal)
      .then(({ document: fresh, etag }) => {
        if (abort.signal.aborted) return
        // A page whose write was refused is still holding a draft nobody has saved. Opening it
        // again is not the member choosing the server's version — that choice is the banner's
        // re-read, and it is the only thing that takes the draft off the screen. So the draft
        // comes back with the page, and so does the refusal: a version read on the way in says
        // nothing about a conflict with a collaborator who has already committed.
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
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current.timer)
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

  const handleCreatePage = async (parentId: string | null) => {
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

  /** The draft of a page, as the editor holds it after the render that typed it. */
  const draftOf = (docId: string): { readonly title: string; readonly markdown: string } => {
    const held = docsRef.current.find((d) => d.id === docId)
    return { title: held?.title ?? '', markdown: held?.markdown ?? '' }
  }

  /** The refused state of a page, as it is now, holding the draft the page is holding. */
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

  /**
   * The same, for a write Core refused — except that a page already refused against a
   * collaborator's version stays in that state. Forgetting the version is what makes every write
   * after the first refusal fail for a missing one instead, and `version-required` is the state
   * with no 'keep my draft as a new page' on it: the one action a stale version calls for.
   */
  const noteWriteRefusal = (docId: string, kind: PageWriteConflict['kind']): void => {
    const previous = conflictsRef.current.get(docId)
    setConflictKind(docId, previous?.kind === 'version-conflict' ? 'version-conflict' : kind)
  }

  const forgetConflict = (docId: string): void => {
    if (!conflictsRef.current.has(docId)) return
    commitConflicts(withoutEntry(conflictsRef.current, docId))
  }

  const writeGenerationOf = (docId: string): number => writeGenerationsRef.current.get(docId) ?? 0

  /**
   * Retire earlier responses whenever a new write leaves or an explicit resolution begins.
   * Only the latest generation can update the page's version or its refused-write state.
   */
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

  /**
   * A write Core refused, told as one of the two version states rather than as the generic save
   * error. The refused version is forgotten so that the next write cannot pair the draft with a
   * tag already known to be stale, and so that the state the person is shown is the one the next
   * attempt would actually produce. The draft itself is not touched — that is the whole point.
   *
   * A failure that is not about a version (offline, a refused field, Core unavailable) keeps the
   * standard handling: `console.docs.collab.error-save`, whose "réessayez" is right there and
   * wrong for a precondition.
   */
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

  /** The debounced save, dropped. Named with a page, only when it is that page's save. */
  const cancelScheduledSave = (documentId?: string): void => {
    const scheduled = saveTimerRef.current
    if (scheduled === null) return
    if (documentId !== undefined && scheduled.documentId !== documentId) return
    clearTimeout(scheduled.timer)
    saveTimerRef.current = null
  }

  const scheduleRemotePatch = (
    docId: string,
    patch: { title?: string; markdown?: string; parentId?: string | null }
  ) => {
    if (!isRemoteMode || !organisationId) return
    if (conflictsRef.current.get(docId)?.kind === 'version-conflict') {
      // The version this tab held was refused against a collaborator's and nothing has replaced
      // it, so this write would be refused in turn — and its refusal would report the missing
      // version the first one left behind rather than the conflict that is actually open, taking
      // 'keep my draft as a new page' off the screen with it. Nothing goes out until one of the
      // two actions ends the conflict. The draft is not lost by not being sent: it is held
      // against the page, so the action that saves it saves what is typed now.
      cancelScheduledSave(docId)
      return
    }
    cancelScheduledSave()
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (protectionRef.current?.required && patch.markdown !== undefined) return
      if (conflictsRef.current.get(docId)?.kind === 'version-conflict') return
      const etag = etagsRef.current.get(docId)
      if (!etag) {
        // The page is on the server and its version is not here, so the write would have to go out
        // with no `If-Match` — the client-side half of `precondition-required`. Refused before it
        // is sent: an unconditional body write replaces whatever a collaborator wrote meanwhile.
        // Silence was the old answer, and it left the draft looking saved when nothing was.
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
          // A newer write or explicit resolution now owns the version and conflict state.
          if (writeGenerationOf(docId) !== generation) return
          if (nextEtag) etagsRef.current.set(docId, nextEtag)
          forgetConflict(docId)
        })
        .catch((error: unknown) => {
          if (writeGenerationOf(docId) !== generation) return
          reportWriteFailure(docId, error)
        })
    }, 350)
    saveTimerRef.current = { documentId: docId, timer }
  }

  /**
   * Make the block editor render the page the re-read just brought.
   *
   * `CollaborativeBlockEditor` is keyed per document and seeds its `Y.Doc` from Markdown once
   * (`seededYdocRef`), so a document whose body is replaced under it keeps the fragment it was
   * seeded with. The next keystroke would then serialize the body from before the re-read and
   * send it with the version the re-read brought: the collaborator's commit overwritten by the
   * very draft the member asked to replace, and this time with a version the server accepts.
   *
   * The document's reload epoch moves its key, so the editor is rebuilt, and tells it that this
   * mount replaces a body rather than resuming one — the one case where it seeds over a fragment
   * that already has content. Only where no collaboration session owns the body: the epoch is
   * what `replacesSeededBody` reads, and the editor seeds at all only under
   * `maySeedFromMarkdown`, which is false under a live session and under a confidential policy.
   * Where a session owns the body it holds the authoritative state and every participant's share
   * of it, and a re-read of this tab's own has no business replacing it.
   */
  const resetSeededBody = (docId: string): void => {
    setBodyReloadEpochs((prev) =>
      withNewestEntry(prev, docId, (prev.get(docId) ?? 0) + 1, MAX_TRACKED_DOCUMENTS)
    )
  }

  /**
   * The server's version of the page, fetched with a fresh tag, replacing the draft because the
   * person asked for it. Nothing here is automatic: the other action exists so that a draft worth
   * keeping is kept first, and this one is the deliberate "show me theirs".
   */
  const handleReloadLatestVersion = async () => {
    const docId = activeDocId
    if (!docId || !activeConflict || !organisationId) return
    // A debounced write still in flight would re-send the refused version over what we are about
    // to read, and land after it. The timer is dropped, and the generation retires what has
    // already left the tab: no timer can be cleared for a request whose answer is on its way.
    cancelScheduledSave(docId)
    const generation = supersedeWrites(docId)

    try {
      const { document: fresh, etag } = await getWorkspaceDocument(organisationId, docId)
      // Another resolution overtook this read — a second re-read, or the draft kept as a page.
      if (writeGenerationOf(docId) !== generation) return
      if (!etag) {
        // No version came back with the page, so no write could carry one either: keep the draft
        // and keep saying so, rather than overwriting it with a page that still cannot be saved.
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

  /**
   * The draft, kept as a page of its own, so that choosing to look at the server's version never
   * costs the person their text. The body is a second write on purpose: `WorkspaceDocumentRequest`
   * carries a title, a parent and a starter template and no Markdown, so the draft's text can only
   * arrive as a patch — with the version the creation just handed back, which nobody else can have
   * moved yet. Awaited before the new page is selected, because selecting it re-reads it.
   */
  const handleSaveDraftAsNewPage = async () => {
    const docId = activeDocId
    const draft = docId ? docs.find((d) => d.id === docId) : undefined
    if (!docId || !activeConflict || !draft || !organisationId) return
    const savedDraft = { title: draft.title, markdown: draft.markdown }
    cancelScheduledSave(docId)
    // The draft leaves for a page of its own, so the refused write it came from is retired with
    // it: an answer still on its way speaks for a version this page no longer holds.
    supersedeWrites(docId)

    try {
      const { document: created, etag } = await createWorkspaceDocument(organisationId, {
        title: savedDraft.title.trim(),
        parentId: draft.parentId,
      })
      let version = etag
      if (savedDraft.markdown.length > 0) {
        if (!version) {
          // Same refusal as `putWorkspaceCollectionRow`'s and `updateWorkspaceDocumentMetadata`'s:
          // a body write without a version is not sent. Reported below, with the banner left up,
          // so the draft stays in the editor where it still is.
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
    if (new TextEncoder().encode(nextMarkdown).length > 262_144) return
    commitDocs((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, markdown: nextMarkdown } : d))
    )
    // With a server session the body travels over the realtime socket only. While it is synced the
    // collaboration server commits the body and its Markdown itself: a second REST write carried
    // the tag read on open, which that commit had made stale, so it failed with 412 on every edit
    // and would replace the whole fragment under a collaborator typing at the same time. Before
    // the server state arrives (connecting, reconnecting, offline) the editor is not seeded, so
    // the body it serializes is a fragment of the page and a REST write would replace the page
    // with it. Markdown goes over REST only when it is the document: the same rule as seeding.
    if (!maySeedFromMarkdown(isRemoteMode, collabSnapshot.status, confidential)) return
    scheduleRemotePatch(currentDoc.id, { markdown: nextMarkdown })
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
        // Same refusal as a scheduled patch with no version: the move stays local and is reported,
        // rather than going out with no `If-Match` or being dropped without a word.
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

  /**
   * Whether the draft can be kept as a page of its own, which is only true of a conflict with a
   * colleague: `version-required` means this tab never had a version to begin with, and the fix
   * for that is the re-read, not a second page. A confidential policy excludes it too — under one
   * the body never travels over REST at all (`maySeedFromMarkdown`), so a copy written that way
   * would be the one write the policy exists to prevent. A title is what the creation needs.
   */
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

  /**
   * The block editor's identity: the page, and how many times its body has been re-read. A
   * re-read that left the key alone would keep an editor seeded from the body before it.
   */
  const bodyReloadEpoch = currentDoc ? (bodyReloadEpochs.get(currentDoc.id) ?? 0) : 0
  const blockEditorKey = currentDoc ? `${currentDoc.id}#${bodyReloadEpoch}` : ''

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
                const isSelected = node.doc.id === currentDoc?.id
                return (
                  <li key={node.doc.id}>
                    <button
                      type="button"
                      data-testid={`docs-tree-item-${node.doc.id}`}
                      data-depth={node.depth}
                      aria-current={isSelected ? 'page' : undefined}
                      onClick={() => {
                        selectDocument(node.doc.id)
                        if (editorSurface === 'collections') {
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

      <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-md border border-c-border-soft bg-c-surface p-4">
        {treeError ? (
          <div role="alert" data-testid="docs-tree-error">
            <InlineAlert kind="error">{treeError}</InlineAlert>
          </div>
        ) : null}

        {/*
          The refused write and the two ways out of it. `InlineAlert kind="error"` is
          `role="alert"`, implicitly `aria-live="assertive"` — which is what a refusal needs: a
          polite announcement can be queued behind a presence update and reach the person after
          they have typed another paragraph into a draft they believe is saved. The sentence is
          one of two governed catalogue sentences, by precondition, and neither names a status
          number nor asks for a retry of the write that was just refused.

          The actions are outside the alert on purpose: a live region announces its contents, and
          two buttons read back as part of the sentence. They are plain buttons, so they are in
          the tab order with the editor's focus ring and the shared touch-target minimum.
        */}
        {activeConflict !== undefined ? (
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

        {/*
          Mounted empty and filled when the draft has landed somewhere of its own: a polite region
          inserted with its content already in it is often not announced at all, so the region is
          here from the first render and the alert inside it carries no role of its own.
        */}
        <div role="status">
          {draftCopiedTo !== null ? (
            <InlineAlert kind="success" inLiveRegion data-testid="page-conflict-draft-saved">
              {t('console.docs.collab.notice-draft-saved-as-page', { title: draftCopiedTo })}
            </InlineAlert>
          ) : null}
        </div>

        {currentDoc && currentNode ? (
          <>
            <header className="flex flex-col gap-3 border-b border-c-border-soft pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CollaboratorPresence
                  status={collabSnapshot.status}
                  role={effectiveRole}
                  peers={collabSnapshot.peers}
                />

                <div role="group" className="flex flex-wrap items-center gap-1">
                  {(['blocks', 'markdown', 'collections'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      data-testid={`docs-surface-${mode}`}
                      aria-pressed={editorSurface === mode}
                      onClick={() => setEditorSurface(mode)}
                      className={cx(
                        'inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET,
                        editorSurface === mode
                          ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                          : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                      )}
                    >
                      {mode === 'blocks'
                        ? t('console.docs.collab.mode-blocks')
                        : mode === 'markdown'
                          ? t('console.docs.collab.mode-markdown')
                          : collectionCopy.modeCollections}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                    className="h-10 w-full rounded-md border border-c-border-input bg-c-surface px-3 text-md font-semibold text-c-ink read-only:bg-c-sunken read-only:text-c-ink-2 focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                </div>

                {effectiveRole === 'editor' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor={parentSelectId} className="text-xs font-medium text-c-ink-2">
                        {t('console.docs.collab.label-parent-page')}
                      </label>
                      <select
                        id={parentSelectId}
                        data-testid="docs-parent-select"
                        value={currentDoc.parentId ?? ''}
                        onChange={(event) => void handleReparent(event.target.value || null)}
                        className="h-8 max-w-[176px] rounded-md border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
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
                    </div>

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
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('console.docs.collab.action-delete-page')}
                      onClick={() => void handleDelete()}
                    >
                      {t('console.docs.collab.action-delete-page')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </header>

            {editorSurface === 'collections' ? (
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
                  activeDocumentId={currentDoc.id}
                  accessRole={effectiveRole}
                  onOpenDocument={(docId) => {
                    selectDocument(docId)
                    setEditorSurface('blocks')
                  }}
                  onCreateDocument={handleCreateCollectionEntry}
                />
              </Suspense>
            ) : editorSurface === 'blocks' ? (
              <CollaborativeBlockEditor
                key={blockEditorKey}
                documentId={currentDoc.id}
                markdown={currentDoc.markdown}
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
              />
            ) : (
              <textarea
                aria-label={t('console.docs.collab.mode-markdown')}
                readOnly={effectiveRole === 'viewer'}
                value={currentDoc.markdown}
                onChange={(event) => handleMarkdownChange(event.target.value)}
                rows={12}
                className="w-full rounded-md border border-c-border-input bg-c-surface p-3 font-mono text-xs text-c-ink read-only:bg-c-sunken focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            )}

            {editorSurface !== 'collections' ? (
              <BacklinksFooter
                backlinks={effectiveBacklinks}
                onSelectDocument={(docId) => selectDocument(docId)}
              />
            ) : null}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-end gap-1 border-b border-c-border-soft pb-3">
              <div role="group" className="flex flex-wrap items-center gap-1">
                {(['blocks', 'collections'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`docs-surface-${mode}`}
                    aria-pressed={editorSurface === mode}
                    onClick={() => setEditorSurface(mode)}
                    className={cx(
                      'inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                      TOUCH_TARGET,
                      editorSurface === mode
                        ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                        : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                    )}
                  >
                    {mode === 'blocks'
                      ? t('console.docs.collab.mode-blocks')
                      : collectionCopy.modeCollections}
                  </button>
                ))}
              </div>
            </div>
            {editorSurface === 'collections' ? (
              <Suspense
                fallback={
                  <p role="status" className="py-4 text-xs text-c-ink-3">
                    {collectionCopy.loadingCollections}
                  </p>
                }
              >
                <LazyDocsCollectionView
                  organisationId={isRemoteMode ? organisationId : undefined}
                  documents={[]}
                  members={effectiveMembers}
                  accessRole="editor"
                  onOpenDocument={(docId) => {
                    selectDocument(docId)
                    setEditorSurface('blocks')
                  }}
                  onCreateDocument={handleCreateCollectionEntry}
                />
              </Suspense>
            ) : (
              <p className="py-8 text-center text-sm text-c-ink-3">
                {t('console.docs.collab.empty-workspace')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default WorkspaceCollaborativeDocs
