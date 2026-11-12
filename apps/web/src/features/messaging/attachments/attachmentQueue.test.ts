import { describe, expect, it, vi } from 'vitest'
import { AttachmentQueue } from './attachmentQueue'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const png = (name = 'a.png') => new File([PNG], name, { type: 'image/png' })

function storing() {
  return vi.fn(async () => ({ id: crypto.randomUUID() }) as never)
}

describe('the files waiting in a composer', () => {
  it('sends a checked file at once and offers its reference when stored', async () => {
    const upload = storing()
    const queue = new AttachmentQueue('org', upload)
    const seen = vi.fn()
    queue.subscribe(seen)
    await queue.add('room', [png()])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(queue.files('room')[0]).toMatchObject({ status: 'ready', filename: 'a.png' })
    expect(queue.readyRefs('room')).toHaveLength(1)
    expect(seen).toHaveBeenCalled()
    expect(queue.files('other')).toEqual([])
  })

  it('never sends a refused file, and keeps it listed with its reason', async () => {
    const upload = storing()
    const queue = new AttachmentQueue('org', upload)
    await queue.add('room', [new File(['<html>'], 'page.html', { type: 'text/html' })])
    expect(upload).not.toHaveBeenCalled()
    expect(queue.files('room')[0]).toMatchObject({ status: 'refused', reason: 'active-content' })
    // A message cannot leave with a refused file still listed.
    expect(queue.readyRefs('room')).toBeNull()
  })

  it('holds the message while a file is sending, and marks a failed one', async () => {
    let finish: ((value: never) => void) | undefined
    const queue = new AttachmentQueue(
      'org',
      vi.fn(() => new Promise<never>((resolve) => (finish = resolve)))
    )
    const adding = queue.add('room', [png()])
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(queue.files('room')[0]?.status).toBe('uploading')
    expect(queue.readyRefs('room')).toBeNull()
    finish!({ id: crypto.randomUUID() } as never)
    await adding

    const failing = new AttachmentQueue('org', vi.fn().mockRejectedValue(new Error('x')))
    await failing.add('room', [png()])
    expect(failing.files('room')[0]?.status).toBe('failed')
  })

  it('refuses an eleventh file, and aborts a removed upload', async () => {
    const queue = new AttachmentQueue('org', storing())
    await queue.add(
      'room',
      Array.from({ length: 11 }, (_, n) => png(`${n}.png`))
    )
    expect(queue.files('room').filter((f) => f.status === 'refused')).toHaveLength(1)

    let signal: AbortSignal | undefined
    const slow = new AttachmentQueue(
      'org',
      vi.fn(({ signal: s }) => {
        signal = s
        return new Promise<never>(() => {})
      })
    )
    void slow.add('room', [png()])
    await vi.waitFor(() => expect(signal).toBeDefined())
    slow.remove('room', slow.files('room')[0]!.key)
    expect(signal!.aborted).toBe(true)
    expect(slow.files('room')).toEqual([])
  })
})
