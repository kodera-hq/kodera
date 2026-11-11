import { InlineMarkdown, MarkdownText } from '../messaging/MarkdownText'
// A message's text with its web addresses as links (V1 bar M10): http and https only, each
// opening a new tab with no handle back on this page and no referrer. No preview is fetched.
// Everything else stays text, which React escapes.

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { LINK_TEXT } from '../../ui/linkText'

export type TextSegment = { text: string } | { text: string; href: string }

const ADDRESS = /\bhttps?:\/\/[^\s<>"]+/giu
/** Punctuation that ends a sentence more often than an address. */
const TRAILING = /[.,;:!?'»…]/u

/**
 * Drops what reads as the sentence's, not the address's: trailing punctuation, an unopened `)`.
 * The brackets are counted once and the count kept as `)` is dropped: a message is up to
 * 64 KiB, so counting again on each pass would let one message stall every reader's tab.
 */
function trim(candidate: string): string {
  let end = candidate.length
  const open = count(candidate, '(')
  let close = count(candidate, ')')
  for (;;) {
    const last = candidate[end - 1]
    if (last !== undefined && TRAILING.test(last)) {
      end--
      continue
    }
    if (last === ')' && open < close) {
      end--
      close--
      continue
    }
    return candidate.slice(0, end)
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

/** The text cut into plain runs and web addresses, in order; nothing is lost or added. */
export function linkSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let from = 0
  for (const match of text.matchAll(ADDRESS)) {
    const address = trim(match[0])
    // The pattern admits http and https only; an address the URL parser refuses stays text.
    let href: string
    try {
      href = new URL(address).href
    } catch {
      continue
    }
    if (match.index > from) segments.push({ text: text.slice(from, match.index) })
    segments.push({ text: address, href })
    from = match.index + address.length
  }
  if (from < text.length) segments.push({ text: text.slice(from) })
  return segments
}

export function MessageText({ body }: { body: string }) {
  return <MarkdownText body={body} renderText={(text) => <LinkedText body={text} />} />
}

function LinkedText({ body }: { body: string }) {
  const { t } = useTranslation()
  const newTabId = useId()
  const segments = linkSegments(body)
  if (!segments.some((segment) => 'href' in segment)) return <InlineMarkdown text={body} />
  return (
    <>
      {segments.map((segment, index) =>
        'href' in segment ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-describedby={newTabId}
            className={cx(
              LINK_TEXT.inline,
              'rounded-sm focus-visible:ring focus-visible:outline-hidden'
            )}
          >
            {segment.text}
          </a>
        ) : (
          <InlineMarkdown key={index} text={segment.text} />
        )
      )}
      <span id={newTabId} className="sr-only">
        {t('console.common.a11y-opens-new-tab')}
      </span>
    </>
  )
}
