// Opaque storage recovery only. Framing never authenticates inner native state.
import {
  ConfidentialStateError,
  ConfidentialStateStore,
  LOCAL_STATE_LIMITS,
  type ConfidentialScope,
  type OpaqueLocalState,
} from './local-state'

export interface AcceptedStoredContext {
  readonly ownerId: string
  readonly organisationId: string
  readonly membershipId: string
}
export interface CurrentContextTicket { checkCurrent(): boolean }
export type OpaqueHostFailure = 'closed' | 'context-changed' | 'corrupt' | 'capacity' |
  'invalid-input' | 'not-initialized' | 'owner-revoked' | 'storage' | 'unavailable'
export class OpaqueHostError extends Error {
  constructor(readonly code: OpaqueHostFailure) { super(code); this.name = 'OpaqueHostError' }
}
export interface OpaqueDeviceDescription extends AcceptedStoredContext {
  readonly devicePublicKey: string
  readonly generation: number
  readonly native: 'unavailable'
  readonly innerAuthentication: 'not-performed'
}
export interface OpaqueRoomDescription {
  readonly roomId: string
  readonly generation: number
  readonly format: 'initial' | 'durable'
  readonly native: 'unavailable'
  readonly innerAuthentication: 'not-performed'
}
export interface OpaqueStoredRoom { describe(): OpaqueRoomDescription; close(): void }
export interface OpaqueStoredDevice {
  describe(): OpaqueDeviceDescription
  openStoredRoom(roomId: string): Promise<OpaqueStoredRoom | null>
  close(): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NIL = '00000000-0000-0000-0000-000000000000'
const KEY = /^[0-9a-f]{64}$/
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const MAX_INITIAL = 14 * 1024 * 1024
const MAX_RETAINED = 36 * 1024 * 1024
const UNAVAILABLE = { native: 'unavailable', innerAuthentication: 'not-performed' } as const
// Use the imported implementation, not caller-injected per-instance methods.
const READ_VAULT = ConfidentialStateStore.prototype.readUniqueDeviceVault
const READ_ROOM = ConfidentialStateStore.prototype.read
const CLOSE_STORE = ConfidentialStateStore.prototype.close
function fail(code: OpaqueHostFailure): never { throw new OpaqueHostError(code) }
function safe(error: unknown): OpaqueHostError {
  if (error instanceof OpaqueHostError) return error
  if (error instanceof ConfidentialStateError) {
    return new OpaqueHostError(error.code === 'conflict' ? 'storage' : error.code)
  }
  return new OpaqueHostError('storage')
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value) || value === NIL) fail('invalid-input')
}
function generation(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('corrupt')
}
function context(value: AcceptedStoredContext): AcceptedStoredContext {
  try {
    const { ownerId, organisationId, membershipId } = value
    id(ownerId); id(organisationId); id(membershipId)
    return Object.freeze({ ownerId, organisationId, membershipId })
  } catch { throw new OpaqueHostError('invalid-input') }
}
function ticket(value: CurrentContextTicket): () => boolean {
  try {
    const check = value.checkCurrent
    if (typeof check !== 'function') fail('context-changed')
    return () => { try { return Reflect.apply(check, value, []) === true } catch { return false } }
  } catch { throw new OpaqueHostError('context-changed') }
}
function bytes(value: unknown, maximum: number, minimum = 0): asserts value is Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) ||
      value.byteLength < minimum || value.byteLength > maximum) fail('corrupt')
}
function magic(value: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every((letter, index) => value[offset + index] === letter.charCodeAt(0))
}
function clear(state: OpaqueLocalState | undefined): void {
  state?.checkpoint.fill(0)
  for (const item of state?.pendingSends ?? []) item.ciphertext.fill(0)
}
interface PrivateDevice { id: Uint8Array<ArrayBuffer>; seed: Uint8Array<ArrayBuffer>; sealed: Uint8Array<ArrayBuffer> }
function clearDevice(value: PrivateDevice | undefined): void {
  value?.id.fill(0); value?.seed.fill(0); value?.sealed.fill(0)
}
function deviceFrame(state: OpaqueLocalState): PrivateDevice {
  const source = state.checkpoint
  bytes(source, LOCAL_STATE_LIMITS.checkpointBytes, 92)
  if (!Array.isArray(state.pendingSends) || state.pendingSends.length !== 0 || !magic(source, 0, 'KWE1')) fail('corrupt')
  const length = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(52)
  if (length < 36 || length > LOCAL_STATE_LIMITS.checkpointBytes - 56 ||
      length !== source.byteLength - 56 || !magic(source, 56, 'KDV1')) fail('corrupt')
  const owned: Uint8Array<ArrayBuffer>[] = []
  try {
    // Ordinary/resizable inputs are synchronously snapshotted into fixed private buffers.
    const identifier = new Uint8Array(source.subarray(4, 20)); owned.push(identifier)
    const seed = new Uint8Array(source.subarray(20, 52)); owned.push(seed)
    const sealed = new Uint8Array(source.subarray(56)); owned.push(sealed)
    return { id: identifier, seed, sealed }
  } catch { for (const value of owned) value.fill(0); throw new OpaqueHostError('storage') }
}
function safeU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset)
  if (value > BigInt(MAX_SAFE)) fail('corrupt')
  return Number(value)
}
function initialFrame(source: Uint8Array<ArrayBuffer>): void {
  bytes(source, MAX_INITIAL + 73, 109)
  if (!magic(source, 0, 'KRI1')) fail('corrupt')
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const epoch = safeU64(view, 5), sequence = safeU64(view, 13), length = view.getUint32(69)
  if (length < 36 || length > MAX_INITIAL || length !== source.byteLength - 73 || !magic(source, 73, 'KMS1')) fail('corrupt')
  const envelope = source.subarray(21, 37), digest = source.subarray(37, 69)
  if (source[4] === 0) {
    if (epoch !== 0 || sequence !== 0 || envelope.some((value) => value !== 0) || digest.some((value) => value !== 0)) fail('corrupt')
  } else if (source[4] === 1) {
    const hex = [...envelope].map((value) => value.toString(16).padStart(2, '0')).join('')
    const canonical = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    if (epoch === 0 || sequence === 0 || canonical === NIL || !UUID.test(canonical) ||
        canonical.replaceAll('-', '') !== hex) fail('corrupt')
  } else fail('corrupt')
}
interface PrivateRoom extends OpaqueLocalState {
  pendingSends: { id: string; ciphertext: Uint8Array<ArrayBuffer> }[]
  format: 'initial' | 'durable'
  retained: number
}
function roomFrame(state: OpaqueLocalState, current: number): PrivateRoom {
  generation(current)
  const source = state.checkpoint
  bytes(source, LOCAL_STATE_LIMITS.checkpointBytes)
  if (!Array.isArray(state.pendingSends) || state.pendingSends.length > LOCAL_STATE_LIMITS.pendingCount) fail('corrupt')
  if (current === 1) {
    if (state.pendingSends.length !== 0) fail('corrupt')
    initialFrame(source)
  } else if (source.byteLength < 33 || !magic(source, 0, 'KDR1')) fail('corrupt')
  const seen = new Set<string>()
  let total = 0
  for (const pending of state.pendingSends) {
    try { id(pending.id) } catch { throw new OpaqueHostError('corrupt') }
    bytes(pending.ciphertext, LOCAL_STATE_LIMITS.pendingItemBytes)
    total += pending.ciphertext.byteLength
    if (seen.has(pending.id) || total > LOCAL_STATE_LIMITS.pendingBytes) fail('corrupt')
    seen.add(pending.id)
  }
  const result: PrivateRoom = { checkpoint: new Uint8Array(source), pendingSends: [],
    format: current === 1 ? 'initial' : 'durable', retained: source.byteLength + total }
  try {
    for (const value of state.pendingSends) result.pendingSends.push({ id: value.id, ciphertext: new Uint8Array(value.ciphertext) })
    return result
  } catch { clear(result); throw new OpaqueHostError('storage') }
}

function closeStore(store: ConfidentialStateStore): void {
  try { CLOSE_STORE.call(store) } catch { /* No raw exception or foreign connection is exposed. */ }
}
class StoredRoom implements OpaqueStoredRoom {
  #state: PrivateRoom | undefined
  readonly #description: OpaqueRoomDescription
  readonly #current: () => void
  readonly #release: () => void
  constructor(state: PrivateRoom, roomId: string, currentGeneration: number, current: () => void, release: () => void) {
    this.#state = state; this.#current = current; this.#release = release
    this.#description = Object.freeze({ roomId, generation: currentGeneration, format: state.format, ...UNAVAILABLE })
  }
  describe(): OpaqueRoomDescription {
    if (this.#state === undefined) fail('closed')
    this.#current()
    if (this.#state === undefined) fail('closed')
    return this.#description
  }
  close(): void {
    if (this.#state === undefined) return
    const owned = this.#state; this.#state = undefined
    clear(owned); this.#release()
  }
}
class StoredDevice implements OpaqueStoredDevice {
  readonly #store: ConfidentialStateStore
  readonly #current: () => boolean
  readonly #scope: Extract<ConfidentialScope, { kind: 'device-vault' }>
  readonly #description: OpaqueDeviceDescription
  readonly #retained: number
  #device: PrivateDevice | undefined
  #room: StoredRoom | undefined
  #opening = false
  #failure: OpaqueHostFailure | undefined
  constructor(store: ConfidentialStateStore, current: () => boolean,
    scope: Extract<ConfidentialScope, { kind: 'device-vault' }>, currentGeneration: number, device: PrivateDevice) {
    this.#store = store; this.#current = current; this.#scope = Object.freeze({ ...scope }); this.#device = device
    this.#retained = device.id.byteLength + device.seed.byteLength + device.sealed.byteLength
    this.#description = Object.freeze({ ownerId: scope.ownerId, organisationId: scope.organisationId,
      membershipId: scope.membershipId, devicePublicKey: scope.devicePublicKey, generation: currentGeneration, ...UNAVAILABLE })
  }
  #stop(code: OpaqueHostFailure): void {
    this.#failure ??= code
    const room = this.#room; this.#room = undefined; room?.close()
    clearDevice(this.#device); this.#device = undefined
    closeStore(this.#store)
  }
  #assertCurrent = (): void => {
    if (this.#failure !== undefined) fail(this.#failure)
    const current = this.#current()
    if (this.#failure !== undefined) fail(this.#failure)
    if (!current) { this.#stop('context-changed'); fail('context-changed') }
  }
  describe(): OpaqueDeviceDescription { this.#assertCurrent(); return this.#description }
  async openStoredRoom(roomId: string): Promise<OpaqueStoredRoom | null> {
    this.#assertCurrent()
    id(roomId)
    const capturedRoom = roomId
    if (this.#opening || this.#room !== undefined) fail('capacity')
    this.#opening = true
    let snapshot: OpaqueLocalState | undefined, owned: PrivateRoom | undefined
    try {
      const value = await READ_ROOM.call(this.#store, { ...this.#scope, kind: 'room', roomId: capturedRoom })
      snapshot = value ?? undefined
      this.#assertCurrent()
      if (value === null) return null
      owned = roomFrame(value, value.generation)
      if (this.#retained + owned.retained > MAX_RETAINED) fail('capacity')
      this.#assertCurrent()
      const room = new StoredRoom(owned, capturedRoom, value.generation, this.#assertCurrent,
        () => { if (this.#room === room) this.#room = undefined })
      this.#room = room; owned = undefined
      return room
    } catch (error) {
      const refusal = safe(error); this.#stop(refusal.code); throw refusal
    } finally { this.#opening = false; clear(snapshot); clear(owned) }
  }
  close(): void { this.#stop('closed') }
}

/** Consumes a dedicated already-open connection, including on empty/refused reads.
 * The caller must not transfer a shared connection. Database bootstrap is outside
 * this read-only boundary; no store initialization or native operation occurs here.
 */
export async function openStoredContext(ownedStore: ConfidentialStateStore,
  acceptedContext: AcceptedStoredContext, currentTicket: CurrentContextTicket): Promise<OpaqueStoredDevice | null> {
  if (!(ownedStore instanceof ConfidentialStateStore)) fail('invalid-input')
  let snapshot: OpaqueLocalState | undefined, owned: PrivateDevice | undefined
  try {
    const accepted = context(acceptedContext), current = ticket(currentTicket)
    if (!current()) fail('context-changed')
    const value = await READ_VAULT.call(ownedStore, accepted)
    snapshot = value?.state
    if (!current()) fail('context-changed')
    if (value === null) { closeStore(ownedStore); return null }
    const scope = value.scope
    if (scope.kind !== 'device-vault' || scope.roomId !== undefined || scope.ownerId !== accepted.ownerId ||
        scope.organisationId !== accepted.organisationId || scope.membershipId !== accepted.membershipId ||
        typeof scope.devicePublicKey !== 'string' || !KEY.test(scope.devicePublicKey)) fail('corrupt')
    generation(value.generation)
    owned = deviceFrame(value.state)
    if (!current()) fail('context-changed')
    const result = new StoredDevice(ownedStore, current, scope, value.generation, owned)
    owned = undefined
    return result
  } catch (error) {
    closeStore(ownedStore); clearDevice(owned)
    throw safe(error)
  } finally { clear(snapshot) }
}
