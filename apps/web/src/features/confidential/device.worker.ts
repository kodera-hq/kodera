// Fixed dedicated-worker composition. Never import this entry from application code.
import initializeNative, { BrowserMlsHttpDevice } from './native/kodera_rs.js'
import nativeWasmUrl from './native/kodera_rs_bg.wasm?url'
import {
  ConfidentialStateError, initializeConfidentialState, openConfidentialState,
  LOCAL_STATE_LIMITS, type ConfidentialStateStore, type UniqueDeviceVault,
} from './local-state'
import { createDeviceCasHost, DeviceCasHostError } from './device-cas-host'
import {
  decodeDeviceHttpRecord, validateDeviceHttpBinding, verifyDeviceHttpAck,
  type DeviceHttpRecord, type DeviceHttpAck,
} from './device-http-record'
import {
  parseDeviceBootstrap, parseDeviceCommand, parseDeviceStatus,
  deviceWorkerNeed as need, deviceWorkerObject as object, deviceWorkerJson as json,
  deviceWorkerInteger as integer, deviceWorkerId as id, deviceWorkerBytes as bytes,
  DeviceWorkerProtocolError, type DeviceCommand, type DeviceStatus, type DeviceWorkerCode,
} from './device-worker-protocol'

// An accidental main-document import cannot install a bootstrap listener.
need(!Reflect.has(self, 'document'))

interface Context { readonly ownerId: string; readonly organisationId: string; readonly membershipId: string }
interface Rpc {
  readonly token: Readonly<{ id: number; deadline: number }>
  frames: number; active: boolean; retiredWire: boolean; wireCell?: string; timer: ReturnType<typeof setTimeout>
}
interface NativeOperation { readonly rpc: Rpc; readonly actorOperation: number }
interface Tuple {
  readonly key: string | null; readonly n: number; readonly g: number
  readonly record: DeviceHttpRecord | null; readonly frameSha: string | null
}
interface Waiting {
  readonly rpc: Rpc; readonly kind: string; readonly cellId?: string
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: unknown) => void
}
interface Attempt {
  readonly wrapper: object; readonly operation: NativeOperation; readonly cellId: string
  readonly info: string; readonly descriptor: Record<string, unknown>; readonly body: Uint8Array<ArrayBuffer>
}
class Refusal extends Error {
  constructor(readonly code: DeviceWorkerCode) { super(code); this.name = 'DeviceWorkerRefusal' }
}
const now = performance.now.bind(performance)
const encoder = new TextEncoder()
const HEX = /^[0-9a-f]{64}$/
const CONTEXT_KEYS = ['version', 'profile', 'actorOperation', 'ownerId', 'organisationId', 'membershipId',
  'devicePublicKey', 'nativeGeneration', 'hostGeneration', 'recordId', 'recordSha256', 'admittedDeviceId']
const DESCRIPTOR_KEYS = ['version', 'actorOperation', 'recordId', 'operation', 'operationId', 'ownerId',
  'organisationId', 'membershipId', 'devicePublicKey', 'nativeGeneration', 'hostGeneration', 'bodySha256', 'recordSha256']
const ACK_KEYS = ['version', 'ownerId', 'organisationId', 'membershipId', 'devicePublicKey', 'recordId',
  'expectedNativeGeneration', 'nextNativeGeneration', 'expectedHostGeneration', 'nextHostGeneration', 'sealedSha256', 'recordSha256']
let alive = true, booted = false, loaded = false, lastRpc = 0, nativeCounter = 0, lastTime = 0
let nonce = '', control: MessagePort | undefined, transport: MessagePort | undefined
let rpc: Rpc | undefined, nativeOperation: NativeOperation | undefined, waiting: Waiting | undefined
let context: Readonly<Context> | undefined, store: ConfidentialStateStore | undefined
let actor: BrowserMlsHttpDevice | undefined, durableHost: ReturnType<typeof createDeviceCasHost> | undefined
let header: Uint8Array<ArrayBuffer> | undefined
let tuple: Tuple = Object.freeze({ key: null, n: 0, g: 0, record: null, frameSha: null })
const attempts = new WeakMap<object, Attempt>(), retainedAttempts = new Set<Attempt>()
const temporaries = new Set<Uint8Array<ArrayBuffer>>()
let startupTimer: ReturnType<typeof setTimeout> | undefined

function fail(code: DeviceWorkerCode): never { throw new Refusal(code) }
function time(): number {
  const value = now()
  if (!Number.isFinite(value) || value < lastTime || value < 0 || value > Number.MAX_SAFE_INTEGER) fail('ineligible')
  lastTime = value; return value
}
function fence(current: Rpc): void {
  if (!alive || !current.active || rpc !== current) fail('closed')
  if (time() > current.token.deadline) fail('closed')
}
function nativeFence(current: NativeOperation): void {
  fence(current.rpc)
  if (nativeOperation !== current) fail('restore-required')
}
function frame(current: Rpc): void { fence(current); if (++current.frames > 64) fail('invalid-input') }
function sendControl(current: Rpc, fields: Record<string, unknown>): void {
  frame(current); need(control)
  control.postMessage({ version: 1, nonce, rpcId: current.token.id, ...fields })
}
function retireWire(current: Rpc): void {
  // Retire before erasing local correlation; this grants no new dispatch permission.
  if (!current.retiredWire && alive && current.active && transport && current.frames < 64) {
    current.retiredWire = true
    current.frames += 1
    transport.postMessage({ version: 1, nonce, rpcId: current.token.id, kind: 'retire-rpc' })
  }
}
function retire(current: Rpc): void {
  retireWire(current)
  current.active = false; clearTimeout(current.timer)
  if (waiting?.rpc === current) { const pending = waiting; waiting = undefined; pending.reject(new Refusal('closed')) }
  for (const entry of retainedAttempts) { attempts.delete(entry.wrapper); entry.body.fill(0) }
  retainedAttempts.clear()
  for (const item of temporaries) item.fill(0)
  temporaries.clear()
  if (rpc === current) rpc = undefined
  nativeOperation = undefined
}
function shutdown(code: DeviceWorkerCode = 'closed', publish = true): void {
  if (!alive) return
  const current = rpc
  if (current) retireWire(current)
  if (publish && current?.active && control && current.frames < 64) {
    try { control.postMessage({ version: 1, nonce, rpcId: current.token.id, kind: 'refused', code }) } catch { /* Closing is final. */ }
  }
  if (current) retire(current)
  alive = false
  if (startupTimer !== undefined) clearTimeout(startupTimer)
  try { actor?.close(); actor?.free() } catch { /* No raw error crosses the port. */ }
  try { durableHost?.close(); store?.close() } catch { /* Already quarantined. */ }
  header?.fill(0); header = undefined; actor = undefined; store = undefined; durableHost = undefined
  context = undefined; tuple = Object.freeze({ key: null, n: 0, g: 0, record: null, frameSha: null })
  control?.close(); transport?.close()
  self.removeEventListener('message', bootstrap)
  self.close()
}
function code(error: unknown): DeviceWorkerCode {
  if (error instanceof Refusal) return error.code
  if (error instanceof ConfidentialStateError || error instanceof DeviceCasHostError) return 'storage'
  if (error instanceof DeviceWorkerProtocolError) return 'invalid-input'
  if (typeof error === 'string') {
    const codes: Record<string, DeviceWorkerCode> = { InvalidInput: 'invalid-input', Busy: 'busy', Closed: 'closed',
      RestoreRequired: 'restore-required', Context: 'ineligible', Storage: 'storage', Crypto: 'restore-required', Capacity: 'storage' }
    return codes[error] ?? 'invalid-response'
  }
  return 'invalid-response'
}
function hex(value: Uint8Array): string { return Array.from(value, (x) => x.toString(16).padStart(2, '0')).join('') }
function raw(value: string): Uint8Array<ArrayBuffer> {
  need(HEX.test(value)); const result = new Uint8Array(32)
  for (let i = 0; i < 32; i++) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return result
}
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]) }
async function hash(value: Uint8Array<ArrayBuffer>, current: Rpc): Promise<string> {
  fence(current); const result = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value))); fence(current); return result
}
function scoped(value: Record<string, unknown>): void {
  need(context && value.ownerId === context.ownerId && value.organisationId === context.organisationId && value.membershipId === context.membershipId)
}
function scope(key: string) { need(context); return { ...context, devicePublicKey: key, kind: 'device-vault' as const } }
function clearVault(value: UniqueDeviceVault | null | undefined): void {
  value?.state.checkpoint.fill(0); for (const item of value?.state.pendingSends ?? []) item.ciphertext.fill(0)
}
function wrap(sealed: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  need(header && header.length === 52 && sealed.length >= 36 && sealed.length <= LOCAL_STATE_LIMITS.checkpointBytes - 56 &&
    String.fromCharCode(...sealed.subarray(0, 4)) === 'KDV1')
  const result = new Uint8Array(56 + sealed.length); result.set(header); new DataView(result.buffer).setUint32(52, sealed.length); result.set(sealed, 56)
  return result
}
function checkpoint(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = bytes(value, 92, LOCAL_STATE_LIMITS.checkpointBytes)
  try {
    need(String.fromCharCode(...copy.subarray(0, 4)) === 'KWE1' && String.fromCharCode(...copy.subarray(56, 60)) === 'KDV1' &&
      new DataView(copy.buffer).getUint32(52) === copy.length - 56)
    return copy
  } catch (error) { copy.fill(0); throw error }
}
async function read(current: Rpc): Promise<UniqueDeviceVault | null> {
  need(store && context); fence(current)
  const value = await store.readUniqueDeviceVault(context)
  try { fence(current); return value } catch (error) { clearVault(value); throw error }
}
async function install(value: UniqueDeviceVault, current: Rpc, expected?: Uint8Array<ArrayBuffer>): Promise<void> {
  const sealed = checkpoint(value.state.checkpoint)
  try {
    need(context && value.scope.ownerId === context.ownerId && value.scope.organisationId === context.organisationId &&
      value.scope.membershipId === context.membershipId && value.scope.kind === 'device-vault' && HEX.test(value.scope.devicePublicKey))
    integer(value.generation); need(value.state.pendingSends.length <= 1)
    if (expected) need(equal(sealed, expected))
    const payload = new Uint8Array(sealed.subarray(56))
    let sealedSha: string
    try { sealedSha = await hash(payload, current) } finally { payload.fill(0) }
    const item = value.state.pendingSends[0]
    let record: DeviceHttpRecord | null = null, frameSha: string | null = null
    if (item) {
      const frameCopy = bytes(item.ciphertext, 8, 65536)
      try {
        record = await decodeDeviceHttpRecord(frameCopy); fence(current)
        frameSha = await hash(frameCopy, current); need(item.id === record.recordId)
        validateDeviceHttpBinding(record, { scope: [context.ownerId, context.organisationId, context.membershipId, value.scope.devicePublicKey],
          nativeGeneration: record.nativeGeneration, hostGeneration: value.generation, sealedSha256: sealedSha })
      } finally { frameCopy.fill(0) }
    } else need(value.generation === 1)
    fence(current)
    header?.fill(0); header = new Uint8Array(sealed.subarray(0, 52))
    tuple = Object.freeze({ key: value.scope.devicePublicKey, n: record?.nativeGeneration ?? 1,
      g: value.generation, record, frameSha })
  } finally { sealed.fill(0) }
}
function principal(value: unknown): Readonly<Context> {
  const p = object(value, ['ownerId', 'identityId', 'organisationId', 'membershipId', 'issuer', 'subject', 'organisationSlug'])
  for (const key of ['ownerId', 'identityId', 'organisationId', 'membershipId']) id(p[key])
  need(typeof p.issuer === 'string' && p.issuer.length > 0 && p.issuer.length <= 2048 &&
    typeof p.subject === 'string' && p.subject.length > 0 && p.subject.length <= 255 &&
    typeof p.organisationSlug === 'string' && /^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$/.test(p.organisationSlug))
  id(p.ownerId); id(p.organisationId); id(p.membershipId)
  return Object.freeze({ ownerId: p.ownerId, organisationId: p.organisationId, membershipId: p.membershipId })
}
function transportReply(value: unknown, current: Rpc): Record<string, unknown> {
  need(value !== null && typeof value === 'object')
  const k = Object.getOwnPropertyDescriptor(value, 'kind'); need(k && 'value' in k)
  const scopedRefusal = k.value === 'refused' && Object.hasOwn(value, 'cellId')
  const extras = k.value === 'initialization-prepared' ? ['cellId', 'principal', 'mode'] :
    k.value === 'initialization-consumed' ? ['cellId', 'mode', 'remainingMs'] :
    k.value === 'attempt-prepared' ? ['cellId', 'info'] : k.value === 'attempt-outcome' ? ['cellId', 'outcome'] :
    k.value === 'refused' ? ['code', ...(scopedRefusal ? ['cellId'] : [])] : null
  need(extras)
  const reply = object(value, ['version', 'nonce', 'rpcId', 'kind', ...extras])
  need(reply.version === 1 && reply.nonce === nonce && reply.rpcId === current.token.id)
  if (reply.kind !== 'refused' || scopedRefusal) id(reply.cellId)
  if (scopedRefusal && current.wireCell !== undefined) need(reply.cellId === current.wireCell)
  return reply
}
function onTransport(event: MessageEvent<unknown>): void {
  try {
    const current = rpc; need(current); frame(current)
    const reply = transportReply(event.data, current)
    if (reply.kind === 'refused') {
      const errors: Record<string, DeviceWorkerCode> = { 'invalid-input': 'invalid-input', 'invalid-config': 'ineligible',
        ineligible: 'ineligible', network: 'network', 'invalid-response': 'invalid-response', capacity: 'storage' }
      need(typeof reply.code === 'string' && Object.hasOwn(errors, reply.code))
      throw new Refusal(errors[reply.code]!)
    }
    const pending = waiting; need(pending && pending.rpc === current && reply.kind === pending.kind &&
      (pending.cellId === undefined || reply.cellId === pending.cellId))
    id(reply.cellId); current.wireCell = reply.cellId
    waiting = undefined; pending.resolve(reply)
  } catch (error) { shutdown(code(error)) }
}
function bridge(current: Rpc, kind: string, extra: Record<string, unknown>, expected: string, cellId?: string): Promise<Record<string, unknown>> {
  fence(current); need(transport && !waiting)
  return new Promise((resolve, reject) => {
    waiting = { rpc: current, kind: expected, ...(cellId ? { cellId } : {}), resolve, reject }
    try { frame(current); transport!.postMessage({ version: 1, nonce, rpcId: current.token.id, kind, ...extra }) }
    catch (error) { waiting = undefined; reject(error) }
  })
}
function operation(): NativeOperation { const current = nativeOperation; need(current); nativeFence(current); return current }
function descriptor(text: unknown, current: NativeOperation): Record<string, unknown> {
  nativeFence(current); const d = json(text, 2048, DESCRIPTOR_KEYS); scoped(d)
  const pending = tuple.record?.pending; need(pending)
  need(d.version === 2 && d.actorOperation === current.actorOperation && d.devicePublicKey === tuple.key &&
    d.nativeGeneration === tuple.n && d.hostGeneration === tuple.g && d.recordId === tuple.record?.recordId && d.recordSha256 === tuple.frameSha &&
    d.operation === pending.operation && d.operationId === pending.operationId && d.bodySha256 === pending.bodySha256)
  return d
}
function outcome(value: unknown, entry: Attempt): Record<string, unknown> {
  need(value !== null && typeof value === 'object')
  const k = Object.getOwnPropertyDescriptor(value, 'kind'); need(k && 'value' in k)
  if (k.value === 'unknown') { object(value, ['kind']); return { kind: 'unknown' } }
  const v = object(value, ['kind', 'actorOperation', 'operationId', 'bodySha256', 'status', 'contentType', 'requestId', 'replayed', 'body'])
  need(v.kind === 'response' && v.actorOperation === entry.operation.actorOperation && v.operationId === entry.descriptor.operationId &&
    v.bodySha256 === entry.descriptor.bodySha256 && typeof v.status === 'number' && Number.isInteger(v.status) && v.status >= 100 && v.status <= 599 &&
    (v.contentType === 'application/json' || v.contentType === 'application/problem+json') &&
    typeof v.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.requestId) && (v.replayed === null || v.replayed === 'true'))
  const body = bytes(v.body, 0, 16384); temporaries.add(body)
  return { ...v, body }
}
const host = {
  checkCurrent(text: unknown): boolean {
    try {
      const current = operation(), v = json(text, 2048, CONTEXT_KEYS); scoped(v)
      return v.version === 2 && v.profile === 'http' && v.actorOperation === current.actorOperation && v.devicePublicKey === tuple.key &&
        v.nativeGeneration === tuple.n && v.hostGeneration === tuple.g && v.recordId === (tuple.record?.recordId ?? null) &&
        v.recordSha256 === tuple.frameSha && v.admittedDeviceId === (tuple.record?.admission?.deviceId ?? null)
    } catch { return false }
  },
  async compareAndSwapDevice(text: unknown, source: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const current = operation(), meta = json(text, 2048, ['version', 'ownerId', 'organisationId', 'membershipId', 'devicePublicKey', 'expectedGeneration', 'generation', 'checkpointSha256'])
    scoped(meta); need(store && context && tuple.n === 0 && tuple.g === 0 && meta.version === 1 && meta.expectedGeneration === 0 && meta.generation === 1 &&
      typeof meta.devicePublicKey === 'string' && HEX.test(meta.devicePublicKey) && typeof meta.checkpointSha256 === 'string' && HEX.test(meta.checkpointSha256))
    const sealed = bytes(source, 36, LOCAL_STATE_LIMITS.checkpointBytes - 56), wrapped = wrap(sealed)
    let value: UniqueDeviceVault | null | undefined
    try {
      need(await hash(sealed, current.rpc) === meta.checkpointSha256); nativeFence(current)
      need(await store.createUniqueDeviceVault(scope(meta.devicePublicKey), { checkpoint: wrapped, pendingSends: [] }) === 1); nativeFence(current)
      value = await read(current.rpc); nativeFence(current)
      need(value && value.generation === 1 && value.scope.devicePublicKey === meta.devicePublicKey && value.state.pendingSends.length === 0)
      await install(value, current.rpc, wrapped); nativeFence(current)
      const ack = new Uint8Array(192), view = new DataView(ack.buffer)
      ack.set(encoder.encode('KDA1'))
      ack.set(encoder.encode(context.ownerId), 4); ack.set(encoder.encode(context.organisationId), 40); ack.set(encoder.encode(context.membershipId), 76)
      ack.set(raw(meta.devicePublicKey), 112); view.setBigUint64(144, 0n); view.setBigUint64(152, 1n); ack.set(raw(meta.checkpointSha256), 160)
      nativeFence(current); return ack
    } finally { sealed.fill(0); wrapped.fill(0); clearVault(value) }
  },
  async compareAndSwapDeviceV2(text: unknown, sealedInput: unknown, recordInput: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const current = operation(), m = json(text, 2048, ACK_KEYS); scoped(m)
    need(durableHost && context && m.version === 2 && m.devicePublicKey === tuple.key && m.expectedNativeGeneration === tuple.n && m.expectedHostGeneration === tuple.g)
    for (const name of ['expectedNativeGeneration', 'nextNativeGeneration', 'expectedHostGeneration', 'nextHostGeneration']) integer(m[name])
    for (const name of ['devicePublicKey', 'sealedSha256', 'recordSha256']) need(typeof m[name] === 'string' && HEX.test(m[name]))
    id(m.recordId)
    const sealed = bytes(sealedInput, 36, LOCAL_STATE_LIMITS.checkpointBytes - 56), manifest = bytes(recordInput, 8, 65536), wrapped = wrap(sealed)
    let value: UniqueDeviceVault | null | undefined
    try {
      // The real host independently checks sealed/frame digests, N/G, strict CAS and exact final reread.
      need(typeof text === 'string')
      const ack = await durableHost.compareAndSwapDeviceV2(text, sealed, manifest); nativeFence(current)
      value = await read(current.rpc); nativeFence(current)
      need(value && value.generation === m.nextHostGeneration && value.state.pendingSends.length === 1 &&
        value.state.pendingSends[0]!.id === m.recordId && equal(value.state.pendingSends[0]!.ciphertext, manifest))
      await install(value, current.rpc, wrapped); nativeFence(current)
      need(tuple.n === m.nextNativeGeneration && tuple.g === m.nextHostGeneration && tuple.frameSha === m.recordSha256)
      const expected = { scope: [context.ownerId, context.organisationId, context.membershipId, m.devicePublicKey], recordId: m.recordId,
        expectedNativeGeneration: m.expectedNativeGeneration, nextNativeGeneration: m.nextNativeGeneration,
        expectedHostGeneration: m.expectedHostGeneration, nextHostGeneration: m.nextHostGeneration,
        sealedSha256: m.sealedSha256, recordSha256: m.recordSha256 } as DeviceHttpAck
      verifyDeviceHttpAck(ack, expected); nativeFence(current); return ack
    } finally { sealed.fill(0); manifest.fill(0); wrapped.fill(0); clearVault(value) }
  },
  async prepareDeviceHttpAttempt(text: unknown, bodyInput: unknown): Promise<object> {
    const current = operation(), d = descriptor(text, current), body = bytes(bodyInput, 1, 32768)
    temporaries.add(body); need(await hash(body, current.rpc) === d.bodySha256); nativeFence(current)
    const reply = await bridge(current.rpc, 'attempt-prepare', { descriptor: text, body }, 'attempt-prepared'); nativeFence(current)
    const info = object(reply.info, ['version', 'actorOperation', 'operationId', 'bodySha256', 'observedWallMs', 'retryBeforeMs'])
    need(info.version === 2 && info.actorOperation === current.actorOperation && info.operationId === d.operationId && info.bodySha256 === d.bodySha256)
    integer(info.observedWallMs, false); integer(info.retryBeforeMs)
    need(info.retryBeforeMs > info.observedWallMs && info.retryBeforeMs - info.observedWallMs <= 86400000)
    id(reply.cellId)
    const wrapper = Object.freeze({}), entry: Attempt = { wrapper, operation: current, cellId: reply.cellId, info: JSON.stringify(info), descriptor: d, body }
    attempts.set(wrapper, entry); retainedAttempts.add(entry); return wrapper
  },
  deviceHttpAttemptInfo(wrapper: object): string {
    const entry = attempts.get(wrapper); need(entry); nativeFence(entry.operation); return entry.info
  },
  async sendDeviceHttpAttempt(wrapper: object, text: unknown, bodyInput: unknown): Promise<Record<string, unknown>> {
    const entry = attempts.get(wrapper); need(entry); nativeFence(entry.operation)
    const d = descriptor(text, entry.operation), body = bytes(bodyInput, 1, 32768)
    temporaries.add(body)
    need(equal(entry.body, body) && ['operationId', 'bodySha256', 'recordId', 'operation', 'nativeGeneration', 'devicePublicKey'].every((key) => d[key] === entry.descriptor[key]))
    attempts.delete(wrapper); retainedAttempts.delete(entry)
    const reply = await bridge(entry.operation.rpc, 'attempt-send', { cellId: entry.cellId, descriptor: text, body }, 'attempt-outcome', entry.cellId)
    nativeFence(entry.operation); return outcome(reply.outcome, entry)
  },
}
async function invoke(current: Rpc, call: () => Promise<unknown>, startDeadline?: number): Promise<DeviceStatus> {
  fence(current); need(nativeOperation === undefined && nativeCounter < Number.MAX_SAFE_INTEGER)
  const captured = Object.freeze({ rpc: current, actorOperation: ++nativeCounter }); nativeOperation = captured
  try {
    // Only invocation START is subject to initializer age. No callback/await follows this sample before call.
    if (startDeadline !== undefined && time() >= startDeadline) fail('ineligible')
    const pending: unknown = call()
    const result: unknown = await pending; nativeFence(captured)
    const status = parseDeviceStatus(result)
    need(status.nativeGeneration === tuple.n && status.hostGeneration === tuple.g)
    return status
  } finally { if (nativeOperation === captured) nativeOperation = undefined }
}
async function initialize(current: Rpc, command: 'create' | 'restore'): Promise<DeviceStatus> {
  need(!actor && !store && !context)
  const prepared = await bridge(current, 'initialize-prepare', { mode: command }, 'initialization-prepared'); fence(current)
  need(prepared.mode === command); context = principal(prepared.principal)
  const opening = command === 'create' ? initializeConfidentialState(context.ownerId) : openConfidentialState(context.ownerId)
  const opened = await opening
  try { fence(current); store = opened } catch (error) { opened.close(); throw error }
  let value = await read(current)
  try {
    if (command === 'create') {
      if (value) fail('restore-required')
      header = new Uint8Array(52); header.set(encoder.encode('KWE1')); header.set(crypto.getRandomValues(new Uint8Array(16)), 4)
      header.set(crypto.getRandomValues(new Uint8Array(32)), 20)
    } else { if (!value) fail('restore-required'); await install(value, current) }
    durableHost = createDeviceCasHost(store, context, () => {
      const captured = nativeOperation
      if (!captured) return undefined
      return () => { try { nativeFence(captured); return true } catch { return false } }
    })
    actor = new BrowserMlsHttpDevice(host, context.ownerId, context.organisationId, context.membershipId)
    const started = time()
    const consumed = await bridge(current, 'initialize-consume', { cellId: prepared.cellId }, 'initialization-consumed', String(prepared.cellId))
    fence(current); need(consumed.mode === command && typeof consumed.remainingMs === 'number' && Number.isFinite(consumed.remainingMs) && consumed.remainingMs > 0 && consumed.remainingMs <= 5000)
    const received = time(); if (received - started >= consumed.remainingMs) fail('ineligible')
    const deadline = started + consumed.remainingMs; need(header)
    if (command === 'restore') {
      // Bind the final actual owner/record again after the asynchronous handshake.
      const latest = await read(current)
      try {
        need(value && latest && latest.generation === value.generation &&
          latest.scope.devicePublicKey === value.scope.devicePublicKey && equal(latest.state.checkpoint, value.state.checkpoint) &&
          latest.state.pendingSends.length === value.state.pendingSends.length && latest.state.pendingSends.every((item, index) =>
            item.id === value!.state.pendingSends[index]!.id && equal(item.ciphertext, value!.state.pendingSends[index]!.ciphertext)))
      } finally { clearVault(latest) }
      fence(current)
    }
    const seed = new Uint8Array(header.subarray(20, 52)); temporaries.add(seed)
    if (command === 'create') {
      const identity = encoder.encode(JSON.stringify({ version: 1, ownerId: context.ownerId })); need(identity.length === 62)
      return await invoke(current, () => { need(actor); return actor.createHttpDevice(identity, seed, true) }, deadline)
    }
    need(value && tuple.key)
    const sealed = new Uint8Array(value.state.checkpoint.subarray(56)); temporaries.add(sealed)
    const manifest = value.state.pendingSends[0] ? new Uint8Array(value.state.pendingSends[0].ciphertext) : null
    if (manifest) temporaries.add(manifest)
    return await invoke(current, () => { need(actor && tuple.key); return actor.openHttpDevice(raw(tuple.key), tuple.n, tuple.g, sealed, manifest, seed) }, deadline)
  } finally { clearVault(value); value = null }
}
async function execute(current: Rpc, command: DeviceCommand): Promise<DeviceStatus> {
  if (command === 'create' || command === 'restore') return initialize(current, command)
  need(actor && context && tuple.key)
  if (command === 'prepare-registration') {
    need(tuple.record === null || tuple.record.pending?.operation === 'register')
    const recordId = tuple.record?.recordId ?? crypto.randomUUID(), operationId = tuple.record?.pending?.operationId ?? crypto.randomUUID()
    return invoke(current, () => { need(actor); return actor.prepareRegistration(recordId, operationId) })
  }
  if (command === 'prepare-publication') {
    need(tuple.record?.admission && !tuple.record.publication && (!tuple.record.pending || tuple.record.pending.operation === 'publish-package'))
    const operationId = tuple.record.pending?.operationId ?? crypto.randomUUID()
    return invoke(current, () => { need(actor); return actor.preparePublication(operationId) })
  }
  need(tuple.record?.pending)
  return invoke(current, () => { need(actor); return actor.attemptHttp() })
}
async function onControl(event: MessageEvent<unknown>): Promise<void> {
  let current: Rpc | undefined
  try {
    const request = parseDeviceCommand(event.data, nonce)
    if (!alive || !loaded) fail('closed')
    if (rpc) {
      frame(rpc); frame(rpc)
      control?.postMessage({ version: 1, nonce, rpcId: request.rpcId, kind: 'refused', code: 'busy' })
      return
    }
    need(request.rpcId > lastRpc && (lastRpc !== 0 || request.rpcId === 1)); lastRpc = request.rpcId
    const start = time(), deadline = start + (request.command.startsWith('prepare-') ? 30000 : 60000)
    need(Number.isSafeInteger(Math.ceil(deadline)))
    const token = Object.freeze({ id: request.rpcId, deadline })
    const timer = setTimeout(() => shutdown('closed'), deadline - start)
    current = { token, frames: 1, active: true, retiredWire: false, timer }; rpc = current
    const result = await execute(current, request.command); fence(current)
    // A native outcome-unknown remains live for a later deliberate operation.
    retireWire(current)
    sendControl(current, { kind: 'result', result })
  } catch (error) {
    if (current && alive) shutdown(code(error))
    else if (alive) shutdown('invalid-input')
  } finally { if (current?.active) retire(current) }
}
async function bootstrap(event: MessageEvent<unknown>): Promise<void> {
  if (booted || !alive) return
  try {
    const first = parseDeviceBootstrap(event.data, event.ports)
    booted = true; nonce = first.nonce; control = first.control; transport = first.transport
    self.removeEventListener('message', bootstrap)
    startupTimer = setTimeout(() => shutdown('closed', false), 30000)
    const started = time()
    await initializeNative({ module_or_path: nativeWasmUrl })
    if (!alive || time() - started > 30000) fail('closed')
    loaded = true; clearTimeout(startupTimer)
    control.addEventListener('message', (message: MessageEvent<unknown>) => { void onControl(message) })
    transport.addEventListener('message', onTransport)
    control.addEventListener('messageerror', () => shutdown('invalid-input'))
    transport.addEventListener('messageerror', () => shutdown('invalid-input'))
    control.start(); transport.start()
    control.postMessage({ version: 1, nonce, kind: 'ready' })
  } catch { shutdown('invalid-input', false) }
}
self.addEventListener('message', bootstrap)
self.addEventListener('messageerror', () => shutdown('invalid-input'))
