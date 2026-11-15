// Test-only fixed worker host. No production import, seed getter or injected engine.
import initializeNative, { BrowserMlsDevice } from '/native/kodera_rs.js'
import { initializeConfidentialState, openConfidentialState, deleteConfidentialOwner } from '/storage/local-state.js'

const LIMIT = 17 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const CODES = new Set(['InvalidInput', 'Busy', 'Closed', 'RestoreRequired', 'Context', 'Storage', 'Crypto', 'Capacity'])
export const CASES = Object.freeze([
  'create', 'restore', 'lost-ack', 'missing-vault', 'nil-owner', 'upper-owner',
  'current-false', 'current-throw', 'current-nonboolean', 'free-pending', 'tamper-native', 'wrong-seed', 'wrong-generation',
  'consent', 'identity-empty', 'identity-large', 'seed-short', 'seed-long',
  'identity-proxy', 'identity-subclass', 'identity-detached', 'identity-resizable', 'identity-shared',
  'promise-immediate', 'promise-thenable', 'promise-proxy', 'promise-reject', 'host-throw',
  'ack-short', 'ack-long', 'ack-magic', 'ack-owner', 'ack-organisation', 'ack-membership',
  'ack-key', 'ack-prior-generation', 'ack-generation', 'ack-digest',
  'busy', 'pre-close', 'cas-close', 'post-close', 'post-context', 'store-close', 'store-abort', 'owner-revoke',
])
const need = (value) => { if (!value) throw 'Fixture' }
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
const unhex = (text) => { need(HEX.test(text)); return Uint8Array.from(text.match(/../g), (value) => parseInt(value, 16)) }
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
const closed = (error) => typeof error === 'string' && CODES.has(error) ? error : 'Fixture'
const fields = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')

function scope(value) {
  need(fields(value, ['ownerId', 'organisationId', 'membershipId']))
  need(Object.values(value).every((part) => typeof part === 'string' && UUID.test(part) &&
    part !== '00000000-0000-0000-0000-000000000000'))
  return Object.freeze({ ...value })
}

function wrap(seed, keyId, sealed) {
  need(seed.length === 32 && keyId.length === 16 && sealed.length >= 36 && sealed.length <= LIMIT - 56)
  const result = new Uint8Array(56 + sealed.length)
  result.set([75, 87, 69, 49]); result.set(keyId, 4); result.set(seed, 20)
  new DataView(result.buffer).setUint32(52, sealed.length, false); result.set(sealed, 56)
  return result
}

function unwrap(bytes) {
  need(Object.getPrototypeOf(bytes) === Uint8Array.prototype && bytes.length >= 92 && bytes.length <= LIMIT)
  need(equal(bytes.subarray(0, 4), Uint8Array.of(75, 87, 69, 49)))
  need(new DataView(bytes.buffer, bytes.byteOffset).getUint32(52, false) === bytes.length - 56)
  return { keyId: bytes.slice(4, 20), seed: bytes.slice(20, 52), sealed: bytes.slice(56) }
}

function acknowledge(context, metadata, digest) {
  const result = new Uint8Array(192), encoder = new TextEncoder()
  result.set([75, 68, 65, 49])
  for (const [name, offset] of [['ownerId', 4], ['organisationId', 40], ['membershipId', 76]])
    result.set(encoder.encode(context[name]), offset)
  result.set(unhex(metadata.devicePublicKey), 112)
  const view = new DataView(result.buffer)
  view.setBigUint64(144, 0n, false); view.setBigUint64(152, 1n, false); result.set(digest, 160)
  return result
}

// Observe real strict transactions; no Promise/request callback is replaced.
function transactions() {
  const original = IDBDatabase.prototype.transaction
  const state = { strictWrites: 0, completedWrites: 0, abortedWrites: 0, abortNext: false }
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = Reflect.apply(original, this, args)
    if (args[1] === 'readwrite') {
      need(args[2]?.durability === 'strict' && tx.durability === 'strict')
      state.strictWrites += 1
      tx.addEventListener('complete', () => { state.completedWrites += 1 }, { once: true })
      tx.addEventListener('abort', () => { state.abortedWrites += 1 }, { once: true })
      if (state.abortNext) { state.abortNext = false; queueMicrotask(() => tx.abort()) }
    }
    return tx
  }
  return { state, restore: () => { IDBDatabase.prototype.transaction = original } }
}

export function createFixture() {
  let actor, store, alive = true, pending, seed, keyId, freed = false
  const retire = () => { alive = false; if (!freed) actor?.close(); store?.close() }
  return Object.freeze({
    close: retire,
    async run(input, mode) {
      const accepted = scope(input)
      need(CASES.includes(mode) && alive && !actor)
      const observe = transactions()
      let prior
      let ready = false, generation = 0, publicKey = null, thenGets = 0, thenCalls = 0, faultCurrent = true, stage = 'input'
      let casEntered
      const entered = new Promise((resolve) => { casEntered = resolve })
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const isRestore = ['restore', 'tamper-native', 'wrong-seed', 'wrong-generation'].includes(mode)
      const context = { organisationId: accepted.organisationId, membershipId: accepted.membershipId }
      const host = {
        checkCurrent(text) {
          need(typeof text === 'string' && text.length <= 1024)
          const value = JSON.parse(text)
          need(fields(value, ['version', 'ownerId', 'organisationId', 'membershipId', 'devicePublicKey', 'generation', 'admittedDeviceId']))
          const valid = alive && ready && value.version === 1 && value.admittedDeviceId === null &&
            Object.keys(accepted).every((key) => value[key] === accepted[key]) &&
            value.generation === generation && value.devicePublicKey === publicKey
          if (faultCurrent && ['current-false', 'current-throw', 'current-nonboolean'].includes(mode)) {
            faultCurrent = false
            if (mode === 'current-throw') throw new Error('Fixture')
            return mode === 'current-nonboolean' ? 'true' : false
          }
          if (mode === 'pre-close' && generation === 0 || mode === 'post-close' && generation === 1) actor.close()
          if (mode === 'post-context' && generation === 1) return false
          return valid
        },
        compareAndSwapDevice(text, nativeSealed) {
          stage = 'cas'; casEntered()
          if (mode === 'host-throw') throw new Error('Fixture')
          if (mode === 'promise-immediate') return new Uint8Array(192)
          if (mode === 'promise-thenable') return Object.defineProperty({}, 'then', { get() {
            thenGets += 1
            return () => { thenCalls += 1 }
          } })
          if (mode === 'promise-reject') return Promise.reject(new Error('Fixture'))
          // Copy every input before asynchronous WebCrypto/storage work.
          need(typeof text === 'string' && text.length <= 1024 && Object.getPrototypeOf(nativeSealed) === Uint8Array.prototype && nativeSealed.byteLength >= 36 && nativeSealed.byteLength <= LIMIT - 56)
          const metadata = JSON.parse(text), sealed = Uint8Array.prototype.slice.call(nativeSealed)
          need(fields(metadata, ['version', 'ownerId', 'organisationId', 'membershipId', 'devicePublicKey',
            'expectedGeneration', 'generation', 'checkpointSha256']))
          need(metadata.version === 1 && Object.keys(accepted).every((key) => metadata[key] === accepted[key]) &&
            typeof metadata.devicePublicKey === 'string' && typeof metadata.checkpointSha256 === 'string' &&
            HEX.test(metadata.devicePublicKey) && HEX.test(metadata.checkpointSha256) &&
            metadata.expectedGeneration === 0 && metadata.generation === 1 && sealed.length >= 36 && sealed.length <= LIMIT - 56)
          if (mode === 'cas-close') actor.close()
          if (mode === 'free-pending') { actor.free(); freed = true }
          pending = (async () => {
            let wrapped, current
            try {
              const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', sealed))
              need(alive)
              need(hex(hash) === metadata.checkpointSha256)
              if (mode === 'busy') { await gate; need(alive) }
              if (mode === 'store-close') store.close()
              if (mode === 'store-abort') observe.state.abortNext = true
              const before = observe.state.completedWrites
              wrapped = wrap(seed, keyId, sealed)
              const recordScope = { ...accepted, devicePublicKey: metadata.devicePublicKey, kind: 'device-vault' }
              const next = await store.createUniqueDeviceVault(recordScope, { checkpoint: wrapped, pendingSends: [] })
              need(alive)
              need(next === 1 && observe.state.completedWrites > before)
              if (mode === 'owner-revoke') await deleteConfidentialOwner(accepted.ownerId)
              current = await store.readUniqueDeviceVault(context)
              need(alive)
              need(current && current.scope.devicePublicKey === metadata.devicePublicKey && current.generation === 1 &&
                current.state.pendingSends.length === 0 && equal(current.state.checkpoint, wrapped))
              current.state.checkpoint.fill(0)
              publicKey = metadata.devicePublicKey; generation = 1; stage = 'committed'
              if (mode === 'lost-ack') throw new Error('Fixture')
              need(alive)
              let result = acknowledge(accepted, metadata, hash)
              const offsets = { 'ack-magic': 0, 'ack-owner': 4, 'ack-organisation': 40, 'ack-membership': 76,
                'ack-key': 112, 'ack-prior-generation': 144, 'ack-generation': 152, 'ack-digest': 160 }
              if (mode in offsets) result[offsets[mode]] ^= 1
              if (mode === 'ack-short') result = result.slice(0, 191)
              if (mode === 'ack-long') { const extra = new Uint8Array(193); extra.set(result); result = extra }
              return result
            } finally { sealed.fill(0); wrapped?.fill(0); current?.state.checkpoint.fill(0) }
          })()
          pending.catch(() => {})
          return mode === 'promise-proxy' ? new Proxy(pending, {}) : pending
        },
      }
      try {
        await initializeNative()
        need(alive)
        const runtimeMethods = Object.getOwnPropertyNames(BrowserMlsDevice.prototype)
        const allowedMethods = ['constructor', '__destroy_into_raw', 'free', 'createDevice', 'openDevice', 'publicKey', 'registrationRequest', 'close']
        need(runtimeMethods.every((name) => allowedMethods.includes(name)) &&
          allowedMethods.filter((name) => name !== '__destroy_into_raw').every((name) => runtimeMethods.includes(name)))
        store = await (isRestore ? openConfidentialState(accepted.ownerId) : initializeConfidentialState(accepted.ownerId))
        need(alive)
        prior = await store.readUniqueDeviceVault(context)
        need(alive)
        if (mode === 'missing-vault') { need(prior === null); return { status: 'refused', code: 'Context' } }
        if (isRestore) {
          need(prior && prior.generation === 1 && prior.state.pendingSends.length === 0)
          const opened = unwrap(prior.state.checkpoint)
          seed = opened.seed; keyId = opened.keyId
          prior.state.checkpoint.fill(0)
          publicKey = prior.scope.devicePublicKey; generation = prior.generation
          if (mode === 'tamper-native') opened.sealed[opened.sealed.length - 1] ^= 1
          if (mode === 'wrong-seed') seed[0] ^= 1
          actor = new BrowserMlsDevice(host, accepted.ownerId, accepted.organisationId, accepted.membershipId)
          ready = true
          try {
            const outcome = await actor.openDevice(unhex(publicKey), mode === 'wrong-generation' ? Number.MAX_SAFE_INTEGER + 1 : generation,
              opened.sealed, seed)
            need(alive && outcome === undefined && mode === 'restore')
          } catch (error) {
            if (mode === 'restore') throw error
            const code = closed(error); need(code !== 'Fixture')
            return { status: 'refused', code, stage: 'loaded' }
          } finally { opened.sealed.fill(0) }
        } else {
          need(prior === null)
          seed = crypto.getRandomValues(new Uint8Array(32)); keyId = crypto.getRandomValues(new Uint8Array(16))
          if (mode === 'nil-owner' || mode === 'upper-owner') {
            let code
            try { actor = new BrowserMlsDevice(host, mode === 'nil-owner' ? '00000000-0000-0000-0000-000000000000' : 'A' + accepted.ownerId.slice(1), accepted.organisationId, accepted.membershipId) }
            catch (error) { code = closed(error) }
            need(code === 'InvalidInput'); return { status: 'refused', code }
          }
          actor = new BrowserMlsDevice(host, accepted.ownerId, accepted.organisationId, accepted.membershipId)
          ready = true
          let identity = new TextEncoder().encode('public browser device proof'), suppliedSeed = seed
          let sharedSupported = true
          if (mode === 'identity-empty') identity = new Uint8Array()
          if (mode === 'identity-large') identity = new Uint8Array(129)
          if (mode === 'seed-short') suppliedSeed = seed.slice(0, 31)
          if (mode === 'seed-long') { suppliedSeed = new Uint8Array(33); suppliedSeed.set(seed) }
          if (mode === 'identity-proxy') identity = new Proxy(identity, {})
          if (mode === 'identity-subclass') identity = new (class extends Uint8Array {})(1)
          if (mode === 'identity-detached') { const buffer = new ArrayBuffer(1); identity = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] }) }
          if (mode === 'identity-resizable') { const buffer = new ArrayBuffer(1, { maxByteLength: 2 }); need(buffer.resizable); identity = new Uint8Array(buffer) }
          if (mode === 'identity-shared') { sharedSupported = typeof SharedArrayBuffer !== 'undefined'; need(sharedSupported); identity = new Uint8Array(new SharedArrayBuffer(1)) }
          let code
          try {
            const operation = actor.createDevice(identity, suppliedSeed, mode !== 'consent')
            if (mode === 'busy') {
              await entered
              let busy
              try { actor.publicKey() } catch (error) { busy = closed(error) }
              need(busy === 'Busy'); release()
            }
            need(await operation === undefined)
            need(alive)
          } catch (error) { code = closed(error) }
          if (suppliedSeed !== seed) suppliedSeed.fill(0)
          if (mode === 'free-pending') {
            need(freed && ['Closed', 'Storage'].includes(code))
            if (pending) await pending.catch(() => {})
            return { status: 'refused', code, stage }
          }
          if (!['create', 'busy'].includes(mode)) {
            need(code && code !== 'Fixture')
            if (['current-false', 'current-throw', 'current-nonboolean'].includes(mode))
              need(host.checkCurrent(JSON.stringify({ version: 1, ...accepted, devicePublicKey: null, generation: 0, admittedDeviceId: null })) === true)
            let unpublished
            try { actor.publicKey() } catch (error) { unpublished = closed(error) }
            need(['RestoreRequired', 'Closed', 'InvalidInput'].includes(unpublished))
            if (pending) await pending.catch(() => {})
            need(thenGets === 0 && thenCalls === 0)
            return { status: 'refused', code, unpublished, committedPublicKey: publicKey, stage,
              completedWrites: observe.state.completedWrites, abortedWrites: observe.state.abortedWrites }
          }
          need(code === undefined)
        }
        const first = actor.publicKey(), second = actor.publicKey(), registration = actor.registrationRequest()
        need(Object.getPrototypeOf(first) === Uint8Array.prototype && first.length === 32 && first.buffer !== second.buffer &&
          Object.getPrototypeOf(registration) === Uint8Array.prototype && registration.length <= 1024 && equal(first, second))
        const expected = second.slice(); first[0] ^= 1
        need(equal(actor.publicKey(), expected))
        return { status: 'ready', publicKey: hex(expected), registration: Array.from(registration),
          strictWrites: observe.state.strictWrites, completedWrites: observe.state.completedWrites }
      } finally {
        // Unknown writes may commit; never revive this actor. A later worker must read.
        release()
        if (pending) await pending.catch(() => {})
        retire(); if (!freed && actor) { actor.free(); freed = true }; actor = undefined
        seed?.fill(0); keyId?.fill(0); prior?.state.checkpoint.fill(0); observe.restore()
      }
    },
  })
}
