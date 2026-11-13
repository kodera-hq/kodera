import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { BacklinksFooter } from './BacklinksFooter'
import { CollaborativeBlockEditor } from './CollaborativeBlockEditor'
import { CollaboratorPresence } from './CollaboratorPresence'
import {
  CollabSessionController,
  type CollabSessionSnapshot,
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
  listWorkspaceDocumentBacklinks,
  listWorkspaceDocuments,
  updateWorkspaceDocument,
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

export interface WorkspaceCollaborativeDocsProps {
  readonly organisationId?: string | undefined
  readonly currentUser?:
    | {
        readonly id: string
        readonly name: string
      }
    | undefined
  readonly activeDocumentId?: string | undefined
  readonly onActiveDocumentChange?: ((documentId: string) => void) | undefined
  readonly onDocumentsLoaded?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
  readonly localDocuments?: readonly WorkspacePageRecord[] | undefined
  readonly onLocalDocumentsChange?: ((docs: readonly WorkspacePageRecord[]) => void) | undefined
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
  activeDocumentId,
  onActiveDocumentChange,
  onDocumentsLoaded,
  localDocuments,
  onLocalDocumentsChange,
  webSocketFactory,
}: WorkspaceCollaborativeDocsProps) {
  const { t, i18n } = useTranslation()
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
  const [editorSurface, setEditorSurface] = useState<'blocks' | 'markdown'>('blocks')
  const [treeError, setTreeError] = useState<string | null>(null)
  const [remoteBacklinksEntry, setRemoteBacklinksEntry] = useState<{
    readonly docId: string
    readonly items: readonly DocumentBacklinkItem[]
  } | null>(null)
  const [controllerBridge] = useState(() => new CollabControllerBridge())

  const etagsRef = useRef<Map<string, string>>(new Map())
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDocumentsLoadedRef = useRef(onDocumentsLoaded)

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

  // Fetch ETag + fresh document + backlinks when switching documents in Core 0.43.0 mode.
  useEffect(() => {
    if (!isRemoteMode || !organisationId || !activeDocId) return
    const abort = new AbortController()

    void getWorkspaceDocument(organisationId, activeDocId, abort.signal)
      .then(({ document: fresh, etag }) => {
        if (abort.signal.aborted) return
        if (etag) etagsRef.current.set(activeDocId, etag)
        setInternalDocs((prev) =>
          prev.map((d) =>
            d.id === activeDocId
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
    currentUser.id,
    currentUser.name,
    isRemoteMode,
    organisationId,
    webSocketFactory,
  ])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
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

  const scheduleRemotePatch = (
    docId: string,
    patch: { title?: string; markdown?: string; parentId?: string | null }
  ) => {
    if (!isRemoteMode || !organisationId) return
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const etag = etagsRef.current.get(docId)
      if (!etag) return
      void updateWorkspaceDocument(organisationId, docId, etag, patch)
        .then(({ etag: nextEtag }) => {
          if (nextEtag) etagsRef.current.set(docId, nextEtag)
        })
        .catch(() => {
          setTreeError(t('console.docs.collab.error-save'))
        })
    }, 350)
  }

  const handleTitleChange = (nextTitle: string) => {
    if (!currentDoc || effectiveRole === 'viewer') return
    if (nextTitle.length > 120) return
    setTreeError(null)
    commitDocs((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, title: nextTitle } : d))
    )
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
      if (etag) {
        try {
          const { etag: nextEtag } = await updateWorkspaceDocument(
            organisationId,
            currentDoc.id,
            etag,
            { parentId: nextParentId }
          )
          if (nextEtag) etagsRef.current.set(currentDoc.id, nextEtag)
        } catch {
          setTreeError(t('console.docs.collab.error-save'))
        }
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

  const ydocForEditor = useMemo(() => {
    if (!sessionController) return undefined
    if (effectiveRole === 'viewer') {
      const hasContent = sessionController.ydoc.getXmlFragment('content').length > 0
      return hasContent || collabSnapshot.status === 'synced'
        ? sessionController.ydoc
        : undefined
    }
    return sessionController.ydoc
  }, [collabSnapshot.status, effectiveRole, sessionController])

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
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handleCreatePage(null)}
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
                      onClick={() => selectDocument(node.doc.id)}
                      className={cx(
                        'flex min-h-8 w-full items-center justify-between gap-2 rounded-md pr-2 py-1 text-left text-xs focus-visible:ring focus-visible:outline-hidden',
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
                  {(['blocks', 'markdown'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
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
                        : t('console.docs.collab.mode-markdown')}
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
                    className="h-10 w-full rounded-md border border-c-border-input bg-c-surface px-3 text-md font-semibold text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden read-only:bg-c-sunken read-only:text-c-ink-2"
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
                        onChange={(event) =>
                          void handleReparent(event.target.value || null)
                        }
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

            {editorSurface === 'blocks' ? (
              <CollaborativeBlockEditor
                key={currentDoc.id}
                documentId={currentDoc.id}
                markdown={currentDoc.markdown}
                onMarkdownChange={handleMarkdownChange}
                role={effectiveRole}
                ydoc={ydocForEditor}
                seedMarkdown={!isRemoteMode || currentDoc.markdown.length > 0}
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
                className="w-full rounded-md border border-c-border-input bg-c-surface p-3 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden read-only:bg-c-sunken"
              />
            )}

            <BacklinksFooter
              backlinks={effectiveBacklinks}
              onSelectDocument={(docId) => selectDocument(docId)}
            />
          </>
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
