// Sending one attachment (Core API 0.43.0): ask for an upload ticket with the file's name, type, size
// and SHA-256, send the bytes to the ticket's presigned URL with exactly its signed headers, then
// ask Core to complete it, which checks the stored object before anything is visible.
//
// The presigned URL is another origin (object storage), so the bytes go through a bare `fetch`:
// never the Core client, which would add the member's token. The console's policy names that
// origin in `connect-src` (`server/static.mjs`, `ATTACHMENT_ORIGIN`); a ticket for any other
// origin, or not over https, is refused here before a byte leaves.

import { mutate } from '../../../api/mutations'
import type { components } from '../../../api/schema'
import { putToStorage } from './storageTransport'
import type { Preflight } from './uploadPreflight'

export type Attachment = components['schemas']['Attachment']
type Ticket = components['schemas']['AttachmentUploadTicket']

export class UploadRefused extends Error {
  constructor(readonly reason: 'ticket' | 'storage' | 'complete') {
    super(`attachment upload refused: ${reason}`)
    this.name = 'UploadRefused'
  }
}

/** The file's SHA-256, as the contract writes it: 64 lower-case hex digits. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Headers a page may not set, or must never forward to storage. */
const REFUSED_HEADERS = /^(authorization|cookie|host|origin|referer|proxy-.*|sec-.*)$/iu

/** The ticket, checked: https, a PUT, and string headers only, none of them a credential. */
export function checkTicket(ticket: Ticket, pageProtocol = globalThis.location?.protocol): Ticket {
  let url: URL
  try {
    url = new URL(ticket.uploadUrl)
  } catch {
    throw new UploadRefused('ticket')
  }
  const local = pageProtocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new UploadRefused('ticket')
  if (url.username !== '' || url.password !== '') throw new UploadRefused('ticket')
  if (ticket.method !== 'PUT') throw new UploadRefused('ticket')
  const headers = ticket.headers as Record<string, unknown>
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || REFUSED_HEADERS.test(name)) throw new UploadRefused('ticket')
  }
  return ticket
}

export interface UploadInput {
  organisationId: string
  file: Blob
  checked: Extract<Preflight, { ok: true }>
  signal?: AbortSignal
  /** For tests: the transport the bytes go through. */
  put?: typeof fetch
}

export async function uploadAttachment({
  organisationId,
  file,
  checked,
  signal,
  put = putToStorage,
}: UploadInput): Promise<Attachment> {
  const sha256 = await sha256Hex(file)
  const ticket = checkTicket(
    await mutate(
      { method: 'post', path: '/organisations/{organisation_id}/workspace/attachments/uploads' },
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body: {
          filename: checked.filename,
          contentType: checked.contentType,
          sizeBytes: checked.sizeBytes,
          sha256,
        },
      }
    )
  )
  const stored = await put(ticket.uploadUrl, {
    method: 'PUT',
    headers: ticket.headers as Record<string, string>,
    body: file,
    // Storage is another origin: no cookie, no referrer, nothing of this page goes with the bytes.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    mode: 'cors',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!stored.ok) throw new UploadRefused('storage')
  const data = await mutate(
    {
      method: 'post',
      path: '/organisations/{organisation_id}/workspace/attachments/{attachment_id}/complete',
    },
    {
      params: {
        path: { organisation_id: organisationId, attachment_id: ticket.attachmentId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      ...(signal === undefined ? {} : { signal }),
    }
  )
  if (data === undefined || data.sha256 !== sha256) throw new UploadRefused('complete')
  return data
}
