import type { JSONContent } from '@tiptap/core'
import { safeDocumentLink } from './markdownCommands'
import { parseWikilinksInLine } from './wikilinks'

/**
 * Parses inline Markdown text into Tiptap inline `JSONContent[]`, preserving `[[Wikilink]]`
 * atoms, safe `[label](https://...)` links, `` `code` ``, `**bold**`, `_italic_`, and `~~strike~~`.
 */
export function parseInlineMarkdownToNodes(text: string): JSONContent[] {
  if (!text) return []

  const wikilinks = parseWikilinksInLine(text)
  if (wikilinks.length > 0) {
    const nodes: JSONContent[] = []
    let cursor = 0
    for (const token of wikilinks) {
      if (token.start > cursor) {
        nodes.push(...parseInlineFormatting(text.slice(cursor, token.start)))
      }
      nodes.push({
        type: 'wikilink',
        attrs: {
          title: token.targetTitle,
          label: token.displayLabel,
        },
      })
      cursor = token.end
    }
    if (cursor < text.length) {
      nodes.push(...parseInlineFormatting(text.slice(cursor)))
    }
    return nodes
  }

  return parseInlineFormatting(text)
}

function parseInlineFormatting(segment: string): JSONContent[] {
  if (!segment) return []
  const out: JSONContent[] = []
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^\s()]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null = pattern.exec(segment)

  while (match !== null) {
    if (match.index > lastIndex) {
      out.push({ type: 'text', text: segment.slice(lastIndex, match.index) })
    }
    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      out.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'code' }],
      })
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      out.push({
        type: 'text',
        text: token.slice(2, -2),
        marks: [{ type: 'bold' }],
      })
    } else if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
      out.push({
        type: 'text',
        text: token.slice(2, -2),
        marks: [{ type: 'strike' }],
      })
    } else if (token.startsWith('_') && token.endsWith('_') && token.length > 2) {
      out.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'italic' }],
      })
    } else {
      const linkMatch = /^\[([^\]]+)\]\((.+)\)$/.exec(token)
      const href = linkMatch?.[2] ?? ''
      if (linkMatch?.[1] && safeDocumentLink(href)) {
        out.push({
          type: 'text',
          text: linkMatch[1],
          marks: [{ type: 'link', attrs: { href } }],
        })
      } else {
        out.push({ type: 'text', text: token })
      }
    }
    lastIndex = match.index + token.length
    match = pattern.exec(segment)
  }

  if (lastIndex < segment.length) {
    out.push({ type: 'text', text: segment.slice(lastIndex) })
  }
  return out
}

function splitPipeRow(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const cells: string[] = []
  let current = ''
  let endedOnDelimiter = false

  for (let idx = 0; idx < inner.length; idx += 1) {
    const ch = inner[idx] ?? ''
    const next = inner[idx + 1]
    if (ch === '\\' && (next === '|' || next === '\\')) {
      current += next
      endedOnDelimiter = false
      idx += 1
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      endedOnDelimiter = true
      continue
    }
    current += ch
    endedOnDelimiter = false
  }

  if (!endedOnDelimiter) {
    cells.push(current.trim())
  }
  return cells
}

function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = splitPipeRow(trimmed)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

/**
 * Converts a Markdown document into Tiptap `JSONContent` supporting Headings 1–3, Bullet/Ordered
 * lists, checkable Task lists, Callouts, Blockquotes, Dividers, Fenced Code blocks, Diagrams,
 * Pipe Tables, and `[[Wikilinks]]`.
 */
export function markdownToTiptapDoc(markdown: string): JSONContent {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const content: JSONContent[] = []
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i] ?? ''
    const trimmed = rawLine.trim()

    if (trimmed === '') {
      i += 1
      continue
    }

    // Fenced code or diagram block
    const fenceMatch = /^```([A-Za-z0-9_-]*)\s*$/.exec(trimmed)
    if (fenceMatch) {
      const lang = (fenceMatch[1] ?? '').toLowerCase()
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1

      const source = body.join('\n')
      if (lang === 'diagram' || lang === 'mermaid') {
        content.push({
          type: 'diagramBlock',
          attrs: { source },
        })
      } else {
        content.push({
          type: 'codeBlock',
          attrs: { language: lang || null },
          ...(source ? { content: [{ type: 'text', text: source }] } : {}),
        })
      }
      continue
    }

    // Horizontal divider
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      content.push({ type: 'horizontalRule' })
      i += 1
      continue
    }

    // Headings 1–3
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (headingMatch?.[1] && headingMatch[2]) {
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarkdownToNodes(headingMatch[2]),
      })
      i += 1
      continue
    }

    // Pipe table
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1] ?? '')) {
      const headerCells = splitPipeRow(rawLine)
      const rows: JSONContent[] = [
        {
          type: 'docTableRow',
          content: headerCells.map((cell) => ({
            type: 'docTableHeader',
            content: cell ? parseInlineMarkdownToNodes(cell) : [],
          })),
        },
      ]
      i += 2
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        const dataCells = splitPipeRow(lines[i] ?? '')
        const normalizedCells = headerCells.map((_, idx) => dataCells[idx] ?? '')
        rows.push({
          type: 'docTableRow',
          content: normalizedCells.map((cell) => ({
            type: 'docTableCell',
            content: cell ? parseInlineMarkdownToNodes(cell) : [],
          })),
        })
        i += 1
      }
      content.push({
        type: 'docTable',
        content: rows,
      })
      continue
    }

    // Callout (`> [!NOTE]` / `> [!WARNING]` / etc.) or standard blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''))
        i += 1
      }
      const alertHeader = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(
        quoteLines[0] ?? ''
      )
      if (alertHeader) {
        const firstRest = alertHeader[2]?.trim()
        const bodyLines = firstRest
          ? [firstRest, ...quoteLines.slice(1)]
          : quoteLines.slice(1)
        const textBody = bodyLines.join(' ').trim()
        content.push({
          type: 'calloutBlock',
          attrs: { tone: (alertHeader[1] ?? 'NOTE').toLowerCase() },
          content: [
            {
              type: 'paragraph',
              content: textBody ? parseInlineMarkdownToNodes(textBody) : [],
            },
          ],
        })
      } else {
        const joined = quoteLines.join(' ').trim()
        content.push({
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: joined ? parseInlineMarkdownToNodes(joined) : [],
            },
          ],
        })
      }
      continue
    }

    // Task list (`- [ ]` / `- [x]`)
    if (/^[-*]\s+\[[ xX]\]\s*/.test(trimmed)) {
      const items: JSONContent[] = []
      while (i < lines.length) {
        const itemMatch = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec((lines[i] ?? '').trim())
        if (!itemMatch) break
        const checked = (itemMatch[1] ?? '').toLowerCase() === 'x'
        const itemText = itemMatch[2] ?? ''
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: [
            {
              type: 'paragraph',
              content: itemText ? parseInlineMarkdownToNodes(itemText) : [],
            },
          ],
        })
        i += 1
      }
      content.push({
        type: 'taskList',
        content: items,
      })
      continue
    }

    // Bullet list (`- ` / `* `)
    if (/^[-*]\s+/.test(trimmed)) {
      const items: JSONContent[] = []
      while (i < lines.length) {
        const bulletMatch = /^[-*]\s+(.*)$/.exec((lines[i] ?? '').trim())
        if (!bulletMatch || /^\[[ xX]\]/.test(bulletMatch[1] ?? '')) break
        const itemText = bulletMatch[1] ?? ''
        items.push({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: itemText ? parseInlineMarkdownToNodes(itemText) : [],
            },
          ],
        })
        i += 1
      }
      content.push({
        type: 'bulletList',
        content: items,
      })
      continue
    }

    // Ordered list (`1. `)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: JSONContent[] = []
      while (i < lines.length) {
        const ordMatch = /^\d+\.\s+(.*)$/.exec((lines[i] ?? '').trim())
        if (!ordMatch) break
        const itemText = ordMatch[1] ?? ''
        items.push({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: itemText ? parseInlineMarkdownToNodes(itemText) : [],
            },
          ],
        })
        i += 1
      }
      content.push({
        type: 'orderedList',
        content: items,
      })
      continue
    }

    // Standard paragraph
    content.push({
      type: 'paragraph',
      content: parseInlineMarkdownToNodes(rawLine),
    })
    i += 1
  }

  if (content.length === 0) {
    content.push({ type: 'paragraph' })
  }

  return {
    type: 'doc',
    content,
  }
}

function serializeInlineNodes(nodes: readonly JSONContent[] | undefined): string {
  if (!nodes || nodes.length === 0) return ''
  return nodes
    .map((node) => {
      if (node.type === 'wikilink') {
        const title = String(node.attrs?.['title'] ?? '').trim()
        const label = String(node.attrs?.['label'] ?? '').trim()
        if (!title) return ''
        return label && label !== title ? `[[${title}|${label}]]` : `[[${title}]]`
      }
      if (node.type === 'hardBreak') {
        return '\n'
      }
      if (node.type === 'text') {
        let out = node.text ?? ''
        for (const mark of node.marks ?? []) {
          if (mark.type === 'code') out = `\`${out}\``
          else if (mark.type === 'bold') out = `**${out}**`
          else if (mark.type === 'italic') out = `_${out}_`
          else if (mark.type === 'strike') out = `~~${out}~~`
          else if (mark.type === 'link') {
            const href = String(mark.attrs?.['href'] ?? '')
            if (safeDocumentLink(href)) out = `[${out}](${href})`
          }
        }
        return out
      }
      return serializeInlineNodes(node.content)
    })
    .join('')
}

function serializeBlocksInItem(nodes: readonly JSONContent[] | undefined): string {
  if (!nodes || nodes.length === 0) return ''
  return nodes.map((child) => serializeInlineNodes(child.content)).join(' ')
}

/**
 * Serializes a Tiptap `JSONContent` document back into canonical Markdown.
 */
export function tiptapDocToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? []
  const chunks: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(block.attrs?.['level'] ?? 2)))
        chunks.push(`${'#'.repeat(level)} ${serializeInlineNodes(block.content)}`.trimEnd())
        break
      }
      case 'paragraph': {
        chunks.push(serializeInlineNodes(block.content))
        break
      }
      case 'bulletList': {
        const lines = (block.content ?? []).map(
          (item) => `- ${serializeBlocksInItem(item.content)}`
        )
        chunks.push(lines.join('\n'))
        break
      }
      case 'orderedList': {
        const lines = (block.content ?? []).map(
          (item, index) => `${index + 1}. ${serializeBlocksInItem(item.content)}`
        )
        chunks.push(lines.join('\n'))
        break
      }
      case 'taskList': {
        const lines = (block.content ?? []).map((item) => {
          const checked = Boolean(item.attrs?.['checked'])
          return `- [${checked ? 'x' : ' '}] ${serializeBlocksInItem(item.content)}`
        })
        chunks.push(lines.join('\n'))
        break
      }
      case 'calloutBlock': {
        const tone = String(block.attrs?.['tone'] ?? 'note').toUpperCase()
        const body = (block.content ?? [])
          .map((p) => `> ${serializeInlineNodes(p.content)}`)
          .join('\n')
        chunks.push(`> [!${tone}]\n${body || '>'}`)
        break
      }
      case 'blockquote': {
        const body = (block.content ?? [])
          .map((p) => `> ${serializeInlineNodes(p.content)}`)
          .join('\n')
        chunks.push(body || '>')
        break
      }
      case 'horizontalRule': {
        chunks.push('---')
        break
      }
      case 'codeBlock': {
        const lang = String(block.attrs?.['language'] ?? '').trim()
        const code = serializeInlineNodes(block.content)
        chunks.push(`\`\`\`${lang}\n${code}\n\`\`\``)
        break
      }
      case 'diagramBlock': {
        const source = String(block.attrs?.['source'] ?? '').trim()
        chunks.push(`\`\`\`diagram\n${source}\n\`\`\``)
        break
      }
      case 'docTable': {
        const rows = block.content ?? []
        if (rows.length > 0) {
          const tableLines: string[] = []
          rows.forEach((row, rowIndex) => {
            const cells = (row.content ?? []).map((cell) =>
              serializeInlineNodes(cell.content).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
            )
            tableLines.push(`| ${cells.join(' | ')} |`)
            if (rowIndex === 0) {
              tableLines.push(`| ${cells.map(() => '---').join(' | ')} |`)
            }
          })
          chunks.push(tableLines.join('\n'))
        }
        break
      }
      default: {
        const fallback = serializeInlineNodes(block.content)
        if (fallback) chunks.push(fallback)
        break
      }
    }
  }

  return chunks.join('\n\n')
}
