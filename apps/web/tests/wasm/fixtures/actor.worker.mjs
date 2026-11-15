import { createFixture, CASES } from './host-adapter.mjs'

const fixture = createFixture()
let nonce, busy = false, closed = false, messages = 0
const fail = () => { closed = true; fixture.close(); self.close() }
const exact = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const csp = async () => {
  let evalBlocked = false, functionBlocked = false
  try { eval('1') } catch (error) { evalBlocked = error instanceof EvalError }
  try { Function('return 1')() } catch (error) { functionBlocked = error instanceof EvalError }
  const wasm = await WebAssembly.compile(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))
  if (!evalBlocked || !functionBlocked || !(wasm instanceof WebAssembly.Module)) throw 'Fixture'
}
self.onmessage = async ({ data }) => {
  if (closed || ++messages > 8) { fail(); return }
  if (nonce === undefined) {
    if (!exact(data, ['version', 'operation', 'nonce']) || data.version !== 1 || data.operation !== 'boot' ||
      typeof data.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(data.nonce)) { fail(); return }
    nonce = data.nonce
    try { await csp() } catch { fail(); return }
    if (!closed) self.postMessage({ version: 1, operation: 'nonceAck', nonce })
    return
  }
  if (exact(data, ['version', 'operation', 'nonce']) && data.version === 1 && data.operation === 'close' && data.nonce === nonce) {
    fail(); return
  }
  if (busy || !exact(data, ['version', 'operation', 'nonce', 'requestId', 'context', 'mode']) || data.version !== 1 ||
    data.operation !== 'run' || data.nonce !== nonce || data.requestId !== 1 || !CASES.includes(data.mode)) { fail(); return }
  busy = true
  try {
    const value = await fixture.run(data.context, data.mode)
    if (!closed) self.postMessage({ version: 1, operation: 'result', nonce, requestId: 1, value })
  } catch {
    if (!closed) self.postMessage({ version: 1, operation: 'error', nonce, requestId: 1, code: 'Fixture' })
  } finally { fixture.close(); closed = true; self.close() }
}
