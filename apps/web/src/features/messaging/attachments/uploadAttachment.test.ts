import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
vi.mock('../../../api/mutations', () => ({ mutate }))

const { checkTicket, sha256Hex, uploadAttachment, UploadRefused } =
  await import('./uploadAttachment')

const ORG = crypto.randomUUID()
const bytes = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], {
  type: 'application/pdf',
})
const checked = {
  ok: true as const,
  filename: 'note.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: bytes.size,
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: crypto.randomUUID(),
    uploadUrl: 'https://objects.exemple.fr/bucket/key?signature=x',
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    expiresAt: '2026-11-12T23:00:00Z',
    ...overrides,
  } as Parameters<typeof checkTicket>[0]
}

beforeEach(() => mutate.mockReset())

describe('an upload ticket', () => {
  it('is kept when it is an https PUT with plain headers', () => {
    expect(() => checkTicket(ticket(), 'https:')).not.toThrow()
  })

  it('is refused over http, with credentials in its address, or for another method', () => {
    for (const bad of [
      ticket({ uploadUrl: 'http://objects.exemple.fr/k' }),
      ticket({ uploadUrl: 'javascript:alert(1)' }),
      ticket({ uploadUrl: 'https://u:p@objects.exemple.fr/k' }),
      ticket({ uploadUrl: 'not a url' }),
      ticket({ method: 'POST' }),
    ]) {
      expect(() => checkTicket(bad, 'https:')).toThrow(UploadRefused)
    }
  })

  it('is refused when it asks the page to send a credential or a forbidden header', () => {
    for (const name of ['Authorization', 'Cookie', 'Host', 'Origin', 'Sec-Fetch-Site']) {
      expect(() => checkTicket(ticket({ headers: { [name]: 'x' } }), 'https:')).toThrow(
        UploadRefused
      )
    }
    expect(() => checkTicket(ticket({ headers: { 'x-amz-meta': 4 } }), 'https:')).toThrow(
      UploadRefused
    )
  })

  it('allows plain http only to a local store from a local page', () => {
    expect(() =>
      checkTicket(ticket({ uploadUrl: 'http://localhost:9000/k' }), 'http:')
    ).not.toThrow()
    expect(() => checkTicket(ticket({ uploadUrl: 'http://localhost:9000/k' }), 'https:')).toThrow()
  })
})

describe('sending an attachment', () => {
  it('asks for a ticket with the digest, sends exactly the ticket headers without credentials, then completes', async () => {
    const sha256 = await sha256Hex(bytes)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u)
    const issued = ticket()
    mutate.mockResolvedValueOnce(issued).mockResolvedValueOnce({ id: issued.attachmentId, sha256 })
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    const done = await uploadAttachment({ organisationId: ORG, file: bytes, checked, put })

    expect(done.id).toBe(issued.attachmentId)
    const [, ask] = mutate.mock.calls[0]!
    expect(ask.body).toEqual({
      filename: 'note.pdf',
      contentType: 'application/pdf',
      sizeBytes: 6,
      sha256,
    })
    expect(ask.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/u)
    const [url, init] = put.mock.calls[0]!
    expect(url).toBe(issued.uploadUrl)
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    expect(mutate.mock.calls[1]![1].params.path.attachment_id).toBe(issued.attachmentId)
  })

  it('sends no byte for a refused ticket, and never completes after a failed store', async () => {
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    mutate.mockResolvedValueOnce(ticket({ uploadUrl: 'http://evil.example/' }))
    await expect(
      uploadAttachment({ organisationId: ORG, file: bytes, checked, put })
    ).rejects.toThrow(UploadRefused)
    expect(put).not.toHaveBeenCalled()

    mutate.mockResolvedValueOnce(ticket())
    await expect(
      uploadAttachment({ organisationId: ORG, file: bytes, checked, put })
    ).rejects.toThrow('storage')
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('refuses a completed attachment whose digest is not the one sent', async () => {
    mutate
      .mockResolvedValueOnce(ticket())
      .mockResolvedValueOnce({ id: 'x', sha256: '0'.repeat(64) })
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await expect(
      uploadAttachment({ organisationId: ORG, file: bytes, checked, put })
    ).rejects.toThrow('complete')
  })
})
