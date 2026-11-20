// The files waiting in a composer, one list per room (docs/specs/messaging-media-and-notifications.md).
// A file is checked on this device the moment it is dropped, pasted or chosen, then sent to storage
// at once; the message waits until every file it carries is stored. A refused file stays in the list
// with its reason until the member removes it, so a drop never fails silently.
//
// A small store read with `useSyncExternalStore`: the composer draws from a snapshot, and an upload
// finishing never sets React state from inside an effect.

import {
  cleanFilename,
  headOf,
  MAX_PENDING_ATTACHMENTS,
  preflight,
  type PreflightRefusal,
} from './uploadPreflight'
import { uploadAttachment, type Attachment, type UploadInput } from './uploadAttachment'
import type { AttachmentRef } from './attachmentRefs'

export type QueuedState =
  | { status: 'uploading' }
  | { status: 'ready'; ref: AttachmentRef }
  | { status: 'refused'; reason: PreflightRefusal | 'too-many' }
  | { status: 'failed' }

export type QueuedFile = QueuedState & { key: string; filename: string; sizeBytes: number }

type Upload = (input: UploadInput) => Promise<Attachment>

const NONE: readonly QueuedFile[] = []

export class AttachmentQueue {
  readonly #organisationId: string
  readonly #upload: Upload
  readonly #mayUpload: (room: string) => boolean
  #rooms = new Map<string, readonly QueuedFile[]>()
  #aborts = new Map<string, AbortController>()
  #sources = new Map<string, { room: string; file: File }>()
  #listeners = new Set<() => void>()
  #serial = 0
  #generation = 0

  constructor(
    organisationId: string,
    upload: Upload = uploadAttachment,
    mayUpload: (room: string) => boolean = () => true
  ) {
    this.#organisationId = organisationId
    this.#upload = upload
    this.#mayUpload = mayUpload
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

  async add(room: string, incoming: readonly File[]): Promise<void> {
    if (!this.#mayUpload(room)) return
    const generation = this.#generation
    await Promise.all(
      incoming.map(async (file) => {
        const key = `f${++this.#serial}`
        const base = { key, filename: cleanFilename(file.name), sizeBytes: file.size }
        if (this.files(room).length >= MAX_PENDING_ATTACHMENTS) {
          this.#put(room, { ...base, status: 'refused', reason: 'too-many' })
          return
        }
        this.#put(room, { ...base, status: 'uploading' })
        await this.#send(room, key, file, base, generation)
      })
    )
  }

  /** Re-sends a failed file in place without asking the member to choose it again. */
  async retry(room: string, key: string): Promise<void> {
    const existing = this.files(room).find((item) => item.key === key)
    const source = this.#sources.get(key)
    if (existing?.status !== 'failed' || source?.room !== room || !this.#mayUpload(room)) return
    const generation = this.#generation
    const base = { key, filename: existing.filename, sizeBytes: existing.sizeBytes }
    this.#sources.delete(key)
    this.#replace(room, key, { ...base, status: 'uploading' })
    await this.#send(room, key, source.file, base, generation)
  }

  remove(room: string, key: string): void {
    this.#aborts.get(key)?.abort()
    this.#sources.delete(key)
    this.#set(
      room,
      this.files(room).filter((file) => file.key !== key)
    )
  }

  /** Forgets the room's list once its message is sent. */
  clear(room: string): void {
    for (const file of this.files(room)) {
      this.#aborts.get(file.key)?.abort()
      this.#sources.delete(file.key)
    }
    this.#set(room, NONE)
  }

  /** Stops every upload: the composer is gone. */
  close(): void {
    this.#generation += 1
    this.#sources.clear()
    for (const abort of this.#aborts.values()) abort.abort()
    this.#aborts.clear()
  }

  async #send(
    room: string,
    key: string,
    file: File,
    base: { key: string; filename: string; sizeBytes: number },
    generation: number
  ): Promise<void> {
    const rememberFailure = (named = base) => {
      if (generation === this.#generation && this.files(room).some((entry) => entry.key === key)) {
        this.#sources.set(key, { room, file })
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
      this.#replace(room, key, { ...base, status: 'refused', reason: checked.reason })
      return
    }
    if (!this.#mayUpload(room)) {
      rememberFailure()
      return
    }
    if (generation !== this.#generation || !this.files(room).some((entry) => entry.key === key))
      return
    const named = { ...base, filename: checked.filename }
    const abort = new AbortController()
    this.#aborts.set(key, abort)
    try {
      const stored = await this.#upload({
        organisationId: this.#organisationId,
        file,
        checked,
        signal: abort.signal,
        mayUpload: () => generation === this.#generation && this.#mayUpload(room),
      })
      this.#replace(room, key, {
        ...named,
        status: 'ready',
        ref: {
          id: stored.id,
          filename: checked.filename,
          contentType: checked.contentType,
          sizeBytes: checked.sizeBytes,
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
    // A file removed while it was being sent stays removed.
    if (!this.files(room).some((item) => item.key === key)) return
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
