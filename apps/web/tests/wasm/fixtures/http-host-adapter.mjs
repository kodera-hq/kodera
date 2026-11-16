// Test-only trusted-host oracle. Synthetic 201s are NOT real Core qualification.
import { initializeConfidentialState, openConfidentialState } from '/storage/local-state'
import { createDeviceCasHost } from '/storage/device-cas-host.js'

const need = (v) => { if (!v) throw new Error('HTTP fixture') }
const hex = (v) => Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')
const raw = (v) => Uint8Array.from(v.match(/../g), (b) => parseInt(b, 16))
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const digest = async (v) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', v)))
const b64 = (v) => btoa(String.fromCharCode(...v))
const unb64 = (v) => Uint8Array.from(atob(v), (b) => b.charCodeAt(0))
const decode = (v) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(v.slice(8)))
const state = (v) => { const value = JSON.parse(v); need(value.version === 2); return value }
const codes = new Set(['InvalidInput', 'Busy', 'Closed', 'RestoreRequired', 'Context', 'Storage', 'Crypto', 'Capacity'])
const CASES = Object.freeze([
  'http-flow', 'http-profile', 'http-restart', 'http-prepare-restart',
  'http-registration-unknown', 'http-publication-unknown', 'http-recovery-spent',
  'http-wrong-signing-key', 'http-wrong-reference', 'http-wrong-correlation',
  'http-ack-native', 'http-ack-host', 'http-ack-record', 'http-ack-sealed',
  'http-ack-manifest', 'http-ack-legacy', 'http-lost-store-ack', 'http-close-cas',
  'http-second-package', 'http-missing-manifest', 'http-wrong-native-generation',
  'http-cell-expired', 'http-forged-outcome', 'http-request-id',
  'http-live-retry', 'http-clock-rollback', 'http-clock-monotonic-expired', 'http-clock-nonfinite',
  'http-abort-admission', 'http-abort-publication', 'http-admission-store-unknown', 'http-publication-store-unknown',
  'http-preparation-body-mutation',
  'http-outcome-symbol', 'http-close-outcome-descriptor',
])
async function refused(action) {
  let code
  try { await action() } catch (error) { need(typeof error === 'string' && codes.has(error)); code = error }
  need(code)
  return code
}
function wrap(header, sealed) {
  need(header.length === 56 && sealed.length >= 36 && sealed.length <= 17 * 1024 * 1024 - 56)
  const out = new Uint8Array(56 + sealed.length); out.set(header); out.set(sealed, 56)
  new DataView(out.buffer).setUint32(52, sealed.length, false)
  return out
}
async function proof(scope, descriptor, bytes) {
  need(bytes.length > 0 && bytes.length <= 32768 && await digest(bytes) === descriptor.bodySha256)
  const body = JSON.parse(new TextDecoder().decode(bytes)), signature = unb64(body.signature)
  delete body.signature
  const unsigned = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)))
  const operation = descriptor.operation === 'register' ? 'register-device' : 'publish-key-package'
  const payload = new TextEncoder().encode('kodera-e2ee-relay-v1\0' + JSON.stringify([
    operation, scope.organisationId, scope.membershipId, null, unsigned,
  ]))
  const key = await crypto.subtle.importKey('raw', raw(descriptor.devicePublicKey), 'Ed25519', false, ['verify'])
  need(await crypto.subtle.verify('Ed25519', key, signature, payload))
  return body
}

async function run(context, mode) {
  need(CASES.includes(mode))
  // Private test-worker-only clocks are installed BEFORE importing the real
  // generated module, so the actual captured functions exercise the guards.
  // No clock parameter or replacement hook is added to the production actor.
  let wallOffset = 0, monotonicOffset = 0, invalidClock = false
  if (mode.startsWith('http-clock-')) {
    const wall = Date.now.bind(Date), monotonic = performance.now.bind(performance)
    Object.defineProperty(Date, 'now', { value: () => invalidClock ? NaN : wall() + wallOffset })
    Object.defineProperty(performance, 'now', { value: () => monotonic() + monotonicOffset })
  }
  stage = 'native-import'
  const { default: initializeNative, BrowserMlsDevice, BrowserMlsHttpDevice } = await import('/native/kodera_rs.js')
  stage = 'native-init'
  await initializeNative()
  need(Object.keys(context).sort().join() === 'membershipId,organisationId,ownerId')
  let alive = true, actor, n = 0, g = 0, key = null, record = null, frameSha = null, nativeWrites = 0, sends = 0
  stage = 'store-open'
  let fault = null, store = await initializeConfidentialState(context.ownerId)
  let recoveryArms = 0
  const sentRequests = []
  const workerToken = Object.freeze({})
  let currentWorker = workerToken
  const makeDurableHost = () => createDeviceCasHost(store, context, () => {
    const capturedWorker = currentWorker
    return () => alive && capturedWorker === currentWorker
  })
  stage = 'host-create'
  let durableHost = makeDurableHost(), abortNext = false, aborted = 0
  const originalTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = Reflect.apply(originalTransaction, this, args)
    if (args[1] === 'readwrite') {
      need(args[2]?.durability === 'strict' && tx.durability === 'strict')
      if (abortNext) {
        abortNext = false
        tx.addEventListener('abort', () => { aborted += 1 }, { once: true })
        queueMicrotask(() => tx.abort())
      }
    }
    return tx
  }
  const seed = crypto.getRandomValues(new Uint8Array(32)), header = new Uint8Array(56), cells = new WeakMap()
  header.set(new TextEncoder().encode('KWE1')); header.set(crypto.getRandomValues(new Uint8Array(16)), 4); header.set(seed, 20)
  const deviceId = crypto.randomUUID(), corePackageId = crypto.randomUUID(), op = crypto.randomUUID(), recordId = crypto.randomUUID()
  const scope = () => ({ ...context, devicePublicKey: key, kind: 'device-vault' })
  const reread = () => store.readUniqueDeviceVault({ organisationId: context.organisationId, membershipId: context.membershipId })
  const host = {
    checkCurrent(text) {
      const value = JSON.parse(text)
      need(value.version === 2 && value.profile === 'http' && Number.isSafeInteger(value.actorOperation) && value.actorOperation > 0 &&
        Object.entries(context).every(([name, id]) => value[name] === id))
      return alive && value.nativeGeneration === n && value.hostGeneration === g && value.devicePublicKey === key &&
        value.recordId === (record?.recordId ?? null) && value.recordSha256 === frameSha &&
        value.admittedDeviceId === (record?.admission?.deviceId ?? null)
    },
    async compareAndSwapDevice(text, sealed) {
      const meta = JSON.parse(text), copy = sealed.slice(), wrapped = wrap(header, copy)
      need(n === 0 && g === 0 && meta.expectedGeneration === 0 && meta.generation === 1 && await digest(copy) === meta.checkpointSha256)
      key = meta.devicePublicKey
      need(await store.createUniqueDeviceVault(scope(), { checkpoint: wrapped, pendingSends: [] }) === 1)
      const read = await reread(); need(read && same(read.state.checkpoint, wrapped))
      n = 1; g = 1
      const reply = new Uint8Array(192), encoder = new TextEncoder(), view = new DataView(reply.buffer)
      reply.set(encoder.encode('KDA1'))
      for (const [name, at] of [['ownerId', 4], ['organisationId', 40], ['membershipId', 76]]) reply.set(encoder.encode(context[name]), at)
      reply.set(raw(key), 112); view.setBigUint64(152, 1n, false); reply.set(raw(meta.checkpointSha256), 160)
      return reply
    },
    async compareAndSwapDeviceV2(text, sealed, frame) {
      const meta = JSON.parse(text), copy = sealed.slice(), manifest = frame.slice(), next = decode(manifest)
      need(Object.keys(meta).length === 12 && meta.expectedNativeGeneration === n && meta.expectedHostGeneration === g &&
        meta.nextHostGeneration === g + 1 && meta.nextNativeGeneration >= n && meta.nextNativeGeneration <= n + 1 &&
        meta.recordId === next.recordId && meta.sealedSha256 === await digest(copy) && meta.recordSha256 === await digest(manifest))
      const wrapped = wrap(header, copy)
      // Execute the actual fixed worker host, shared codec and strict IDB end
      // fence. Faults below alter only the returned post-commit acknowledgement.
      if (fault === 'abort-admission' && next.admission && !record?.admission ||
        fault === 'abort-publication' && next.publication) { abortNext = true; fault = null }
      let reply = await durableHost.compareAndSwapDeviceV2(text, copy, manifest)
      const read = await reread()
      need(read && read.generation === g + 1 && same(read.state.checkpoint, wrapped) &&
        read.state.pendingSends.length === 1 && same(read.state.pendingSends[0].ciphertext, manifest))
      const verifiedFrameSha = await digest(read.state.pendingSends[0].ciphertext)
      need(verifiedFrameSha === meta.recordSha256)
      if (meta.nextNativeGeneration > n) nativeWrites += 1
      if (next.pending?.recoverySpent === 1 && record?.pending?.recoverySpent === 0) recoveryArms += 1
      n = meta.nextNativeGeneration; g = meta.nextHostGeneration; record = next; frameSha = verifiedFrameSha
      if (fault === 'lost-admission-ack' && next.admission || fault === 'lost-publication-ack' && next.publication) {
        fault = null; throw new Error('lost retirement acknowledgement')
      }
      if (fault === 'prepare-gap' && n === 3 && next.pending === null && next.publication === null) { fault = null; throw new Error('lost native preparation acknowledgement') }
      if (fault === 'lost-store-ack') { fault = null; throw new Error('lost acknowledgement') }
      if (fault === 'close-cas') { fault = null; actor.close() }
      const offsets = { 'ack-native': 188, 'ack-host': 204, 'ack-record': 144, 'ack-sealed': 212, 'ack-manifest': 244 }
      if (fault in offsets) { reply[offsets[fault]] ^= 1; fault = null }
      if (fault === 'ack-legacy') { reply = reply.slice(0, 192); fault = null }
      return reply
    },
    async prepareDeviceHttpAttempt(text, bytes) {
      const descriptor = JSON.parse(text), body = bytes.slice()
      if (mode === 'http-preparation-body-mutation') bytes.fill(0)
      await proof(context, descriptor, body)
      const cell = Object.freeze({}); cells.set(cell, { descriptor, body }); return cell
    },
    deviceHttpAttemptInfo(cell) {
      const entry = cells.get(cell); need(entry)
      return JSON.stringify({ version: 2, actorOperation: entry.descriptor.actorOperation,
        operationId: entry.descriptor.operationId, bodySha256: entry.descriptor.bodySha256,
        observedWallMs: Date.now(), retryBeforeMs: Date.now() + 86400000 - 10000 })
    },
    async sendDeviceHttpAttempt(cell, text, bytes) {
      const entry = cells.get(cell); need(entry); cells.delete(cell)
      const descriptor = JSON.parse(text)
      need(alive && entry.descriptor.actorOperation === descriptor.actorOperation &&
        entry.descriptor.operationId === descriptor.operationId && same(entry.body, bytes))
      if (fault === 'cell-expired') { fault = null; return { kind: 'unknown' } }
      sends += 1
      sentRequests.push({ operationId: descriptor.operationId, digest: await digest(bytes) })
      const body = await proof(context, descriptor, bytes)
      if (fault === 'http-unknown') { fault = null; return { kind: 'unknown' } }
      let response = descriptor.operation === 'register' ? { deviceId, signingKey: body.signingKey } :
        { keyPackageId: corePackageId, reference: b64(raw(await digest(unb64(body.keyPackage)))), expiresAt: '2030-01-01T00:00:00Z' }
      if (fault === 'wrong-signing-key') { const wrong = raw(key); wrong[0] ^= 1; response.signingKey = b64(wrong); fault = null }
      if (fault === 'wrong-reference') { const wrong = unb64(response.reference); wrong[0] ^= 1; response.reference = b64(wrong); fault = null }
      const reply = { kind: 'response', actorOperation: descriptor.actorOperation, operationId: descriptor.operationId,
        bodySha256: descriptor.bodySha256, status: 201, contentType: 'application/json',
        requestId: mode === 'http-request-id' ? 'c-synthetic-request-123' : crypto.randomUUID(), replayed: null,
        body: new TextEncoder().encode(JSON.stringify(response)) }
      if (fault === 'wrong-correlation') { reply.operationId = crypto.randomUUID(); fault = null }
      if (mode === 'http-outcome-symbol') reply[Symbol('unknown')] = true
      if (fault === 'close-descriptors') {
        fault = null
        return new Proxy(reply, { ownKeys(target) { actor.close(); return Reflect.ownKeys(target) } })
      }
      return reply
    },
  }
  const fresh = () => new BrowserMlsHttpDevice(host, context.ownerId, context.organisationId, context.membershipId)
  async function restart(mutate) {
    actor.close(); actor.free()
    durableHost.close(); currentWorker = Object.freeze({})
    store = await openConfidentialState(context.ownerId); durableHost = makeDurableHost()
    const read = await reread(); need(read)
    const manifest = read.state.pendingSends[0]?.ciphertext ?? null
    const native = manifest ? decode(manifest).nativeGeneration : 1
    const restoredFrameSha = manifest ? await digest(manifest) : null
    n = native; g = read.generation; record = manifest ? decode(manifest) : null; frameSha = restoredFrameSha
    actor = fresh()
    const restoredSealed = read.state.checkpoint.slice(56), restoredSeed = read.state.checkpoint.slice(20, 52)
    try {
      await actor.openHttpDevice(raw(key), mutate === 'native' ? native + 1 : native, read.generation,
        restoredSealed, mutate === 'manifest' ? null : manifest, restoredSeed)
    } finally { restoredSealed.fill(0); restoredSeed.fill(0); read.state.checkpoint.fill(0) }
  }
  try {
    stage = 'actor-create'
    actor = fresh()
    need(state(await actor.createHttpDevice(new TextEncoder().encode('public HTTP fixture'), seed, true)).state === 'pre-admission')
    stage = 'protocol'
    if (mode === 'http-profile') {
      for (const name of ['registrationRequest', 'createDevice', 'openDevice']) need(!(name in actor))
      const legacy = new BrowserMlsDevice(host, context.ownerId, context.organisationId, context.membershipId)
      need(!('prepareRegistration' in legacy) && !('attemptHttp' in legacy))
      need(await refused(() => BrowserMlsDevice.prototype.registrationRequest.call(actor)) === 'InvalidInput')
      need(await refused(() => BrowserMlsHttpDevice.prototype.attemptHttp.call(legacy)) === 'InvalidInput')
      need(same(await actor.publicKey(), raw(key)))
      legacy.close(); legacy.free()
      return
    }
    if (mode.startsWith('http-ack-') || ['http-lost-store-ack', 'http-close-cas'].includes(mode)) fault = mode.slice(5)
    if (fault) {
      await refused(() => actor.prepareRegistration(recordId, op)); need(sends === 0 && record.pending.operationId === op)
      await restart(); need(n === 1 && g === 2); return
    }
    need(state(await actor.prepareRegistration(recordId, op)).state === 'registration-prepared' && n === 1 && g === 2)
    if (mode === 'http-missing-manifest' || mode === 'http-wrong-native-generation') {
      await refused(() => restart(mode === 'http-missing-manifest' ? 'manifest' : 'native')); need(sends === 0); return
    }
    if (mode === 'http-forged-outcome') {
      need(!('acceptRegistration' in actor) && !('acceptHttp' in actor)); need(record.admission === null && sends === 0); return
    }
    if (mode === 'http-restart') await restart()
    if (['http-registration-unknown', 'http-recovery-spent', 'http-live-retry'].includes(mode) || mode.startsWith('http-clock-')) fault = 'http-unknown'
    if (mode === 'http-wrong-signing-key') fault = 'wrong-signing-key'
    if (mode === 'http-wrong-correlation') fault = 'wrong-correlation'
    if (mode === 'http-cell-expired') fault = 'cell-expired'
    if (mode === 'http-close-outcome-descriptor') {
      fault = 'close-descriptors'
      need(await refused(() => actor.attemptHttp()) === 'Closed')
      need(record.admission === null && n === 1 && sends === 1)
      await restart(); need(record.admission === null); return
    }
    if (mode === 'http-abort-admission' || mode === 'http-admission-store-unknown') {
      fault = mode === 'http-abort-admission' ? 'abort-admission' : 'lost-admission-ack'
      await refused(() => actor.attemptHttp()); need(sends === 1)
      await restart()
      if (mode === 'http-abort-admission') {
        need(aborted === 1 && n === 1 && record.admission === null && record.pending.phase === 'attempted')
        need(state(await actor.attemptHttp()).state === 'admitted' && n === 2 && recoveryArms === 1)
      } else {
        const count = sends
        need(n === 2 && record.admission.deviceId === deviceId && record.pending === null)
        need(state(await actor.attemptHttp()).state === 'admitted' && sends === count)
      }
      return
    }
    const registered = state(await actor.attemptHttp())
    if (['http-wrong-signing-key', 'http-wrong-correlation', 'http-cell-expired', 'http-outcome-symbol'].includes(mode)) {
      need(registered.state === 'outcome-unknown' && record.admission === null && n === 1); return
    }
    if (registered.state === 'outcome-unknown') {
      if (mode === 'http-clock-rollback') wallOffset = -60000
      if (mode === 'http-clock-monotonic-expired') monotonicOffset = 86400001
      if (mode === 'http-clock-nonfinite') {
        invalidClock = true; const count = sends
        await refused(() => actor.attemptHttp()); need(sends === count)
        invalidClock = false; await restart()
      } else if (mode !== 'http-live-retry' && !mode.startsWith('http-clock-')) await restart()
      if (mode === 'http-recovery-spent') fault = 'http-unknown'
      const recovered = state(await actor.attemptHttp())
      if (mode === 'http-recovery-spent') {
        need(recovered.state === 'outcome-unknown' && record.pending.recoverySpent === 1)
        const sent = sends; await restart(); need(state(await actor.attemptHttp()).state === 'outcome-unknown' && sends === sent); return
      }
      need(recovered.state === 'admitted')
      need(sentRequests.length === 2 && sentRequests[0].operationId === sentRequests[1].operationId && sentRequests[0].digest === sentRequests[1].digest)
      if (mode === 'http-live-retry') { need(recoveryArms === 0 && n === 2 && g === 4); return }
      if (mode.startsWith('http-clock-')) { need(recoveryArms === 1); return }
    } else need(registered.state === 'admitted' && n === 2 && g === 4)
    const publicationOp = crypto.randomUUID()
    if (mode === 'http-prepare-restart') {
      fault = 'prepare-gap'; await refused(() => actor.preparePublication(publicationOp))
      need(n === 3 && record.pending === null); const sealedHash = record.sealedSha256
      await restart(); await actor.preparePublication(publicationOp)
      need(n === 3 && record.sealedSha256 === sealedHash && nativeWrites === 2)
    } else await actor.preparePublication(publicationOp)
    need(record.pending.operation === 'publish-package' && n === 3)
    if (mode === 'http-second-package') {
      const before = { pending: JSON.stringify(record.pending), sealed: record.sealedSha256,
        nativeWrites, sends, n, g }
      need(await refused(() => actor.preparePublication(crypto.randomUUID())) === 'InvalidInput')
      const read = await reread(); need(read && read.state.pendingSends.length === 1)
      const actual = decode(read.state.pendingSends[0].ciphertext)
      need(JSON.stringify(actual.pending) === before.pending && actual.sealedSha256 === before.sealed &&
        actual.nativeGeneration === before.n && read.generation === before.g &&
        JSON.stringify(record.pending) === before.pending && nativeWrites === before.nativeWrites &&
        sends === before.sends && n === before.n && g === before.g)
      read.state.checkpoint.fill(0)
      return
    }
    if (mode === 'http-wrong-reference') fault = 'wrong-reference'
    if (mode === 'http-publication-unknown') fault = 'http-unknown'
    if (mode === 'http-abort-publication' || mode === 'http-publication-store-unknown') {
      fault = mode === 'http-abort-publication' ? 'abort-publication' : 'lost-publication-ack'
      await refused(() => actor.attemptHttp()); need(sends === 2)
      await restart()
      if (mode === 'http-abort-publication') {
        need(aborted === 1 && n === 3 && record.publication === null && record.pending.operation === 'publish-package')
        need(state(await actor.attemptHttp()).state === 'published' && n === 3 && recoveryArms === 1)
      } else {
        const count = sends
        need(n === 3 && record.publication.corePackageId === corePackageId && record.pending === null)
        need(state(await actor.attemptHttp()).state === 'published' && sends === count)
      }
      return
    }
    const published = state(await actor.attemptHttp())
    if (mode === 'http-wrong-reference') { need(published.state === 'outcome-unknown' && record.publication === null && n === 3); return }
    if (mode === 'http-publication-unknown') { await restart(); need(state(await actor.attemptHttp()).state === 'published') }
    else need(published.state === 'published')
    need(record.pending === null && record.publication.corePackageId === corePackageId && nativeWrites === 2)
    await restart(); const sent = sends; need(state(await actor.attemptHttp()).state === 'published' && sends === sent)
  } finally {
    alive = false; currentWorker = null; actor?.close(); actor?.free(); durableHost.close()
    IDBDatabase.prototype.transaction = originalTransaction
    seed.fill(0); header.fill(0)
  }
}

let nonce, running = false, stage = 'boot'
self.onmessage = async ({ data }) => {
  if (!nonce) {
    need(data?.version === 1 && data.operation === 'boot' && /^[0-9a-f]{32}$/.test(data.nonce))
    nonce = data.nonce; self.postMessage({ version: 1, operation: 'nonceAck', nonce }); return
  }
  if (running || data?.version !== 1 || data.nonce !== nonce || data.operation !== 'run' || data.requestId !== 1) { self.close(); return }
  running = true
  try {
    await run(data.context, data.mode)
    self.postMessage({ version: 1, operation: 'result', nonce, requestId: 1,
      value: { status: 'passed', case: data.mode, hostOracleOnly: true } })
  } catch (error) {
    self.postMessage({ version: 1, operation: 'result', nonce, requestId: 1,
      value: { status: 'failed', case: CASES.includes(data.mode) ? data.mode : 'invalid-case', hostOracleOnly: true,
        stage, code: typeof error === 'string' && codes.has(error) ? error : 'Fixture' } })
  } finally { self.close() }
}
