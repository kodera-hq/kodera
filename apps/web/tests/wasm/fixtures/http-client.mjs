// Native actor execution starts only in this HTTP-served module and its worker.
// This test-only client never receives a seed, provider, checkpoint or token.
const output = document.querySelector('output')
const exact = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',')
const mode = new URL(location.href).searchParams.get('httpCase')
let worker, timer, finished = false, phase = 'boot', messages = 0
const finish = (passed) => {
  if (finished) return
  finished = true; clearTimeout(timer); worker?.terminate()
  output.textContent = JSON.stringify(passed ? { status: 'passed', case: mode, hostOracleOnly: true } : { status: 'failed' })
  output.dataset.phase = 'complete'
}
try {
  if (typeof mode !== 'string' || !/^http-[a-z-]{1,60}$/.test(mode)) throw new Error('Fixture')
  worker = new Worker('/fixture/http-host-adapter.mjs', { type: 'module' })
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  const context = { ownerId: crypto.randomUUID(), organisationId: crypto.randomUUID(), membershipId: crypto.randomUUID() }
  timer = setTimeout(() => finish(false), 25000)
  worker.onerror = (event) => { event.preventDefault(); finish(false) }
  worker.onmessageerror = () => finish(false)
  worker.onmessage = ({ data }) => {
    if (finished || ++messages > 2 || data?.version !== 1 || data.nonce !== nonce) { finish(false); return }
    if (phase === 'boot' && exact(data, ['version', 'operation', 'nonce']) && data.operation === 'nonceAck') {
      phase = 'run'; worker.postMessage({ version: 1, operation: 'run', nonce, requestId: 1, context, mode }); return
    }
    if (phase !== 'run' || !exact(data, ['version', 'operation', 'nonce', 'requestId', 'value']) ||
      data.operation !== 'result' || data.requestId !== 1 ||
      !exact(data.value, ['status', 'case', 'hostOracleOnly']) || data.value.status !== 'passed' ||
      data.value.case !== mode || data.value.hostOracleOnly !== true) { finish(false); return }
    finish(true)
  }
  worker.postMessage({ version: 1, operation: 'boot', nonce })
} catch { finish(false) }
addEventListener('pagehide', () => { clearTimeout(timer); worker?.terminate() }, { once: true })
