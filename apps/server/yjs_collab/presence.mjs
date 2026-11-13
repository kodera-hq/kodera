/** Ephemeral relative cursors and selections bind their client identifier to one authenticated socket. */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Refused } from './engine.mjs'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ALLOWED_TOP_KEYS = new Set(['cursor', 'selection', 'user'])
const ALLOWED_USER_KEYS = new Set(['id', 'name', 'role', 'cursorSlot'])

function bounded(value) {
  const queue = [[value, 0]]
  let count = 0
  while (queue.length) {
    const [node, depth] = queue.pop()
    if (++count > 128 || depth > 8) throw new Refused('cursor bounds exceeded')
    if (node === null || typeof node === 'boolean') continue
    if (typeof node === 'number') { if (!Number.isSafeInteger(node)) throw new Refused(); continue }
    if (typeof node === 'string') { if (node.length > 512 || !node.isWellFormed() || node.includes('\0')) throw new Refused(); continue }
    if (Array.isArray(node)) { if (node.length > 16) throw new Refused(); for (const child of node) queue.push([child, depth + 1]); continue }
    if (typeof node !== 'object') throw new Refused()
    for (const key of Object.getOwnPropertyNames(node)) {
      if (key.length > 32 || FORBIDDEN_KEYS.has(key)) throw new Refused()
      queue.push([node[key], depth + 1])
    }
  }
}

function sanitizeUser(rawUser, claims) {
  const user = { id: claims.membership, role: claims.role }
  if (rawUser === undefined || rawUser === null) return user
  if (typeof rawUser !== 'object' || Array.isArray(rawUser)) throw new Refused()
  for (const key of Object.getOwnPropertyNames(rawUser)) {
    if (FORBIDDEN_KEYS.has(key) || !ALLOWED_USER_KEYS.has(key)) throw new Refused()
  }
  if (rawUser.id !== undefined && (typeof rawUser.id !== 'string' || rawUser.id.length > 128)) throw new Refused()
  if (rawUser.role !== undefined && (typeof rawUser.role !== 'string' || rawUser.role.length > 32)) throw new Refused()
  if (rawUser.name !== undefined) {
    if (typeof rawUser.name !== 'string' || rawUser.name.length > 128 || !rawUser.name.isWellFormed() || rawUser.name.includes('\0')) {
      throw new Refused()
    }
    user.name = rawUser.name
  }
  if (rawUser.cursorSlot !== undefined) {
    if (!Number.isInteger(rawUser.cursorSlot) || rawUser.cursorSlot < 0 || rawUser.cursorSlot > 15) {
      throw new Refused()
    }
    user.cursorSlot = rawUser.cursorSlot
  }
  return user
}

export function receive(bytes, socket, room) {
  try {
    const reader = decoding.createDecoder(bytes)
    if (decoding.readVarUint(reader) !== 1) throw new Refused('one presence identity per connection')
    const id = decoding.readVarUint(reader), clock = decoding.readVarUint(reader)
    const text = decoding.readVarString(reader)
    if (!Number.isSafeInteger(id) || id < 0 || id > 2 ** 32 - 1 || !Number.isSafeInteger(clock) || text.length > 4096 || reader.pos !== bytes.length) throw new Refused()
    if (id === room.awareness.clientID || (socket.presenceId !== null && socket.presenceId !== id) || (room.owners.has(id) && room.owners.get(id) !== socket)) throw new Refused('presence identity belongs to another connection')
    const value = JSON.parse(text)
    let state = null
    if (value !== null) {
      if (typeof value !== 'object' || Array.isArray(value)) throw new Refused()
      for (const key of Object.getOwnPropertyNames(value)) {
        if (FORBIDDEN_KEYS.has(key) || !ALLOWED_TOP_KEYS.has(key)) throw new Refused()
      }
      bounded(value.cursor ?? null)
      bounded(value.selection ?? null)
      state = {
        cursor: value.cursor ?? null,
        selection: value.selection ?? null,
        user: sanitizeUser(value.user, socket.claims),
      }
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, id); encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
    room.owners.set(id, socket)
    socket.presenceId = id
    return encoding.toUint8Array(encoder)
  } catch (error) { throw error instanceof Refused ? error : new Refused('malformed awareness update') }
}

export function awarenessFrame(bytes) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1); encoding.writeVarUint8Array(encoder, bytes)
  return encoding.toUint8Array(encoder)
}
