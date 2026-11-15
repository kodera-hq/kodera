// All executable CSP controls live in HTTP-served modules, never debugger evaluation.
const output = document.querySelector('output')
const need = (value) => { if (!value) throw new Error('Fixture') }
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
const CODES = new Set(['InvalidInput', 'Busy', 'Closed', 'RestoreRequired', 'Context', 'Storage', 'Crypto', 'Capacity'])
const exact = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const activeWorkers = new Set()

function request(context, mode, invalidNonce = false) {
  const worker = new Worker('/fixture/actor.worker.mjs', { type: 'module' })
  activeWorkers.add(worker)
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  let phase = 'boot', completed = false, count = 0
  return new Promise((resolve, reject) => {
    let silenceTimeout
    const end = (error, value) => {
      if (completed) return
      completed = true; clearTimeout(timeout); clearTimeout(silenceTimeout); worker.terminate(); activeWorkers.delete(worker)
      if (error) reject(new Error('Fixture')); else resolve(value)
    }
    const timeout = setTimeout(() => end(true), 15000)
    worker.onerror = (event) => { event.preventDefault(); end(true) }
    worker.onmessageerror = () => end(true)
    worker.onmessage = ({ data }) => {
      if (completed || ++count > 8 || data?.version !== 1 || data.nonce !== nonce) { end(true); return }
      if (phase === 'boot' && exact(data, ['version', 'operation', 'nonce']) && data.operation === 'nonceAck') {
        phase = invalidNonce ? 'silence' : 'run'
        const runNonce = invalidNonce ? (nonce[0] === '0' ? '1' : '0') + nonce.slice(1) : nonce
        if (invalidNonce) silenceTimeout = setTimeout(() => end(false, { status: 'silence-after-ack' }), 500)
        try {
          worker.postMessage({ version: 1, operation: 'run', nonce: runNonce, requestId: 1, context, mode })
        } catch { end(true) }
        return
      }
      if (phase !== 'run' || data.requestId !== 1 || data.operation !== 'result' ||
        !exact(data, ['version', 'operation', 'nonce', 'requestId', 'value'])) { end(true); return }
      const value = data.value
      if (value?.status === 'ready') {
        if (!exact(value, ['status', 'publicKey', 'registration', 'strictWrites', 'completedWrites']) ||
          !/^[0-9a-f]{64}$/.test(value.publicKey) || !Array.isArray(value.registration) || value.registration.length > 1024 ||
          !value.registration.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ||
          !Number.isSafeInteger(value.strictWrites) || !Number.isSafeInteger(value.completedWrites)) { end(true); return }
      } else if (value?.status === 'refused') {
        if (!CODES.has(value.code) || Object.keys(value).some((key) =>
          !['status', 'code', 'unpublished', 'committedPublicKey', 'stage', 'completedWrites', 'abortedWrites'].includes(key)) ||
          value.unpublished !== undefined && !CODES.has(value.unpublished) ||
          value.committedPublicKey !== undefined && value.committedPublicKey !== null &&
          !/^[0-9a-f]{64}$/.test(value.committedPublicKey)) { end(true); return }
        if (value.stage !== undefined && !['input', 'cas', 'committed', 'loaded'].includes(value.stage) ||
          ['completedWrites', 'abortedWrites'].some((key) => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0))) { end(true); return }
      } else { end(true); return }
      end(false, value)
    }
    worker.postMessage({ version: 1, operation: 'boot', nonce })
  })
}

async function verify(value, context) {
  need(value.status === 'ready')
  const bytes = Uint8Array.from(value.registration)
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  need(exact(body, ['signingKey', 'signature']))
  const decode = (text, length) => {
    need(typeof text === 'string')
    const result = Uint8Array.from(atob(text), (part) => part.charCodeAt(0))
    need(result.length === length && btoa(String.fromCharCode(...result)) === text)
    return result
  }
  const key = decode(body.signingKey, 32), signature = decode(body.signature, 64)
  need(hex(key) === value.publicKey)
  const transcript = new TextEncoder().encode('kodera-e2ee-relay-v1\0' + JSON.stringify([
    'register-device', context.organisationId, context.membershipId, null, { signingKey: body.signingKey },
  ]))
  const imported = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
  need(await crypto.subtle.verify('Ed25519', imported, signature, transcript))
  const changed = transcript.slice(); changed[changed.length - 2] ^= 1
  need(!await crypto.subtle.verify('Ed25519', imported, signature, changed))
  signature[0] ^= 1
  need(!await crypto.subtle.verify('Ed25519', imported, signature, transcript))
}

async function blockedWorker(url) {
  return new Promise((resolve, reject) => {
    let worker, timeout
    const done = (blocked) => { clearTimeout(timeout); worker?.terminate(); blocked ? resolve(true) : reject(new Error('Fixture')) }
    try {
      worker = new Worker(url, { type: 'module' })
      worker.onerror = (event) => { event.preventDefault(); done(true) }
      worker.onmessage = () => done(false)
      timeout = setTimeout(() => done(false), 3000)
    } catch (error) { done(error instanceof DOMException && error.name === 'SecurityError') }
  })
}

async function policy(control) {
  let evalBlocked = false, functionBlocked = false, wasmBlocked = false
  try { eval('1') } catch (error) { evalBlocked = error instanceof EvalError }
  try { Function('return 1')() } catch (error) { functionBlocked = error instanceof EvalError }
  const module = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
  try { await WebAssembly.compile(module) } catch (error) { wasmBlocked = error instanceof WebAssembly.CompileError }
  need(evalBlocked && functionBlocked && wasmBlocked !== control)
  if (!control) {
    const other = document.querySelector('meta[name=control-origin]').content
    need(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(other))
    const blob = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))
    try { await blockedWorker(blob) } finally { URL.revokeObjectURL(blob) }
    await blockedWorker('data:text/javascript,postMessage(1)')
    await blockedWorker(other + '/fixture/cross-origin.worker.mjs')
  }
}

async function main() {
  const params = new URLSearchParams(location.search)
  need([...params.keys()].every((key) => key === 'case') && params.getAll('case').length === 1)
  const name = params.get('case')
  if (name === 'csp-control') { await policy(true); return { status: 'passed', case: name } }
  const context = { ownerId: crypto.randomUUID(), organisationId: crypto.randomUUID(), membershipId: crypto.randomUUID() }
  await policy(false)
  if (name === 'restart' || name === 'lost-ack-restart') {
    const first = await request(context, name === 'restart' ? 'create' : 'lost-ack')
    if (name === 'restart') await verify(first, context)
    else need(first.status === 'refused' && first.code === 'Storage' && first.committedPublicKey)
    const second = await request(context, 'restore')
    await verify(second, context)
    need(second.publicKey === (first.publicKey ?? first.committedPublicKey))
  } else if (['tamper-native', 'wrong-seed', 'wrong-generation'].includes(name)) {
    await verify(await request(context, 'create'), context)
    const refused = await request(context, name)
    need(refused.status === 'refused' && (name === 'wrong-generation' ? refused.code === 'InvalidInput' : refused.code === 'Crypto'))
  } else if (name === 'wrong-nonce') {
    await verify(await request(context, 'create'), context)
    const outcome = await request(context, 'create', true)
    need(exact(outcome, ['status']) && outcome.status === 'silence-after-ack')
  } else {
    const value = await request(context, name)
    if (name === 'create' || name === 'busy') { await verify(value, context); need(value.strictWrites >= 2 && value.completedWrites >= 2) }
    else {
      need(value.status === 'refused')
      if (name.startsWith('ack-')) need(value.code === 'Storage' && value.stage === 'committed' && value.committedPublicKey &&
        value.completedWrites >= 2 && value.unpublished === 'RestoreRequired')
      else if (name.startsWith('promise-') || name === 'host-throw') need(value.code === 'Storage' &&
        value.stage === (name === 'promise-proxy' ? 'committed' : 'cas') && value.unpublished === 'RestoreRequired')
      else if (name.startsWith('current-')) need(value.code === 'Context' && value.stage === 'input' && value.unpublished === 'RestoreRequired')
      else if (name === 'pre-close') need(value.code === 'Closed' && value.stage === 'input' && value.unpublished === 'Closed')
      else if (['cas-close', 'post-close', 'post-context'].includes(name)) need(value.code === 'Storage' && value.stage === 'committed' && value.completedWrites >= 2)
      else if (name === 'free-pending') need(['Storage', 'Closed'].includes(value.code) && value.stage === 'committed')
      else if (name === 'store-abort') need(value.code === 'Storage' && value.stage === 'cas' &&
        value.abortedWrites >= 1 && value.unpublished === 'RestoreRequired' && value.committedPublicKey === null)
      else if (name === 'generated-export-mutant') need(exact(value, ['status', 'code', 'stage']) &&
        value.code === 'InvalidInput' && value.stage === 'input')
      else if (name === 'store-close' || name === 'owner-revoke') need(value.code === 'Storage' && value.stage === 'cas')
      else if (name === 'missing-vault') need(value.code === 'Context')
      else need(value.code === 'InvalidInput' && (value.stage === undefined || value.stage === 'input'))
    }
  }
  return { status: 'passed', case: name }
}
addEventListener('pagehide', () => { for (const worker of activeWorkers) worker.terminate(); activeWorkers.clear() })
main().then((result) => { output.textContent = JSON.stringify(result); output.dataset.phase = 'complete' },
  () => { for (const worker of activeWorkers) worker.terminate(); activeWorkers.clear(); output.textContent = '{"status":"failed","code":"Fixture"}'; output.dataset.phase = 'complete' })
