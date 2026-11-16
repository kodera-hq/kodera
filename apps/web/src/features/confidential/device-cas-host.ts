// Application-private worker wiring, not a facade capability or HTTP authority.
// Only the fixed worker owns the store and immutable per-operation lifetime closure.
import {
  ConfidentialStateError, ConfidentialStateStore, LOCAL_STATE_LIMITS,
  type ConfidentialScope, type OpaqueLocalState, type UniqueDeviceVault,
} from './local-state'
import {
  decodeDeviceHttpRecord, encodeDeviceHttpAck, validateDeviceHttpBinding,
  type DeviceHttpAck, type DeviceHttpRecord, type DeviceHttpScope,
} from './device-http-record'

interface AcceptedContext { readonly ownerId: string; readonly organisationId: string; readonly membershipId: string }
// Deliberately not exported as a caller-supplied CurrentTicket or facade option.
type CaptureCurrent = () => (() => boolean) | undefined
type Failure = 'invalid-input' | 'corrupt' | 'conflict' | 'storage' | 'closed' | 'context-changed' | 'busy'
export class DeviceCasHostError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = 'DeviceCasHostError' }
}
const READ = ConfidentialStateStore.prototype.readUniqueDeviceVault
const CAS = ConfidentialStateStore.prototype.compareAndSwap
const CLOSE = ConfidentialStateStore.prototype.close
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object
const viewBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const viewOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!
const viewLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const META_KEYS = ['devicePublicKey', 'expectedHostGeneration', 'expectedNativeGeneration', 'membershipId',
  'nextHostGeneration', 'nextNativeGeneration', 'organisationId', 'ownerId', 'recordId', 'recordSha256', 'sealedSha256', 'version'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function fail(code: Failure): never { throw new DeviceCasHostError(code) }
function require(condition: unknown, code: Failure = 'invalid-input'): asserts condition { if (!condition) fail(code) }
function id(value: unknown): asserts value is string {
  require(typeof value === 'string' && value.length === 36 && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000')
}
function capture(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  require(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
  const buffer: unknown = Reflect.apply(viewBuffer, value, [])
  const offset: number = Reflect.apply(viewOffset, value, [])
  const length: number = Reflect.apply(viewLength, value, [])
  require(buffer instanceof ArrayBuffer && (!resizable || Reflect.apply(resizable, buffer, []) === false) && length >= minimum && length <= maximum)
  const result = new Uint8Array(length); result.set(new Uint8Array(buffer, offset, length)); return result
}
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]) }
function magic(value: Uint8Array, at: number, text: string): boolean {
  return Array.from(text, (c) => c.charCodeAt(0)).every((v, i) => value[at + i] === v)
}
async function hash(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (v) => v.toString(16).padStart(2, '0')).join('')
}
function clear(value: OpaqueLocalState | undefined): void {
  value?.checkpoint.fill(0); for (const item of value?.pendingSends ?? []) item.ciphertext.fill(0)
}
function sealedPart(checkpoint: Uint8Array): Uint8Array<ArrayBuffer> {
  require(checkpoint.buffer instanceof ArrayBuffer && checkpoint.length >= 92 && checkpoint.length <= LOCAL_STATE_LIMITS.checkpointBytes && magic(checkpoint, 0, 'KWE1'), 'corrupt')
  const length = new DataView(checkpoint.buffer, checkpoint.byteOffset, checkpoint.byteLength).getUint32(52)
  require(length >= 36 && length === checkpoint.length - 56 && magic(checkpoint, 56, 'KDV1'), 'corrupt')
  return new Uint8Array(checkpoint.buffer, checkpoint.byteOffset + 56, length)
}
function metadata(text: unknown, accepted: AcceptedContext): DeviceHttpAck {
  require(typeof text === 'string' && text.length > 0 && text.length <= 2048)
  for (let i = 0; i < text.length; i++) require(text.charCodeAt(i) >= 32 && text.charCodeAt(i) <= 126)
  const parsed: unknown = JSON.parse(text)
  require(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  const p = parsed as Record<string, unknown>, keys = Object.keys(p)
  require(keys.length === META_KEYS.length && keys.every((key) => (META_KEYS as readonly string[]).includes(key)))
  require(JSON.stringify(Object.fromEntries(META_KEYS.map((key) => [key, p[key]]))) === text)
  require(p.version === 2 && p.ownerId === accepted.ownerId && p.organisationId === accepted.organisationId && p.membershipId === accepted.membershipId)
  // The shared ACK codec validates every UUID, digest and safe N/G transition.
  const result = { scope: [p.ownerId, p.organisationId, p.membershipId, p.devicePublicKey], recordId: p.recordId,
    expectedNativeGeneration: p.expectedNativeGeneration, nextNativeGeneration: p.nextNativeGeneration,
    expectedHostGeneration: p.expectedHostGeneration, nextHostGeneration: p.nextHostGeneration,
    sealedSha256: p.sealedSha256, recordSha256: p.recordSha256 } as DeviceHttpAck
  encodeDeviceHttpAck(result)
  return Object.freeze({ ...result, scope: Object.freeze([...result.scope]) as DeviceHttpScope })
}
function matchesScope(vault: UniqueDeviceVault, expected: DeviceHttpScope): boolean {
  return vault.scope.kind === 'device-vault' && vault.scope.ownerId === expected[0] && vault.scope.organisationId === expected[1] &&
    vault.scope.membershipId === expected[2] && vault.scope.devicePublicKey === expected[3]
}

/** Internal fixed-worker composition only. No public factory/options may expose its callback. */
export function createDeviceCasHost(store: ConfidentialStateStore, accepted: AcceptedContext, captureCurrent: CaptureCurrent) {
  require(store instanceof ConfidentialStateStore && typeof captureCurrent === 'function')
  require(accepted !== null && typeof accepted === 'object' && Object.getPrototypeOf(accepted) === Object.prototype)
  const descriptors = Object.getOwnPropertyDescriptors(accepted)
  require(Reflect.ownKeys(descriptors).length === 3 && ['ownerId', 'organisationId', 'membershipId'].every((key) => descriptors[key] && 'value' in descriptors[key]!))
  const { ownerId, organisationId, membershipId } = accepted
  id(ownerId); id(organisationId); id(membershipId)
  const context = Object.freeze({ ownerId, organisationId, membershipId })
  const captureOperation = captureCurrent
  let closed = false, busy = false
  const close = () => { if (!closed) { closed = true; Reflect.apply(CLOSE, store, []) } }
  const compareAndSwapDeviceV2 = async (metadataJson: string, sealedKdv1: Uint8Array, kdh1: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
    if (closed) fail('closed')
    if (busy) fail('busy')
    busy = true
    let sealed: Uint8Array<ArrayBuffer> | undefined, manifest: Uint8Array<ArrayBuffer> | undefined
    let prior: UniqueDeviceVault | null | undefined, reread: UniqueDeviceVault | null | undefined
    let successor: OpaqueLocalState | undefined
    try {
      const current = captureOperation()
      require(!closed && typeof current === 'function', 'context-changed')
      const fence = () => {
        require(!closed, 'closed')
        let valid = false
        try { valid = current() === true } catch { /* Only a strict successful private predicate is live. */ }
        require(!closed, 'closed'); require(valid, 'context-changed')
      }
      fence()
      // All caller bytes and the expected full tuple are owned before the first await.
      const expected = metadata(metadataJson, context), acknowledgement = encodeDeviceHttpAck(expected)
      sealed = capture(sealedKdv1, 36, LOCAL_STATE_LIMITS.checkpointBytes - 56)
      manifest = capture(kdh1, 8, 65_536)
      require(magic(sealed, 0, 'KDV1'))
      fence()
      const parsing = decodeDeviceHttpRecord(manifest); fence()
      const record = await parsing; fence()
      validateDeviceHttpBinding(record, { scope: expected.scope, nativeGeneration: expected.nextNativeGeneration,
        hostGeneration: expected.nextHostGeneration, sealedSha256: expected.sealedSha256 })
      require(record.recordId === expected.recordId)
      const sealedHashing = hash(sealed); fence()
      const sealedHash = await sealedHashing; fence(); require(sealedHash === expected.sealedSha256)
      const manifestHashing = hash(manifest); fence()
      const manifestHash = await manifestHashing; fence(); require(manifestHash === expected.recordSha256)
      const reading = Reflect.apply(READ, store, [context]) as Promise<UniqueDeviceVault | null>; fence()
      prior = await reading; fence()
      require(prior !== null && matchesScope(prior, expected.scope) && prior.generation === expected.expectedHostGeneration, 'conflict')
      const previousSealed = sealedPart(prior.state.checkpoint)
      let previous: DeviceHttpRecord | null = null
      if (prior.state.pendingSends.length === 0) {
        // Native admitted=None at this sole legacy boundary is authenticated by the actor.
        require(prior.generation === 1 && expected.expectedNativeGeneration === 1 && expected.nextNativeGeneration === 1 &&
          record.admission === null && record.publication === null && record.pending?.operation === 'register' && record.pending.phase === 'prepared', 'corrupt')
      } else {
        require(prior.state.pendingSends.length === 1, 'corrupt')
        const item = prior.state.pendingSends[0]!
        const decoding = decodeDeviceHttpRecord(item.ciphertext); fence()
        previous = await decoding; fence()
        require(item.id === previous.recordId && previous.recordId === record.recordId, 'corrupt')
        const previousHashing = hash(previousSealed); fence()
        const previousHash = await previousHashing; fence()
        validateDeviceHttpBinding(previous, { scope: expected.scope, nativeGeneration: expected.expectedNativeGeneration,
          hostGeneration: prior.generation, sealedSha256: previousHash })
      }
      // Outer-only writes cannot replace even a same-generation native ciphertext.
      if (expected.expectedNativeGeneration === expected.nextNativeGeneration) require(equal(previousSealed, sealed), 'corrupt')
      const checkpoint = new Uint8Array(56 + sealed.length)
      checkpoint.set(prior.state.checkpoint.subarray(0, 52)); new DataView(checkpoint.buffer).setUint32(52, sealed.length); checkpoint.set(sealed, 56)
      successor = { checkpoint, pendingSends: [{ id: record.recordId, ciphertext: manifest }] }
      const scope: ConfidentialScope = { ...context, devicePublicKey: expected.scope[3], kind: 'device-vault' }
      fence()
      const committing = Reflect.apply(CAS, store, [[{ scope, expectedGeneration: expected.expectedHostGeneration, state: successor }]]) as Promise<number[]>; fence()
      const generations = await committing; fence()
      require(generations.length === 1 && generations[0] === expected.nextHostGeneration, 'storage')
      // CAS resolves only after strict oncomplete; now independently reread the unique current record.
      const verifying = Reflect.apply(READ, store, [context]) as Promise<UniqueDeviceVault | null>; fence()
      reread = await verifying; fence()
      require(reread !== null && matchesScope(reread, expected.scope) && reread.generation === expected.nextHostGeneration &&
        equal(reread.state.checkpoint, checkpoint) && reread.state.pendingSends.length === 1 &&
        reread.state.pendingSends[0]!.id === record.recordId && equal(reread.state.pendingSends[0]!.ciphertext, manifest), 'conflict')
      fence()
      return acknowledgement
    } catch (error) {
      close()
      if (error instanceof DeviceCasHostError) throw error
      if (error instanceof ConfidentialStateError) {
        throw new DeviceCasHostError(error.code === 'conflict' ? 'conflict' : error.code === 'corrupt' ? 'corrupt' : 'storage')
      }
      throw new DeviceCasHostError('invalid-input')
    } finally {
      sealed?.fill(0); manifest?.fill(0); clear(prior?.state); clear(reread?.state); clear(successor); busy = false
    }
  }
  return Object.freeze({ compareAndSwapDeviceV2, close })
}
