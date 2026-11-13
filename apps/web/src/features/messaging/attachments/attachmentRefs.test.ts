import { describe, expect, it } from 'vitest'
import { ATTACHMENTS_FIELD, attachmentRefsOf, attachmentsFallback } from './attachmentRefs'

const id = () => crypto.randomUUID()

describe('attachment references in a message', () => {
  it('keeps references that look like the ones Core issues', () => {
    const ref = { id: id(), filename: 'note.pdf', contentType: 'application/pdf', sizeBytes: 12 }
    expect(attachmentRefsOf({ [ATTACHMENTS_FIELD]: [ref] })).toEqual([ref])
  })

  it('drops whatever another client could have forged', () => {
    const good = { id: id(), filename: 'a.png', contentType: 'image/png', sizeBytes: 1 }
    const refs = attachmentRefsOf({
      [ATTACHMENTS_FIELD]: [
        good,
        good,
        { ...good, id: 'https://evil.example/x' },
        { ...good, id: id(), contentType: 'text/html' },
        { ...good, id: id(), sizeBytes: -1 },
        { ...good, id: id(), sizeBytes: '4' },
        { ...good, id: id(), filename: 7 },
        null,
        'x',
      ],
    })
    expect(refs).toEqual([good])
  })

  it('cleans a name and reads at most ten', () => {
    const many = Array.from({ length: 12 }, () => ({
      id: id(),
      filename: '../‮fdp.exe',
      contentType: 'application/octet-stream',
      sizeBytes: 3,
    }))
    const refs = attachmentRefsOf({ [ATTACHMENTS_FIELD]: many })
    expect(refs).toHaveLength(10)
    expect(refs[0]!.filename).toBe('fdp.exe')
    expect(attachmentRefsOf({ [ATTACHMENTS_FIELD]: 'x' })).toEqual([])
    expect(attachmentRefsOf(null)).toEqual([])
  })

  it('writes one line per file for other clients', () => {
    expect(
      attachmentsFallback([
        { id: id(), filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 },
        { id: id(), filename: 'b.png', contentType: 'image/png', sizeBytes: 1 },
      ])
    ).toBe('📎 a.pdf\n📎 b.png')
  })
})
