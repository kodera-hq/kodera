import { useId, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { channelDocsMessages } from './channelDocsMessages'

export interface ChannelDoc {
  readonly id: string
  readonly channelId: string
  readonly title: string
  readonly content: string
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
}: {
  readonly channelId: string
  readonly channelName: string
  readonly workspace: ChannelDocsWorkspace
  readonly onWorkspaceChange: Dispatch<SetStateAction<ChannelDocsWorkspace>>
  readonly onPublish: (title: string, content: string) => Promise<void>
}) {
  const { i18n } = useTranslation()
  const copy = channelDocsMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const titleId = useId()
  const bodyId = useId()
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
      await onPublish(current.title, current.content)
      setStatus(copy.published)
    } catch {
      setStatus(copy.failed)
    } finally {
      setPublishing(false)
    }
  }
  const download = () => {
    if (!current) return
    const url = URL.createObjectURL(
      new Blob([current.content], { type: 'text/markdown;charset=utf-8' })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${current.id}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section
      aria-label={copy.title}
      className="flex min-h-0 flex-col gap-4 rounded-lg border border-c-border bg-c-surface p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-c-ink">
            {copy.title} · #{channelName}
          </h2>
          <p className="text-xs text-c-ink-3">{copy.local}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
      </header>
      {current ? (
        <>
          <nav aria-label={copy.documents} className="flex flex-wrap gap-2">
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
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border bg-c-surface text-c-ink'
                )}
              >
                {doc.title}
              </button>
            ))}
          </nav>
          <label htmlFor={titleId} className="text-sm font-medium text-c-ink">
            {copy.documentTitle}
          </label>
          <input
            id={titleId}
            value={current.title}
            maxLength={120}
            onChange={(event) => update({ title: event.target.value })}
            className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-c-ink focus-visible:ring"
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label htmlFor={bodyId} className="text-sm font-medium text-c-ink">
                {copy.body}
              </label>
              <textarea
                id={bodyId}
                value={current.content}
                rows={12}
                onChange={(event) => update({ content: event.target.value })}
                className="w-full flex-1 rounded-md border border-c-border-input bg-c-surface p-3 font-mono text-sm text-c-ink focus-visible:ring"
              />
            </div>
            <section
              aria-label={copy.preview}
              className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3"
            >
              <h3 className="text-sm font-semibold text-c-ink">{copy.preview}</h3>
              {current.content.split('\n').map((line, index) =>
                line.startsWith('## ') ? (
                  <h4 key={index} className="text-md font-semibold text-c-ink">
                    {line.slice(3)}
                  </h4>
                ) : (
                  <p key={index} className="text-sm whitespace-pre-wrap text-c-ink-2">
                    {line || '\u00a0'}
                  </p>
                )
              )}
            </section>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={publishing || !current.title.trim() || !current.content.trim()}
              onClick={() => void publish()}
            >
              {copy.publish}
            </Button>
            <Button variant="secondary" onClick={download}>
              {copy.exporting}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-c-ink-2">{copy.empty}</p>
      )}
      {status ? (
        <p role="status" className="text-sm text-c-ink-2">
          {status}
        </p>
      ) : null}
    </section>
  )
}
