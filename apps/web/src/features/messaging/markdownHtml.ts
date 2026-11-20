// The outgoing message's HTML (Matrix client-server API, `m.room.message`: `format`
// `org.matrix.custom.html` and `formatted_body`), compiled from the Markdown the member typed, so
// other Matrix clients draw the same bold, lists and links Kodera does. The plain `body` is always
// sent too, unchanged. A pure function over text: every character the member typed is escaped
// before any tag is written, and only the tags the Matrix specification recommends are produced.

/** The `m.room.message` fields a formatted message carries. */
export const HTML_FORMAT = 'org.matrix.custom.html'

/** A member a mention pill links to: the text names `@label`, the link points at `userId`. */
export interface MentionTarget {
  userId: string
  label: string
}

function escape(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** A web address a link may point at, else nothing: no `javascript:`, no `data:`. */
function webHref(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** The `matrix.to` permalink of a user, as mention pills carry it (Matrix spec, user mentions). */
export function userPermalink(userId: string): string {
  return `https://matrix.to/#/${encodeURIComponent(userId).replace(/%40/gu, '@').replace(/%3A/gu, ':')}`
}

interface InlineContext {
  mentions: readonly MentionTarget[]
}

/** The mention starting at `at` (just after `@`), the longest label first. */
function mentionAt(text: string, at: number, mentions: readonly MentionTarget[]) {
  if (at > 1 && !/\s/u.test(text[at - 2]!)) return undefined
  const rest = text.slice(at)
  return [...mentions]
    .sort((a, b) => b.label.length - a.label.length)
    .find(
      ({ label }) =>
        label !== '' &&
        rest.startsWith(label) &&
        (rest.length === label.length || /[\s\p{P}]/u.test(rest[label.length]!))
    )
}

/** The emphasis markers, longest first, so `**` is never read as two `*`. */
const EMPHASIS = [
  ['**', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
] as const

/** One line's inline Markdown: code, bold, italic, strike, links and mention pills. */
function inline(text: string, context: InlineContext): string {
  let out = ''
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    if (char === '`') {
      const close = text.indexOf('`', at + 1)
      if (close > at + 1) {
        out += `<code>${escape(text.slice(at + 1, close))}</code>`
        at = close + 1
        continue
      }
    }
    if (char === '[') {
      const link = /^\[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^\s)]+)\)/u.exec(text.slice(at))
      const href = link === null ? null : webHref(link[2]!)
      if (link !== null && href !== null) {
        const label = link[1]!.replace(/\\(.)/gu, '$1')
        out += `<a href="${escape(href)}">${inline(label, context)}</a>`
        at += link[0].length
        continue
      }
    }
    const emphasis = EMPHASIS.find(([marker]) => text.startsWith(marker, at))
    if (emphasis !== undefined) {
      const [marker, tag] = emphasis
      const close = text.indexOf(marker, at + marker.length)
      if (close > at + marker.length) {
        out += `<${tag}>${inline(text.slice(at + marker.length, close), context)}</${tag}>`
        at = close + marker.length
        continue
      }
    }
    if (char === '@') {
      const mention = mentionAt(text, at + 1, context.mentions)
      if (mention !== undefined) {
        out += `<a href="${escape(userPermalink(mention.userId))}">@${escape(mention.label)}</a>`
        at += 1 + mention.label.length
        continue
      }
    }
    out += escape(char)
    at += 1
  }
  return out
}

/** Whether the text holds anything HTML would draw differently from the plain body. */
function hasMarkup(body: string, mentions: readonly MentionTarget[]): boolean {
  if (/(\*\*|~~|`|\*[^\s*]|\[[^\]]+\]\(https?:)/u.test(body)) return true
  if (/^(?:[-*] |> )/mu.test(body)) return true
  return mentions.length > 0 && body.includes('@')
}

/**
 * The message's HTML, or null when it is plain text and `body` says it all. Fenced code is kept
 * verbatim; `- ` / `* ` lines become a list, `> ` lines a quote, and other line breaks `<br>`.
 */
export function markdownToHtml(
  body: string,
  mentions: readonly MentionTarget[] = []
): string | null {
  if (!hasMarkup(body, mentions)) return null
  const context: InlineContext = { mentions }
  const lines = body.split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push(paragraph.join('<br>'))
    paragraph = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fence = /^```([\w+-]{0,32})\s*$/u.exec(line)
    if (fence !== null) {
      const close = lines.findIndex((candidate, at) => at > index && candidate.trim() === '```')
      if (close !== -1) {
        flush()
        const language = fence[1] ? ` class="language-${escape(fence[1])}"` : ''
        blocks.push(
          `<pre><code${language}>${escape(lines.slice(index + 1, close).join('\n'))}</code></pre>`
        )
        index = close
        continue
      }
    }
    if (/^[-*] /u.test(line)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^[-*] /u.test(lines[index]!)) {
        items.push(`<li>${inline(lines[index]!.slice(2), context)}</li>`)
        index += 1
      }
      index -= 1
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^> ?/u.test(line) && line.startsWith('>')) {
      flush()
      const quoted: string[] = []
      while (index < lines.length && lines[index]!.startsWith('>')) {
        quoted.push(inline(lines[index]!.replace(/^> ?/u, ''), context))
        index += 1
      }
      index -= 1
      blocks.push(`<blockquote>${quoted.join('<br>')}</blockquote>`)
      continue
    }
    paragraph.push(inline(line, context))
  }
  flush()
  return blocks.join('')
}
