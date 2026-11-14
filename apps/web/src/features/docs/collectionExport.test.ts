import { describe, expect, it } from 'vitest'
import {
  escapeMarkdownTableCell,
  exportCollection,
  exportCollectionToCsv,
  exportCollectionToJson,
  exportCollectionToMarkdownTable,
  neutralizeCsvFormula,
} from './collectionExport'
import { createDefaultCollectionSchema, type EnrichedCollectionRow } from './collectionSchema'

describe('collectionExport deterministic CSV, JSON, and Markdown table exports', () => {
  const schema = createDefaultCollectionSchema('en')
  const members = [{ id: 'u-camille', name: 'Camille Laurent' }]

  const sampleRows: EnrichedCollectionRow[] = [
    {
      documentId: 'doc-1',
      title: '=CMD|\' /C calc\'!A0',
      updatedAt: '2026-11-13T10:00:00Z',
      role: 'editor',
      values: {
        status: { kind: 'status', value: 'done' },
        priority: { kind: 'priority', value: 'urgent' },
        assignee: { kind: 'assignee', value: 'u-camille' },
        due_date: { kind: 'due_date', value: '2026-11-25' },
        verified: { kind: 'checkbox', value: true },
        estimate: { kind: 'number', value: 8 },
        reference_url: { kind: 'url', value: 'https://docs.kodera.io/adr/1' },
        tags: { kind: 'tags', value: ['security', 'ops'] },
      },
    },
    {
      documentId: 'doc-2',
      title: 'Architecture | Storage\\Layer',
      updatedAt: '2026-11-13T11:00:00Z',
      role: 'editor',
      values: {
        status: { kind: 'status', value: 'in_progress' },
        priority: { kind: 'priority', value: 'medium' },
        assignee: { kind: 'assignee', value: null },
        due_date: { kind: 'due_date', value: null },
        verified: { kind: 'checkbox', value: false },
        estimate: { kind: 'number', value: 4 },
        // Unsafe scheme even if injected into in-memory state must never export
        reference_url: { kind: 'url', value: 'javascript:alert(1)' },
        tags: { kind: 'tags', value: ['architecture'] },
      },
    },
  ]

  it('neutralizes CSV formula injection vectors (leading =, +, -, @, tab, CR, LF, and whitespace-prefixed formulas)', () => {
    expect(neutralizeCsvFormula('=CMD|\' /C calc\'!A0')).toBe('\'=CMD|\' /C calc\'!A0')
    expect(neutralizeCsvFormula('+SUM(A1:A9)')).toBe("'+SUM(A1:A9)")
    expect(neutralizeCsvFormula('-2+3+cmd')).toBe("'-2+3+cmd")
    expect(neutralizeCsvFormula('@SUM(1+1)')).toBe("'@SUM(1+1)")
    expect(neutralizeCsvFormula('\t=1+1')).toBe("'\t=1+1")
    expect(neutralizeCsvFormula('\r=1+1')).toBe("'\r=1+1")
    expect(neutralizeCsvFormula('\n=1+1')).toBe("'\n=1+1")
    expect(neutralizeCsvFormula('   =HYPERLINK("http://evil.test")')).toBe(
      '\'   =HYPERLINK("http://evil.test")'
    )
    expect(neutralizeCsvFormula('Safe Document Title')).toBe('Safe Document Title')
    expect(neutralizeCsvFormula('')).toBe('')
  })

  it('exports deterministic RFC 4180 CSV with neutralized formulas and stripped unsafe URLs', () => {
    const csv = exportCollectionToCsv({
      collectionId: schema.id,
      collectionTitle: schema.title,
      properties: schema.properties,
      rows: sampleRows,
      totalCount: 3,
      members,
      locale: 'en',
    })

    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'Document,Status,Priority,Assignee,Due date,Verified,Effort,Reference URL,Tags'
    )
    // Formula payload is neutralized with a leading single quote inside RFC 4180 quotes
    expect(lines[1]).toContain('"\'=CMD|\' /C calc\'!A0"')
    expect(lines[1]).toContain('Camille Laurent')
    expect(lines[1]).toContain('https://docs.kodera.io/adr/1')
    expect(lines[1]).toContain('"Security, Operations"')
    // Malicious javascript: URL is stripped cleanly
    expect(csv).not.toContain('javascript:')
    expect(
      exportCollection('csv', {
        collectionId: schema.id,
        collectionTitle: schema.title,
        properties: schema.properties,
        rows: sampleRows,
        members,
        locale: 'en',
      })
    ).toBe(csv)
  })

  it('exports deterministic JSON with rollup metrics and sanitized URLs', () => {
    const rawJson = exportCollectionToJson({
      collectionId: schema.id,
      collectionTitle: schema.title,
      properties: schema.properties,
      rows: sampleRows,
      totalCount: 4,
      members,
      locale: 'en',
    })
    const parsed = JSON.parse(rawJson) as {
      totalCount: number
      exportedCount: number
      rollups: {
        doneCount: number
        donePercent: number
        numeric: Array<{ propertyId: string; sum: number; avg: number }>
      }
      rows: Array<{ documentId: string; properties: Record<string, unknown> }>
    }

    expect(parsed.totalCount).toBe(4)
    expect(parsed.exportedCount).toBe(2)
    expect(parsed.rollups.doneCount).toBe(1)
    expect(parsed.rollups.donePercent).toBe(50)
    expect(parsed.rollups.numeric).toEqual([
      { propertyId: 'estimate', count: 2, sum: 12, avg: 6 },
    ])
    expect(parsed.rows[0]?.properties['reference_url']).toBe('https://docs.kodera.io/adr/1')
    expect(parsed.rows[1]?.properties['reference_url']).toBeNull()
  })

  it('exports deterministic Markdown table with escaped pipes/backslashes and rollup summary', () => {
    expect(escapeMarkdownTableCell('a | b \\ c\nd')).toBe('a \\| b \\\\ c d')

    const md = exportCollectionToMarkdownTable({
      collectionId: schema.id,
      collectionTitle: schema.title,
      properties: schema.properties,
      rows: sampleRows,
      totalCount: 2,
      members,
      locale: 'en',
    })

    expect(md).toContain('# Document tracker')
    expect(md).toContain(
      '| Document | Status | Priority | Assignee | Due date | Verified | Effort | Reference URL | Tags |'
    )
    expect(md).toContain('Architecture \\| Storage\\\\Layer')
    expect(md).toContain(
      '> 2 entries · Done: 50% (1/2) · Verified: 50% checked · Effort: sum 12 · avg 6'
    )
    expect(md).not.toContain('javascript:')
  })
})
