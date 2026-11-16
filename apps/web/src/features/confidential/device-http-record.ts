// Structural KDH1/KDA2 codecs only. Native state and actual HTTP/host authority
// are verified by their owners; these data utilities confer no send permission.
export const DEVICE_HTTP_RECORD_BYTES = 65_536
export const DEVICE_HTTP_BODY_BYTES = 32_768
export const DEVICE_HTTP_ACK_BYTES = 276
const SAFE = Number.MAX_SAFE_INTEGER
const HORIZON = 86_400_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type DeviceHttpScope = readonly [string, string, string, string]
export interface DeviceHttpAdmission {
  readonly operationId: string
  readonly bodySha256: string
  readonly deviceId: string
  readonly responseSha256: string
}
export interface DeviceHttpPending {
  readonly operation: 'register' | 'publish-package'
  readonly operationId: string
  readonly bodyBase64: string
  readonly bodySha256: string
  readonly nativePackageId: string | null
  readonly packageWireSha256: string | null
  readonly phase: 'prepared' | 'attempted'
  readonly recoverySpent: 0 | 1
  readonly firstAttemptAtMs: number | null
  readonly retryBeforeMs: number | null
}
export interface DeviceHttpPublication {
  readonly operationId: string
  readonly nativePackageId: string
  readonly bodySha256: string
  readonly corePackageId: string
  readonly packageWireSha256: string
  readonly expiresAt: string
  readonly responseSha256: string
}
export interface DeviceHttpRecord {
  readonly version: 1
  readonly recordId: string
  readonly scope: DeviceHttpScope
  readonly nativeGeneration: number
  readonly sealedSha256: string
  readonly admission: DeviceHttpAdmission | null
  readonly pending: DeviceHttpPending | null
  readonly publication: DeviceHttpPublication | null
}
export interface DeviceHttpBinding {
  readonly scope: DeviceHttpScope
  readonly nativeGeneration: number
  readonly hostGeneration: number
  readonly sealedSha256: string
}
export interface DeviceHttpAck {
  readonly scope: DeviceHttpScope
  readonly recordId: string
  readonly expectedNativeGeneration: number
  readonly nextNativeGeneration: number
  readonly expectedHostGeneration: number
  readonly nextHostGeneration: number
  readonly sealedSha256: string
  readonly recordSha256: string
}
export class DeviceHttpRecordError extends Error {
  readonly code = 'invalid-input'
  constructor() { super('invalid device HTTP record'); this.name = 'DeviceHttpRecordError' }
}
function fail(): never { throw new DeviceHttpRecordError() }
function require(condition: unknown): asserts condition { if (!condition) fail() }
type IntrinsicGetter = (this: unknown) => unknown
const ByteArray = Uint8Array
const typedArrayPrototype = Object.getPrototypeOf(ByteArray.prototype) as object
const intrinsicGetter = (prototype: object, name: PropertyKey): IntrinsicGetter | undefined =>
  Object.getOwnPropertyDescriptor(prototype, name)?.get as IntrinsicGetter | undefined
const typedArrayTag = intrinsicGetter(typedArrayPrototype, Symbol.toStringTag)
const typedArrayBuffer = intrinsicGetter(typedArrayPrototype, 'buffer')
const typedArrayOffset = intrinsicGetter(typedArrayPrototype, 'byteOffset')
const typedArrayLength = intrinsicGetter(typedArrayPrototype, 'byteLength')
const bufferLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength')
const bufferResizable = intrinsicGetter(ArrayBuffer.prototype, 'resizable')
const copyBytes = ByteArray.prototype.set
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  require(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const names = Reflect.ownKeys(descriptors)
  require(names.length === keys.length && names.every((key) => typeof key === 'string' && keys.includes(key)))
  const result = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = descriptors[key]
    require(descriptor && 'value' in descriptor)
    result[key] = descriptor.value
  }
  return result
}
function uuid(value: unknown): asserts value is string {
  require(typeof value === 'string' && value.length === 36 && value !== '00000000-0000-0000-0000-000000000000' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
}
function hex32(value: unknown): asserts value is string {
  require(typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value))
}
function unsigned(value: unknown): asserts value is number {
  require(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}
function positive(value: unknown): asserts value is number { unsigned(value); require(value > 0) }
const SCOPE_KEYS = ['0', '1', '2', '3', 'length'] as const
function scope(value: unknown): DeviceHttpScope {
  require(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype)
  const descriptors = Object.getOwnPropertyDescriptors<object>(value)
  const names = Reflect.ownKeys(descriptors)
  require(names.length === SCOPE_KEYS.length &&
    names.every((key) => typeof key === 'string' && (SCOPE_KEYS as readonly string[]).includes(key)))
  const items: unknown[] = []
  for (const key of SCOPE_KEYS) {
    const descriptor = descriptors[key]
    require(descriptor && 'value' in descriptor)
    if (key === 'length') require(descriptor.value === 4)
    else items.push(descriptor.value)
  }
  const [s0, s1, s2, s3] = items
  uuid(s0); uuid(s1); uuid(s2); hex32(s3)
  return Object.freeze([s0, s1, s2, s3])
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') }
function rawHex(value: string): Uint8Array<ArrayBuffer> {
  hex32(value)
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
// Read internal slots before allocating; source properties and iterators are never consulted.
function snapshot(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  require(typedArrayTag && typedArrayBuffer && typedArrayOffset && typedArrayLength && bufferLength && bufferResizable)
  require(typedArrayTag.call(value) === 'Uint8Array')
  const buffer = typedArrayBuffer.call(value), offset = typedArrayOffset.call(value), length = typedArrayLength.call(value)
  // The ArrayBuffer getter rejects real SharedArrayBuffers, including disguised backing stores.
  const total = bufferLength.call(buffer)
  require(bufferResizable.call(buffer) === false)
  require(typeof length === 'number' && Number.isSafeInteger(length) && length >= minimum && length <= maximum)
  require(typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 &&
    typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= total && length <= total - offset)
  const result = new ByteArray(length)
  copyBytes.call(result, new ByteArray(buffer as ArrayBuffer, offset, length))
  return result
}
function bodyBytes(value: unknown): Uint8Array<ArrayBuffer> {
  require(typeof value === 'string' && value.length > 0 && value.length <= 43_692 && value.length % 4 === 0)
  const match = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.exec(value)
  require(match?.[0] === value)
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const length = value.length / 4 * 3 - padding
  require(length >= 1 && length <= DEVICE_HTTP_BODY_BYTES)
  const raw = atob(value); require(raw.length === length && btoa(raw) === value)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
function rfc3339(value: unknown): asserts value is string {
  require(typeof value === 'string' && value.length >= 20 && value.length <= 64)
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value)
  require(m?.[0] === value)
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  require(month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 60)
  const offsetHour = m[8] === undefined ? 0 : Number(m[8]), offsetMinute = m[9] === undefined ? 0 : Number(m[9])
  require(offsetHour <= 23 && offsetMinute <= 59)
  const offset = (m[7] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  if (second === 60) {
    const utc = hour * 60 + minute - offset
    require((utc === 1439 && ((month === 6 && day === 30) || (month === 12 && day === 31))) ||
      (utc === -1 && ((month === 7 && day === 1) || (month === 1 && day === 1))))
  }
}
function admission(value: unknown): DeviceHttpAdmission | null {
  if (value === null) return null
  const a = object(value, ['operationId', 'bodySha256', 'deviceId', 'responseSha256'])
  uuid(a.operationId); hex32(a.bodySha256); uuid(a.deviceId); hex32(a.responseSha256)
  return Object.freeze({ operationId: a.operationId, bodySha256: a.bodySha256, deviceId: a.deviceId, responseSha256: a.responseSha256 })
}
function pending(value: unknown): DeviceHttpPending | null {
  if (value === null) return null
  const p = object(value, ['operation', 'operationId', 'bodyBase64', 'bodySha256', 'nativePackageId', 'packageWireSha256',
    'phase', 'recoverySpent', 'firstAttemptAtMs', 'retryBeforeMs'])
  require(p.operation === 'register' || p.operation === 'publish-package')
  uuid(p.operationId); require(typeof p.bodyBase64 === 'string'); bodyBytes(p.bodyBase64); hex32(p.bodySha256)
  if (p.nativePackageId !== null) hex32(p.nativePackageId)
  if (p.packageWireSha256 !== null) hex32(p.packageWireSha256)
  require(p.recoverySpent === 0 || p.recoverySpent === 1)
  require(p.phase === 'prepared' || p.phase === 'attempted')
  if (p.phase === 'prepared') require(p.recoverySpent === 0 && p.firstAttemptAtMs === null && p.retryBeforeMs === null)
  else {
    unsigned(p.firstAttemptAtMs); unsigned(p.retryBeforeMs)
    require(p.firstAttemptAtMs <= SAFE - HORIZON && p.firstAttemptAtMs <= p.retryBeforeMs && p.retryBeforeMs <= p.firstAttemptAtMs + HORIZON)
  }
  return Object.freeze({ operation: p.operation, operationId: p.operationId, bodyBase64: p.bodyBase64, bodySha256: p.bodySha256,
    nativePackageId: p.nativePackageId, packageWireSha256: p.packageWireSha256, phase: p.phase, recoverySpent: p.recoverySpent,
    firstAttemptAtMs: p.firstAttemptAtMs as number | null, retryBeforeMs: p.retryBeforeMs as number | null })
}
function publication(value: unknown): DeviceHttpPublication | null {
  if (value === null) return null
  const p = object(value, ['operationId', 'nativePackageId', 'bodySha256', 'corePackageId', 'packageWireSha256', 'expiresAt', 'responseSha256'])
  uuid(p.operationId); hex32(p.nativePackageId); hex32(p.bodySha256); uuid(p.corePackageId)
  hex32(p.packageWireSha256); rfc3339(p.expiresAt); hex32(p.responseSha256)
  return Object.freeze({ operationId: p.operationId, nativePackageId: p.nativePackageId, bodySha256: p.bodySha256,
    corePackageId: p.corePackageId, packageWireSha256: p.packageWireSha256, expiresAt: p.expiresAt, responseSha256: p.responseSha256 })
}
function record(value: unknown): DeviceHttpRecord {
  const r = object(value, ['version', 'recordId', 'scope', 'nativeGeneration', 'sealedSha256', 'admission', 'pending', 'publication'])
  require(r.version === 1); uuid(r.recordId); const s = scope(r.scope); positive(r.nativeGeneration); hex32(r.sealedSha256)
  const a = admission(r.admission), p = pending(r.pending), published = publication(r.publication)
  if (p) {
    require(published === null)
    if (p.operation === 'register') require(a === null && p.nativePackageId === null && p.packageWireSha256 === null)
    else require(a !== null && p.nativePackageId !== null && p.packageWireSha256 !== null)
  }
  if (published) require(a !== null)
  return Object.freeze({ version: 1, recordId: r.recordId, scope: s,
    nativeGeneration: r.nativeGeneration, sealedSha256: r.sealedSha256, admission: a, pending: p, publication: published })
}

/** Strict Rust-format decode/re-encode validation; not an HTTP proof or HPKE validator. */
export async function decodeDeviceHttpRecord(value: Uint8Array): Promise<DeviceHttpRecord> {
  try {
    const bytes = snapshot(value, 8, DEVICE_HTTP_RECORD_BYTES)
    require(bytes[0] === 75 && bytes[1] === 68 && bytes[2] === 72 && bytes[3] === 49)
    require(new DataView(bytes.buffer).getUint32(4) === bytes.length - 8)
    const json = decoder.decode(bytes.subarray(8))
    const parsed = record(JSON.parse(json) as unknown)
    // Construction above uses declared field order at every object level. Comparing
    // full JSON also rejects duplicate keys, escapes, alternate numbers and whitespace.
    require(JSON.stringify(parsed) === json)
    if (parsed.pending) {
      const body = bodyBytes(parsed.pending.bodyBase64)
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
      require(hex(hash) === parsed.pending.bodySha256)
    }
    return parsed
  } catch { throw new DeviceHttpRecordError() }
}

/** Caller must independently authenticate the native seal and current host ownership. */
export function validateDeviceHttpBinding(value: DeviceHttpRecord, binding: DeviceHttpBinding): void {
  try {
    const r = record(value)
    const b = object(binding, ['scope', 'nativeGeneration', 'hostGeneration', 'sealedSha256'])
    const expectedScope = scope(b.scope); positive(b.nativeGeneration); positive(b.hostGeneration); hex32(b.sealedSha256)
    require(b.hostGeneration >= b.nativeGeneration && r.nativeGeneration === b.nativeGeneration &&
      r.scope.every((v, i) => v === expectedScope[i]) && r.sealedSha256 === b.sealedSha256)
  } catch { throw new DeviceHttpRecordError() }
}

function ack(value: unknown): DeviceHttpAck {
  const a = object(value, ['scope', 'recordId', 'expectedNativeGeneration', 'nextNativeGeneration',
    'expectedHostGeneration', 'nextHostGeneration', 'sealedSha256', 'recordSha256'])
  const s = scope(a.scope); uuid(a.recordId); hex32(a.sealedSha256); hex32(a.recordSha256)
  positive(a.expectedNativeGeneration); positive(a.nextNativeGeneration); positive(a.expectedHostGeneration); positive(a.nextHostGeneration)
  require(a.expectedHostGeneration < SAFE && a.nextHostGeneration === a.expectedHostGeneration + 1 &&
    a.expectedHostGeneration >= a.expectedNativeGeneration && a.nextHostGeneration >= a.nextNativeGeneration &&
    (a.nextNativeGeneration === a.expectedNativeGeneration ||
      (a.expectedNativeGeneration < SAFE && a.nextNativeGeneration === a.expectedNativeGeneration + 1)))
  return Object.freeze({ scope: s, recordId: a.recordId,
    expectedNativeGeneration: a.expectedNativeGeneration, nextNativeGeneration: a.nextNativeGeneration,
    expectedHostGeneration: a.expectedHostGeneration, nextHostGeneration: a.nextHostGeneration,
    sealedSha256: a.sealedSha256, recordSha256: a.recordSha256 })
}
/** Structural packing only; use exclusively after strict CAS/readback/current fences. */
export function encodeDeviceHttpAck(value: DeviceHttpAck): Uint8Array<ArrayBuffer> {
  try {
    const a = ack(value), bytes = new Uint8Array(DEVICE_HTTP_ACK_BYTES)
    let at = 0
    const put = (part: Uint8Array) => { bytes.set(part, at); at += part.length }
    put(encoder.encode('KDA2')); for (const id of a.scope.slice(0, 3)) put(encoder.encode(id))
    put(rawHex(a.scope[3])); put(encoder.encode(a.recordId))
    const view = new DataView(bytes.buffer)
    for (const n of [a.expectedNativeGeneration, a.nextNativeGeneration, a.expectedHostGeneration, a.nextHostGeneration]) {
      view.setBigUint64(at, BigInt(n)); at += 8
    }
    put(rawHex(a.sealedSha256)); put(rawHex(a.recordSha256)); require(at === DEVICE_HTTP_ACK_BYTES)
    return bytes
  } catch { throw new DeviceHttpRecordError() }
}
export function decodeDeviceHttpAck(value: Uint8Array): DeviceHttpAck {
  try {
    const bytes = snapshot(value, DEVICE_HTTP_ACK_BYTES, DEVICE_HTTP_ACK_BYTES)
    require(decoder.decode(bytes.subarray(0, 4)) === 'KDA2')
    const text = (start: number, end: number) => decoder.decode(bytes.subarray(start, end))
    const view = new DataView(bytes.buffer)
    const integer = (at: number) => { const n = view.getBigUint64(at); require(n <= BigInt(SAFE)); return Number(n) }
    return ack({ scope: [text(4, 40), text(40, 76), text(76, 112), hex(bytes.subarray(112, 144))], recordId: text(144, 180),
      expectedNativeGeneration: integer(180), nextNativeGeneration: integer(188), expectedHostGeneration: integer(196), nextHostGeneration: integer(204),
      sealedSha256: hex(bytes.subarray(212, 244)), recordSha256: hex(bytes.subarray(244, 276)) })
  } catch { throw new DeviceHttpRecordError() }
}
export function verifyDeviceHttpAck(value: Uint8Array, expected: DeviceHttpAck): void {
  try {
    const bytes = snapshot(value, DEVICE_HTTP_ACK_BYTES, DEVICE_HTTP_ACK_BYTES), correct = encodeDeviceHttpAck(expected)
    require(bytes.every((b, i) => b === correct[i]))
  } catch { throw new DeviceHttpRecordError() }
}
