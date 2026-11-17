// Worker-only encoded media encryption; secret provisioning never uses the SDK key provider.
import {
  WorkerFrameCryptor,
  fields,
  integer,
  need,
  ownedBytes,
  text,
} from './crypto-session.worker-core'
if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Media crypto requires a worker.')

export interface MediaCryptoContext {
  readonly roomId: string
  readonly epoch: number
  readonly participantIdentity: string
}
export type ConfidentialTrackKind = 'audio' | 'video'
export function mediaContext(input: unknown): MediaCryptoContext {
  const value = fields(input, ['roomId', 'epoch', 'participantIdentity'])
  text(value.roomId)
  integer(value.epoch)
  text(value.participantIdentity)
  return Object.freeze({
    roomId: value.roomId,
    epoch: value.epoch,
    participantIdentity: value.participantIdentity,
  })
}
export function createMediaCryptoSession(context: MediaCryptoContext, secret: Uint8Array) {
  const scope = mediaContext(context)
  const cryptor = new WorkerFrameCryptor(
    'KSM1',
    'kodera-confidential-media',
    [scope.roomId],
    scope.epoch,
    scope.participantIdentity,
    secret
  )
  return Object.freeze({
    get epoch() {
      return cryptor.epoch
    },
    isActive: () => cryptor.isActive(),
    close: () => cryptor.close(),
    seal: (frame: Uint8Array, kind: ConfidentialTrackKind) => {
      need(kind === 'audio' || kind === 'video')
      return cryptor.seal(frame, kind)
    },
    open: (frame: Uint8Array, kind: ConfidentialTrackKind, participantIdentity: string) => {
      text(participantIdentity)
      need(kind === 'audio' || kind === 'video')
      return cryptor.open(frame, (value) => value === kind, participantIdentity)
    },
    ratchetEpochKey: (nextEpoch: number) => cryptor.ratchetEpochKey(nextEpoch),
  })
}
export function provisionMediaEpochKey(
  port: MessagePort,
  context: MediaCryptoContext,
  secret: Uint8Array
): void {
  const scope = mediaContext(context),
    copy = ownedBytes(secret, 32, 32)
  port.postMessage({ kind: 'epoch-key', context: scope, secret: copy }, [copy.buffer])
}
interface EncodedFrame {
  data: ArrayBuffer
  type?: string
}
interface TransformOptions {
  kind: 'encode' | 'decode'
  participantIdentity: string
  trackId: string
  codec?: string
  encrypted?: boolean
}
interface FrameTransformer {
  readonly readable: ReadableStream<EncodedFrame>
  readonly writable: WritableStream<EncodedFrame>
  readonly options: TransformOptions
}
interface MediaWorkerScope {
  postMessage(message: unknown): void
  addEventListener(kind: string, listener: (event: MessageEvent<unknown>) => void): void
}
export function hostMediaCryptoSession(
  control: MessagePort,
  epochPort: MessagePort,
  context: MediaCryptoContext,
  workerScope?: MediaWorkerScope
) {
  const scope = mediaContext(context)
  let session: ReturnType<typeof createMediaCryptoSession> | undefined,
    closed = false,
    enabled = false
  interface Pipeline {
    options: TransformOptions
    revision: number
    admitted: boolean
    settled: boolean
    abort: AbortController
  }
  const pipelines = new Set<Pipeline>()
  const close = () => {
    if (closed) return
    closed = true
    enabled = false
    session?.close()
    for (const pipeline of pipelines) {
      pipeline.admitted = false
      pipeline.revision++
      pipeline.abort.abort()
    }
    pipelines.clear()
    control.close()
    epochPort.close()
  }
  const refuse = () => {
    if (closed) return
    control.postMessage({ kind: 'closed' })
    workerScope?.postMessage({
      kind: 'error',
      data: { error: new Error('Confidential media closed.') },
    })
    close()
  }
  epochPort.onmessage = (event: MessageEvent<unknown>) => {
    let secret: Uint8Array<ArrayBuffer> | undefined
    try {
      need(!closed && !session)
      const value = fields(event.data, ['kind', 'context', 'secret'])
      secret = ownedBytes(value.secret, 32, 32)
      ;(value.secret as Uint8Array).fill(0)
      need(
        value.kind === 'epoch-key' &&
          JSON.stringify(mediaContext(value.context)) === JSON.stringify(scope)
      )
      session = createMediaCryptoSession(scope, secret)
      control.postMessage({ kind: 'ready' })
      epochPort.close()
    } catch {
      refuse()
    } finally {
      secret?.fill(0)
    }
  }
  control.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data as { kind?: unknown }
    if (value?.kind === 'close') close()
    else refuse()
  }
  function transform(transformer: FrameTransformer): void {
    try {
      need(!closed && session && enabled)
      const options = { ...transformer.options }
      need(options.kind === 'encode' || options.kind === 'decode')
      text(options.participantIdentity)
      text(options.trackId)
      need(options.kind !== 'encode' || options.participantIdentity === scope.participantIdentity)
      need(options.kind !== 'decode' || options.encrypted !== false)
      need(
        pipelines.size < 256 &&
          ![...pipelines].some(
            (pipeline) =>
              pipeline.options.kind === options.kind &&
              pipeline.options.participantIdentity === options.participantIdentity &&
              pipeline.options.trackId === options.trackId
          )
      )
      const active = session,
        abort = new AbortController()
      const binding: Pipeline = { options, revision: 0, admitted: true, settled: false, abort }
      pipelines.add(binding)
      const pipeline = new TransformStream<EncodedFrame, EncodedFrame>({
        async transform(frame, controller) {
          let output: Uint8Array<ArrayBuffer> | undefined
          const original = frame.data
          if (!binding.admitted || binding.settled) {
            if (frame.data instanceof ArrayBuffer) new Uint8Array(frame.data).fill(0)
            return
          }
          const revision = binding.revision,
            options = binding.options
          try {
            need(!closed && enabled && active.isActive() && frame.data instanceof ArrayBuffer)
            const kind: ConfidentialTrackKind =
              options.codec !== undefined || typeof frame.type === 'string' ? 'video' : 'audio'
            const input = new Uint8Array(frame.data)
            output =
              options.kind === 'encode'
                ? await active.seal(input, kind)
                : await active.open(input, kind, options.participantIdentity)
            need(!closed && enabled && active.isActive())
            if (!binding.admitted || revision !== binding.revision) {
              output.fill(0)
              return
            }
            frame.data = output.buffer
            output = undefined
            controller.enqueue(frame)
          } catch {
            output?.fill(0)
            if (!closed && (!binding.admitted || revision !== binding.revision)) return
            refuse()
            controller.error(new Error('Confidential media frame refused.'))
          } finally {
            // Encoded frame storage belongs to this worker. Erase the replaced plaintext
            // and any retired input even when encryption or authority checks reject.
            if (original instanceof ArrayBuffer) new Uint8Array(original).fill(0)
          }
        },
      })
      void transformer.readable
        .pipeThrough(pipeline, { signal: abort.signal })
        .pipeTo(transformer.writable, { signal: abort.signal })
        .catch(() => {
          if (!abort.signal.aborted) refuse()
        })
        .finally(() => {
          binding.settled = true
          binding.admitted = false
          pipelines.delete(binding)
        })
    } catch {
      refuse()
    }
  }
  function sdkMessage(input: unknown): void {
    if (closed) return
    try {
      need(input !== null && typeof input === 'object')
      const message = input as { kind?: unknown; data?: Record<string, unknown> },
        data = message.data
      if (message.kind === 'init') {
        need(session?.isActive())
        workerScope?.postMessage({ kind: 'initAck', data: { enabled: true } })
        return
      }
      if (message.kind === 'enable') {
        need(data && data.enabled === true && session?.isActive())
        if (data.local === true) {
          enabled = true
          control.postMessage({ kind: 'enabled' })
        }
        workerScope?.postMessage({ kind: 'enable', data })
        return
      }
      if (message.kind === 'encode' || message.kind === 'decode') {
        need(
          data &&
            data.readableStream instanceof ReadableStream &&
            data.writableStream instanceof WritableStream
        )
        transform({
          readable: data.readableStream,
          writable: data.writableStream,
          options: { ...data, kind: message.kind } as unknown as TransformOptions,
        })
        return
      }
      if (message.kind === 'updateCodec') {
        need(data && session?.isActive() && enabled)
        const operation = data.operation ?? 'decode'
        need(operation === 'encode' || operation === 'decode')
        text(data.participantIdentity)
        text(data.trackId)
        need(
          data.codec === undefined ||
            (typeof data.codec === 'string' && data.codec.length > 0 && data.codec.length <= 32)
        )
        need(operation !== 'decode' || data.encrypted !== false)
        need(
          operation !== 'encode' ||
            (data.participantIdentity === scope.participantIdentity &&
              data.previousTrackId === undefined)
        )
        if (data.previousTrackId !== undefined) text(data.previousTrackId)
        const candidates = [...pipelines].filter(
          (pipeline) =>
            pipeline.options.kind === operation &&
            (data.previousTrackId === undefined
              ? pipeline.options.trackId === data.trackId &&
                pipeline.options.participantIdentity === data.participantIdentity
              : pipeline.options.trackId === data.previousTrackId)
        )
        need(candidates.length === 1)
        const binding = candidates[0]!
        need(
          !binding.settled &&
            ![...pipelines].some(
              (other) =>
                other !== binding &&
                other.options.kind === operation &&
                other.options.trackId === data.trackId &&
                other.options.participantIdentity === data.participantIdentity
            )
        )
        binding.revision++
        binding.options = {
          kind: operation,
          participantIdentity: data.participantIdentity,
          trackId: data.trackId,
          ...(typeof data.codec === 'string' ? { codec: data.codec } : {}),
          ...(operation === 'decode' && typeof data.encrypted === 'boolean'
            ? { encrypted: data.encrypted }
            : {}),
        }
        binding.admitted = true
        return
      }
      if (message.kind === 'removeTransform') {
        need(data)
        text(data.participantIdentity)
        text(data.trackId)
        for (const binding of pipelines) {
          if (
            binding.options.kind === 'decode' &&
            binding.options.participantIdentity === data.participantIdentity &&
            binding.options.trackId === data.trackId
          ) {
            // Keep the transferred stream for transceiver reuse, but admit no detached frames.
            binding.admitted = false
            binding.revision++
          }
        }
        return
      }
      if (['setRTPMap', 'setSifTrailer', 'setLogLevel'].includes(String(message.kind))) return
      // Main-thread key injection, SDK ratchet export and unsupported data encryption are refused.
      refuse()
    } catch {
      refuse()
    }
  }
  control.onmessageerror = refuse
  epochPort.onmessageerror = refuse
  control.start()
  epochPort.start()
  return Object.freeze({ close, sdkMessage, transform })
}
/** Worker-side deterministic port factory; accepts only a secret-bearing port. */
export function createMediaCryptoSessionPort(context: MediaCryptoContext, epochPort: MessagePort) {
  const channel = new MessageChannel()
  const host = hostMediaCryptoSession(channel.port2, epochPort, context)
  return Object.freeze({ control: channel.port1, host })
}
if (
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  !Reflect.has(globalThis, 'document')
) {
  let host: ReturnType<typeof hostMediaCryptoSession> | undefined
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    try {
      const input = event.data as { kind?: unknown }
      if (input?.kind === 'bootstrap') {
        need(!host)
        const value = fields(event.data, ['kind', 'control', 'epochPort', 'context'])
        need(value.control instanceof MessagePort && value.epochPort instanceof MessagePort)
        host = hostMediaCryptoSession(
          value.control,
          value.epochPort,
          mediaContext(value.context),
          self as unknown as MediaWorkerScope
        )
      } else host?.sdkMessage(event.data)
    } catch {
      host?.close()
    }
  })
  self.addEventListener('rtctransform', (event) => {
    host?.transform((event as unknown as { transformer: FrameTransformer }).transformer)
  })
}
