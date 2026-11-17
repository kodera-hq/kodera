export interface ConfidentialCollabCipher {
  readonly senderClientId: number
  readonly epoch: number
  readonly scopeKey: string
  readonly documentId: string
  isActive(): boolean
  seal(frame: Uint8Array): Promise<Uint8Array>
  open(frame: Uint8Array): Promise<Uint8Array>
  close(): void
}
export interface ConfidentialCollabContext {
  readonly scopeKey: string
  readonly documentId: string
  readonly epoch: number
  readonly senderClientId: number
}
function captureContext(input: ConfidentialCollabContext): ConfidentialCollabContext {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error('Invalid collaboration context.')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const values = ['scopeKey', 'documentId', 'epoch', 'senderClientId'].map((key) => {
    const property = descriptors[key]
    if (!property || !('value' in property)) throw new Error('Invalid collaboration context.')
    return property.value as unknown
  })
  const [scopeKey, documentId, epoch, senderClientId] = values
  if (
    Reflect.ownKeys(descriptors).length !== 4 ||
    typeof scopeKey !== 'string' ||
    !scopeKey ||
    scopeKey.length > 256 ||
    typeof documentId !== 'string' ||
    !documentId ||
    documentId.length > 256 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    epoch > 0xffffffff ||
    typeof senderClientId !== 'number' ||
    !Number.isSafeInteger(senderClientId) ||
    senderClientId < 0 ||
    senderClientId > 0xffffffff
  )
    throw new Error('Invalid collaboration context.')
  return Object.freeze({ scopeKey, documentId, epoch, senderClientId })
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const arrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const arrayOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
function copyFrame(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    !(frame instanceof Uint8Array) ||
    Object.getPrototypeOf(frame) !== Uint8Array.prototype ||
    !Reflect.ownKeys(frame).every((key) => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key))
  )
    throw new Error('Invalid collaboration frame.')
  const buffer: unknown = Reflect.apply(arrayBufferGetter, frame, [])
  const length: number = Reflect.apply(arrayLengthGetter, frame, [])
  const offset: number = Reflect.apply(arrayOffsetGetter, frame, [])
  if (
    !(buffer instanceof ArrayBuffer) ||
    (resizableGetter && Reflect.apply(resizableGetter, buffer, [])) ||
    length < 1 ||
    length > 1024 * 1024 + 2048
  )
    throw new Error('Invalid collaboration frame.')
  return new Uint8Array(new Uint8Array(buffer, offset, length))
}
/** Public-frame RPC only. The epoch port transfers directly to the dedicated worker. */
function portClient(
  context: ConfidentialCollabContext,
  port: MessagePort,
  retire: () => void = () => {}
) {
  context = captureContext(context)
  let active = true,
    ready = false,
    nextId = 0
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void started.catch(() => undefined)
  const pending = new Map<
    number,
    {
      resolve: (frame: Uint8Array) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let queue = Promise.resolve()
  const close = () => {
    if (!active) return
    active = false
    clearTimeout(startupTimer)
    rejectReady(new Error('Confidential collaboration closed.'))
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Confidential collaboration closed.'))
    }
    pending.clear()
    port.postMessage({ kind: 'close' })
    port.close()
    retire()
  }
  const startupTimer = setTimeout(close, 10000)
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (!active) return
    const reply = event.data as { kind?: unknown; id?: unknown; frame?: unknown }
    if (reply?.kind === 'ready' && !ready) {
      ready = true
      clearTimeout(startupTimer)
      resolveReady()
      return
    }
    if (
      reply?.kind !== 'result' ||
      typeof reply.id !== 'number' ||
      !(reply.frame instanceof Uint8Array)
    ) {
      close()
      return
    }
    const item = pending.get(reply.id)
    if (!item) {
      close()
      return
    }
    pending.delete(reply.id)
    clearTimeout(item.timer)
    item.resolve(reply.frame)
  }
  port.onmessageerror = close
  port.start()
  function run(kind: 'seal' | 'open', frame: Uint8Array): Promise<Uint8Array> {
    const copy = copyFrame(frame)
    const operation = queue.then(async () => {
      try {
        await started
        if (!active) throw new Error('Confidential collaboration closed.')
        const id = ++nextId
        return await new Promise<Uint8Array>((resolve, reject) => {
          pending.set(id, { resolve, reject, timer: setTimeout(close, 10000) })
          try {
            port.postMessage({ kind, id, frame: copy })
          } catch {
            close()
          }
        })
      } finally {
        copy.fill(0)
      }
    })
    queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  const client: ConfidentialCollabCipher = Object.freeze({
    epoch: context.epoch,
    senderClientId: context.senderClientId,
    scopeKey: context.scopeKey,
    documentId: context.documentId,
    isActive: () => active && ready,
    seal: (frame: Uint8Array) => run('seal', frame),
    open: (frame: Uint8Array) => run('open', frame),
    close,
  })
  return { client, started }
}
export function createConfidentialCollabCipherFromPort(
  context: ConfidentialCollabContext,
  port: MessagePort
): ConfidentialCollabCipher {
  return portClient(context, port).client
}
export async function createConfidentialCollabCipher(
  context: ConfidentialCollabContext,
  epochPort: MessagePort
): Promise<ConfidentialCollabCipher> {
  context = captureContext(context)
  const worker = new Worker(new URL('./collab-crypto.worker.ts', import.meta.url), {
    type: 'module',
    name: 'confidential-collaboration',
  })
  const channel = new MessageChannel()
  const { client, started } = portClient(context, channel.port1, () => worker.terminate())
  worker.addEventListener('error', () => client.close())
  worker.addEventListener('messageerror', () => client.close())
  worker.postMessage({ kind: 'bootstrap', control: channel.port2, epochPort, context }, [
    channel.port2,
    epochPort,
  ])
  try {
    await started
    return client
  } catch (error) {
    client.close()
    throw error
  }
}
