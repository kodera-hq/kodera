import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { composerCopy } from './composerMessages'

/**
 * Only literal emphasis/code delimiters. HTML, images and arbitrary links remain escaped text.
 * `renderText` draws the plain and emphasised runs (Kodera's emoji, for one); inline code is
 * always shown exactly as written.
 */
export function InlineMarkdown({
  text,
  renderText = (run) => run,
}: {
  text: string
  renderText?: (run: string) => ReactNode
}) {
  const nodes: ReactNode[] = []
  let cursor = 0
  let plain = 0
  while (cursor < text.length) {
    const marker = text.startsWith('**', cursor)
      ? '**'
      : text[cursor] === '*'
        ? '*'
        : text[cursor] === '`'
          ? '`'
          : undefined
    if (!marker) {
      cursor++
      continue
    }
    const end = text.indexOf(marker, cursor + marker.length)
    if (end < 0 || end === cursor + marker.length) {
      cursor += marker.length
      continue
    }
    if (cursor > plain)
      nodes.push(<Fragment key={`t${plain}`}>{renderText(text.slice(plain, cursor))}</Fragment>)
    const body = text.slice(cursor + marker.length, end)
    nodes.push(
      marker === '**' ? (
        <strong key={cursor}>{renderText(body)}</strong>
      ) : marker === '*' ? (
        <em key={cursor}>{renderText(body)}</em>
      ) : (
        <code key={cursor} className="rounded-sm bg-c-muted px-1 font-mono text-sm">
          {body}
        </code>
      )
    )
    cursor = end + marker.length
    plain = cursor
  }
  nodes.push(<Fragment key={`t${plain}`}>{renderText(text.slice(plain))}</Fragment>)
  return <>{nodes}</>
}
function CodeBlock({ code, language }: { code: string; language: string }) {
  const { i18n } = useTranslation()
  const copy = composerCopy(i18n.resolvedLanguage)
  const [status, setStatus] = useState('')
  return (
    <span className="my-2 block overflow-hidden rounded-md border border-c-border bg-c-sunken">
      <span className="flex items-center justify-between gap-2 border-b border-c-border px-3 py-1 text-xs text-c-ink-2">
        <span>{language}</span>
        <button
          type="button"
          className="min-h-10 rounded-sm px-2 focus-visible:ring focus-visible:outline-hidden"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setStatus(copy.copied))
              .catch(() => setStatus(copy.copyFailed))
            if (!navigator.clipboard) setStatus(copy.copyFailed)
          }}
        >
          {copy.copy}
        </button>
      </span>
      <code className="block overflow-auto p-3 font-mono text-sm whitespace-pre text-c-ink">
        {code}
      </code>
      <span role="status" className="sr-only">
        {status}
      </span>
    </span>
  )
}

export function MarkdownText({
  body,
  renderText,
}: {
  body: string
  renderText: (text: string) => ReactNode
}) {
  const nodes: ReactNode[] = []
  let from = 0
  let search = 0
  while (search < body.length) {
    const start = body.indexOf('```', search)
    if (start < 0) break
    const newline = body.indexOf('\n', start + 3)
    if (newline < 0) break
    const end = body.indexOf('\n```', newline)
    if (end < 0) break
    if (start > from)
      nodes.push(<span key={`text:${from}`}>{renderText(body.slice(from, start))}</span>)
    nodes.push(
      <CodeBlock
        key={start}
        code={body.slice(newline + 1, end)}
        language={body.slice(start + 3, newline).slice(0, 80)}
      />
    )
    from = end + 4
    search = from
  }
  if (from < body.length)
    nodes.push(<span key={`text:${from}`}>{renderText(body.slice(from))}</span>)
  return <>{nodes}</>
}
