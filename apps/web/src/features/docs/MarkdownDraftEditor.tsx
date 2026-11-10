import { useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { Dialog } from '../../ui/Dialog/Dialog'
import { LINK_TEXT } from '../../ui/LinkButton/LinkButton'
import { StudioGlyph } from '../../ui/icons/StudioGlyph'
import { studioMessages } from '../workspace/studioMessages'
import {
  applyMarkdownCommand,
  markdownState,
  safeDocumentLink,
  type MarkdownCommand,
  type TextSelection,
} from './markdownCommands'

const TOOL =
  'flex min-h-10 min-w-10 items-center justify-center rounded-sm px-2 text-sm text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:text-c-ink-3 narrow:min-h-12 narrow:min-w-12'

/** An escaped Markdown subset. No HTML, remote images, or embedded content is interpreted. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|_[^_]+_|==[^=]+==|\[[^\]]+\]\(https?:\/\/[^\s()]+\))/g)
    .map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={index}>{part.slice(2, -2)}</strong>
      if (part.startsWith('_') && part.endsWith('_'))
        return <em key={index}>{part.slice(1, -1)}</em>
      if (part.startsWith('==') && part.endsWith('=='))
        return (
          <mark key={index} className="rounded-sm bg-c-warn-soft px-1 text-c-warn-ink">
            {part.slice(2, -2)}
          </mark>
        )
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(part)
      if (link && safeDocumentLink(link[2] ?? ''))
        return (
          <a
            key={index}
            className={`${LINK_TEXT.inline} focus-visible:ring`}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link[1]}
          </a>
        )
      return part
    })
}

export function MarkdownDraftEditor({
  title,
  channelName,
  content,
  onChange,
  shareAction,
  sourceLabel,
  sourceTestId,
}: {
  title: string
  channelName: string
  content: string
  onChange: (text: string) => void
  shareAction?: ReactNode
  sourceLabel?: string
  sourceTestId?: string
}) {
  const { i18n } = useTranslation()
  const copy = studioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const editor = useRef<HTMLTextAreaElement>(null)
  const linkReturnFocus = useRef<HTMLElement | null>(null)
  const urlField = useRef<HTMLInputElement>(null)
  const commentsId = useId()
  const noticeId = useId()
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [favorite, setFavorite] = useState(false)
  const [comments, setComments] = useState(true)
  const [status, setStatus] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [linkError, setLinkError] = useState(false)
  const [history, setHistory] = useState<TextSelection[]>([])
  const [future, setFuture] = useState<TextSelection[]>([])
  const state = markdownState(content, selection.start, selection.end)
  const readSelection = () => {
    if (editor.current)
      setSelection({ start: editor.current.selectionStart, end: editor.current.selectionEnd })
  }
  const restore = (next: TextSelection) => {
    onChange(next.text)
    setSelection({ start: next.start, end: next.end })
    requestAnimationFrame(() => {
      editor.current?.focus()
      editor.current?.setSelectionRange(next.start, next.end)
    })
  }
  const commit = (next: TextSelection, focus = true) => {
    if (new TextEncoder().encode(next.text).length > 65_536) {
      setStatus(copy.limit)
      return
    }
    setHistory([...history.slice(-99), { text: content, ...selection }])
    setFuture([])
    if (focus) restore(next)
    else {
      onChange(next.text)
      setSelection({ start: next.start, end: next.end })
    }
    setStatus(copy.edited)
  }
  const command = (name: MarkdownCommand) => {
    const start = editor.current?.selectionStart ?? selection.start
    const end = editor.current?.selectionEnd ?? selection.end
    commit(applyMarkdownCommand(content, start, end, name))
  }
  const undo = (redo = false) => {
    const from = redo ? future : history
    const next = from.at(-1)
    if (!next) return
    if (redo) {
      setFuture(future.slice(0, -1))
      setHistory([...history, { text: content, ...selection }])
    } else {
      setHistory(history.slice(0, -1))
      setFuture([...future, { text: content, ...selection }])
    }
    restore(next)
    setStatus(copy.edited)
  }
  const download = () => {
    const href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = 'document.md'
    anchor.click()
    URL.revokeObjectURL(href)
  }
  return (
    <section className="flex min-w-0 flex-col bg-c-surface" data-testid="studio-document">
      <div
        className="flex flex-wrap items-center gap-2 border-b border-c-border-soft px-4 py-2 text-xs text-c-ink-2"
        aria-label={copy.docs}
      >
        <span>#{channelName}</span>
        <span aria-hidden="true">›</span>
        <span>{copy.docs}</span>
        <span aria-hidden="true">›</span>
        <strong className="min-w-0 flex-1 break-words">{title}</strong>
        <button
          type="button"
          className={`${TOOL} ${favorite ? 'bg-c-muted text-c-ink' : ''}`}
          aria-label={copy.favorite}
          aria-pressed={favorite}
          title={copy.favorite}
          onClick={() => setFavorite(!favorite)}
        >
          <StudioGlyph name="star" />
        </button>
        <details>
          <summary className="cursor-pointer rounded-sm p-2 focus-visible:ring">
            {copy.actions}
          </summary>
          <Button variant="secondary" size="sm" onClick={download}>
            {copy.export}
          </Button>
        </details>
      </div>
      <div
        role="group"
        aria-label={copy.toolbar}
        className="flex flex-wrap items-center gap-1 border-b border-c-border-soft px-3 py-2"
      >
        <select
          aria-label={copy.heading}
          value={state.heading}
          onChange={(event) => command(event.target.value as MarkdownCommand)}
          className={`${TOOL} bg-c-surface font-bold`}
        >
          <option value="paragraph">{copy.paragraph}</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
        </select>
        <span aria-hidden="true" className="mx-1 h-4 border-l border-c-border-soft" />
        {(['bold', 'italic', 'list', 'task'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`${TOOL} ${state[name] ? 'bg-c-muted' : ''}`}
            aria-label={copy[name]}
            title={copy[name]}
            aria-pressed={state[name]}
            onClick={() => command(name)}
          >
            <StudioGlyph name={name} />
          </button>
        ))}
        <button
          type="button"
          className={TOOL}
          aria-label={copy.link}
          title={copy.link}
          onClick={(event) => {
            readSelection()
            linkReturnFocus.current = event.currentTarget
            setUrl('')
            setLinkError(false)
            setLinkOpen(true)
          }}
        >
          <StudioGlyph name="link" />
        </button>
        <button
          type="button"
          className={TOOL}
          aria-label={copy.mention}
          disabled
          title={copy.mentionGap}
        >
          <StudioGlyph name="mention" />
        </button>
        <button
          type="button"
          className={TOOL}
          aria-label={copy.comments}
          title={copy.comments}
          aria-expanded={comments}
          aria-controls={commentsId}
          onClick={() => setComments(!comments)}
        >
          <StudioGlyph name="message" />
        </button>
        <span aria-hidden="true" className="mx-1 h-4 border-l border-c-border-soft" />
        <div className="ml-auto">
          {shareAction ?? (
            <Button disabled title={copy.shareGap} icon={<StudioGlyph name="share" />}>
              {copy.share}
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 gap-6 p-5 narrow:flex-col narrow:p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="text-2xl leading-snug font-extrabold tracking-tight break-words text-c-ink">
            {title}
          </h2>
          <p id={noticeId} className="text-xs text-c-ink-3">
            {copy.local}
          </p>
          <div
            aria-label={copy.preview}
            className="flex flex-col gap-2 text-md leading-body break-words text-c-ink"
          >
            {content.split('\n').map((line, index) => {
              const task = /^- \[([ xX])\] (.*)$/.exec(line)
              if (task)
                return (
                  <label key={index} className="flex min-h-8 items-center gap-2 narrow:min-h-12">
                    <input
                      type="checkbox"
                      className="h-5 w-5 focus-visible:ring"
                      checked={task[1] !== ' '}
                      onChange={() => {
                        const lines = content.split('\n')
                        lines[index] = `- [${task[1] === ' ' ? 'x' : ' '}] ${task[2]}`
                        commit({ text: lines.join('\n'), ...selection }, false)
                      }}
                    />
                    <span>{inline(task[2] ?? '')}</span>
                  </label>
                )
              if (line.startsWith('### '))
                return (
                  <h4 key={index} className="mt-3 text-lg font-extrabold tracking-snug">
                    {inline(line.slice(4))}
                  </h4>
                )
              if (line.startsWith('## '))
                return (
                  <h3 key={index} className="mt-3 text-xl font-extrabold tracking-snug">
                    {inline(line.slice(3))}
                  </h3>
                )
              if (line.startsWith('- ')) return <p key={index}>• {inline(line.slice(2))}</p>
              return (
                <p key={index} className="whitespace-pre-wrap">
                  {inline(line || '\u00a0')}
                </p>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-c-ink-3">
            <span className="flex-1">{sourceLabel ?? copy.source}</span>
            <button
              type="button"
              className={TOOL}
              disabled={!history.length}
              onClick={() => undo()}
            >
              {copy.undo}
            </button>
            <button
              type="button"
              className={TOOL}
              disabled={!future.length}
              onClick={() => undo(true)}
            >
              {copy.redo}
            </button>
          </div>
          <textarea
            ref={editor}
            aria-label={sourceLabel ?? copy.source}
            aria-describedby={noticeId}
            data-testid={sourceTestId}
            value={content}
            rows={6}
            onSelect={readSelection}
            onKeyUp={readSelection}
            onPointerUp={readSelection}
            onBlur={readSelection}
            onChange={(event) =>
              commit(
                {
                  text: event.target.value,
                  start: event.target.selectionStart,
                  end: event.target.selectionEnd,
                },
                false
              )
            }
            onKeyDown={(event) => {
              if (!(event.metaKey || event.ctrlKey) || event.altKey) return
              const key = event.key.toLowerCase()
              if (key === 'b' || key === 'i') {
                event.preventDefault()
                command(key === 'b' ? 'bold' : 'italic')
              }
              if (key === 'z') {
                event.preventDefault()
                undo(event.shiftKey)
              }
            }}
            className="w-full rounded-md border border-c-border-input bg-c-sunken p-3 font-mono text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
          />
          <p role="status" className="text-xs text-c-ink-2">
            {status}
          </p>
        </div>
        <aside
          id={commentsId}
          hidden={!comments}
          aria-label={copy.comments}
          className="w-shell-sidebar-width shrink-0 border-l border-c-border-soft pl-4 narrow:w-full narrow:border-t narrow:border-l-0 narrow:pt-4 narrow:pl-0"
        >
          <h3 className="flex items-center gap-2 text-sm font-bold text-c-ink">
            <StudioGlyph name="message" />
            {copy.comments}
          </h3>
          <p className="mt-3 rounded-md bg-c-muted p-3 text-sm text-c-ink-2">{copy.commentGap}</p>
        </aside>
      </div>
      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title={copy.link}
        closeLabel={copy.close}
        returnFocusTo={linkReturnFocus}
        initialFocus={urlField}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const href = safeDocumentLink(url)
            if (!href) {
              setLinkError(true)
              return
            }
            const label = content.slice(selection.start, selection.end) || href
            const text =
              content.slice(0, selection.start) +
              `[${label}](${href})` +
              content.slice(selection.end)
            linkReturnFocus.current = editor.current
            setLinkOpen(false)
            commit({ text, start: selection.start + 1, end: selection.start + 1 + label.length })
          }}
        >
          <label className="flex flex-col gap-2 text-sm text-c-ink">
            {copy.url}
            <input
              ref={urlField}
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="rounded-md border border-c-border-input bg-c-surface p-3 focus-visible:ring"
            />
          </label>
          {linkError ? (
            <p role="alert" className="text-sm text-c-bad-ink">
              {copy.invalidUrl}
            </p>
          ) : null}
          <Button type="submit">{copy.insert}</Button>
        </form>
      </Dialog>
    </section>
  )
}
