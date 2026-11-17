// Test entry only: production native/worker/store bytes are imported unchanged.
const first = await new Promise((resolve) => self.addEventListener('message', resolve, { once: true }))
const { fixtureFault: mode, ...bootstrap } = first.data
if (!['abort-record-write', 'hold-record-completion'].includes(mode)) throw new Error('Fixture mode refused')
const held = new WeakSet()
if (mode === 'hold-record-completion') {
  const openTx = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = Reflect.apply(openTx, this, args)
    tx.addEventListener('complete', (event) => {
      if (!held.has(tx)) return
      event.stopImmediatePropagation()
      self.postMessage({ fixture: 1, kind: 'record-committed-completion-held' })
    }, { once: true })
    return tx
  }
}
const add = IDBObjectStore.prototype.add
let armed = true
IDBObjectStore.prototype.add = function (...args) {
  const request = Reflect.apply(add, this, args)
  if (armed && this.name === 'records') {
    armed = false
    const tx = this.transaction
    if (mode === 'abort-record-write') {
      request.addEventListener('success', () => {
        tx.abort()
        self.postMessage({ fixture: 1, kind: 'record-aborted' })
      }, { once: true })
    } else {
      held.add(tx)
    }
  }
  return request
}
await import('../../src/features/confidential/device.worker.ts')

self.dispatchEvent(new MessageEvent('message', { data: bootstrap, ports: first.ports }))
