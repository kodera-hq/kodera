import { getFromStorage } from './storageTransport'
import { isVoiceNoteType, type AttachmentRef } from './attachmentRefs'
import { headOf, MAX_ATTACHMENT_BYTES, preflight } from './uploadPreflight'

/** Reads bounded voice-note audio bytes without forwarding credentials or following redirects. */
export async function loadVoiceNoteBlob(
  href: string,
  ref: AttachmentRef,
  signal: AbortSignal
): Promise<Blob> {
  const url = new URL(href)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('voice-note-refused')
  }
  if (!isVoiceNoteType(ref.contentType) || ref.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('voice-note-refused')
  }
  const response = await getFromStorage(href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal,
  })
  const type = response.headers.get('content-type')?.split(';')[0]?.trim()
  if (!response.ok || type !== ref.contentType || response.body === null) {
    throw new Error('voice-note-refused')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ATTACHMENT_BYTES || size > ref.sizeBytes) {
        throw new Error('voice-note-refused')
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const blob = new Blob(chunks, { type })
  if (!preflight({ name: ref.filename, size: blob.size, type }, await headOf(blob)).ok) {
    throw new Error('voice-note-refused')
  }
  return blob
}
