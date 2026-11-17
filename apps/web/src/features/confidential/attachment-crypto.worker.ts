// Worker-internal attachment AEAD. Never import this module from document code.
if (Reflect.has(globalThis, 'document')) throw new Error('Attachment crypto requires a worker.')

export const MAX_CONFIDENTIAL_ATTACHMENT_BYTES = 25 * 1024 * 1024 - 16
const ALGORITHM = 'AES-256-GCM' as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const NIL = '00000000-0000-0000-0000-000000000000'
const encoder = new TextEncoder()
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get

export interface ConfidentialAttachmentContext {
  readonly roomId: string
  readonly epoch: number
  readonly attachmentId: string
}
export interface ConfidentialAttachmentUpload {
  readonly version: 1
  readonly algorithm: typeof ALGORITHM
  readonly ciphertextSha256: string
  readonly ciphertextBytes: number
}
export interface EncryptedConfidentialAttachment {
  readonly ciphertext: Uint8Array<ArrayBuffer>
  readonly upload: ConfidentialAttachmentUpload
  // Sensitive: only the worker's encrypted room-payload pipeline may consume it.
  readonly secretDescriptor: string
}
export class ConfidentialAttachmentCryptoError extends Error {
  constructor() { super('Confidential attachment crypto refused.'); this.name = 'ConfidentialAttachmentCryptoError' }
}
function need(value: unknown): asserts value {
  if (!value) throw new ConfidentialAttachmentCryptoError()
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors)
  need(actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key)))
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const property = descriptors[key]
    need(property && property.enumerable && 'value' in property)
    result[key] = property.value
  }
  return result
}
function id(value: unknown): asserts value is string {
  need(typeof value === 'string' && value.length === 36 && UUID.test(value) && value !== NIL)
}
function context(value: unknown): ConfidentialAttachmentContext {
  const v = object(value, ['roomId', 'epoch', 'attachmentId'])
  id(v.roomId); id(v.attachmentId)
  need(typeof v.epoch === 'number' && Number.isSafeInteger(v.epoch) && v.epoch >= 0)
  return Object.freeze({ roomId: v.roomId, epoch: v.epoch, attachmentId: v.attachmentId })
}
function bytes(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  need(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
  const buffer: unknown = Reflect.apply(bufferOf, value, [])
  const length: number = Reflect.apply(lengthOf, value, [])
  need(buffer instanceof ArrayBuffer && (!resizable || Reflect.apply(resizable, buffer, []) === false) &&
    length >= minimum && length <= maximum)
  const copy = new Uint8Array(length); copy.set(value); return copy
}
function aad(value: ConfidentialAttachmentContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['kodera-confidential-attachment', 1, value.roomId, value.epoch, value.attachmentId]))
}
function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
}
function decode(value: unknown, length: number): Uint8Array<ArrayBuffer> {
  need(typeof value === 'string' && value.length === Math.ceil(length / 3) * 4)
  const result = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  try { need(result.length === length && base64(result) === value); return result }
  catch (error) { result.fill(0); throw error }
}
async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (v) => v.toString(16).padStart(2, '0')).join('')
}

export async function encryptConfidentialAttachment(input: {
  readonly context: ConfidentialAttachmentContext; readonly plaintext: Uint8Array
}): Promise<EncryptedConfidentialAttachment> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined, rawKey: Uint8Array<ArrayBuffer> | undefined
  let iv: Uint8Array<ArrayBuffer> | undefined, ciphertext: Uint8Array<ArrayBuffer> | undefined
  try {
    const fields = object(input, ['context', 'plaintext']), scope = context(fields.context)
    plaintext = bytes(fields.plaintext, 1, MAX_CONFIDENTIAL_ATTACHMENT_BYTES)
    rawKey = crypto.getRandomValues(new Uint8Array(32)); iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(scope), tagLength: 128 }, key, plaintext))
    const ciphertextSha256 = await digest(ciphertext), ciphertextBytes = ciphertext.length
    const secretDescriptor = JSON.stringify({ version: 1, algorithm: ALGORITHM, ...scope,
      keyBase64: base64(rawKey), ivBase64: base64(iv), ciphertextSha256, ciphertextBytes })
    const result = Object.freeze({ ciphertext, upload: Object.freeze({ version: 1 as const, algorithm: ALGORITHM,
      ciphertextSha256, ciphertextBytes }), secretDescriptor })
    ciphertext = undefined
    return result
  } catch { throw new ConfidentialAttachmentCryptoError() }
  finally { plaintext?.fill(0); rawKey?.fill(0); iv?.fill(0); ciphertext?.fill(0) }
}

export async function decryptConfidentialAttachment(input: {
  readonly context: ConfidentialAttachmentContext; readonly ciphertext: Uint8Array; readonly secretDescriptor: string
}): Promise<Uint8Array<ArrayBuffer>> {
  let ciphertext: Uint8Array<ArrayBuffer> | undefined, rawKey: Uint8Array<ArrayBuffer> | undefined
  let iv: Uint8Array<ArrayBuffer> | undefined
  try {
    const fields = object(input, ['context', 'ciphertext', 'secretDescriptor']), scope = context(fields.context)
    need(typeof fields.secretDescriptor === 'string' && fields.secretDescriptor.length <= 1024)
    const d = object(JSON.parse(fields.secretDescriptor) as unknown, ['version', 'algorithm', 'roomId', 'epoch', 'attachmentId',
      'keyBase64', 'ivBase64', 'ciphertextSha256', 'ciphertextBytes'])
    need(d.version === 1 && d.algorithm === ALGORITHM && d.roomId === scope.roomId && d.epoch === scope.epoch && d.attachmentId === scope.attachmentId)
    need(typeof d.ciphertextSha256 === 'string' && d.ciphertextSha256.length === 64 && HEX.test(d.ciphertextSha256))
    need(typeof d.ciphertextBytes === 'number' && Number.isSafeInteger(d.ciphertextBytes) && d.ciphertextBytes >= 17 &&
      d.ciphertextBytes <= MAX_CONFIDENTIAL_ATTACHMENT_BYTES + 16)
    need(JSON.stringify({ version: 1, algorithm: ALGORITHM, ...scope, keyBase64: d.keyBase64, ivBase64: d.ivBase64,
      ciphertextSha256: d.ciphertextSha256, ciphertextBytes: d.ciphertextBytes }) === fields.secretDescriptor)
    rawKey = decode(d.keyBase64, 32); iv = decode(d.ivBase64, 12)
    ciphertext = bytes(fields.ciphertext, 17, MAX_CONFIDENTIAL_ATTACHMENT_BYTES + 16)
    need(ciphertext.length === d.ciphertextBytes && await digest(ciphertext) === d.ciphertextSha256)
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(scope), tagLength: 128 }, key, ciphertext))
  } catch { throw new ConfidentialAttachmentCryptoError() }
  finally { ciphertext?.fill(0); rawKey?.fill(0); iv?.fill(0) }
}
