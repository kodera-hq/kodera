import { expect, it } from 'vitest'
import {
  DOCUMENT_KIND_MARKERS,
  driveDocumentKind,
  preserveDocumentKind,
  readDriveCollectionRows,
  writeDriveCollectionRows,
} from './driveKinds'

it('preserves document kinds through body edits and treats ordinary Markdown as a page', () => {
  expect(driveDocumentKind('# Page')).toBe('page')
  expect(driveDocumentKind('Example: ' + DOCUMENT_KIND_MARKERS.base)).toBe('page')
  for (const [kind, marker] of Object.entries(DOCUMENT_KIND_MARKERS)) {
    expect(driveDocumentKind(preserveDocumentKind(marker, '# Updated'))).toBe(kind)
  }
})

it('round-trips database rows inside Markdown without allowing comment termination', () => {
  const rows = [
    {
      documentId: 'row',
      updatedAt: '',
      values: { title: { kind: 'text' as const, value: '--><script>example</script>' } },
    },
  ]
  const markdown = writeDriveCollectionRows(DOCUMENT_KIND_MARKERS.base, rows)
  expect(readDriveCollectionRows(markdown)).toEqual(rows)
  expect(markdown).not.toContain('<script>')
  expect(driveDocumentKind(markdown)).toBe('base')
  expect(writeDriveCollectionRows(markdown, rows)).toBe(markdown)
  expect(readDriveCollectionRows('<!-- kodera:collection-rows:v1 invalid -->')).toEqual([])
})

it('round-trips document kinds and database rows through the existing server Markdown codec', async () => {
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const path = pathToFileURL(resolve(process.cwd(), '../server/yjs_collab/engine.mjs')).href
  const engine = await import(/* @vite-ignore */ path)
  const rows = [
    {
      documentId: 'row-1',
      updatedAt: '',
      values: {
        note: { kind: 'text' as const, value: 'Review [draft] with _details_ and accents: été.' },
      },
    },
  ]
  for (const marker of Object.values(DOCUMENT_KIND_MARKERS)) {
    const doc = engine.load()
    try {
      const source = writeDriveCollectionRows(marker, rows)
      const result = engine.replace(doc, source)
      expect(driveDocumentKind(result.markdown)).toBe(driveDocumentKind(source))
      expect(readDriveCollectionRows(result.markdown)).toEqual(rows)
      expect(readDriveCollectionRows(engine.inspect(doc).markdown)).toEqual(rows)
    } finally {
      doc.destroy()
    }
  }
})
