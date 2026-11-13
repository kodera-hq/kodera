export interface WikilinkDocumentTarget {
  readonly id: string
  readonly title: string
  readonly content?: string | undefined
}

export interface DocumentBacklinkItem {
  readonly documentId: string
  readonly title: string
}

export interface ParsedWikilinkToken {
  readonly raw: string
  readonly targetTitle: string
  readonly displayLabel: string
  readonly start: number
  readonly end: number
}

const MAX_WIKILINK_TITLE_LENGTH = 120

export function normalizeWikilinkKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function stripFencedAndInlineCode(markdown: string): string {
  const lines = markdown.split('\n')
  const kept: string[] = []
  let inFence = false

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      kept.push('')
      continue
    }
    if (inFence) {
      kept.push('')
      continue
    }
    // Mask inline code spans (`...`) with spaces so character indices stay aligned if needed.
    let masked = ''
    let i = 0
    let inCode = false
    while (i < line.length) {
      const ch = line[i]
      if (ch === '`') {
        inCode = !inCode
        masked += ' '
      } else {
        masked += inCode ? ' ' : ch
      }
      i += 1
    }
    kept.push(masked)
  }

  return kept.join('\n')
}

/**
 * Parses inline `[[Page Title]]` and `[[Page Title|Alias]]` tokens outside code blocks.
 * Linear character scan — no backtracking regular expressions.
 */
export function parseWikilinksInLine(line: string): ParsedWikilinkToken[] {
  const tokens: ParsedWikilinkToken[] = []
  let cursor = 0

  while (cursor < line.length - 3) {
    const open = line.indexOf('[[', cursor)
    if (open < 0) break
    const close = line.indexOf(']]', open + 2)
    if (close < 0) break

    const inner = line.slice(open + 2, close)
    if (
      inner.length > 0 &&
      inner.length <= MAX_WIKILINK_TITLE_LENGTH * 2 &&
      !inner.includes('[') &&
      !inner.includes(']') &&
      !inner.includes('\n')
    ) {
      const pipeAt = inner.indexOf('|')
      const rawTarget = (pipeAt >= 0 ? inner.slice(0, pipeAt) : inner).trim()
      const rawLabel = (pipeAt >= 0 ? inner.slice(pipeAt + 1) : inner).trim()
      if (rawTarget.length > 0 && rawTarget.length <= MAX_WIKILINK_TITLE_LENGTH) {
        tokens.push({
          raw: line.slice(open, close + 2),
          targetTitle: rawTarget,
          displayLabel: rawLabel.length > 0 ? rawLabel : rawTarget,
          start: open,
          end: close + 2,
        })
      }
      cursor = close + 2
    } else {
      cursor = open + 2
    }
  }

  return tokens
}

/**
 * Extracts unique outgoing `[[Target Title]]` references from Markdown content,
 * ignoring fenced code blocks and inline code spans.
 */
export function extractOutgoingWikilinks(markdown: string): string[] {
  const cleaned = stripFencedAndInlineCode(markdown)
  const seen = new Set<string>()
  const targets: string[] = []

  for (const line of cleaned.split('\n')) {
    for (const token of parseWikilinksInLine(line)) {
      const key = normalizeWikilinkKey(token.targetTitle)
      if (key && !seen.has(key)) {
        seen.add(key)
        targets.push(token.targetTitle)
      }
    }
  }

  return targets
}

/**
 * Resolves a `[[Target Title]]` reference against available workspace documents
 * using case- and accent-insensitive title matching.
 */
export function resolveWikilinkTarget<T extends WikilinkDocumentTarget>(
  docs: readonly T[],
  targetTitle: string
): T | undefined {
  const wanted = normalizeWikilinkKey(targetTitle)
  if (!wanted) return undefined
  return docs.find((doc) => normalizeWikilinkKey(doc.title) === wanted)
}

/**
 * Computes incoming backlinks to `targetDocumentId` across a local/demo document graph.
 * Excludes self-links and deduplicates by source document ID.
 */
export function computeLocalBacklinks(
  docs: readonly (WikilinkDocumentTarget & { readonly content: string })[],
  targetDocumentId: string
): DocumentBacklinkItem[] {
  const target = docs.find((doc) => doc.id === targetDocumentId)
  if (!target) return []
  const targetKey = normalizeWikilinkKey(target.title)
  if (!targetKey) return []

  const backlinks: DocumentBacklinkItem[] = []
  for (const candidate of docs) {
    if (candidate.id === targetDocumentId) continue
    const outgoing = extractOutgoingWikilinks(candidate.content)
    if (outgoing.some((title) => normalizeWikilinkKey(title) === targetKey)) {
      backlinks.push({ documentId: candidate.id, title: candidate.title })
    }
  }
  return backlinks
}

/**
 * Detects an active `[[query` trigger immediately preceding the cursor for inline autocomplete.
 */
export function matchWikilinkAutocomplete(
  textBeforeCursor: string
): { readonly query: string; readonly fromOffset: number } | null {
  const open = textBeforeCursor.lastIndexOf('[[')
  if (open < 0) return null
  // Ignore `[[[`
  if (open > 0 && textBeforeCursor[open - 1] === '[') return null

  const tail = textBeforeCursor.slice(open + 2)
  if (
    tail.length > MAX_WIKILINK_TITLE_LENGTH ||
    tail.includes(']]') ||
    tail.includes('[') ||
    tail.includes(']') ||
    tail.includes('\n')
  ) {
    return null
  }
  return {
    query: tail,
    fromOffset: open,
  }
}

/**
 * Filters workspace documents for `[[` autocomplete, ranking prefix matches ahead of substring matches.
 */
export function filterWikilinkCandidates<T extends WikilinkDocumentTarget>(
  docs: readonly T[],
  query: string,
  excludeDocumentId?: string
): T[] {
  const needle = normalizeWikilinkKey(query)
  const pool = excludeDocumentId ? docs.filter((doc) => doc.id !== excludeDocumentId) : [...docs]
  if (!needle) return pool.slice(0, 12)

  return pool
    .flatMap((doc, index) => {
      const normalized = normalizeWikilinkKey(doc.title)
      const pos = normalized.indexOf(needle)
      if (pos < 0) return []
      return [{ doc, score: pos === 0 ? 0 : 100 + pos, index }]
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 12)
    .map((entry) => entry.doc)
}
