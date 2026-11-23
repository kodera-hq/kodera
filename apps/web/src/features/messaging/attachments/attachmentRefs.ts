// How a message carries its attachments (docs/specs/messaging-media-and-notifications.md): the
// Matrix event names each one by Core's id under `io.kodera.attachments`, never by an address. A
// download address expires within minutes, so a reader asks Core for a fresh one when opening it,
// and Core enforces the channel or Matrix direct-message room scope bound at upload-ticket creation.
// What another member's client wrote is read field by field: a reference that does not look like
// one Core issued is dropped, and nothing in it is ever used as an address.

import {
  ATTACHMENT_TYPES,
  cleanFilename,
  MAX_PENDING_ATTACHMENTS,
  type AttachmentType,
} from './uploadPreflight'

export const ATTACHMENTS_FIELD = 'io.kodera.attachments'

export const VOICE_NOTE_TYPES = ['audio/ogg', 'audio/webm', 'audio/mp4'] as const
export type VoiceNoteMimeType = (typeof VOICE_NOTE_TYPES)[number]

export function isVoiceNoteType(value: string): value is VoiceNoteMimeType {
  return (VOICE_NOTE_TYPES as readonly string[]).includes(value)
}

export interface AttachmentMetadata {
  readonly durationMs?: number | undefined
  readonly waveform?: readonly number[] | undefined
}

export interface AttachmentRef {
  id: string
  filename: string
  contentType: AttachmentType
  sizeBytes: number
  durationMs?: number
  waveform?: number[]
}

export type AttachmentUploadScope =
  | { readonly channelId: string; readonly roomId?: undefined }
  | { readonly roomId: string; readonly channelId?: undefined }
  | { readonly channelId?: undefined; readonly roomId?: undefined }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MATRIX_ROOM_ID = /^!(?:[!-9;-~]{1,128}:[A-Za-z0-9.:-]{1,253}|[A-Za-z0-9_-]{43})$/u

/** Maps a composer target room to its authoritative Core channel UUID or Matrix DM room ID. */
export function resolveAttachmentScope(
  room: string,
  channels?: ReadonlyMap<string, { readonly state: string; readonly roomId?: string }>
): AttachmentUploadScope {
  if (channels !== undefined) {
    for (const [channelId, resolved] of channels.entries()) {
      if (resolved.state === 'resolved' && resolved.roomId === room && UUID.test(channelId)) {
        return { channelId: channelId.toLowerCase() }
      }
    }
  }
  if (UUID.test(room)) {
    return { channelId: room.toLowerCase() }
  }
  if (MATRIX_ROOM_ID.test(room) && room.length <= 255) {
    return { roomId: room }
  }
  return {}
}

/** The references a message's content carries, checked; at most ten, never twice the same id. */
export function attachmentRefsOf(content: unknown): AttachmentRef[] {
  if (content === null || typeof content !== 'object') return []
  const listed = (content as Record<string, unknown>)[ATTACHMENTS_FIELD]
  if (!Array.isArray(listed)) return []
  const refs: AttachmentRef[] = []
  for (const item of listed.slice(0, MAX_PENDING_ATTACHMENTS)) {
    if (item === null || typeof item !== 'object') continue
    const { id, filename, contentType, sizeBytes, durationMs, waveform } = item as Record<
      string,
      unknown
    >
    if (typeof id !== 'string' || !UUID.test(id) || refs.some((ref) => ref.id === id)) continue
    if (typeof filename !== 'string' || typeof contentType !== 'string') continue
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(contentType)) continue
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) continue
    const validDuration =
      typeof durationMs === 'number' &&
      Number.isSafeInteger(durationMs) &&
      durationMs >= 1 &&
      durationMs <= 3_600_000
        ? durationMs
        : undefined
    const validWaveform =
      Array.isArray(waveform) &&
      waveform.length >= 1 &&
      waveform.length <= 64 &&
      waveform.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100)
        ? (waveform as number[])
        : undefined
    refs.push({
      id,
      filename: cleanFilename(filename),
      contentType: contentType as AttachmentType,
      sizeBytes,
      ...(validDuration === undefined ? {} : { durationMs: validDuration }),
      ...(validWaveform === undefined ? {} : { waveform: validWaveform }),
    })
  }
  return refs
}

/** The text other clients show for a message that is only attachments. */
export function attachmentsFallback(refs: readonly AttachmentRef[]): string {
  return refs.map((ref) => `📎 ${ref.filename}`).join('\n')
}
