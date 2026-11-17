import { afterEach, expect, it, vi } from 'vitest'
import { loadImagePreview } from '../../../src/features/messaging/attachments/imagePreview'
import type { AttachmentRef } from '../../../src/features/messaging/attachments/attachmentRefs'
const transport = vi.hoisted(() => vi.fn())
vi.mock('../../../src/features/messaging/attachments/storageTransport', () => ({
  getFromStorage: transport,
}))
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ref: AttachmentRef = {
  id: 'file',
  filename: 'photo.png',
  contentType: 'image/png',
  sizeBytes: png.length,
}
const signal = new AbortController().signal
afterEach(() => transport.mockReset())
it('only previews checked raster bytes using a credential-free bounded read', async () => {
  transport.mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }))
  expect((await loadImagePreview('https://storage.example.org/file', ref, signal)).size).toBe(
    png.length
  )
  expect(transport).toHaveBeenCalledWith('https://storage.example.org/file', {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  })
})
it('refuses active MIME types and unsafe addresses before fetching', async () => {
  for (const href of ['javascript:alert(1)', 'https://user:pass@example.org/file'])
    await expect(loadImagePreview(href, ref, signal)).rejects.toThrow()
  await expect(
    loadImagePreview(
      'https://storage.example.org/file',
      { ...ref, contentType: 'image/svg+xml' } as unknown as AttachmentRef,
      signal
    )
  ).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
})
it('refuses forged images, excess bytes, and a mismatched response type', async () => {
  for (const response of [
    new Response('<html>', { headers: { 'content-type': 'image/png' } }),
    new Response(new Uint8Array(20), { headers: { 'content-type': 'image/png' } }),
    new Response(png, { headers: { 'content-type': 'text/html' } }),
  ]) {
    transport.mockResolvedValueOnce(response)
    await expect(
      loadImagePreview('https://storage.example.org/file', ref, signal)
    ).rejects.toThrow()
  }
})
