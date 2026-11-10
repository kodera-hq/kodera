export type MarkdownCommand = 'bold' | 'italic' | 'list' | 'task' | 'paragraph' | 'h2' | 'h3'
export interface TextSelection {
  text: string
  start: number
  end: number
}
const prefixes = { list: '- ', task: '- [ ] ', paragraph: '', h2: '## ', h3: '### ' }
const linePrefix = /^(?:#{1,6} |- (?:\[[ xX]\] )?)/

export function markdownState(text: string, start: number, end: number) {
  const line = text.slice(text.lastIndexOf('\n', Math.max(0, start - 1)) + 1).split('\n')[0] ?? ''
  return {
    bold: text.slice(start - 2, start) === '**' && text.slice(end, end + 2) === '**',
    italic: text.slice(start - 1, start) === '_' && text.slice(end, end + 1) === '_',
    list: /^- (?!\[)/.test(line),
    task: /^- \[[ xX]\] /.test(line),
    heading: line.startsWith('### ') ? 'h3' : line.startsWith('## ') ? 'h2' : 'paragraph',
  }
}

export function applyMarkdownCommand(
  text: string,
  start: number,
  end: number,
  command: MarkdownCommand
): TextSelection {
  if (command === 'bold' || command === 'italic') {
    const marker = command === 'bold' ? '**' : '_'
    const active = markdownState(text, start, end)[command]
    return active
      ? {
          text:
            text.slice(0, start - marker.length) +
            text.slice(start, end) +
            text.slice(end + marker.length),
          start: start - marker.length,
          end: end - marker.length,
        }
      : {
          text: text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end),
          start: start + marker.length,
          end: end + marker.length,
        }
  }
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
  const nextLine = text.indexOf('\n', Math.max(start, end - 1))
  const to = nextLine < 0 ? text.length : nextLine
  const prefix = prefixes[command]
  const lines = text.slice(from, to).split('\n')
  const remove = prefix !== '' && lines.every((line) => line.startsWith(prefix))
  const replacement = lines
    .map((line) => (remove ? '' : prefix) + line.replace(linePrefix, ''))
    .join('\n')
  return {
    text: text.slice(0, from) + replacement + text.slice(to),
    start: from,
    end: from + replacement.length,
  }
}

export function safeDocumentLink(value: string): string | null {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !/[\s()<>]/.test(value)
      ? url.href
      : null
  } catch {
    return null
  }
}
