// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createMediaCryptoSession,
  createMediaCryptoSessionPort,
  hostMediaCryptoSession,
  provisionMediaEpochKey,
} from './media-crypto.worker'
import {
  createConfidentialMediaSession,
  supportsConfidentialMediaTransforms,
} from './media-crypto-client'

const context = { roomId: 'room-test', epoch: 7, participantIdentity: 'participant-one' }
const secret = () => new Uint8Array(32).fill(71)
const body = () => new TextEncoder().encode('Encoded confidential media sentinel')
const peer = (change = {}) => createMediaCryptoSession({ ...context, ...change }, secret())
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('worker encoded media encryption', () => {
  it('round-trips complete encoded audio and video payloads with an authenticated header', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' })
    for (const kind of ['audio', 'video'] as const) {
      const envelope = await sender.seal(body(), kind)
      expect(new TextDecoder().decode(envelope.subarray(0, 4))).toBe('KSM1')
      expect(new TextDecoder().decode(envelope)).not.toContain(
        'Encoded confidential media sentinel'
      )
      expect(await receiver.open(envelope, kind, context.participantIdentity)).toEqual(body())
    }
    sender.close()
    receiver.close()
  })
  it('authenticates zero-byte Opus silence and rejects reflection and tag tampering', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' })
    const frame = await sender.seal(new Uint8Array(), 'audio')
    const size = new DataView(frame.buffer).getUint16(4)
    expect(frame.length - 18 - size).toBe(16)
    await expect(sender.open(frame, 'audio', context.participantIdentity)).rejects.toThrow()
    const changed = frame.slice()
    changed[changed.length - 1]! ^= 1
    await expect(receiver.open(changed, 'audio', context.participantIdentity)).rejects.toThrow()
    expect(await receiver.open(frame, 'audio', context.participantIdentity)).toEqual(
      new Uint8Array()
    )
    await expect(receiver.open(frame, 'audio', context.participantIdentity)).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('one-way ratchets the epoch and refuses frames across unmatched ratchet states', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' })
    const old = await sender.seal(body(), 'audio')
    await sender.ratchetEpochKey(8)
    await expect(sender.open(old, 'audio', context.participantIdentity)).rejects.toThrow()
    const next = await sender.seal(body(), 'audio')
    await expect(receiver.open(next, 'audio', context.participantIdentity)).rejects.toThrow()
    await receiver.ratchetEpochKey(8)
    expect(await receiver.open(next, 'audio', context.participantIdentity)).toEqual(body())
    await expect(receiver.open(old, 'audio', context.participantIdentity)).rejects.toThrow()
    const freshEpoch = peer({ epoch: 8 })
    await expect(freshEpoch.open(next, 'audio', context.participantIdentity)).rejects.toThrow()
    await expect(sender.ratchetEpochKey(7)).rejects.toThrow()
    sender.close()
    receiver.close()
    freshEpoch.close()
  })
  it('rejects wrong room, epoch, participant and track kind', async () => {
    const sender = peer(),
      envelope = await sender.seal(body(), 'audio')
    for (const change of [{ roomId: 'other-room' }, { epoch: 8 }]) {
      const receiver = peer(change)
      await expect(receiver.open(envelope, 'audio', context.participantIdentity)).rejects.toThrow()
      receiver.close()
    }
    const receiver = peer({ participantIdentity: 'participant-two' })
    await expect(receiver.open(envelope, 'video', context.participantIdentity)).rejects.toThrow()
    await expect(receiver.open(envelope, 'audio', 'other-participant')).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('rejects tampering and simultaneous replay without releasing duplicate media', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' }),
      envelope = await sender.seal(body(), 'audio')
    const changed = envelope.slice()
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    await expect(receiver.open(changed, 'audio', context.participantIdentity)).rejects.toThrow()
    const results = await Promise.allSettled([
      receiver.open(envelope, 'audio', context.participantIdentity),
      receiver.open(envelope, 'audio', context.participantIdentity),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    sender.close()
    receiver.close()
  })
  it('copies caller views before crypto and refuses release after closure', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' }),
      input = body(),
      sealing = sender.seal(input, 'video')
    input.fill(0)
    const envelope = await sealing
    expect(await receiver.open(envelope, 'video', context.participantIdentity)).toEqual(body())
    const pending = sender.seal(body(), 'video')
    sender.close()
    await expect(pending).rejects.toThrow()
    receiver.close()
  })
  it('refuses unsafe buffer ownership and accessor contexts', () => {
    const sender = peer(),
      input = body()
    Object.defineProperty(input, 'buffer', { get: () => new ArrayBuffer(0) })
    expect(() => sender.seal(input, 'audio')).toThrow()
    if (typeof SharedArrayBuffer !== 'undefined')
      expect(() => sender.seal(new Uint8Array(new SharedArrayBuffer(8)), 'audio')).toThrow()
    const scope = { ...context }
    Object.defineProperty(scope, 'epoch', { get: () => 7 })
    expect(() => createMediaCryptoSession(scope, secret())).toThrow()
    sender.close()
  })
  it('runs worker TransformStream encode/decode after worker-to-worker key provisioning', async () => {
    const keys = new MessageChannel(),
      { control, host } = createMediaCryptoSessionPort(context, keys.port2)
    const messages: unknown[] = []
    control.onmessage = (event) => {
      messages.push(event.data)
    }
    control.start()
    provisionMediaEpochKey(keys.port1, context, secret())
    await vi.waitFor(() => expect(messages).toContainEqual({ kind: 'ready' }))
    expect(messages).toContainEqual({ kind: 'ready' })
    host.sdkMessage({ kind: 'enable', data: { enabled: true, local: true } })
    const results: ArrayBuffer[] = []
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({ data: body().buffer })
        controller.close()
      },
    })
    const writable = new WritableStream<{ data: ArrayBuffer }>({
      write(frame) {
        results.push(frame.data)
      },
    })
    host.transform({
      readable,
      writable,
      options: {
        kind: 'encode',
        participantIdentity: context.participantIdentity,
        trackId: 'track-a',
      },
    })
    await vi.waitFor(() => expect(results).toHaveLength(1))
    const receiver = peer({ participantIdentity: 'participant-two' })
    expect(
      await receiver.open(new Uint8Array(results[0]!), 'audio', context.participantIdentity)
    ).toEqual(body())
    receiver.close()
    host.close()
    control.close()
    keys.port1.close()
  })
  it('matches the SDK init, repeated enable and bidirectional transferred-stream transcript', async () => {
    const keys = new MessageChannel(),
      channel = new MessageChannel(),
      sdkReplies: unknown[] = [],
      replies: unknown[] = []
    const host = hostMediaCryptoSession(channel.port2, keys.port2, context, {
      postMessage(message) {
        sdkReplies.push(message)
      },
      addEventListener() {},
    })
    channel.port1.onmessage = (event) => {
      replies.push(event.data)
    }
    channel.port1.start()
    provisionMediaEpochKey(keys.port1, context, secret())
    await vi.waitFor(() => expect(replies).toContainEqual({ kind: 'ready' }))
    host.sdkMessage({ kind: 'init', data: { keyProviderOptions: { keySize: 256 } } })
    expect(sdkReplies).toContainEqual({ kind: 'initAck', data: { enabled: true } })
    for (let count = 0; count < 2; count++)
      host.sdkMessage({
        kind: 'enable',
        data: { enabled: true, local: true, participantIdentity: context.participantIdentity },
      })
    expect(
      sdkReplies.filter((reply) => (reply as { kind: string }).kind === 'enable')
    ).toHaveLength(2)
    const encoded: ArrayBuffer[] = [],
      decoded: ArrayBuffer[] = []
    host.sdkMessage({
      kind: 'encode',
      data: {
        participantIdentity: context.participantIdentity,
        trackId: 'video-track',
        codec: 'vp8',
        readableStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ data: body().buffer, type: 'key' })
            controller.close()
          },
        }),
        writableStream: new WritableStream<{ data: ArrayBuffer }>({
          write(frame) {
            encoded.push(frame.data)
          },
        }),
      },
    })
    await vi.waitFor(() => expect(encoded).toHaveLength(1))
    const remote = peer({ participantIdentity: 'remote-peer' })
    const remoteFrame = await remote.seal(body(), 'video')
    remote.close()
    host.sdkMessage({
      kind: 'decode',
      data: {
        participantIdentity: 'remote-peer',
        trackId: 'remote-video',
        codec: 'vp8',
        encrypted: true,
        readableStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ data: remoteFrame.buffer, type: 'key' })
            controller.close()
          },
        }),
        writableStream: new WritableStream<{ data: ArrayBuffer }>({
          write(frame) {
            decoded.push(frame.data)
          },
        }),
      },
    })
    await vi.waitFor(() => expect(decoded).toHaveLength(1))
    expect(new Uint8Array(decoded[0]!)).toEqual(body())
    host.sdkMessage({
      kind: 'enable',
      data: { enabled: false, local: false, participantIdentity: 'remote-peer' },
    })
    await vi.waitFor(() => expect(replies).toContainEqual({ kind: 'closed' }))
    host.close()
    channel.port1.close()
    keys.port1.close()
  })
  it('handles Safari codec updates, detached receivers and transceiver reuse without plaintext passthrough', async () => {
    const keys = new MessageChannel(),
      { control, host } = createMediaCryptoSessionPort(context, keys.port2)
    const replies: unknown[] = []
    control.onmessage = (event) => {
      replies.push(event.data)
    }
    control.start()
    provisionMediaEpochKey(keys.port1, context, secret())
    await vi.waitFor(() => expect(replies).toContainEqual({ kind: 'ready' }))
    host.sdkMessage({ kind: 'enable', data: { enabled: true, local: true } })
    const encoded: ArrayBuffer[] = [],
      decoded: ArrayBuffer[] = []
    let encoder!: ReadableStreamDefaultController<{ data: ArrayBuffer; type: string }>
    let decoder!: ReadableStreamDefaultController<{ data: ArrayBuffer; type: string }>
    host.sdkMessage({
      kind: 'encode',
      data: {
        participantIdentity: context.participantIdentity,
        trackId: 'local-video',
        readableStream: new ReadableStream({
          start(controller) {
            encoder = controller
          },
        }),
        writableStream: new WritableStream<{ data: ArrayBuffer }>({
          write(frame) {
            encoded.push(frame.data)
          },
        }),
      },
    })
    host.sdkMessage({
      kind: 'updateCodec',
      data: {
        operation: 'encode',
        participantIdentity: context.participantIdentity,
        trackId: 'local-video',
        codec: 'vp8',
        hasPacketTrailer: false,
      },
    })
    const original = body().buffer
    encoder.enqueue({ data: original, type: 'key' })
    await vi.waitFor(() => expect(encoded).toHaveLength(1))
    expect(new Uint8Array(original).every((value) => value === 0)).toBe(true)
    expect(replies).not.toContainEqual({ kind: 'closed' })
    const remote = peer({ participantIdentity: 'remote-peer' })
    const remoteFrame = await remote.seal(body(), 'video')
    remote.close()
    host.sdkMessage({
      kind: 'decode',
      data: {
        participantIdentity: 'remote-peer',
        trackId: 'old-remote-video',
        codec: 'vp8',
        encrypted: true,
        readableStream: new ReadableStream({
          start(controller) {
            decoder = controller
          },
        }),
        writableStream: new WritableStream<{ data: ArrayBuffer }>({
          write(frame) {
            decoded.push(frame.data)
          },
        }),
      },
    })
    decoder.enqueue({ data: remoteFrame.buffer, type: 'key' })
    await vi.waitFor(() => expect(decoded).toHaveLength(1))
    expect(new Uint8Array(decoded[0]!)).toEqual(body())
    host.sdkMessage({
      kind: 'removeTransform',
      data: { participantIdentity: 'remote-peer', trackId: 'old-remote-video' },
    })
    const detached = body().buffer
    decoder.enqueue({ data: detached, type: 'key' })
    await vi.waitFor(() =>
      expect(new Uint8Array(detached).every((value) => value === 0)).toBe(true)
    )
    expect(decoded).toHaveLength(1)
    host.sdkMessage({
      kind: 'updateCodec',
      data: {
        previousTrackId: 'old-remote-video',
        trackId: 'new-remote-video',
        participantIdentity: 'participant-two',
        codec: 'vp8',
        encrypted: true,
        hasPacketTrailer: false,
      },
    })
    const secondSender = peer({ participantIdentity: 'participant-two' }),
      next = await secondSender.seal(body(), 'video')
    decoder.enqueue({ data: next.buffer, type: 'key' })
    await vi.waitFor(() => expect(decoded).toHaveLength(2))
    expect(new Uint8Array(decoded[1]!)).toEqual(body())
    expect(replies).not.toContainEqual({ kind: 'closed' })
    host.sdkMessage({
      kind: 'updateCodec',
      data: {
        trackId: 'new-remote-video',
        participantIdentity: 'participant-two',
        codec: 'vp8',
        encrypted: false,
      },
    })
    await vi.waitFor(() => expect(replies).toContainEqual({ kind: 'closed' }))
    secondSender.close()
    host.close()
    control.close()
    keys.port1.close()
  })
  it('allows independent video receivers to deliver authenticated counters out of order while refusing duplicates', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' })
    const camera = await sender.seal(body(), 'video'),
      screen = await sender.seal(body(), 'video')
    expect(await receiver.open(screen, 'video', context.participantIdentity)).toEqual(body())
    expect(await receiver.open(camera, 'video', context.participantIdentity)).toEqual(body())
    await expect(receiver.open(camera, 'video', context.participantIdentity)).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('refuses counters older than the bounded authenticated reorder window', async () => {
    const sender = peer(),
      receiver = peer({ participantIdentity: 'participant-two' }),
      oldest = await sender.seal(body(), 'video')
    let newest = oldest
    for (let index = 0; index < 1024; index++) newest = await sender.seal(body(), 'video')
    expect(await receiver.open(newest, 'video', context.participantIdentity)).toEqual(body())
    await expect(receiver.open(oldest, 'video', context.participantIdentity)).rejects.toThrow()
    sender.close()
    receiver.close()
  })
  it('creates a public capability with port-only provisioning and tears it down on worker refusal', async () => {
    const posted: unknown[] = []
    let host: ReturnType<typeof hostMediaCryptoSession> | undefined,
      terminated = false
    class FakeWorker {
      addEventListener() {}
      terminate() {
        terminated = true
        host?.close()
      }
      postMessage(message: {
        control: MessagePort
        epochPort: MessagePort
        context: typeof context
      }) {
        posted.push(message)
        host = hostMediaCryptoSession(message.control, message.epochPort, message.context)
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('RTCRtpScriptTransform', class {})
    const keys = new MessageChannel()
    try {
      const requested = { ...context },
        creating = createConfidentialMediaSession(requested, keys.port2)
      requested.roomId = 'mutated-room'
      requested.epoch++
      provisionMediaEpochKey(keys.port1, context, secret())
      const capability = await creating
      expect(capability.isActive()).toBe(true)
      expect(capability.roomId).toBe(context.roomId)
      expect(capability.epoch).toBe(context.epoch)
      expect(Object.keys(posted[0] as object).sort()).toEqual([
        'context',
        'control',
        'epochPort',
        'kind',
      ])
      expect(Object.keys(capability).sort()).toEqual([
        'attach',
        'close',
        'epoch',
        'isActive',
        'roomId',
        'subscribeRevocation',
        'worker',
      ])
      await capability.attach({
        async setE2EEEnabled(enabled) {
          host!.sdkMessage({ kind: 'enable', data: { enabled, local: true } })
        },
      })
      const revoked = vi.fn()
      capability.subscribeRevocation(revoked)
      host!.sdkMessage({ kind: 'setKey', data: { key: 'forbidden-main-thread-key' } })
      await vi.waitFor(() => expect(capability.isActive()).toBe(false))
      expect(revoked).toHaveBeenCalledTimes(1)
      expect(terminated).toBe(true)
      capability.close()
      expect(revoked).toHaveBeenCalledTimes(1)
    } finally {
      keys.port1.close()
      host?.close()
      vi.unstubAllGlobals()
    }
  })
  it('closes instead of accepting main-thread key injection or a downgrade', async () => {
    for (const message of [
      { kind: 'setKey', data: { key: secret() } },
      { kind: 'enable', data: { enabled: false, local: true } },
    ]) {
      const keys = new MessageChannel(),
        { control, host } = createMediaCryptoSessionPort(context, keys.port2)
      const messages: unknown[] = []
      control.onmessage = (event) => {
        messages.push(event.data)
      }
      control.start()
      provisionMediaEpochKey(keys.port1, context, secret())
      await vi.waitFor(() => expect(messages).toContainEqual({ kind: 'ready' }))
      host.sdkMessage(message)
      await settle()
      expect(messages).toContainEqual({ kind: 'closed' })
      host.close()
      control.close()
      keys.port1.close()
    }
  })
  it('requires a real encoded transform path in both send and receive directions', () => {
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('RTCRtpScriptTransform', undefined)
    vi.stubGlobal('RTCRtpSender', class {})
    vi.stubGlobal('RTCRtpReceiver', class {})
    expect(supportsConfidentialMediaTransforms()).toBe(false)
    vi.stubGlobal('RTCRtpScriptTransform', class {})
    expect(supportsConfidentialMediaTransforms()).toBe(true)
    vi.unstubAllGlobals()
  })
  it('refuses importing media crypto into a document context', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})
    try {
      await expect(import('./media-crypto.worker')).rejects.toThrow('Worker crypto only.')
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
