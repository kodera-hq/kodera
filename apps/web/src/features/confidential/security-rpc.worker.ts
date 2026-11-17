import { fields, need } from './crypto-session.worker-core'

export interface SecurityWorkerScope {
  postMessage(value: unknown): void
  addEventListener(kind: string, handler: (event: MessageEvent<unknown>) => void): void
  close(): void
}
/** One bootstrap, ordered bounded operations, sanitized failures, no generic secret result path. */
export function hostSecurityWorker(
  scope: SecurityWorkerScope,
  bootstrap: (
    context: unknown,
    vaultPort?: MessagePort
  ) => Promise<(operation: string, input: unknown) => Promise<unknown>>,
  dispose: () => void,
  withVault = false
): void {
  let booted = false,
    closed = false,
    lastId = 0,
    queued = 0
  let queue = Promise.resolve()
  let dispatch: ((operation: string, input: unknown) => Promise<unknown>) | undefined
  const close = () => {
    if (!closed) {
      closed = true
      dispose()
      scope.close()
    }
  }
  scope.addEventListener('messageerror', close)
  scope.addEventListener('message', (event) => {
    if (closed) return
    try {
      if (!booted) {
        const value = fields(
          event.data,
          withVault ? ['kind', 'context', 'vaultPort'] : ['kind', 'context']
        )
        need(
          value.kind === 'bootstrap' &&
            (withVault
              ? value.vaultPort instanceof MessagePort &&
                event.ports.length === 1 &&
                event.ports[0] === value.vaultPort
              : event.ports.length === 0)
        )
        booted = true
        queue = bootstrap(value.context, value.vaultPort as MessagePort | undefined)
          .then((handler) => {
            if (!closed) dispatch = handler
            else dispose()
          })
          .catch(close)
        return
      }
      const request = fields(event.data, ['kind', 'id', 'operation', 'input'])
      need(
        request.kind === 'request' &&
          typeof request.id === 'number' &&
          Number.isSafeInteger(request.id) &&
          request.id > lastId &&
          typeof request.operation === 'string' &&
          ++queued <= 4
      )
      const id = request.id,
        operation = request.operation
      lastId = id
      queue = queue
        .then(async () => {
          try {
            need(!closed && dispatch)
            const result = await dispatch(operation, request.input)
            need(!closed)
            scope.postMessage({ kind: 'result', id, result })
          } catch {
            if (!closed) scope.postMessage({ kind: 'refused', id })
          } finally {
            queued--
          }
        })
        .catch(close)
    } catch {
      close()
    }
  })
}
