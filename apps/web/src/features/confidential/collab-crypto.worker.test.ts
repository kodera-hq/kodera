// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { WorkerFrameCryptor } from './crypto-session.worker-core'
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
const body = () =>
  new Uint8Array([0, 2, ...new TextEncoder().encode('Private Yjs document sentinel')])
const awarenessBody = () =>
  new Uint8Array([1, ...new TextEncoder().encode('Private Yjs document sentinel')])
const syncStep1Body = () => new Uint8Array([0, 0, 1, 0])
const checkpointBody = () =>
  new Uint8Array([0, 1, ...new TextEncoder().encode('Compacted Yjs snapshot sentinel')])
const peer = (change = {}) => createCollabCryptoSession({ ...context, ...change }, secret())

function readOuterMeta(envelope: Uint8Array): {
  epoch: number
  sender: string
  sequence: number
  kind: number
  ratchet: number
} {
  const size = (envelope[4]! << 8) | envelope[5]!
  return JSON.parse(new TextDecoder().decode(envelope.subarray(6, 6 + size))) as {
    epoch: number
    sender: string
    sequence: number
    kind: number
    ratchet: number
  }
}

describe('worker confidential collaboration envelopes', () => {
  it('round-trips sync, SyncStep1 (kind=2), awareness (kind=1), and stateless checkpoints (kind=3) with strict header binding', async () => {
    const sender = peer(),
      receiver = peer({ senderClientId: 22 }),
      reloadedAuthor = peer({ senderClientId: 11 })
    for (const [frame, expectedKind] of [
      [body(), 0],
      [awarenessBody(), 1],
      [syncStep1Body(), 2],
    ] as const) {
      const sealed = await sender.seal(frame)
      expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe('KDE1')
      expect(readOuterMeta(sealed).kind).toBe(expectedKind)
      expect(new TextDecoder().decode(sealed)).not.toContain('Private Yjs document sentinel')
      expect(await receiver.open(sealed)).toEqual(frame)
      expect(await sender.seal(frame)).not.toEqual(sealed)
    }

    // Stateless kind===3 checkpoint can be opened by peers AND by the author on a reloaded session.
    const sealedCheckpoint = await sender.seal(checkpointBody(), {
      checkpoint: true,
      sequence: 64,
    })
    expect(readOuterMeta(sealedCheckpoint)).toMatchObject({
      epoch: 7,
      sender: 'checkpoint',
      sequence: 64,
      kind: 3,
      ratchet: 0,
    })
    expect(await receiver.open(sealedCheckpoint)).toEqual(checkpointBody())
    expect(await reloadedAuthor.open(sealedCheckpoint)).toEqual(checkpointBody())
    // Even opening the same checkpoint twice is statelessly permitted for idempotent CRDT hydration.
    expect(await receiver.open(sealedCheckpoint)).toEqual(checkpointBody())

    sender.close()
    receiver.close()
    reloadedAuthor.close()
  })
  it('refuses viewer privilege-escalation frames where outer kind=1 or kind=2 wraps an inner MSG_SYNC update', async () => {
    const rawViewer = new WorkerFrameCryptor(
      'KDE1',
      'kodera-confidential-collab',
      [context.scopeKey, context.documentId],
      context.epoch,
      '99',
      secret()
    )
    const receiver = peer({ senderClientId: 22 })
    // Viewer seals a Yjs state update ([0, 2, ...]) claiming outer kind=1 (awareness) or kind=2 (SyncStep1)
    const spoofedKind1 = await rawViewer.seal(body(), 1)
    const spoofedKind2 = await rawViewer.seal(body(), 2)
    await expect(receiver.open(spoofedKind1)).rejects.toThrow('Invalid collaboration frame.')
    await expect(receiver.open(spoofedKind2)).rejects.toThrow('Invalid collaboration frame.')
    rawViewer.close()
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
  it('tracks independent sequence watermarks per (sender, kind) so live awareness never drops delayed durable updates', async () => {
    const sender = peer({ senderClientId: 11 })
    const receiver = peer({ senderClientId: 22 })
    // Sender seals a durable Yjs update (kind=0, seq=1) and two awareness frames (kind=1, seq=1..2).
    const delayedDurable = await sender.seal(body())
    const awareness1 = await sender.seal(new Uint8Array([1, 2, 0]))
    const awareness2 = await sender.seal(new Uint8Array([1, 2, 1]))
    // Live awareness frames arrive BEFORE the delayed durable update!
    expect(await receiver.open(awareness1)).toEqual(new Uint8Array([1, 2, 0]))
    expect(await receiver.open(awareness2)).toEqual(new Uint8Array([1, 2, 1]))
    // Durable kind=0 seq=1 still opens cleanly without sequence collision!
    expect(await receiver.open(delayedDurable)).toEqual(body())
    // Replaying the same durable kind=0 seq=1 is still rejected.
    await expect(receiver.open(delayedDurable)).rejects.toThrow()
    sender.close()
    receiver.close()
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
