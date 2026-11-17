import { getFromStorage } from './storageTransport'
import { headOf, MAX_ATTACHMENT_BYTES, preflight } from './uploadPreflight'
import type { AttachmentRef } from './attachmentRefs'

/** Reads bounded raster bytes without forwarding credentials or trusting an active MIME type. */
export async function loadImagePreview(
  href: string,
  ref: AttachmentRef,
  signal: AbortSignal
): Promise<Blob> {
  const url = new URL(href)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new Error('image-refused')
  if (!/^image\/(png|jpeg|gif|webp)$/.test(ref.contentType) || ref.sizeBytes > MAX_ATTACHMENT_BYTES)
    throw new Error('image-refused')
  const response = await getFromStorage(href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  })
  const type = response.headers.get('content-type')?.split(';')[0]?.trim()
  if (!response.ok || type !== ref.contentType || response.body === null)
    throw new Error('image-refused')
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ATTACHMENT_BYTES || size > ref.sizeBytes) throw new Error('image-refused')
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const blob = new Blob(chunks, { type })
  if (!preflight({ name: ref.filename, size: blob.size, type }, await headOf(blob)).ok)
    throw new Error('image-refused')
  return blob
}
