import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { composerCopy } from './composerMessages'
import { safeLinkHref } from './formatting'

const MD_LINK = /^\[((?:\\.|[^\]\\])+)\]\(([^\s)]+)\)/u

function safeExplicitWebHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!/^https?:\/\//iu.test(trimmed)) return null
  return safeLinkHref(trimmed)
}

/**
 * Literal inline Markdown: inline code takes precedence over everything else, followed by
 * validated `[label](https://...)` links, then `**bold**`, `~~strikethrough~~` and `*italic*`.
 * HTML, images and non-http(s) links remain escaped text.
 */
export function InlineMarkdown({
  text,
  renderText = (run) => run,
  renderLink,
}: {
  text: string
  renderText?: (run: string) => ReactNode
  renderLink?: ((href: string, label: ReactNode) => ReactNode) | undefined
}) {
  const nodes: ReactNode[] = []
  let cursor = 0
  let plain = 0
  while (cursor < text.length) {
    if (text[cursor] === '`') {
      const end = text.indexOf('`', cursor + 1)
      if (end > cursor + 1) {
        if (cursor > plain)
          nodes.push(<Fragment key={`t${plain}`}>{renderText(text.slice(plain, cursor))}</Fragment>)
        nodes.push(
          <code key={cursor} className="rounded-sm bg-c-muted px-1 font-mono text-sm">
            {text.slice(cursor + 1, end)}
          </code>
        )
        cursor = end + 1
        plain = cursor
        continue
      }
      cursor += 1
      continue
    }
    if (text[cursor] === '[') {
      const link = MD_LINK.exec(text.slice(cursor))
      const href = link === null ? null : safeExplicitWebHref(link[2]!)
      if (link !== null && href !== null) {
        if (cursor > plain)
          nodes.push(<Fragment key={`t${plain}`}>{renderText(text.slice(plain, cursor))}</Fragment>)
        const unescaped = link[1]!.replace(/\\([[\]\\])/gu, '$1')
        const inner = (
          <InlineMarkdown text={unescaped} renderText={renderText} renderLink={renderLink} />
        )
        nodes.push(
          <Fragment key={cursor}>
            {renderLink ? (
              renderLink(href, inner)
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {inner}
              </a>
            )}
          </Fragment>
        )
        cursor += link[0].length
        plain = cursor
        continue
      }
    }
    const marker = text.startsWith('**', cursor)
      ? '**'
      : text.startsWith('~~', cursor)
        ? '~~'
        : text[cursor] === '*'
          ? '*'
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
    const inner = (
      <InlineMarkdown
        text={text.slice(cursor + marker.length, end)}
        renderText={renderText}
        renderLink={renderLink}
      />
    )
    nodes.push(
      marker === '**' ? (
        <strong key={cursor}>{inner}</strong>
      ) : marker === '~~' ? (
        <del key={cursor}>{inner}</del>
      ) : (
        <em key={cursor}>{inner}</em>
      )
    )
    cursor = end + marker.length
    plain = cursor
  }
  if (plain < text.length || nodes.length === 0)
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

function renderProseBlocks(
  slice: string,
  renderText: (text: string) => ReactNode,
  baseKey: number
): ReactNode {
  if (!/^(?:[-*] |> )/mu.test(slice)) {
    return <span key={`text:${baseKey}`}>{renderText(slice)}</span>
  }
  const lines = slice.split('\n')
  const blocks: ReactNode[] = []
  let plain: string[] = []
  const flushPlain = (at: number) => {
    if (plain.length === 0) return
    blocks.push(<span key={`p:${baseKey}:${at}`}>{renderText(plain.join('\n'))}</span>)
    plain = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^[-*] /u.test(line)) {
      flushPlain(index)
      const start = index
      const items: string[] = []
      while (index < lines.length && /^[-*] /u.test(lines[index]!)) {
        items.push(lines[index]!.slice(2))
        index += 1
      }
      index -= 1
      blocks.push(
        <ul key={`ul:${baseKey}:${start}`} className="my-1 list-disc pl-5">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderText(item)}</li>
          ))}
        </ul>
      )
      continue
    }
    if (line.startsWith('> ') || line === '>') {
      flushPlain(index)
      const start = index
      const quoted: string[] = []
      while (index < lines.length && (lines[index]!.startsWith('> ') || lines[index] === '>')) {
        quoted.push(lines[index]!.replace(/^> ?/u, ''))
        index += 1
      }
      index -= 1
      blocks.push(
        <blockquote
          key={`bq:${baseKey}:${start}`}
          className="my-1 border-l-2 border-c-border-strong pl-3 text-c-ink-2"
        >
          {renderText(quoted.join('\n'))}
        </blockquote>
      )
      continue
    }
    plain.push(line)
  }
  flushPlain(lines.length)
  return <Fragment key={`text:${baseKey}`}>{blocks}</Fragment>
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
    if (start > from) nodes.push(renderProseBlocks(body.slice(from, start), renderText, from))
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
  if (from < body.length) nodes.push(renderProseBlocks(body.slice(from), renderText, from))
  return <>{nodes}</>
}
