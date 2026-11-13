/** Inspect sync subtypes before any helper may apply a client update. */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import { MAX_STATE, Refused } from './engine.mjs'

export class ViewerWrite extends Refused {
  constructor() { super('viewer state update refused') }
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
