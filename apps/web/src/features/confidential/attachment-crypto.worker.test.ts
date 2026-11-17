// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ConfidentialAttachmentCryptoError, MAX_CONFIDENTIAL_ATTACHMENT_BYTES,
  decryptConfidentialAttachment, encryptConfidentialAttachment,
} from './attachment-crypto.worker'

const context = { roomId: '01970001-0000-7000-8000-000000000001', epoch: 7,
  attachmentId: '01970002-0000-7000-8000-000000000002' }
const body = () => new TextEncoder().encode('Private attachment sentinel')
const decrypt = (value: Awaited<ReturnType<typeof encryptConfidentialAttachment>>, scope = context) =>
  decryptConfidentialAttachment({ context: scope, ciphertext: value.ciphertext, secretDescriptor: value.secretDescriptor })
const rewrite = (descriptor: string, changes: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(descriptor), ...changes })

describe('worker attachment authenticated encryption', () => {
  it('round-trips real AES-GCM with a separate bounded public upload descriptor', async () => {
    const original = body(), encrypted = await encryptConfidentialAttachment({ context, plaintext: original })
    expect(encrypted.ciphertext.length).toBe(original.length + 16)
    expect(encrypted.ciphertext).not.toEqual(original)
    expect(encrypted.upload).toEqual({ version: 1, algorithm: 'AES-256-GCM', ciphertextBytes: encrypted.ciphertext.length,
      ciphertextSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(Object.keys(encrypted.upload).sort()).toEqual(['algorithm', 'ciphertextBytes', 'ciphertextSha256', 'version'])
    expect(Object.isFrozen(encrypted.upload)).toBe(true)
    expect(await decrypt(encrypted)).toEqual(original)
    expect(original).toEqual(body())
  })

  it('generates independent 256-bit keys and 96-bit nonces on each encryption', async () => {
    const first = await encryptConfidentialAttachment({ context, plaintext: body() })
    const second = await encryptConfidentialAttachment({ context, plaintext: body() })
    const a = JSON.parse(first.secretDescriptor), b = JSON.parse(second.secretDescriptor)
    expect(atob(a.keyBase64).length).toBe(32); expect(atob(a.ivBase64).length).toBe(12)
    expect(a.keyBase64).not.toBe(b.keyBase64); expect(a.ivBase64).not.toBe(b.ivBase64)
    expect(first.ciphertext).not.toEqual(second.ciphertext)
  })

  it('captures caller context and bytes before the first asynchronous operation', async () => {
    const scope = { ...context }, plaintext = body()
    const pending = encryptConfidentialAttachment({ context: scope, plaintext })
    scope.epoch += 1; plaintext.fill(0)
    const encrypted = await pending
    expect(await decrypt(encrypted)).toEqual(body())
    const ciphertext = new Uint8Array(encrypted.ciphertext)
    const opening = decryptConfidentialAttachment({ context, ciphertext, secretDescriptor: encrypted.secretDescriptor })
    ciphertext.fill(0)
    expect(await opening).toEqual(body())
  })

  it('refuses wrong room, epoch and attachment ID even if descriptor context is rewritten', async () => {
    const encrypted = await encryptConfidentialAttachment({ context, plaintext: body() })
    for (const change of [{ roomId: context.attachmentId }, { epoch: context.epoch + 1 }, { attachmentId: context.roomId }]) {
      const scope = { ...context, ...change }
      await expect(decrypt(encrypted, scope)).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
      await expect(decryptConfidentialAttachment({ context: scope, ciphertext: encrypted.ciphertext,
        secretDescriptor: rewrite(encrypted.secretDescriptor, change) })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    }
  })

  it('checks SHA-256 before invoking decrypt and also rejects tampering with a rewritten digest', async () => {
    const encrypted = await encryptConfidentialAttachment({ context, plaintext: body() })
    const ciphertext = new Uint8Array(encrypted.ciphertext); ciphertext[0] = ciphertext[0]! ^ 1
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    await expect(decryptConfidentialAttachment({ context, ciphertext, secretDescriptor: encrypted.secretDescriptor }))
      .rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    expect(decryptSpy).not.toHaveBeenCalled()
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext)), (b) => b.toString(16).padStart(2, '0')).join('')
    await expect(decryptConfidentialAttachment({ context, ciphertext,
      secretDescriptor: rewrite(encrypted.secretDescriptor, { ciphertextSha256: sha }) })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    expect(decryptSpy).toHaveBeenCalledOnce()
  })

  it('rejects changed keys, IVs, length, algorithm and noncanonical or duplicate descriptors', async () => {
    const encrypted = await encryptConfidentialAttachment({ context, plaintext: body() })
    for (const descriptor of [
      rewrite(encrypted.secretDescriptor, { keyBase64: btoa('x'.repeat(32)) }),
      rewrite(encrypted.secretDescriptor, { ivBase64: btoa('x'.repeat(12)) }),
      rewrite(encrypted.secretDescriptor, { keyBase64: '!'.repeat(44) }),
      rewrite(encrypted.secretDescriptor, { ciphertextBytes: encrypted.ciphertext.length + 1 }),
      rewrite(encrypted.secretDescriptor, { algorithm: 'AES-CBC' }),
      rewrite(encrypted.secretDescriptor, { version: 2 }),
      rewrite(encrypted.secretDescriptor, { unexpected: true }),
      encrypted.secretDescriptor + '\n',
      encrypted.secretDescriptor.replace('{', '{"version":1,'),
      ' '.repeat(1025),
    ]) await expect(decryptConfidentialAttachment({ context, ciphertext: encrypted.ciphertext, secretDescriptor: descriptor }))
      .rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
  })

  it('rejects malformed scopes, unsafe epochs, accessors and unbounded byte inputs', async () => {
    for (const scope of [
      { ...context, roomId: context.roomId + '\n' }, { ...context, epoch: -1 },
      { ...context, epoch: Number.MAX_SAFE_INTEGER + 1 }, { ...context, epoch: 1.5 },
      { ...context, attachmentId: '00000000-0000-0000-0000-000000000000' },
      { ...context, extra: true },
    ]) await expect(encryptConfidentialAttachment({ context: scope, plaintext: body() })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    const getter = vi.fn(() => body())
    const input = Object.defineProperty({ context }, 'plaintext', { enumerable: true, get: getter })
    await expect(encryptConfidentialAttachment(input as Parameters<typeof encryptConfidentialAttachment>[0])).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    expect(getter).not.toHaveBeenCalled()
    await expect(encryptConfidentialAttachment({ context, plaintext: new Uint8Array() })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    await expect(encryptConfidentialAttachment({ context, plaintext: new Uint8Array(MAX_CONFIDENTIAL_ATTACHMENT_BYTES + 1) }))
      .rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    const shared = new Uint8Array(new SharedArrayBuffer(8))
    await expect(encryptConfidentialAttachment({ context, plaintext: shared })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
    const detached = new Uint8Array(8); structuredClone(detached.buffer, { transfer: [detached.buffer] })
    await expect(encryptConfidentialAttachment({ context, plaintext: detached })).rejects.toBeInstanceOf(ConfidentialAttachmentCryptoError)
  })

  it('refuses a document-context import before any cryptographic operation', async () => {
    vi.resetModules(); vi.stubGlobal('document', {})
    try { await expect(import('./attachment-crypto.worker')).rejects.toThrow('requires a worker') }
    finally { vi.unstubAllGlobals(); vi.resetModules() }
  })
})
