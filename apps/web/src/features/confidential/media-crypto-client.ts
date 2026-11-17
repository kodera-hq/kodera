export interface ConfidentialMediaSession {
  readonly roomId: string
  readonly epoch: number
  readonly worker: Worker
  isActive(): boolean
  subscribeRevocation(listener: () => void): () => void
  attach(room: { setE2EEEnabled(enabled: boolean): Promise<void> }): Promise<void>
  close(): void
}
export interface ConfidentialMediaContext {
  readonly roomId: string
  readonly epoch: number
  readonly participantIdentity: string
}
export function supportsConfidentialMediaTransforms(): boolean {
  if (typeof Worker === 'undefined' || typeof TransformStream === 'undefined') return false
  if (typeof Reflect.get(globalThis, 'RTCRtpScriptTransform') === 'function') return true
  const sender = Reflect.get(globalThis, 'RTCRtpSender') as { prototype?: object } | undefined
  const receiver = Reflect.get(globalThis, 'RTCRtpReceiver') as { prototype?: object } | undefined
  return (
    typeof (sender?.prototype && Reflect.get(sender.prototype, 'createEncodedStreams')) ===
      'function' &&
    typeof (receiver?.prototype && Reflect.get(receiver.prototype, 'createEncodedStreams')) ===
      'function'
  )
}
/** The only secret channel is transferred to the worker, never read here. */
export async function createConfidentialMediaSession(
  context: ConfidentialMediaContext,
  epochPort: MessagePort
): Promise<ConfidentialMediaSession> {
  const descriptors = Object.getOwnPropertyDescriptors(context)
  const values = ['roomId', 'epoch', 'participantIdentity'].map((key) => {
    const property = descriptors[key]
    if (!property || !('value' in property)) throw new Error('Invalid media context.')
    return property.value as unknown
  })
  const [roomId, epoch, participantIdentity] = values
  if (
    Object.getPrototypeOf(context) !== Object.prototype ||
    Reflect.ownKeys(descriptors).length !== 3 ||
    typeof roomId !== 'string' ||
    !roomId ||
    roomId.length > 256 ||
    typeof participantIdentity !== 'string' ||
    !participantIdentity ||
    participantIdentity.length > 256 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    epoch > 0xffffffff
  )
    throw new Error('Invalid media context.')
  context = Object.freeze({ roomId, epoch, participantIdentity })
  if (!supportsConfidentialMediaTransforms())
    throw new Error('confidential-media-transforms-unavailable')
  const worker = new Worker(new URL('./media-crypto.worker.ts', import.meta.url), {
    type: 'module',
    name: 'confidential-media',
  })
  const channel = new MessageChannel(),
    listeners = new Set<() => void>()
  let active = true,
    ready = false,
    enabled = false
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  let resolveEnabled: (() => void) | undefined, rejectEnabled: ((error: Error) => void) | undefined
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const close = () => {
    if (!active) return
    active = false
    clearTimeout(startupTimer)
    rejectReady(new Error('Confidential media closed.'))
    rejectEnabled?.(new Error('Confidential media closed.'))
    channel.port1.postMessage({ kind: 'close' })
    channel.port1.close()
    worker.terminate()
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  const startupTimer = setTimeout(close, 10000)
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const reply = event.data as { kind?: unknown }
    if (reply?.kind === 'ready' && !ready && active) {
      ready = true
      clearTimeout(startupTimer)
      resolveReady()
    } else if (reply?.kind === 'enabled' && ready && active) {
      enabled = true
      resolveEnabled?.()
    } else close()
  }
  channel.port1.onmessageerror = close
  worker.addEventListener('error', close)
  worker.addEventListener('messageerror', close)
  channel.port1.start()
  worker.postMessage({ kind: 'bootstrap', control: channel.port2, epochPort, context }, [
    channel.port2,
    epochPort,
  ])
  try {
    await started
  } catch (error) {
    close()
    throw error
  }
  return Object.freeze({
    roomId: context.roomId,
    epoch: context.epoch,
    worker,
    isActive: () => active && ready,
    subscribeRevocation(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async attach(room: { setE2EEEnabled(enabled: boolean): Promise<void> }) {
      if (!active || !ready) throw new Error('Confidential media closed.')
      const acknowledged = enabled
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            resolveEnabled = resolve
            rejectEnabled = reject
          })
      const timer = setTimeout(close, 10000)
      try {
        await room.setE2EEEnabled(true)
        await acknowledged
        if (!active) throw new Error('Confidential media closed.')
      } catch (error) {
        close()
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
    close,
  })
}
