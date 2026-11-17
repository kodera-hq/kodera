// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createCollabCryptoSession,
  createCollabCryptoSessionPort,
  hostCollabCryptoSession,
  provisionCollabEpochKey,
} from './collab-crypto.worker'
import { createConfidentialCollabCipherFromPort } from './collab-crypto-client'

const context = {
  scopeKey: 'workspace-test',
  documentId: 'page-test',
  epoch: 7,
  senderClientId: 11,
}
const secret = () => new Uint8Array(32).fill(41)
const body = () => new Uint8Array([0, ...new TextEncoder().encode('Private Yjs document sentinel')])
const peer = (change = {}) => createCollabCryptoSession({ ...context, ...change }, secret())

describe('worker confidential collaboration envelopes', () => {
  it('round-trips sync and awareness with independent IVs and no plaintext wire substring', async () => {
    const sender = peer(),
      receiver = peer({ senderClientId: 22 })
    for (const kind of [0, 1]) {
      const frame = body()
      frame[0] = kind
      const sealed = await sender.seal(frame)
      expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe('KDE1')
      expect(new TextDecoder().decode(sealed)).not.toContain('Private Yjs document sentinel')
      expect(await receiver.open(sealed)).toEqual(frame)
      expect(await sender.seal(frame)).not.toEqual(sealed)
    }
    sender.close()
    receiver.close()
  })
  it('rejects reflected own frames and empty collaboration plaintext', async () => {
    const sender = peer()
    await expect(sender.open(await sender.seal(body()))).rejects.toThrow()
    expect(() => sender.seal(new Uint8Array())).toThrow()
    sender.close()
  })
  it('captures plaintext and context before asynchronous crypto', async () => {
    const scope = { ...context },
      sender = createCollabCryptoSession(scope, secret()),
      receiver = peer({ senderClientId: 22 })
    const input = body(),
      operation = sender.seal(input)
    scope.documentId = 'wrong'
    input.fill(0)
    const envelope = await operation,
      opening = receiver.open(envelope)
    envelope.fill(0)
    expect(await opening).toEqual(body())
    sender.close()
    receiver.close()
  })
  it('rejects wrong scope, document, epoch and secret', async () => {
    const sender = peer(),
      envelope = await sender.seal(body())
    for (const change of [{ scopeKey: 'other' }, { documentId: 'other' }, { epoch: 8 }]) {
      const receiver = peer(change)
      await expect(receiver.open(envelope)).rejects.toThrow()
      receiver.close()
    }
    const receiver = createCollabCryptoSession(context, new Uint8Array(32).fill(42))
    await expect(receiver.open(envelope)).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('rejects authenticated metadata, ciphertext and GCM tag tampering', async () => {
    const sender = peer(),
      original = await sender.seal(body())
    for (const offset of [0, 4, 15, original.length - 1, original.length - 17]) {
      const receiver = peer({ senderClientId: 22 }),
        changed = original.slice()
      changed[offset] = changed[offset]! ^ 1
      await expect(receiver.open(changed)).rejects.toThrow()
      receiver.close()
    }
    sender.close()
  })
  it('serializes concurrent replay attempts and refuses stale sender sequences', async () => {
    const sender = peer(),
      receiver = peer({ senderClientId: 22 })
    const first = await sender.seal(body()),
      second = await sender.seal(body())
    const raced = await Promise.allSettled([receiver.open(second), receiver.open(second)])
    expect(raced.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    await expect(receiver.open(first)).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('refuses shared, resizable, accessor and oversized buffers', () => {
    const sender = peer()
    if (typeof SharedArrayBuffer !== 'undefined')
      expect(() => sender.seal(new Uint8Array(new SharedArrayBuffer(8)))).toThrow()
    const accessor = body()
    Object.defineProperty(accessor, 'buffer', { get: () => new ArrayBuffer(0) })
    expect(() => sender.seal(accessor)).toThrow()
    expect(() => sender.seal(new Uint8Array(1024 * 1024 + 1))).toThrow()
    expect(() => sender.seal(new Uint8Array([2, 3]))).toThrow()
    const candidate = Reflect.construct(ArrayBuffer, [8, { maxByteLength: 16 }]) as ArrayBuffer
    if (Reflect.get(candidate, 'resizable'))
      expect(() => sender.seal(new Uint8Array(candidate))).toThrow()
    sender.close()
  })
  it('does not release plaintext or ciphertext when authority closes during crypto', async () => {
    const sender = peer(),
      receiver = peer({ senderClientId: 22 }),
      envelope = await sender.seal(body())
    const opening = receiver.open(envelope)
    receiver.close()
    await expect(opening).rejects.toThrow()
    const sealing = sender.seal(body())
    sender.close()
    await expect(sealing).rejects.toThrow()
  })
  it('provisions secrets directly over a transferred worker key port and exposes only frame RPC', async () => {
    const keys = new MessageChannel(),
      control = createCollabCryptoSessionPort(context, keys.port2)
    const client = createConfidentialCollabCipherFromPort(context, control)
    const receiver = peer({ senderClientId: 22 })
    provisionCollabEpochKey(keys.port1, context, secret())
    expect(Object.keys(client).sort()).toEqual([
      'close',
      'documentId',
      'epoch',
      'isActive',
      'open',
      'scopeKey',
      'seal',
      'senderClientId',
    ])
    expect(await receiver.open(await client.seal(body()))).toEqual(body())
    client.close()
    receiver.close()
    keys.port1.close()
  })
  it('erases worker-owned original RPC plaintext while preserving caller-owned primitive inputs', async () => {
    const keys = new MessageChannel(),
      replies: unknown[] = []
    const control = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null,
      postMessage(message: unknown) {
        replies.push(message)
      },
      start() {},
      close() {},
    }
    const close = hostCollabCryptoSession(control as unknown as MessagePort, keys.port2, context)
    provisionCollabEpochKey(keys.port1, context, secret())
    await vi.waitFor(() => expect(replies).toContainEqual({ kind: 'ready' }))
    const original = body()
    control.onmessage!(
      new MessageEvent('message', { data: { kind: 'seal', id: 1, frame: original } })
    )
    expect(original.every((value) => value === 0)).toBe(true)
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    const encrypted = replies[1] as { kind: string; frame: Uint8Array }
    expect(encrypted.kind).toBe('result')
    const receiver = peer({ senderClientId: 22 })
    expect(await receiver.open(encrypted.frame)).toEqual(body())
    close()
    keys.port1.close()
    receiver.close()
  })
  it('rejects a key port provisioned for another document', async () => {
    const keys = new MessageChannel(),
      control = createCollabCryptoSessionPort(context, keys.port2)
    const client = createConfidentialCollabCipherFromPort(context, control)
    provisionCollabEpochKey(keys.port1, { ...context, documentId: 'wrong' }, secret())
    await expect(client.seal(body())).rejects.toThrow()
    expect(client.isActive()).toBe(false)
    client.close()
    keys.port1.close()
  })
  it('refuses importing the worker into a document context', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})
    try {
      await expect(import('./collab-crypto.worker')).rejects.toThrow('Worker crypto only.')
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
