import { describe, expect, it, vi } from 'vitest'
import * as apiClient from '@/api/client'
import { ApiProblem } from '@/api/client'
import { maySeedFromMarkdown } from './collabSession'
import {
  isCollectionPreconditionFailedError,
  putWorkspaceCollectionRow,
  updateWorkspaceDocumentMetadata,
} from './workspaceDocumentsApi'

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

describe('Core 0.44.0 conditional collection row writes', () => {
  it('sends If-Match on updates, If-None-Match: * on creates, and refuses wildcard or empty If-Match', async () => {
    const putMock = vi.fn().mockResolvedValue({
      data: {
        documentId: DOC,
        values: { status: { type: 'select', value: 'done' } },
        updatedAt: '2026-11-13T12:00:00Z',
      },
      response: new Response(null, { status: 200, headers: { ETag: '"row-v2"' } }),
    })
    const clientSpy = vi
      .spyOn(apiClient, 'coreApi')
      .mockReturnValue({ PUT: putMock } as unknown as ReturnType<typeof apiClient.coreApi>)

    try {
      await expect(
        putWorkspaceCollectionRow(
          ORG,
          'col-1',
          DOC,
          { status: { kind: 'status', value: 'done' } },
          { mode: 'update', ifMatch: '*' }
        )
      ).rejects.toThrow(RangeError)

      await expect(
        putWorkspaceCollectionRow(
          ORG,
          'col-1',
          DOC,
          { status: { kind: 'status', value: 'done' } },
          { mode: 'update', ifMatch: '   ' }
        )
      ).rejects.toThrow(RangeError)

      const updated = await putWorkspaceCollectionRow(
        ORG,
        'col-1',
        DOC,
        { status: { kind: 'status', value: 'done' } },
        { mode: 'update', ifMatch: '"row-v1"' },
        [
          {
            id: 'status',
            name: 'Status',
            kind: 'status',
            options: [{ id: 'done', label: 'Done', isDone: true }],
          },
        ]
      )
      expect(updated.etag).toBe('"row-v2"')
      expect(updated.created).toBe(false)
      expect(putMock).toHaveBeenLastCalledWith(
        '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}',
        expect.objectContaining({
          params: {
            path: { organisation_id: ORG, collection_id: 'col-1', document_id: DOC },
            header: { 'If-Match': '"row-v1"' },
          },
          body: { values: { status: { type: 'select', value: 'done' } } },
        })
      )

      putMock.mockResolvedValueOnce({
        data: {
          documentId: DOC,
          values: { status: { type: 'select', value: 'done' } },
          updatedAt: '2026-11-13T12:05:00Z',
        },
        response: new Response(null, { status: 201, headers: { ETag: '"row-v1"' } }),
      })

      const created = await putWorkspaceCollectionRow(
        ORG,
        'col-1',
        DOC,
        { status: { kind: 'status', value: 'done' } },
        { mode: 'create', ifNoneMatch: '*' }
      )
      expect(created.created).toBe(true)
      expect(putMock).toHaveBeenLastCalledWith(
        '/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}',
        expect.objectContaining({
          params: {
            path: { organisation_id: ORG, collection_id: 'col-1', document_id: DOC },
            header: { 'If-None-Match': '*' },
          },
        })
      )
    } finally {
      clientSpy.mockRestore()
    }
  })

  it('identifies 412 Precondition Failed ApiProblem instances accurately', () => {
    const err412 = new ApiProblem({
      type: 'https://kodera.io/problems/precondition-failed',
      status: 412,
      title: 'Precondition Failed',
      currentEtag: '"row-v9"',
    } as never)
    const err409 = new ApiProblem({
      type: 'https://kodera.io/problems/conflict',
      status: 409,
      title: 'Conflict',
    } as never)

    expect(isCollectionPreconditionFailedError(err412)).toBe(true)
    expect(isCollectionPreconditionFailedError(err409)).toBe(false)
    expect(isCollectionPreconditionFailedError(new Error('network'))).toBe(false)
  })
})
