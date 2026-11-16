// @vitest-environment node
// Public structural records only: none is a real signature, native seal or Core grant.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vectors from '../../../../../packages/kodera-rs/vectors/device-http-v1.json'
import {
  decodeDeviceHttpRecord, validateDeviceHttpBinding,
  encodeDeviceHttpAck, decodeDeviceHttpAck, verifyDeviceHttpAck,
  DeviceHttpRecordError,
} from './device-http-record'

const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function frame(json: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(json)
  const result = new Uint8Array(8 + bytes.length)
  result.set([75, 68, 72, 49]); new DataView(result.buffer).setUint32(4, bytes.length)
  result.set(bytes, 8); return result
}
const row = (index: number) => vectors.records[index]!
const rejectJson = async (json: string) =>
  expect(decodeDeviceHttpRecord(frame(json))).rejects.toBeInstanceOf(DeviceHttpRecordError)

describe('KDH1 shared structural contract', () => {
  it.each(vectors.records)('decodes exact Rust canonical bytes: $name', async (vector) => {
    const bytes = fromHex(vector.frameHex)
    const record = await decodeDeviceHttpRecord(bytes)
    expect(record).toEqual(vector.record)
    expect(digest(bytes)).toBe(vector.frameSha256)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.scope)).toBe(true)
    if (record.pending) expect(Object.isFrozen(record.pending)).toBe(true)
  })

  it('refuses duplicate/unknown/reordered keys, whitespace and alternate number spelling', async () => {
    const json = row(0).canonicalJson
    for (const bad of [
      json.replace('{', '{"version":1,'), json.replace('{', '{"unknown":1,'),
      json.replace('"version":1', '"version":1.0'),
      json.replace('"version":1,', '"version":1, '),
      json.replace('"version":1,', '').replace('}', ',"version":1}'),
    ]) await rejectJson(bad)
  })

  it('checks cap, frame length, true EOF and fatal UTF8 before parsing', async () => {
    const raw = fromHex(row(0).frameHex)
    for (let size = 0; size < 8; size++)
      await expect(decodeDeviceHttpRecord(raw.slice(0, size))).rejects.toBeInstanceOf(DeviceHttpRecordError)
    const tail = new Uint8Array(raw.length + 1); tail.set(raw)
    await expect(decodeDeviceHttpRecord(tail)).rejects.toBeInstanceOf(DeviceHttpRecordError)
    const invalid = raw.slice(); invalid[8] = 255
    await expect(decodeDeviceHttpRecord(invalid)).rejects.toBeInstanceOf(DeviceHttpRecordError)
    await expect(decodeDeviceHttpRecord(new Uint8Array(65537))).rejects.toBeInstanceOf(DeviceHttpRecordError)
    const shared = new Uint8Array(new SharedArrayBuffer(raw.length)); shared.set(raw)
    await expect(decodeDeviceHttpRecord(shared)).rejects.toBeInstanceOf(DeviceHttpRecordError)
  })

  it('owns input before its first await and does not expose mutable parsed state', async () => {
    const bytes = fromHex(row(1).frameHex)
    const pending = decodeDeviceHttpRecord(bytes)
    bytes.fill(0)
    const record = await pending
    expect(record).toEqual(row(1).record)
    expect(() => Reflect.set(record, 'nativeGeneration', 9)).not.toThrow()
    expect(record.nativeGeneration).toBe(1)
  })

  it('reads ordinary fixed subviews using their actual offset and length', async () => {
    const raw = fromHex(row(1).frameHex), storage = new Uint8Array(raw.length + 13)
    storage.set(raw, 7)
    await expect(decodeDeviceHttpRecord(storage.subarray(7, 7 + raw.length))).resolves.toEqual(row(1).record)
    const ack = fromHex(vectors.acknowledgements[0]!.frameHex), backing = new Uint8Array(ack.length + 11)
    backing.set(ack, 5)
    expect(decodeDeviceHttpAck(backing.subarray(5, 5 + ack.length))).toEqual(vectors.acknowledgements[0]!.ack)
  })

  it('never consults subclass or own buffer, length, offset, tag or iterator overrides', async () => {
    class Bytes extends Uint8Array {}
    let reads = 0
    const trap = () => { reads++; throw new Error('source accessor must not run') }
    for (const target of [Bytes.prototype, new Uint8Array()]) {
      const raw = fromHex(row(1).frameHex)
      const value = target === Bytes.prototype ? new Bytes(raw) : raw
      const destination = target === Bytes.prototype ? target : value
      Object.defineProperties(destination, {
        buffer: { get: trap }, byteLength: { get: trap }, byteOffset: { get: trap },
        [Symbol.toStringTag]: { get: trap }, [Symbol.iterator]: { get: trap },
      })
      await expect(decodeDeviceHttpRecord(value)).resolves.toEqual(row(1).record)
    }
    const ack = fromHex(vectors.acknowledgements[0]!.frameHex)
    Object.defineProperties(ack, {
      buffer: { get: trap }, byteLength: { get: trap }, byteOffset: { get: trap },
      [Symbol.toStringTag]: { get: trap }, [Symbol.iterator]: { get: trap },
    })
    expect(decodeDeviceHttpAck(ack)).toEqual(vectors.acknowledgements[0]!.ack)
    expect(reads).toBe(0)
  })

  it('uses actual slots despite forged own length and buffer values', async () => {
    const raw = fromHex(row(1).frameHex)
    Object.defineProperties(raw, {
      byteLength: { value: 2 ** 30 }, byteOffset: { value: 2 ** 30 }, buffer: { value: new ArrayBuffer(0) },
    })
    // The forged values must not reject valid bytes or become allocation arguments.
    await expect(decodeDeviceHttpRecord(raw)).resolves.toEqual(row(1).record)
  })

  it('refuses real shared backing even when an own getter disguises it as ordinary', async () => {
    const raw = fromHex(row(1).frameHex), shared = new Uint8Array(new SharedArrayBuffer(raw.length))
    shared.set(raw)
    let reads = 0
    Object.defineProperty(shared, 'buffer', { get: () => { reads++; return new ArrayBuffer(raw.length) } })
    await expect(decodeDeviceHttpRecord(shared)).rejects.toBeInstanceOf(DeviceHttpRecordError)
    expect(reads).toBe(0)
  })

  it('refuses proxies without invoking source property traps', async () => {
    let reads = 0
    const wrap = (raw: Uint8Array) => new Proxy(raw, { get() { reads++; throw new Error('proxy get must not run') } })
    await expect(decodeDeviceHttpRecord(wrap(fromHex(row(1).frameHex)))).rejects.toBeInstanceOf(DeviceHttpRecordError)
    expect(() => decodeDeviceHttpAck(wrap(fromHex(vectors.acknowledgements[0]!.frameHex)))).toThrow(DeviceHttpRecordError)
    expect(reads).toBe(0)
  })

  it('refuses another typed-array brand even with a Uint8Array prototype and valid underlying bytes', async () => {
    const raw = fromHex(row(1).frameHex)
    expect(raw.byteLength % 2).toBe(0)
    const words = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
    Object.setPrototypeOf(words, Uint8Array.prototype)
    await expect(decodeDeviceHttpRecord(words as unknown as Uint8Array)).rejects.toBeInstanceOf(DeviceHttpRecordError)
  })

  it('refuses detached ordinary backing', async () => {
    const raw = fromHex(row(1).frameHex)
    structuredClone(raw.buffer, { transfer: [raw.buffer] })
    await expect(decodeDeviceHttpRecord(raw)).rejects.toBeInstanceOf(DeviceHttpRecordError)
  })

  it('refuses a resizable backing buffer containing otherwise valid canonical bytes', async () => {
    const raw = fromHex(row(1).frameHex)
    // Reflect avoids inventing a declaration for the newer runtime constructor option.
    const backing = Reflect.construct(ArrayBuffer, [raw.length, { maxByteLength: raw.length + 8 }]) as ArrayBuffer
    const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    expect(resizable?.call(backing)).toBe(true)
    const value = new Uint8Array(backing); value.set(raw)
    await expect(decodeDeviceHttpRecord(value)).rejects.toBeInstanceOf(DeviceHttpRecordError)
  })

  it('requires strict recovery, identifier, hash, union and scheduling fields', async () => {
    const original = row(1).canonicalJson
    for (const bad of [
      original.replace('"recoverySpent":0,', ''), original.replace('"recoverySpent":0', '"recoverySpent":1'),
      original.replace('"recoverySpent":0', '"unknown":0,"recoverySpent":0'),
      original.replace('"phase":"prepared"', '"phase":"prepared","phase":"prepared"'),
      original.replace('"firstAttemptAtMs":null', '"firstAttemptAtMs":0'),
      original.replace('"nativeGeneration":1', '"nativeGeneration":0'),
      original.replace('"nativeGeneration":1', '"nativeGeneration":9007199254740992'),
      original.replace(row(1).record.recordId, `${row(1).record.recordId}\\n`),
      original.replace(row(1).record.sealedSha256, 'AA'.repeat(32)),
      original.replace('"nativePackageId":null', `"nativePackageId":"${'33'.repeat(32)}"`),
      original.replace(row(1).record.pending!.bodySha256, '00'.repeat(32)),
      row(2).canonicalJson.replace('"recoverySpent":1', '"recoverySpent":2'),
      row(2).canonicalJson.replace('1700086400000', '9007199254740991'),
      row(4).canonicalJson.replace(JSON.stringify(row(4).record.admission), 'null'),
      row(6).canonicalJson.replace('"pending":null', `"pending":${JSON.stringify(row(5).record.pending)}`),
    ]) await rejectJson(bad)
    const validBoundary = structuredClone(row(2).record)
    validBoundary.pending!.firstAttemptAtMs = Number.MAX_SAFE_INTEGER - 86_400_000
    validBoundary.pending!.retryBeforeMs = Number.MAX_SAFE_INTEGER
    await expect(decodeDeviceHttpRecord(frame(JSON.stringify(validBoundary)))).resolves.toBeDefined()
  })

  it.each(['', 'e30', 'e31=', 'e30=\n', 'e30= ', '____'])('refuses noncanonical base64 %j', async (body) => {
    const original = row(1)
    const record = structuredClone(original.record)
    record.pending!.bodyBase64 = body
    record.pending!.bodySha256 = digest(Uint8Array.from(Buffer.from('{}')))
    await rejectJson(JSON.stringify(record))
  })

  it('accepts the canonical encoding for the same decoded pad-bit negative bytes', async () => {
    const record = structuredClone(row(1).record)
    record.pending!.bodyBase64 = 'e30='
    record.pending!.bodySha256 = digest(Uint8Array.from(Buffer.from('{}')))
    await expect(decodeDeviceHttpRecord(frame(JSON.stringify(record)))).resolves.toBeDefined()
  })

  it('checks raw body bounds and keeps the two public package ID domains distinct', async () => {
    for (const size of [1, 32768, 32769]) {
      const record = structuredClone(row(1).record)
      const bytes = new Uint8Array(size).fill(120)
      record.pending!.bodyBase64 = Buffer.from(bytes).toString('base64')
      record.pending!.bodySha256 = digest(bytes)
      if (size <= 32768) await expect(decodeDeviceHttpRecord(frame(JSON.stringify(record)))).resolves.toBeDefined()
      else await rejectJson(JSON.stringify(record))
    }
    const record = await decodeDeviceHttpRecord(fromHex(row(6).frameHex))
    expect(record.publication!.nativePackageId).not.toBe(record.publication!.packageWireSha256)
  })

  it.each(['2025-02-29T00:00:00Z', '2026-11-23', '2026-11-23T24:00:00Z', '2026-11-23T00:00:00+24:00', '2026-11-23T00:00:00Z\n'])(
    'rejects invalid bounded RFC3339 expiry %j', async (expiresAt) => {
      const record = structuredClone(row(6).record); record.publication!.expiresAt = expiresAt
      await rejectJson(JSON.stringify(record))
    })

  it.each(['2024-02-29T12:59:59.123Z', '2016-12-31T23:59:60Z', '2017-01-01T00:59:60+01:00'])(
    'retains strictly parsed response metadata without local expiry equality %j', async (expiresAt) => {
      const record = structuredClone(row(6).record); record.publication!.expiresAt = expiresAt
      await expect(decodeDeviceHttpRecord(frame(JSON.stringify(record)))).resolves.toHaveProperty('publication.expiresAt', expiresAt)
    })

  it('binds native N separately from host G, scope and exact seal digest', async () => {
    const record = await decodeDeviceHttpRecord(fromHex(row(5).frameHex))
    const binding = { scope: record.scope, nativeGeneration: 3, hostGeneration: 7, sealedSha256: record.sealedSha256 }
    expect(() => validateDeviceHttpBinding(record, binding)).not.toThrow()
    for (const bad of [
      { ...binding, nativeGeneration: 7 }, { ...binding, hostGeneration: 2 },
      { ...binding, sealedSha256: '00'.repeat(32) },
      { ...binding, scope: [record.scope[1], record.scope[0], record.scope[2], record.scope[3]] as const },
    ]) expect(() => validateDeviceHttpBinding(record, bad)).toThrow(DeviceHttpRecordError)
  })
})

describe('KDA2 closed 276-byte completion data (not authority)', () => {
  it.each(vectors.acknowledgements)('matches independent exact vector $name and detects every changed byte', (vector) => {
    const raw = fromHex(vector.frameHex), ack = decodeDeviceHttpAck(raw)
    expect(raw.length).toBe(276); expect(ack).toEqual(vector.ack)
    expect(encodeDeviceHttpAck(ack)).toEqual(raw)
    expect(() => verifyDeviceHttpAck(raw, ack)).not.toThrow()
    for (let at = 0; at < raw.length; at++) {
      const changed = raw.slice(); changed[at] = changed[at]! ^ 1
      expect(() => verifyDeviceHttpAck(changed, ack)).toThrow(DeviceHttpRecordError)
    }
    expect(() => decodeDeviceHttpAck(raw.slice(0, 275))).toThrow(DeviceHttpRecordError)
    const tail = new Uint8Array(277); tail.set(raw)
    expect(() => decodeDeviceHttpAck(tail)).toThrow(DeviceHttpRecordError)
  })

  it('rejects unsafe, skipped or mismatched clocks before u64 conversion', () => {
    const ack = decodeDeviceHttpAck(fromHex(vectors.acknowledgements[0]!.frameHex))
    for (const bad of [
      { ...ack, nextHostGeneration: ack.expectedHostGeneration },
      { ...ack, nextNativeGeneration: ack.expectedNativeGeneration + 2 },
      { ...ack, expectedHostGeneration: 1 },
      { ...ack, expectedHostGeneration: Number.MAX_SAFE_INTEGER, nextHostGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => encodeDeviceHttpAck(bad)).toThrow(DeviceHttpRecordError)
  })
})
