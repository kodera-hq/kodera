import { expect, it, vi } from 'vitest'
import { AttachmentQueue } from '../../../src/features/messaging/attachments/attachmentQueue'

for (const action of ['close', 'remove'] as const) {
  it(`does not upload a file whose signature read settles after ${action}`, async () => {
    let finish!: (value: ArrayBuffer) => void
    const file = new File(['bytes'], 'image.png', { type: 'image/png' })
    vi.spyOn(file, 'slice').mockReturnValue({
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve
        }),
    } as Blob)
    const upload = vi.fn(async () => ({ id: 'stored' }) as never)
    const queue = new AttachmentQueue('org', upload)
    const adding = queue.add('room', [file])
    if (action === 'close') queue.close()
    else queue.remove('room', queue.files('room')[0]!.key)
    finish(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)
    await adding
    expect(upload).not.toHaveBeenCalled()
  })
}
