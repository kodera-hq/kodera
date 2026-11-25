import { afterEach, describe, expect, it, vi } from 'vitest'
import * as apiClient from '@/api/client'
import { ApiProblem } from '@/api/client'
import {
  availableDocumentSubteams,
  documentSubteamPermission,
  isDocumentRoleGrantConflict,
  listDocumentRoleGrants,
  listDocumentSubteams,
  putDocumentRoleGrant,
  revokeDocumentRoleGrant,
} from './documentRoleGrantsApi'

const org = crypto.randomUUID()
const doc = crypto.randomUUID()
const roleId = crypto.randomUUID()
const grant = {
  workspaceRoleId: roleId,
  name: 'Engineering',
  slug: 'engineering',
  role: 'editor' as const,
}
const response = (etag = '"grants-2"') => new Response(null, { headers: { ETag: etag } })

afterEach(() => vi.restoreAllMocks())

function client(methods: Record<string, unknown>) {
  vi.spyOn(apiClient, 'coreApi').mockReturnValue(
    methods as unknown as ReturnType<typeof apiClient.coreApi>
  )
}

describe('document subteam permissions', () => {
  it('lists only subteams and labels their mentions by slug, with cancellation', async () => {
    const GET = vi.fn().mockResolvedValue({
      data: {
        data: [
          { id: 'role', name: 'Admin', slug: 'admin', kind: 'role' },
          { id: roleId, name: 'Engineering', slug: 'engineering', kind: 'subteam' },
          { id: 'tag', name: 'Remote', slug: 'remote', kind: 'tag' },
        ],
      },
      response: response(),
    })
    client({ GET })
    const signal = new AbortController().signal
    await expect(listDocumentSubteams(org, signal)).resolves.toEqual([
      { id: roleId, name: 'Engineering', slug: 'engineering', mention: '@engineering' },
    ])
    expect(GET).toHaveBeenCalledWith('/organisations/{organisation_id}/workspace/roles', {
      params: { path: { organisation_id: org } },
      signal,
    })
  })

  it('reads the direct grant set and keeps its exact tag and revision', async () => {
    const GET = vi
      .fn()
      .mockResolvedValue({ data: { revision: 2, data: [grant] }, response: response() })
    client({ GET })
    const state = await listDocumentRoleGrants(org, doc)
    expect(state).toEqual({ grants: [grant], revision: 2, etag: '"grants-2"' })
    expect(documentSubteamPermission(state, roleId)).toBe('editor')
    expect(documentSubteamPermission(state, 'absent')).toBeNull()
    const subteams = [
      { id: roleId, name: 'Engineering', slug: 'engineering', mention: '@engineering' as const },
    ]
    expect(availableDocumentSubteams(subteams, state)).toEqual([])
    expect(subteams).toHaveLength(1)
  })

  it('puts and revokes using the grant snapshot tag, then replaces all state from Core', async () => {
    const PUT = vi
      .fn()
      .mockResolvedValue({ data: { revision: 3, data: [grant] }, response: response('"new"') })
    const DELETE = vi
      .fn()
      .mockResolvedValue({ data: { revision: 4, data: [] }, response: response('"removed"') })
    client({ PUT, DELETE })
    const saved = await putDocumentRoleGrant(org, doc, roleId, 'viewer', '"old"')
    expect(PUT).toHaveBeenCalledWith(
      '/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants/{role_id}',
      {
        params: {
          path: { organisation_id: org, document_id: doc, role_id: roleId },
          header: { 'If-Match': '"old"' },
        },
        headers: { 'Idempotency-Key': expect.any(String) },
        body: { role: 'viewer' },
      }
    )
    expect(saved.etag).toBe('"new"')
    const removed = await revokeDocumentRoleGrant(org, doc, roleId, saved.etag)
    expect(DELETE.mock.calls[0]?.[1].params.header).toEqual({ 'If-Match': '"new"' })
    expect(DELETE.mock.calls[0]?.[1].headers['Idempotency-Key']).toEqual(expect.any(String))
    expect(DELETE.mock.calls[0]?.[1].headers['Idempotency-Key']).not.toBe(
      PUT.mock.calls[0]?.[1].headers['Idempotency-Key']
    )
    expect(removed).toEqual({ grants: [], revision: 4, etag: '"removed"' })
  })

  it('generates independent RFC 4122 UUIDv4 keys without randomUUID', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never)
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    const PUT = vi.fn().mockResolvedValue({ data: { revision: 1, data: [] }, response: response() })
    const DELETE = vi
      .fn()
      .mockResolvedValue({ data: { revision: 1, data: [] }, response: response() })
    client({ PUT, DELETE })
    await putDocumentRoleGrant(org, doc, roleId, 'viewer', '"v1"')
    await revokeDocumentRoleGrant(org, doc, roleId, '"v1"')
    const key = PUT.mock.calls[0]?.[1].headers['Idempotency-Key']
    const other = DELETE.mock.calls[0]?.[1].headers['Idempotency-Key']
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(other).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(other).not.toBe(key)
  })

  it.each(['', '*', ' ', 'W/"weak"'])(
    'refuses unsafe mutation tags before transport: %s',
    async (etag) => {
      const PUT = vi.fn()
      const DELETE = vi.fn()
      client({ PUT, DELETE })
      await expect(putDocumentRoleGrant(org, doc, roleId, 'editor', etag)).rejects.toThrow(
        RangeError
      )
      await expect(revokeDocumentRoleGrant(org, doc, roleId, etag)).rejects.toThrow(RangeError)
      expect(PUT).not.toHaveBeenCalled()
      expect(DELETE).not.toHaveBeenCalled()
    }
  )

  it('propagates stale and forbidden responses without retrying a permission change', async () => {
    const stale = new ApiProblem({ status: 412, type: 'precondition-failed' } as never)
    const forbidden = new ApiProblem({ status: 403, type: 'forbidden' } as never)
    const PUT = vi.fn().mockRejectedValue(stale)
    const DELETE = vi.fn().mockRejectedValue(forbidden)
    client({ PUT, DELETE })
    await expect(putDocumentRoleGrant(org, doc, roleId, 'editor', '"old"')).rejects.toBe(stale)
    await expect(revokeDocumentRoleGrant(org, doc, roleId, '"old"')).rejects.toBe(forbidden)
    expect(isDocumentRoleGrantConflict(stale)).toBe(true)
    expect(isDocumentRoleGrantConflict(forbidden)).toBe(false)
    expect(PUT).toHaveBeenCalledTimes(1)
    expect(DELETE).toHaveBeenCalledTimes(1)
  })

  it('refuses missing permission responses and missing ETags', async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({ data: undefined, response: response() })
      .mockResolvedValueOnce({ data: { revision: 1, data: [] }, response: new Response() })
    client({ GET })
    await expect(listDocumentRoleGrants(org, doc)).rejects.toBeInstanceOf(ApiProblem)
    await expect(listDocumentRoleGrants(org, doc)).rejects.toThrow(RangeError)
  })
})
