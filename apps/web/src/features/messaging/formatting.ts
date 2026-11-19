/** What the composer's formatting toolbar and shortcuts apply to the selection. */
export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'fence' | 'bullet' | 'quote'

/** The text after a format, and the selection to restore over what was formatted. */
export interface Formatted {
  text: string
  start: number
  end: number
}

const WRAPS = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  fence: ['```\n', '\n```'],
} as const

/** Lines formats prefix each line of the selection with. */
const PREFIXES = { bullet: '- ', quote: '> ' } as const

/**
 * Whether `left` really closes on `at` in `value` going backwards: an italic `*` that is the end of
 * a bold `**` is not one, unless it is the third of `***` (bold and italic together).
 */
function wrapsAt(value: string, at: number, marker: string, side: 'before' | 'after'): boolean {
  const from = side === 'before' ? at - marker.length : at
  if (from < 0 || value.slice(from, from + marker.length) !== marker) return false
  if (marker !== '*') return true
  const neighbour = side === 'before' ? value[from - 1] : value[from + 1]
  if (neighbour !== '*') return true
  const outer = side === 'before' ? value[from - 2] : value[from + 2]
  return outer === '*'
}

/**
 * Applies `format` to the selection, or takes it off when it is already there: pressing « Gras »
 * twice leaves the text as it was, never `****`. A wrap is found around the selection (`**|hi|**`)
 * or inside it (`|**hi**|`); a line format is taken off when every selected line already carries it.
 */
export function formatSelection(
  value: string,
  start: number,
  end: number,
  format: Format
): Formatted {
  if (format === 'bullet' || format === 'quote')
    return prefixLines(value, start, end, PREFIXES[format])
  const [left, right] = WRAPS[format]
  if (wrapsAt(value, start, left, 'before') && wrapsAt(value, end, right, 'after')) {
    return {
      text:
        value.slice(0, start - left.length) +
        value.slice(start, end) +
        value.slice(end + right.length),
      start: start - left.length,
      end: end - left.length,
    }
  }
  const selected = value.slice(start, end)
  if (
    selected.length >= left.length + right.length &&
    wrapsAt(selected, 0, left, 'after') &&
    wrapsAt(selected, selected.length, right, 'before')
  ) {
    const inner = selected.slice(left.length, selected.length - right.length)
    return {
      text: value.slice(0, start) + inner + value.slice(end),
      start,
      end: start + inner.length,
    }
  }
  return {
    text: value.slice(0, start) + left + selected + right + value.slice(end),
    start: start + left.length,
    end: end + left.length,
  }
}

function prefixLines(value: string, start: number, end: number, prefix: string): Formatted {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? value.length : nextBreak
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const remove = lines.every((line) => line.startsWith(prefix))
  const next = lines.map((line) => (remove ? line.slice(prefix.length) : prefix + line))
  const shift = remove ? -prefix.length : prefix.length
  const block = next.join('\n')
  return {
    text: value.slice(0, lineStart) + block + value.slice(lineEnd),
    start: Math.max(lineStart, start + shift),
    end: Math.max(lineStart, end + shift * lines.length),
  }
}

/** Only web addresses become links; anything else a member types is refused. */
export function safeLinkHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.hostname === '') return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Writes `[label](href)` over the selection (`Cmd+K`): the label typed, else the selected text,
 * else the address itself. Brackets in the label are escaped so the link stays one link.
 */
export function insertLink(
  value: string,
  start: number,
  end: number,
  label: string,
  href: string
): Formatted {
  const text = (label.trim() || value.slice(start, end).trim() || href).replace(/[[\]]/gu, '\\$&')
  const link = `[${text}](${href})`
  return {
    text: value.slice(0, start) + link + value.slice(end),
    start: start + link.length,
    end: start + link.length,
  }
}
export function stagedFiles(existing: readonly File[], incoming: readonly File[]) {
  const accepted = [...existing]
  let rejected = false
  for (const file of incoming) {
    if (file.size === 0 || file.size > 20 * 1024 * 1024 || accepted.length >= 5) {
      rejected = true
      continue
    }
    if (
      !accepted.some(
        (item) =>
          item.name === file.name &&
          item.size === file.size &&
          item.lastModified === file.lastModified
      )
    )
      accepted.push(file)
  }
  return { files: accepted, rejected }
}

/** Never rewrite emoji shortcodes inside authored code, including a fence still being typed. */
export function transformOutsideCode(value: string, transform: (text: string) => string): string {
  let from = 0
  let result = ''
  while (from < value.length) {
    const start = value.indexOf('`', from)
    if (start < 0) return result + transform(value.slice(from))
    result += transform(value.slice(from, start))
    const marker = value.startsWith('```', start) ? '```' : '`'
    const end = value.indexOf(marker, start + marker.length)
    if (end < 0) return result + value.slice(start)
    result += value.slice(start, end + marker.length)
    from = end + marker.length
  }
  return result
}
export function caretInsideCode(value: string, caret: number): boolean {
  const prefix = value.slice(0, caret)
  let from = 0
  while (from < prefix.length) {
    const start = prefix.indexOf('`', from)
    if (start < 0) return false
    const marker = prefix.startsWith('```', start) ? '```' : '`'
    const end = prefix.indexOf(marker, start + marker.length)
    if (end < 0) return true
    from = end + marker.length
  }
  return false
}
