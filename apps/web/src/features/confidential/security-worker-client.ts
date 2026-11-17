import { registerSecuritySessionCleanup } from '../security/localSecuritySession'

/** Public results only. Secret vault bytes use a separate transferred worker-to-worker port. */
export function securityWorkerClient(worker: Worker, context: object, vaultPort?: MessagePort) {
  let active = true,
    nextId = 0
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let unregister = () => {}
  const close = () => {
    if (!active) return
    active = false
    unregister()
    worker.terminate()
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Security session closed.'))
    }
    pending.clear()
  }
  unregister = registerSecuritySessionCleanup(close)
  worker.addEventListener('error', close)
  worker.addEventListener('messageerror', close)
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!active) return
    const reply = event.data as { kind?: unknown; id?: unknown; result?: unknown }
    if (
      !reply ||
      typeof reply.id !== 'number' ||
      !pending.has(reply.id) ||
      !['result', 'refused'].includes(String(reply.kind))
    ) {
      close()
      return
    }
    const item = pending.get(reply.id)!
    pending.delete(reply.id)
    clearTimeout(item.timer)
    if (reply.kind === 'result') item.resolve(reply.result)
    else item.reject(new Error('Security operation refused.'))
  })
  try {
    worker.postMessage(
      { kind: 'bootstrap', context, ...(vaultPort ? { vaultPort } : {}) },
      vaultPort ? [vaultPort] : []
    )
  } catch {
    close()
    throw new Error('Security worker unavailable.')
  }
  return Object.freeze({
    close,
    run(operation: string, input: unknown): Promise<unknown> {
      if (!active || pending.size >= 4)
        return Promise.reject(new Error('Security session unavailable.'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, timer: setTimeout(close, 60_000) })
        try {
          worker.postMessage({ kind: 'request', id, operation, input })
        } catch {
          close()
        }
      })
    },
  })
}
