import { describe, it, expect, vi } from 'vitest'
import { instantClaimWorkspace, localClaim, type InstantClaimPayload } from './instantClaimClient'
const payload: InstantClaimPayload = {
  organizationName: 'Cinema',
  slug: 'cinema',
  hostingMode: 'cloud',
  templateId: 'audiovisual-production',
  themeId: 'real-black',
  soundPackId: 'givre',
  enabledConnectors: ['frameio-review-bridge'],
}
describe('instant claim boundary', () => {
  it('posts the typed intent through Core and validates a successful assignment', async () => {
    const post = vi.fn().mockResolvedValue({
      response: { status: 201 },
      data: {
        workspaceId: 'workspace-1',
        workspaceUrl: 'https://cinema.kodera.io',
        invitationUrl: 'https://cinema.kodera.io/invite?signed=1',
        channels: [{ id: 'production', name: 'production', kind: 'text' }],
        enabledConnectors: ['frameio-review-bridge'],
      },
    })
    const result = await instantClaimWorkspace(payload, { post, idempotencyKey: 'claim-intent-1' })
    expect(post).toHaveBeenCalledWith(
      '/workspaces/instant-claim',
      expect.objectContaining({ body: payload, headers: { 'Idempotency-Key': 'claim-intent-1' } })
    )
    expect(result.workspaceId).toBe('workspace-1')
    expect(result.channels[0]?.name).toBe('production')
  })
  it('refuses malformed successful data instead of presenting an invented cloud workspace', async () => {
    await expect(
      instantClaimWorkspace(payload, {
        post: async () => ({
          response: { status: 200 },
          data: { workspaceId: 'id', workspaceUrl: 'javascript:alert(1)' },
        }),
      })
    ).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('times out even when the transport ignores abort', async () => {
    await expect(
      instantClaimWorkspace(payload, { post: () => new Promise(() => {}), timeoutMs: 10 })
    ).rejects.toMatchObject({ kind: 'unavailable' })
  })
  it('keeps local plans deterministic and never invents an invitation', () => {
    expect(localClaim(payload)).toEqual(localClaim(payload))
    expect(localClaim(payload).invitationUrl).toBeUndefined()
    expect(localClaim(payload).channels.map((c) => c.name)).toContain('post-production')
  })
})

it('classifies a rejected network request as unavailable', async () => {
  await expect(
    instantClaimWorkspace(payload, {
      post: async () => {
        throw new TypeError('offline')
      },
    })
  ).rejects.toMatchObject({ kind: 'unavailable' })
})
it('bounds streamed response bodies before parsing and refuses internal links', async () => {
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537))
      controller.close()
    },
  })
  await expect(
    instantClaimWorkspace(payload, {
      post: async () => ({ data: oversized, response: { status: 200 } }),
    })
  ).rejects.toMatchObject({ kind: 'invalid-response' })
  await expect(
    instantClaimWorkspace(payload, {
      post: async () => ({
        data: {
          workspaceId: 'w',
          workspaceUrl: 'https://private.internal',
          invitationUrl: 'https://cinema.kodera.io/invite',
          channels: [{ id: 'p', name: 'production', kind: 'text' }],
          enabledConnectors: [],
        },
        response: { status: 201 },
      }),
    })
  ).rejects.toMatchObject({ kind: 'invalid-response' })
})
