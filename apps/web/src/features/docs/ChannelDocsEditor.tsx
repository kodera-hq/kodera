import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { BacklinksFooter } from './BacklinksFooter'
import { channelDocsMessages } from './channelDocsMessages'
import type { DocumentComment, DocumentMember } from './documentComments'
import { MarkdownDraftEditor } from './MarkdownDraftEditor'
import {
  buildDocumentTree,
  canCreateDocumentUnderParent,
  canDeleteDocument,
  canReparentDocument,
  deleteLeafDocument,
  getDocumentStarterTemplate,
  reorderSiblingDocument,
  reparentDocument,
  type DocumentAccessRole,
  type WorkspaceCoreTemplateKey,
} from './pageTree'
import { computeLocalBacklinks, resolveWikilinkTarget } from './wikilinks'

const LazyCollaborativeBlockEditor = lazy(() => import('./CollaborativeBlockEditor'))

export type ChannelDocTemplateChoice =
  | 'blank'
  | 'meeting'
  | 'decision'
  | WorkspaceCoreTemplateKey

export interface ChannelDoc {
  readonly id: string
  readonly channelId: string
  readonly title: string
  readonly content: string
  readonly parentId?: string | null | undefined
  readonly order?: number | undefined
  readonly role?: DocumentAccessRole | undefined
  readonly comments?: readonly DocumentComment[] | undefined
}
export interface ChannelDocsWorkspace {
  readonly docs: readonly ChannelDoc[]
  readonly selectedByChannel: Readonly<Record<string, string>>
}
export const createChannelDocsWorkspace = (): ChannelDocsWorkspace => ({
  docs: [],
  selectedByChannel: {},
})

const TREE_PAD_BY_DEPTH: Readonly<Record<number, string>> = {
  1: 'pl-3',
  2: 'pl-5',
  3: 'pl-6',
  4: 'pl-8',
  5: 'pl-10',
  6: 'pl-12',
}

export function ChannelDocsEditor({
  channelId,
  channelName,
  workspace,
  onWorkspaceChange,
  onPublish,
  onNavigateDocument,
  members = [],
  author,
}: {
  readonly channelId: string
  readonly channelName: string
  readonly workspace: ChannelDocsWorkspace
  readonly onWorkspaceChange: Dispatch<SetStateAction<ChannelDocsWorkspace>>
  readonly onPublish: (title: string, content: string, documentId: string) => Promise<void>
  readonly onNavigateDocument?: ((doc: ChannelDoc) => void) | undefined
  readonly members?: readonly DocumentMember[]
  readonly author?: DocumentMember | undefined
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = channelDocsMessages[locale]
  const titleId = useId()
  const templateId = useId()
  const parentSelectId = useId()

  const [template, setTemplate] = useState<ChannelDocTemplateChoice>('blank')
  const [editorMode, setEditorMode] = useState<'markdown' | 'blocks'>('markdown')
  const [status, setStatus] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const docs = useMemo(
    () => workspace.docs.filter((doc) => doc.channelId === channelId),
    [workspace.docs, channelId]
  )
  const treeNodes = useMemo(() => buildDocumentTree(docs), [docs])
  const selectedId = workspace.selectedByChannel[channelId]
  const currentNode =
    treeNodes.find((node) => node.doc.id === selectedId) ?? treeNodes[0]
  const current = currentNode?.doc
  const currentRole: DocumentAccessRole = current?.role === 'viewer' ? 'viewer' : 'editor'

  const resolveTemplateMarkdown = (choice: ChannelDocTemplateChoice): string => {
    if (choice === 'blank' || choice === 'meeting' || choice === 'decision') {
      return copy.templates[choice]
    }
    return getDocumentStarterTemplate(choice, locale).markdown
  }

  const create = (parentId: string | null = null) => {
    if (workspace.docs.length >= 64) {
      setStatus(copy.limit)
      return
    }
    const depthCheck = canCreateDocumentUnderParent(docs, parentId)
    if (!depthCheck.ok) {
      setStatus(t('console.docs.collab.error-max-depth'))
      return
    }
    const doc: ChannelDoc = {
      id: crypto.randomUUID(),
      channelId,
      parentId,
      order: docs.length,
      role: 'editor',
      title: `${copy.newTitle} ${docs.length + 1}`,
      content: resolveTemplateMarkdown(template),
    }
    onWorkspaceChange((prev) => ({
      docs: [...prev.docs, doc],
      selectedByChannel: { ...prev.selectedByChannel, [channelId]: doc.id },
    }))
    setStatus(null)
  }

  const update = (patch: Partial<Pick<ChannelDoc, 'title' | 'content'>>) => {
    if (!current || currentRole === 'viewer') return
    if (
      (patch.title?.length ?? 0) > 120 ||
      new TextEncoder().encode(patch.content ?? '').length > 65_536
    ) {
      setStatus(copy.limit)
      return
    }
    onWorkspaceChange((prev) => ({
      ...prev,
      docs: prev.docs.map((doc) => (doc.id === current.id ? { ...doc, ...patch } : doc)),
    }))
    setStatus(null)
  }

  const reparentCurrent = (nextParentId: string | null) => {
    if (!current || currentRole === 'viewer') return
    const check = canReparentDocument(docs, current.id, nextParentId)
    if (!check.ok) {
      setStatus(
        check.reason === 'cycle_detected'
          ? t('console.docs.collab.error-cycle')
          : t('console.docs.collab.error-max-depth')
      )
      return
    }
    const mutated = reparentDocument(docs, current.id, nextParentId)
    if (!mutated.ok) return
    const byId = new Map(mutated.docs.map((d) => [d.id, d]))
    onWorkspaceChange((prev) => ({
      ...prev,
      docs: prev.docs.map((d) => byId.get(d.id) ?? d),
    }))
    setStatus(null)
  }

  const reorderCurrent = (direction: 'up' | 'down') => {
    if (!current || currentRole === 'viewer') return
    const mutated = reorderSiblingDocument(docs, current.id, direction)
    if (!mutated.ok) return
    const byId = new Map(mutated.docs.map((d) => [d.id, d]))
    onWorkspaceChange((prev) => ({
      ...prev,
      docs: prev.docs.map((d) => byId.get(d.id) ?? d),
    }))
    setStatus(null)
  }

  const deleteCurrent = () => {
    if (!current || currentRole === 'viewer') return
    const check = canDeleteDocument(docs, current.id)
    if (!check.ok) {
      if (check.reason === 'has_children') {
        setStatus(t('console.docs.collab.error-delete-has-children'))
      }
      return
    }
    const mutated = deleteLeafDocument(docs, current.id)
    if (!mutated.ok) return
    const nextSelected = mutated.docs[0]?.id
    onWorkspaceChange((prev) => {
      const nextMap = { ...prev.selectedByChannel }
      if (nextSelected) nextMap[channelId] = nextSelected
      else delete nextMap[channelId]
      return {
        docs: prev.docs.filter((d) => d.id !== current.id),
        selectedByChannel: nextMap,
      }
    })
    setStatus(null)
  }

  const publish = async () => {
    if (!current || currentRole === 'viewer' || publishing) return
    setPublishing(true)
    try {
      await onPublish(current.title, current.content, current.id)
      setStatus(copy.published)
    } catch {
      setStatus(copy.failed)
    } finally {
      setPublishing(false)
    }
  }

  const backlinks = useMemo(
    () => (current ? computeLocalBacklinks(workspace.docs, current.id) : []),
    [current, workspace.docs]
  )

  const openLinkedDoc = (targetDoc: ChannelDoc) => {
    onWorkspaceChange((prev) => ({
      ...prev,
      selectedByChannel: { ...prev.selectedByChannel, [targetDoc.channelId]: targetDoc.id },
    }))
    setStatus(null)
    if (targetDoc.channelId !== channelId) {
      onNavigateDocument?.(targetDoc)
    }
  }

  return (
    <section aria-label={copy.title} className="flex min-h-0 flex-col bg-c-surface">
      <details open={!current} className="border-b border-c-border-soft p-3">
        <summary className="cursor-pointer text-sm font-bold text-c-ink focus-visible:ring">
          {copy.documents}
        </summary>
        <div className="flex flex-wrap items-center gap-3 py-3">
          <label htmlFor={templateId} className="text-sm text-c-ink-2">
            {copy.template}
          </label>
          <select
            id={templateId}
            value={template}
            onChange={(event) => setTemplate(event.target.value as ChannelDocTemplateChoice)}
            className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink"
          >
            <option value="blank">{copy.blank}</option>
            <option value="meeting">{copy.meeting}</option>
            <option value="decision">{copy.decision}</option>
            <option value="spec">{t('console.docs.collab.template-spec')}</option>
            <option value="adr">{t('console.docs.collab.template-adr')}</option>
            <option value="meeting_notes">{t('console.docs.collab.template-meeting-notes')}</option>
            <option value="runbook">{t('console.docs.collab.template-runbook')}</option>
          </select>
          <Button variant="secondary" onClick={() => create(null)}>
            {copy.new}
          </Button>
          {current && currentRole === 'editor' ? (
            <Button variant="secondary" onClick={() => create(current.id)}>
              {t('console.docs.collab.action-new-subpage')}
            </Button>
          ) : null}
        </div>
        {current && currentNode ? (
          <div className="flex flex-col gap-3">
            <nav aria-label={copy.documents} className="flex flex-wrap gap-2 pb-1">
              {treeNodes.map((node) => {
                const padClass = TREE_PAD_BY_DEPTH[Math.min(6, node.depth)] ?? 'pl-12'
                return (
                  <button
                    type="button"
                    key={node.doc.id}
                    aria-pressed={node.doc.id === current.id}
                    onClick={() => {
                      onWorkspaceChange((prev) => ({
                        ...prev,
                        selectedByChannel: {
                          ...prev.selectedByChannel,
                          [channelId]: node.doc.id,
                        },
                      }))
                      setStatus(null)
                    }}
                    className={cx(
                      'min-h-10 rounded-md border pr-3 py-2 text-sm focus-visible:ring',
                      padClass,
                      node.doc.id === current.id
                        ? 'border-c-border bg-c-ok-soft font-bold text-c-ink'
                        : 'border-c-border bg-c-surface text-c-ink'
                    )}
                  >
                    {node.depth > 1 ? `↳ ${node.doc.title}` : node.doc.title}
                  </button>
                )
              })}
            </nav>

            <label htmlFor={titleId} className="flex flex-col gap-2 text-sm text-c-ink">
              {copy.documentTitle}
              <input
                id={titleId}
                value={current.title}
                maxLength={120}
                readOnly={currentRole === 'viewer'}
                onChange={(event) => update({ title: event.target.value })}
                className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink focus-visible:ring read-only:bg-c-sunken"
              />
            </label>

            {currentRole === 'editor' ? (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={parentSelectId} className="text-xs font-medium text-c-ink-2">
                  {t('console.docs.collab.label-parent-page')}
                </label>
                <select
                  id={parentSelectId}
                  value={current.parentId ?? ''}
                  onChange={(event) => reparentCurrent(event.target.value || null)}
                  className="h-8 rounded-md border border-c-border-input bg-c-surface px-2 text-xs text-c-ink focus-visible:ring"
                >
                  <option value="">{t('console.docs.collab.option-root-page')}</option>
                  {treeNodes
                    .filter((node) => node.doc.id !== current.id)
                    .map((node) => (
                      <option key={node.doc.id} value={node.doc.id}>
                        {node.pathTitles.join(' / ')}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={currentNode.siblingIndex === 0}
                  aria-label={t('console.docs.collab.action-move-up')}
                  onClick={() => reorderCurrent('up')}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={currentNode.siblingIndex >= currentNode.siblingCount - 1}
                  aria-label={t('console.docs.collab.action-move-down')}
                  onClick={() => reorderCurrent('down')}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('console.docs.collab.action-delete-page')}
                  onClick={deleteCurrent}
                >
                  {t('console.docs.collab.action-delete-page')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-c-ink-2">{copy.empty}</p>
        )}
      </details>

      {current ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-c-border-soft px-3 py-2">
            <div role="group" className="flex flex-wrap items-center gap-1">
              {(['markdown', 'blocks'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={editorMode === mode}
                  onClick={() => setEditorMode(mode)}
                  className={cx(
                    'inline-flex min-h-8 items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    editorMode === mode
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                      : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                  )}
                >
                  {mode === 'markdown'
                    ? t('console.docs.collab.mode-markdown')
                    : t('console.docs.collab.mode-blocks')}
                </button>
              ))}
            </div>
          </div>

          {editorMode === 'blocks' ? (
            <div className="p-3">
              <Suspense
                fallback={
                  <p className="py-4 text-xs text-c-ink-2">
                    {t('console.docs.collab.editor-loading')}
                  </p>
                }
              >
                <LazyCollaborativeBlockEditor
                  key={current.id}
                  documentId={current.id}
                  markdown={current.content}
                  onMarkdownChange={(content) => update({ content })}
                  role={currentRole}
                  availablePages={workspace.docs}
                  onNavigateWikilink={(targetTitle) => {
                    const resolved = resolveWikilinkTarget(workspace.docs, targetTitle)
                    if (resolved) openLinkedDoc(resolved)
                  }}
                />
              </Suspense>
            </div>
          ) : currentRole === 'viewer' ? (
            <div className="flex flex-col gap-2 p-3">
              <InlineAlert kind="info">{t('console.docs.collab.banner-readonly')}</InlineAlert>
              <textarea
                aria-label={copy.body}
                readOnly
                value={current.content}
                rows={10}
                className="w-full rounded-md border border-c-border-input bg-c-sunken p-3 font-mono text-sm text-c-ink"
              />
            </div>
          ) : (
            <MarkdownDraftEditor
              key={current.id}
              title={current.title}
              channelName={channelName}
              content={current.content}
              onChange={(content) => update({ content })}
              members={members}
              author={author}
              commentThreads={current.comments ?? []}
              onCommentsChange={(comments) =>
                onWorkspaceChange((prev) => ({
                  ...prev,
                  docs: prev.docs.map((doc) =>
                    doc.id === current.id ? { ...doc, comments } : doc
                  ),
                }))
              }
              shareAction={
                <Button
                  disabled={publishing || !current.title.trim() || !current.content.trim()}
                  onClick={() => void publish()}
                >
                  {copy.publish}
                </Button>
              }
            />
          )}

          <BacklinksFooter
            backlinks={backlinks}
            onSelectDocument={(docId) => {
              const target = workspace.docs.find((d) => d.id === docId)
              if (target) openLinkedDoc(target)
            }}
          />
        </>
      ) : null}

      {status ? (
        <p role="status" className="p-3 text-sm text-c-ink-2">
          {status}
        </p>
      ) : null}
    </section>
  )
}
