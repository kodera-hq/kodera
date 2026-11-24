/** Inspect sync subtypes before any helper may apply a client update. */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import { MAX_STATE, Refused } from './engine.mjs'

const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
export const KDE1_MAGIC = Object.freeze([0x4b, 0x44, 0x45, 0x31])

export class ViewerWrite extends Refused {
  constructor() { super('viewer state update refused') }
}
export class ConfidentialRefused extends Refused {
  constructor(message = 'confidential collaboration frame refused') { super(message) }
}
function validConfidentialSender(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  for (const ch of value) {
    const point = ch.codePointAt(0)
    if (point < 32 || (point >= 0xd800 && point <= 0xdfff)) return false
  }
  return true
}
export function isKde1Magic(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4b &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x45 &&
    bytes[3] === 0x31
  )
}
export function confidentialFrame(bytes, role, expectedEpoch) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 36 || bytes.byteLength > MAX_STATE + 2048) {
    throw new ConfidentialRefused('confidential frame out of bounds')
  }
  if (!isKde1Magic(bytes)) {
    throw new ConfidentialRefused('unsealed or non-KDE1 frame refused in confidential room')
  }
  const metadataSize = (bytes[4] << 8) | bytes[5]
  if (metadataSize < 1 || metadataSize > 1024 || bytes.byteLength < 6 + metadataSize + 29) {
    throw new ConfidentialRefused('confidential frame metadata or AEAD payload out of bounds')
  }
  let encoded, meta
  try {
    encoded = utf8Fatal.decode(bytes.subarray(6, 6 + metadataSize))
    meta = JSON.parse(encoded)
  } catch {
    throw new ConfidentialRefused('malformed confidential frame metadata')
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ConfidentialRefused('invalid confidential metadata container')
  }
  if (
    typeof meta.epoch !== 'number' ||
    !Number.isSafeInteger(meta.epoch) ||
    meta.epoch < 0 ||
    meta.epoch > 0xffffffff ||
    meta.epoch !== expectedEpoch ||
    !validConfidentialSender(meta.sender) ||
    typeof meta.sequence !== 'number' ||
    !Number.isSafeInteger(meta.sequence) ||
    meta.sequence < 1 ||
    (meta.kind !== 0 && meta.kind !== 1) ||
    typeof meta.ratchet !== 'number' ||
    !Number.isSafeInteger(meta.ratchet) ||
    meta.ratchet < 0 ||
    meta.ratchet > 0xffffffff
  ) {
    throw new ConfidentialRefused('confidential metadata header invariant failed')
  }
  const canonical = JSON.stringify({
    epoch: meta.epoch,
    sender: meta.sender,
    sequence: meta.sequence,
    kind: meta.kind,
    ratchet: meta.ratchet,
  })
  if (canonical !== encoded) {
    throw new ConfidentialRefused('non-canonical confidential metadata JSON')
  }
  if (meta.kind === 0 && role !== 'editor') {
    throw new ViewerWrite()
  }
  return {
    kind: meta.kind,
    epoch: meta.epoch,
    sender: meta.sender,
    sequence: meta.sequence,
    ratchet: meta.ratchet,
    envelope: new Uint8Array(bytes),
  }
}
export function frame(bytes, role) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_STATE + 32) throw new Refused('frame exceeds limit')
  try {
    const reader = decoding.createDecoder(bytes)
    const kind = decoding.readVarUint(reader)
    if (kind === 0) {
      const subtype = decoding.readVarUint(reader)
      if (![sync.messageYjsSyncStep1, sync.messageYjsSyncStep2, sync.messageYjsUpdate].includes(subtype)) throw new Refused('unknown sync subtype')
      // Do this before decoding or applying any state update, including sync step 2.
      if (role !== 'editor' && subtype !== sync.messageYjsSyncStep1) throw new ViewerWrite()
      const body = decoding.readVarUint8Array(reader)
      if (reader.pos !== bytes.length) throw new Refused('trailing protocol bytes')
      if (subtype === sync.messageYjsSyncStep1 && body.byteLength > 65536) throw new Refused('state vector exceeds limit')
      return { kind: subtype === sync.messageYjsSyncStep1 ? 'vector' : 'update', body }
    }
    if (kind === 1) {
      const body = decoding.readVarUint8Array(reader)
      if (body.byteLength > 8192 || reader.pos !== bytes.length) throw new Refused('awareness frame exceeds limit')
      return { kind: 'awareness', body }
    }
    if (kind === 3 && reader.pos === bytes.length) return { kind: 'awareness-query' }
    throw new Refused('unknown protocol message')
  } catch (error) { throw error instanceof Refused ? error : new Refused('malformed protocol frame') }
}
export function stateFrame(doc, vector = undefined) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeSyncStep2(encoder, doc, vector)
  return encoding.toUint8Array(encoder)
}
export function updateFrame(update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}
export function vectorFrame(doc) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

export function snapshotFrame(state) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarUint(encoder, sync.messageYjsSyncStep2)
  encoding.writeVarUint8Array(encoder, state)
  return encoding.toUint8Array(encoder)
}
export function storedVectorFrame(state) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarUint(encoder, sync.messageYjsSyncStep1)
  encoding.writeVarUint8Array(encoder, Y.encodeStateVectorFromUpdate(state))
  return encoding.toUint8Array(encoder)
}
export function storedDiff(state, vector) {
  try { return Y.diffUpdate(state, vector) } catch { throw new Refused('malformed state vector') }
}
