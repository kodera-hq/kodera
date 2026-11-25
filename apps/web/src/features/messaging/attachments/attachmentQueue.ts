// The files waiting in a composer, one list per room (docs/specs/messaging-media-and-notifications.md).
// Safe raster images get a CSP-compliant `blob:` thumbnail (`URL.createObjectURL`, revoked on
// removal, send/clear, preflight refusal, or close/unmount).

import {
  cleanFilename,
  headOf,
  MAX_PENDING_ATTACHMENTS,
  preflight,
  type PreflightRefusal,
} from './uploadPreflight'
import { uploadAttachment, type Attachment, type UploadInput } from './uploadAttachment'
import {
  resolveAttachmentScope,
  type AttachmentMetadata,
  type AttachmentRef,
  type AttachmentUploadScope,
} from './attachmentRefs'

export type QueuedState =
  | { status: 'uploading' }
  | { status: 'ready'; ref: AttachmentRef }
  | { status: 'refused'; reason: PreflightRefusal | 'too-many' }
  | { status: 'failed' }

export type QueuedFile = QueuedState & {
  key: string
  filename: string
  sizeBytes: number
  previewUrl?: string | undefined
}

type Upload = (input: UploadInput) => Promise<Attachment>

const NONE: readonly QueuedFile[] = []
const SAFE_RASTER_PREVIEW_MIME = /^image\/(png|jpeg|webp|gif)$/u

function createRasterPreviewUrl(file: File): string | undefined {
  if (!SAFE_RASTER_PREVIEW_MIME.test(file.type)) return undefined
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

function revokeRasterPreviewUrl(url: string | undefined): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // Ignore already-revoked object URLs.
  }
}

export class AttachmentQueue {
  readonly #organisationId: string
  readonly #upload: Upload
  readonly #mayUpload: (room: string) => boolean
  readonly #scopeOf: (room: string) => AttachmentUploadScope
  #rooms = new Map<string, readonly QueuedFile[]>()
  #aborts = new Map<string, AbortController>()
  #sources = new Map<string, { room: string; file: File; metadata?: AttachmentMetadata }>()
  #listeners = new Set<() => void>()
  #serial = 0
  #generation = 0

  constructor(
    organisationId: string,
    upload: Upload = uploadAttachment,
    mayUpload: (room: string) => boolean = () => true,
    scopeOf: (room: string) => AttachmentUploadScope = (room) => resolveAttachmentScope(room)
  ) {
    this.#organisationId = organisationId
    this.#upload = upload
    this.#mayUpload = mayUpload
    this.#scopeOf = scopeOf
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  files(room: string): readonly QueuedFile[] {
    return this.#rooms.get(room) ?? NONE
  }

  /** The references a message may carry now, or null while one is still being sent or is refused. */
  readyRefs(room: string): AttachmentRef[] | null {
    const files = this.files(room)
    if (files.some((file) => file.status !== 'ready')) return null
    return files.flatMap((file) => (file.status === 'ready' ? [file.ref] : []))
  }

  async add(
    room: string,
    incoming: readonly File[],
    metadata?: AttachmentMetadata
  ): Promise<void> {
    if (!this.#mayUpload(room)) return
    const generation = this.#generation
    await Promise.all(
      incoming.map(async (file) => {
        const key = `f${++this.#serial}`
        if (this.files(room).length >= MAX_PENDING_ATTACHMENTS) {
          this.#put(room, {
            key,
            filename: cleanFilename(file.name),
            sizeBytes: file.size,
            status: 'refused',
            reason: 'too-many',
          })
          return
        }
        const previewUrl = createRasterPreviewUrl(file)
        const base = {
          key,
          filename: cleanFilename(file.name),
          sizeBytes: file.size,
          ...(previewUrl === undefined ? {} : { previewUrl }),
        }
        this.#put(room, { ...base, status: 'uploading' })
        await this.#send(room, key, file, base, generation, metadata)
      })
    )
  }

  /** Re-sends a failed file in place without asking the member to choose it again. */
  async retry(room: string, key: string): Promise<void> {
    const existing = this.files(room).find((item) => item.key === key)
    const source = this.#sources.get(key)
    if (existing?.status !== 'failed' || source?.room !== room || !this.#mayUpload(room)) return
    const generation = this.#generation
    const base = {
      key,
      filename: existing.filename,
      sizeBytes: existing.sizeBytes,
      ...(existing.previewUrl === undefined ? {} : { previewUrl: existing.previewUrl }),
    }
    this.#sources.delete(key)
    this.#replace(room, key, { ...base, status: 'uploading' })
    await this.#send(room, key, source.file, base, generation, source.metadata)
  }

  remove(room: string, key: string): void {
    const existing = this.files(room).find((item) => item.key === key)
    revokeRasterPreviewUrl(existing?.previewUrl)
    this.#aborts.get(key)?.abort()
    this.#sources.delete(key)
    this.#set(
      room,
      this.files(room).filter((file) => file.key !== key)
    )
  }

  /** Forgets the room's list once its message is sent, revoking staged blob: URLs. */
  clear(room: string): void {
    for (const file of this.files(room)) {
      revokeRasterPreviewUrl(file.previewUrl)
      this.#aborts.get(file.key)?.abort()
      this.#sources.delete(file.key)
    }
    this.#set(room, NONE)
  }

  /** Stops every upload and revokes all staged blob: URLs when the composer unmounts. */
  close(): void {
    this.#generation += 1
    for (const roomFiles of this.#rooms.values()) {
      for (const file of roomFiles) {
        revokeRasterPreviewUrl(file.previewUrl)
      }
    }
    this.#rooms.clear()
    this.#sources.clear()
    for (const abort of this.#aborts.values()) abort.abort()
    this.#aborts.clear()
  }

  async #send(
    room: string,
    key: string,
    file: File,
    base: { key: string; filename: string; sizeBytes: number; previewUrl?: string | undefined },
    generation: number,
    metadata?: AttachmentMetadata
  ): Promise<void> {
    const rememberFailure = (named = base) => {
      if (generation === this.#generation && this.files(room).some((entry) => entry.key === key)) {
        this.#sources.set(key, {
          room,
          file,
          ...(metadata === undefined ? {} : { metadata }),
        })
      }
      this.#replace(room, key, { ...named, status: 'failed' })
    }
    let checked
    try {
      checked = preflight(file, await headOf(file))
    } catch {
      rememberFailure()
      return
    }
    if (!checked.ok) {
      revokeRasterPreviewUrl(base.previewUrl)
      this.#replace(room, key, {
        key: base.key,
        filename: base.filename,
        sizeBytes: base.sizeBytes,
        status: 'refused',
        reason: checked.reason,
      })
      return
    }
    if (!this.#mayUpload(room)) {
      rememberFailure()
      return
    }
    if (generation !== this.#generation || !this.files(room).some((entry) => entry.key === key)) {
      revokeRasterPreviewUrl(base.previewUrl)
      return
    }
    const named = { ...base, filename: checked.filename }
    const abort = new AbortController()
    this.#aborts.set(key, abort)
    try {
      const scope = this.#scopeOf(room)
      if (
        this.#upload === uploadAttachment &&
        scope.channelId === undefined &&
        scope.roomId === undefined
      ) {
        rememberFailure(named)
        return
      }
      const stored = await this.#upload({
        organisationId: this.#organisationId,
        file,
        checked,
        ...(scope.channelId !== undefined
          ? { channelId: scope.channelId }
          : scope.roomId !== undefined
            ? { roomId: scope.roomId }
            : {}),
        signal: abort.signal,
        mayUpload: () => generation === this.#generation && this.#mayUpload(room),
      })
      const validWaveform =
        metadata?.waveform !== undefined &&
        metadata.waveform.length >= 1 &&
        metadata.waveform.length <= 64
          ? metadata.waveform.map((v) => Math.max(0, Math.min(100, Math.round(v))))
          : undefined
      const validDuration =
        metadata?.durationMs !== undefined && metadata.durationMs >= 1
          ? Math.min(3_600_000, Math.round(metadata.durationMs))
          : undefined
      this.#replace(room, key, {
        ...named,
        status: 'ready',
        ref: {
          id: stored.id,
          filename: checked.filename,
          contentType: checked.contentType,
          sizeBytes: checked.sizeBytes,
          ...(validDuration === undefined ? {} : { durationMs: validDuration }),
          ...(validWaveform === undefined ? {} : { waveform: validWaveform }),
        },
      })
    } catch {
      rememberFailure(named)
    } finally {
      this.#aborts.delete(key)
    }
  }

  #put(room: string, file: QueuedFile) {
    this.#set(room, [...this.files(room), file])
  }

  #replace(room: string, key: string, file: QueuedFile) {
    if (!this.files(room).some((item) => item.key === key)) {
      revokeRasterPreviewUrl(file.previewUrl)
      return
    }
    this.#set(
      room,
      this.files(room).map((item) => (item.key === key ? file : item))
    )
  }

  #set(room: string, files: readonly QueuedFile[]) {
    if (files.length === 0) this.#rooms.delete(room)
    else this.#rooms.set(room, files)
    for (const listener of this.#listeners) listener()
  }
}
