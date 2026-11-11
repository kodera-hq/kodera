export type Format = 'bold' | 'italic' | 'code' | 'fence'
export function formatSelection(value: string, start: number, end: number, format: Format) {
  const markers = { bold: '**', italic: '*', code: '`', fence: '```\n' }
  const left = markers[format]
  const right = format === 'fence' ? '\n```' : left
  return {
    text: value.slice(0, start) + left + value.slice(start, end) + right + value.slice(end),
    start: start + left.length,
    end: end + left.length,
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
