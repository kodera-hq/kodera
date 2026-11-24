// Worker-only confidential Yjs frame envelope and port host.
import {
  WorkerFrameCryptor,
  fields,
  integer,
  need,
  ownedBytes,
  text,
} from './crypto-session.worker-core'
if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Collaboration crypto requires a worker.')

export interface CollabCryptoContext {
  readonly scopeKey: string
  readonly documentId: string
  readonly epoch: number
  readonly senderClientId: number
}
export function collabContext(input: unknown): CollabCryptoContext {
  const value = fields(input, ['scopeKey', 'documentId', 'epoch', 'senderClientId'])
  text(value.scopeKey)
  text(value.documentId)
  integer(value.epoch)
  integer(value.senderClientId)
  return Object.freeze({
    scopeKey: value.scopeKey,
    documentId: value.documentId,
    epoch: value.epoch,
    senderClientId: value.senderClientId,
  })
}
export interface CollabSealOptions {
  readonly checkpoint?: boolean | undefined
  readonly sequence?: number | undefined
}
function classifyOutboundCollabFrame(frame: Uint8Array): 0 | 1 | 2 {
  if (frame[0] === 0) {
    need(frame.length >= 2)
    if (frame[1] === 0) {
      need(frame.length <= 65536)
      return 2
    }
    need(frame[1] === 1 || frame[1] === 2)
    return 0
  }
  if (frame[0] === 1) {
    need(frame.length >= 2 && frame.length <= 8208)
    return 1
  }
  if (frame[0] === 3) {
    need(frame.length === 1)
    return 1
  }
  throw new Error('Invalid collaboration frame.')
}
function verifyInboundCollabFrame(frame: Uint8Array, outerKind: number): boolean {
  if (outerKind === 0) {
    return frame.length >= 2 && frame[0] === 0 && (frame[1] === 1 || frame[1] === 2)
  }
  if (outerKind === 1) {
    return (frame.length >= 2 && frame.length <= 8208 && frame[0] === 1) || (frame.length === 1 && frame[0] === 3)
  }
  if (outerKind === 2) {
    return frame.length >= 2 && frame.length <= 65536 && frame[0] === 0 && frame[1] === 0
  }
  if (outerKind === 3) {
    return frame.length >= 2 && frame[0] === 0 && frame[1] === 1
  }
  return false
}
export function createCollabCryptoSession(context: CollabCryptoContext, secret: Uint8Array) {
  const scope = collabContext(context)
  const cryptor = new WorkerFrameCryptor(
    'KDE1',
    'kodera-confidential-collab',
    [scope.scopeKey, scope.documentId],
    scope.epoch,
    String(scope.senderClientId),
    secret
  )
  return Object.freeze({
    epoch: scope.epoch,
    senderClientId: scope.senderClientId,
    scopeKey: scope.scopeKey,
    documentId: scope.documentId,
    isActive: () => cryptor.isActive(),
    close: () => cryptor.close(),
    seal: (frame: Uint8Array, options?: CollabSealOptions) => {
      const copy = ownedBytes(frame)
      try {
        if (options?.checkpoint === true) {
          need(copy.length >= 2 && copy[0] === 0 && copy[1] === 1)
          const seq = options.sequence ?? 1
          need(typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1)
          return cryptor.sealCheckpoint(copy, seq)
        }
        const kind = classifyOutboundCollabFrame(copy)
        return cryptor.seal(copy, kind)
      } finally {
        copy.fill(0)
      }
    },
    open: async (frame: Uint8Array) => {
      let openedKind = -1
      const result = await cryptor.open(frame, (kind) => {
        if (kind === 0 || kind === 1 || kind === 2 || kind === 3) {
          openedKind = kind
          return true
        }
        return false
      })
      if (!verifyInboundCollabFrame(result, openedKind)) {
        result.fill(0)
        throw new Error('Invalid collaboration frame.')
      }
      return result
    },
  })
}
export function provisionCollabEpochKey(
  port: MessagePort,
  context: CollabCryptoContext,
  secret: Uint8Array
): void {
  const scope = collabContext(context),
    copy = ownedBytes(secret, 32, 32)
  port.postMessage({ kind: 'epoch-key', context: scope, secret: copy }, [copy.buffer])
}
export function hostCollabCryptoSession(
  control: MessagePort,
  epochPort: MessagePort,
  context: CollabCryptoContext
): () => void {
  const scope = collabContext(context)
  let session: ReturnType<typeof createCollabCryptoSession> | undefined,
    closed = false,
    busy = false
  const close = () => {
    if (closed) return
    closed = true
    session?.close()
    control.close()
    epochPort.close()
  }
  const refuse = () => {
    if (!closed) control.postMessage({ kind: 'closed' })
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
          JSON.stringify(collabContext(value.context)) === JSON.stringify(scope)
      )
      session = createCollabCryptoSession(scope, secret)
      control.postMessage({ kind: 'ready' })
      epochPort.close()
    } catch {
      refuse()
    } finally {
      secret?.fill(0)
    }
  }
  control.onmessage = (event: MessageEvent<unknown>) => {
    if (closed) return
    const data = event.data as { kind?: unknown }
    if (data?.kind === 'close') {
      close()
      return
    }
    try {
      const isCheckpoint = data?.kind === 'seal-checkpoint'
      const value = isCheckpoint
        ? fields(event.data, ['kind', 'id', 'frame', 'sequence'])
        : fields(event.data, ['kind', 'id', 'frame'])
      need(
        session &&
          !busy &&
          (value.kind === 'seal' || value.kind === 'open' || value.kind === 'seal-checkpoint')
      )
      integer(value.id)
      need(value.id > 0)
      let checkpointSequence = 1
      if (isCheckpoint) {
        need(
          typeof value.sequence === 'number' &&
            Number.isSafeInteger(value.sequence) &&
            value.sequence >= 1
        )
        checkpointSequence = value.sequence
      }
      const id = value.id,
        kind = value.kind,
        frame = ownedBytes(value.frame, 1, 1024 * 1024 + 2048),
        active = session
      // A validated structured-clone frame belongs to this worker, not its sender.
      ;(value.frame as Uint8Array).fill(0)
      busy = true
      void (async () => {
        let output: Uint8Array<ArrayBuffer> | undefined
        try {
          output =
            kind === 'seal-checkpoint'
              ? await active.seal(frame, { checkpoint: true, sequence: checkpointSequence })
              : await active[kind](frame)
          need(!closed && active.isActive())
          control.postMessage({ kind: 'result', id, frame: output }, [output.buffer])
          output = undefined
        } catch {
          refuse()
        } finally {
          frame.fill(0)
          output?.fill(0)
          busy = false
        }
      })()
    } catch {
      refuse()
    }
  }
  control.onmessageerror = refuse
  epochPort.onmessageerror = refuse
  control.start()
  epochPort.start()
  return close
}
/** Worker-side deterministic adapter: the returned port carries public frames only. */
export function createCollabCryptoSessionPort(
  context: CollabCryptoContext,
  epochPort: MessagePort
): MessagePort {
  const channel = new MessageChannel()
  hostCollabCryptoSession(channel.port2, epochPort, context)
  return channel.port1
}
if (
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  !Reflect.has(globalThis, 'document')
) {
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    try {
      const value = fields(event.data, ['kind', 'control', 'epochPort', 'context'])
      need(
        value.kind === 'bootstrap' &&
          value.control instanceof MessagePort &&
          value.epochPort instanceof MessagePort
      )
      hostCollabCryptoSession(value.control, value.epochPort, collabContext(value.context))
    } catch {
      /* Invalid bootstraps never admit key or document material. */
    }
  })
}
