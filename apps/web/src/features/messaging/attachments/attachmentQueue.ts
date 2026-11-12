// The files waiting in a composer, one list per room (docs/specs/messaging-media-and-notifications.md).
// A file is checked on this device the moment it is dropped, pasted or chosen, then sent to storage
// at once; the message waits until every file it carries is stored. A refused file stays in the list
// with its reason until the member removes it, so a drop never fails silently.
//
// A small store read with `useSyncExternalStore`: the composer draws from a snapshot, and an upload
// finishing never sets React state from inside an effect.

import {
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
  #rooms = new Map<string, readonly QueuedFile[]>()
  #aborts = new Map<string, AbortController>()
  #listeners = new Set<() => void>()
  #serial = 0

  constructor(organisationId: string, upload: Upload = uploadAttachment) {
    this.#organisationId = organisationId
    this.#upload = upload
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
    await Promise.all(
      incoming.map(async (file) => {
        const key = `f${++this.#serial}`
        const base = { key, filename: file.name, sizeBytes: file.size }
        if (this.files(room).length >= MAX_PENDING_ATTACHMENTS) {
          this.#put(room, { ...base, status: 'refused', reason: 'too-many' })
          return
        }
        this.#put(room, { ...base, status: 'uploading' })
        const checked = preflight(file, await headOf(file))
        if (!checked.ok) {
          this.#replace(room, key, { ...base, status: 'refused', reason: checked.reason })
          return
        }
        const named = { ...base, filename: checked.filename }
        const abort = new AbortController()
        this.#aborts.set(key, abort)
        try {
          const stored = await this.#upload({
            organisationId: this.#organisationId,
            file,
            checked,
            signal: abort.signal,
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
          this.#replace(room, key, { ...named, status: 'failed' })
        } finally {
          this.#aborts.delete(key)
        }
      })
    )
  }

  remove(room: string, key: string): void {
    this.#aborts.get(key)?.abort()
    this.#set(
      room,
      this.files(room).filter((file) => file.key !== key)
    )
  }

  /** Forgets the room's list once its message is sent. */
  clear(room: string): void {
    for (const file of this.files(room)) this.#aborts.get(file.key)?.abort()
    this.#set(room, NONE)
  }

  /** Stops every upload: the composer is gone. */
  close(): void {
    for (const abort of this.#aborts.values()) abort.abort()
    this.#aborts.clear()
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
