import { MarkdownDraftEditor } from './MarkdownDraftEditor'
import { useId, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { channelDocsMessages } from './channelDocsMessages'
import type { DocumentComment, DocumentMember } from './documentComments'

export interface ChannelDoc {
  readonly id: string
  readonly channelId: string
  readonly title: string
  readonly content: string
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

export function ChannelDocsEditor({
  channelId,
  channelName,
  workspace,
  onWorkspaceChange,
  onPublish,
  members = [],
  author,
}: {
  readonly channelId: string
  readonly channelName: string
  readonly workspace: ChannelDocsWorkspace
  readonly onWorkspaceChange: Dispatch<SetStateAction<ChannelDocsWorkspace>>
  readonly onPublish: (title: string, content: string, documentId: string) => Promise<void>
  readonly members?: readonly DocumentMember[]
  readonly author?: DocumentMember | undefined
}) {
  const { i18n } = useTranslation()
  const copy = channelDocsMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const titleId = useId()
  const templateId = useId()
  const [template, setTemplate] = useState<'blank' | 'meeting' | 'decision'>('blank')
  const [status, setStatus] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const docs = workspace.docs.filter((doc) => doc.channelId === channelId)
  const current = docs.find((doc) => doc.id === workspace.selectedByChannel[channelId]) ?? docs[0]
  const create = () => {
    if (workspace.docs.length >= 64) {
      setStatus(copy.limit)
      return
    }
    const doc = {
      id: crypto.randomUUID(),
      channelId,
      title: `${copy.newTitle} ${docs.length + 1}`,
      content: copy.templates[template],
    }
    onWorkspaceChange((prev) => ({
      docs: [...prev.docs, doc],
      selectedByChannel: { ...prev.selectedByChannel, [channelId]: doc.id },
    }))
    setStatus(null)
  }
  const update = (patch: Partial<Pick<ChannelDoc, 'title' | 'content'>>) => {
    if (!current) return
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
  const publish = async () => {
    if (!current || publishing) return
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
            onChange={(event) => setTemplate(event.target.value as typeof template)}
            className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink"
          >
            {(['blank', 'meeting', 'decision'] as const).map((key) => (
              <option key={key} value={key}>
                {copy[key]}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={create}>
            {copy.new}
          </Button>
        </div>
        {current ? (
          <>
            <nav aria-label={copy.documents} className="flex flex-wrap gap-2 pb-3">
              {docs.map((doc) => (
                <button
                  type="button"
                  key={doc.id}
                  aria-pressed={doc.id === current.id}
                  onClick={() => {
                    onWorkspaceChange((prev) => ({
                      ...prev,
                      selectedByChannel: { ...prev.selectedByChannel, [channelId]: doc.id },
                    }))
                    setStatus(null)
                  }}
                  className={cx(
                    'min-h-10 rounded-md border px-3 py-2 text-sm focus-visible:ring',
                    doc.id === current.id
                      ? 'border-c-border bg-c-ok-soft font-bold text-c-ink'
                      : 'border-c-border bg-c-surface text-c-ink'
                  )}
                >
                  {doc.title}
                </button>
              ))}
            </nav>
            <label htmlFor={titleId} className="flex flex-col gap-2 text-sm text-c-ink">
              {copy.documentTitle}
              <input
                id={titleId}
                value={current.title}
                maxLength={120}
                onChange={(event) => update({ title: event.target.value })}
                className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink focus-visible:ring"
              />
            </label>
          </>
        ) : (
          <p className="text-sm text-c-ink-2">{copy.empty}</p>
        )}
      </details>
      {current ? (
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
              docs: prev.docs.map((doc) => (doc.id === current.id ? { ...doc, comments } : doc)),
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
      ) : null}
      {status ? (
        <p role="status" className="p-3 text-sm text-c-ink-2">
          {status}
        </p>
      ) : null}
    </section>
  )
}
