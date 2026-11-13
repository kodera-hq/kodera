import { describe, expect, it, vi } from 'vitest'
import { ApiProblem } from '@/api/client'
import { maySeedFromMarkdown } from './collabSession'
import { updateWorkspaceDocumentMetadata } from './workspaceDocumentsApi'

const ORG = crypto.randomUUID()
const DOC = crypto.randomUUID()
const stale = () => new ApiProblem({ status: 412, type: 'precondition-failed' } as never)
const saved = (etag: string) => ({ document: { id: DOC } as never, etag })

describe('a document title or parent change', () => {
  it('re-reads the tag once when a realtime commit made it stale, and saves', async () => {
    const update = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce(saved('"fresh-2"'))
    const get = vi.fn().mockResolvedValue(saved('"fresh-1"'))
    const result = await updateWorkspaceDocumentMetadata(ORG, DOC, '"read-on-open"', { title: 'Renamed' }, { update, get })
    expect(result.etag).toBe('"fresh-2"')
    expect(update).toHaveBeenNthCalledWith(1, ORG, DOC, '"read-on-open"', { title: 'Renamed' })
    expect(update).toHaveBeenNthCalledWith(2, ORG, DOC, '"fresh-1"', { title: 'Renamed' })
  })

  it('does not retry any refusal other than a stale tag', async () => {
    const forbidden = new ApiProblem({ status: 403, type: 'forbidden' } as never)
    const update = vi.fn().mockRejectedValue(forbidden)
    const get = vi.fn()
    await expect(
      updateWorkspaceDocumentMetadata(ORG, DOC, '"t"', { parentId: null }, { update, get })
    ).rejects.toBe(forbidden)
    expect(get).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('seeding the block editor from Markdown', () => {
  it('never seeds a server-backed document before or while the server delivers its state', () => {
    for (const status of ['connecting', 'reconnecting', 'synced', 'offline-buffered', 'forbidden'] as const) {
      expect(maySeedFromMarkdown(true, status)).toBe(false)
    }
  })

  it('seeds a local document, and a server document whose server declined collaboration', () => {
    expect(maySeedFromMarkdown(false, 'connecting')).toBe(true)
    expect(maySeedFromMarkdown(true, 'local')).toBe(true)
  })
})
