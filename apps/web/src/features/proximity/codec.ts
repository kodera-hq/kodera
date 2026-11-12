import {
  BEACON_ROTATION_WINDOW_SECS,
  type DeviceIdentitySigner,
  PROXIMITY_FIXED_OVERHEAD_BYTES,
  PROXIMITY_PROTOCOL_VERSION,
  PROXIMITY_REPLAY_ENTRIES,
  ProximityCodecError,
  MAX_PROXIMITY_FRAME_BYTES,
  MAX_PROXIMITY_TEXT_BYTES,
  MAX_PROXIMITY_TTL_HOPS,
  SafetyStatus,
  type SignatureVerifier,
} from './types'

const HEX_CHARS = '0123456789abcdef'
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

// Historical wire data (beacon v1): the label MACed with the bucket. Never renamed.
const BEACON_DOMAIN_PREFIX = UTF8_ENCODER.encode('kodera-beacon-v1')
// Historical wire data (frame v1): the first 20 bytes of every signed input. It keeps the name the
// feature had when v1 was frozen; changing one byte would invalidate every signature.
const SIGNING_DOMAIN_PREFIX = UTF8_ENCODER.encode('kodera-emergency-v1:')

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

function rotr32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0
    out += HEX_CHARS[b >> 4] ?? '0'
    out += HEX_CHARS[b & 0x0f] ?? '0'
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new ProximityCodecError('MalformedFrame', 'Invalid hexadecimal string')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text
  let result = ''
  let usedBytes = 0
  for (const codePoint of text) {
    const encoded = UTF8_ENCODER.encode(codePoint)
    if (usedBytes + encoded.length > maxBytes) break
    result += codePoint
    usedBytes += encoded.length
  }
  return result
}

export function formatBeaconPreview(beacon: Uint8Array): string {
  const hex = bytesToHex(beacon)
  if (hex.length !== 16) return hex
  return `${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}`
}

export function parseSafetyStatus(value: number): SafetyStatus {
  switch (value) {
    case SafetyStatus.MessageOnly:
      return SafetyStatus.MessageOnly
    case SafetyStatus.Safe:
      return SafetyStatus.Safe
    case SafetyStatus.NeedAssistance:
      return SafetyStatus.NeedAssistance
    case SafetyStatus.MusterPoint:
      return SafetyStatus.MusterPoint
    default:
      throw new ProximityCodecError('InvalidStatusBadge')
  }
}

// ---------------------------------------------------------------------------
// 1. Canonical RFC 9562 UUIDv7 Seam
// ---------------------------------------------------------------------------

export class UuidV7 {
  private readonly bytes: Uint8Array

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  static fromParts(unixTsMs: number | bigint, randBytes: Uint8Array): UuidV7 {
    if (randBytes.length !== 10) {
      throw new ProximityCodecError(
        'InvalidUuidV7',
        'UUIDv7 requires exactly 10 random octets'
      )
    }
    const ts = typeof unixTsMs === 'bigint' ? unixTsMs : BigInt(Math.trunc(unixTsMs))
    if (ts < 0n || ts > 0xffffffffffffn) {
      throw new ProximityCodecError('InvalidUuidV7', 'UUIDv7 timestamp out of 48-bit range')
    }

    const out = new Uint8Array(16)
    out[0] = Number((ts >> 40n) & 0xffn)
    out[1] = Number((ts >> 32n) & 0xffn)
    out[2] = Number((ts >> 24n) & 0xffn)
    out[3] = Number((ts >> 16n) & 0xffn)
    out[4] = Number((ts >> 8n) & 0xffn)
    out[5] = Number(ts & 0xffn)
    // Version 7 (0b0111) in top 4 bits of octet 6
    out[6] = 0x70 | ((randBytes[0] ?? 0) & 0x0f)
    out[7] = randBytes[1] ?? 0
    // RFC 9562 variant (0b10) in top 2 bits of octet 8
    out[8] = 0x80 | ((randBytes[2] ?? 0) & 0x3f)
    out.set(randBytes.subarray(3, 10), 9)

    return new UuidV7(out)
  }

  static fromBytesChecked(bytes: Uint8Array): UuidV7 {
    if (bytes.length !== 16) {
      throw new ProximityCodecError('InvalidUuidV7')
    }
    const b6 = bytes[6] ?? 0
    const b8 = bytes[8] ?? 0
    if (b6 >> 4 !== 0x07 || b8 >> 6 !== 0b10) {
      throw new ProximityCodecError('InvalidUuidV7')
    }
    return new UuidV7(new Uint8Array(bytes))
  }

  asBytes(): Uint8Array {
    return new Uint8Array(this.bytes)
  }

  timestampMs(): number {
    const b0 = BigInt(this.bytes[0] ?? 0)
    const b1 = BigInt(this.bytes[1] ?? 0)
    const b2 = BigInt(this.bytes[2] ?? 0)
    const b3 = BigInt(this.bytes[3] ?? 0)
    const b4 = BigInt(this.bytes[4] ?? 0)
    const b5 = BigInt(this.bytes[5] ?? 0)
    const combined =
      (b0 << 40n) | (b1 << 32n) | (b2 << 24n) | (b3 << 16n) | (b4 << 8n) | b5
    return Number(combined)
  }

  compareTo(other: UuidV7): number {
    for (let i = 0; i < 16; i += 1) {
      const a = this.bytes[i] ?? 0
      const b = other.bytes[i] ?? 0
      if (a !== b) return a < b ? -1 : 1
    }
    return 0
  }

  equals(other: UuidV7): boolean {
    return constantTimeEqual(this.bytes, other.bytes)
  }

  toString(): string {
    const hex = bytesToHex(this.bytes)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }
}

// ---------------------------------------------------------------------------
// 2. Proximity Store-and-Forward Frame Codec (`ProximityFrame`), frame v1, frozen
// ---------------------------------------------------------------------------

export interface ProximityFrameInit {
  readonly messageId: UuidV7
  readonly senderPublicKey: Uint8Array
  readonly ttlHops: number
  readonly status: SafetyStatus
  readonly text: string
  readonly signature: Uint8Array
}

export class ProximityFrame {
  // Historical wire data (frame v1): the two magic octets, "KE". Never renamed.
  static readonly MAGIC = new Uint8Array([0x4b, 0x45]) // "KE"
  static readonly VERSION = PROXIMITY_PROTOCOL_VERSION
  static readonly FIXED_OVERHEAD = PROXIMITY_FIXED_OVERHEAD_BYTES
  static readonly MAX_PROXIMITY_FRAME_BYTES = MAX_PROXIMITY_FRAME_BYTES
  static readonly MAX_PROXIMITY_TEXT_BYTES = MAX_PROXIMITY_TEXT_BYTES
  static readonly MAX_PROXIMITY_TTL_HOPS = MAX_PROXIMITY_TTL_HOPS

  readonly messageId: UuidV7
  readonly senderPublicKey: Uint8Array
  readonly ttlHops: number
  readonly status: SafetyStatus
  readonly text: string
  readonly signature: Uint8Array

  constructor(init: ProximityFrameInit) {
    this.messageId = init.messageId
    this.senderPublicKey = new Uint8Array(init.senderPublicKey)
    this.ttlHops = init.ttlHops
    this.status = init.status
    this.text = init.text
    this.signature = new Uint8Array(init.signature)
  }

  static signingTranscript(
    messageId: UuidV7,
    senderPk: Uint8Array,
    status: SafetyStatus,
    textBytes: Uint8Array
  ): Uint8Array {
    if (senderPk.length !== 32) {
      throw new ProximityCodecError('MalformedFrame', 'senderPublicKey must be 32 bytes')
    }
    // Historical wire data (frame v1): the signed input's layout, label 0..20, id 20..36,
    // sender 36..68, status 68, text length 69, text from 70.
    const out = new Uint8Array(70 + textBytes.length)
    out.set(SIGNING_DOMAIN_PREFIX, 0)
    out.set(messageId.asBytes(), 20)
    out.set(senderPk, 36)
    out[68] = status & 0xff
    out[69] = textBytes.length & 0xff
    out.set(textBytes, 70)
    return out
  }

  static newSigned(
    messageId: UuidV7,
    ttlHops: number,
    status: SafetyStatus,
    text: string,
    signer: DeviceIdentitySigner
  ): ProximityFrame {
    if (!Number.isInteger(ttlHops) || ttlHops <= 0 || ttlHops > MAX_PROXIMITY_TTL_HOPS) {
      throw new ProximityCodecError('InvalidTtl')
    }
    const validatedStatus = parseSafetyStatus(status)
    const textBytes = UTF8_ENCODER.encode(text)
    if (textBytes.length > MAX_PROXIMITY_TEXT_BYTES) {
      throw new ProximityCodecError('PayloadTooLarge')
    }

    const senderPublicKey = signer.publicKey()
    if (senderPublicKey.length !== 32) {
      throw new ProximityCodecError('CryptoFailure', 'Signer public key must be 32 bytes')
    }

    const transcript = ProximityFrame.signingTranscript(
      messageId,
      senderPublicKey,
      validatedStatus,
      textBytes
    )
    const signature = signer.sign(transcript)
    if (signature.length !== 64) {
      throw new ProximityCodecError('CryptoFailure', 'Ed25519 signature must be 64 bytes')
    }

    return new ProximityFrame({
      messageId,
      senderPublicKey,
      ttlHops,
      status: validatedStatus,
      text,
      signature,
    })
  }

  verifySender(
    allowedOrgRoster: Iterable<Uint8Array | string>,
    verifier: SignatureVerifier
  ): true {
    const senderHex = bytesToHex(this.senderPublicKey)
    let authorized = false
    for (const entry of allowedOrgRoster) {
      const entryHex = typeof entry === 'string' ? entry.toLowerCase() : bytesToHex(entry)
      if (entryHex === senderHex) {
        authorized = true
        break
      }
    }
    if (!authorized) {
      throw new ProximityCodecError('UnauthorizedSender')
    }

    const textBytes = UTF8_ENCODER.encode(this.text)
    const transcript = ProximityFrame.signingTranscript(
      this.messageId,
      this.senderPublicKey,
      this.status,
      textBytes
    )
    const result = verifier.verify(this.senderPublicKey, transcript, this.signature)
    if (result === false) {
      throw new ProximityCodecError('InvalidSignature')
    }
    return true
  }

  decrementHop(): ProximityFrame | null {
    if (this.ttlHops <= 1) {
      return null
    }
    return new ProximityFrame({
      messageId: this.messageId,
      senderPublicKey: this.senderPublicKey,
      ttlHops: this.ttlHops - 1,
      status: this.status,
      text: this.text,
      signature: this.signature,
    })
  }

  encode(): Uint8Array {
    if (!Number.isInteger(this.ttlHops) || this.ttlHops <= 0 || this.ttlHops > MAX_PROXIMITY_TTL_HOPS) {
      throw new ProximityCodecError('InvalidTtl')
    }
    const textBytes = UTF8_ENCODER.encode(this.text)
    if (textBytes.length > MAX_PROXIMITY_TEXT_BYTES) {
      throw new ProximityCodecError('PayloadTooLarge')
    }
    const total = ProximityFrame.FIXED_OVERHEAD + textBytes.length
    if (total > MAX_PROXIMITY_FRAME_BYTES) {
      throw new ProximityCodecError('PayloadTooLarge')
    }
    if (this.senderPublicKey.length !== 32 || this.signature.length !== 64) {
      throw new ProximityCodecError('MalformedFrame')
    }

    // Historical wire data (frame v1): the frame's layout, magic 0..2, version 2, id 3..19,
    // sender 19..51, hops 51, status 52, text length 53, text from 54, then the signature.
    const out = new Uint8Array(total)
    out.set(ProximityFrame.MAGIC, 0)
    out[2] = ProximityFrame.VERSION
    out.set(this.messageId.asBytes(), 3)
    out.set(this.senderPublicKey, 19)
    out[51] = this.ttlHops
    out[52] = this.status
    out[53] = textBytes.length
    out.set(textBytes, 54)
    out.set(this.signature, 54 + textBytes.length)
    return out
  }

  static decode(raw: Uint8Array): ProximityFrame {
    if (
      raw.length < ProximityFrame.FIXED_OVERHEAD ||
      raw.length > MAX_PROXIMITY_FRAME_BYTES
    ) {
      throw new ProximityCodecError('MalformedFrame')
    }
    if (
      raw[0] !== ProximityFrame.MAGIC[0] ||
      raw[1] !== ProximityFrame.MAGIC[1] ||
      raw[2] !== ProximityFrame.VERSION
    ) {
      throw new ProximityCodecError('MalformedFrame')
    }

    const messageId = UuidV7.fromBytesChecked(raw.subarray(3, 19))
    const senderPublicKey = raw.slice(19, 51)
    const ttlHops = raw[51] ?? 0
    if (ttlHops === 0 || ttlHops > MAX_PROXIMITY_TTL_HOPS) {
      throw new ProximityCodecError('InvalidTtl')
    }

    const status = parseSafetyStatus(raw[52] ?? 255)
    const textLen = raw[53] ?? 0
    if (
      textLen > MAX_PROXIMITY_TEXT_BYTES ||
      ProximityFrame.FIXED_OVERHEAD + textLen !== raw.length
    ) {
      throw new ProximityCodecError('MalformedFrame')
    }

    let text: string
    try {
      text = UTF8_DECODER.decode(raw.subarray(54, 54 + textLen))
    } catch {
      throw new ProximityCodecError('MalformedFrame')
    }

    const signature = raw.slice(54 + textLen, 54 + textLen + 64)
    return new ProximityFrame({
      messageId,
      senderPublicKey,
      ttlHops,
      status,
      text,
      signature,
    })
  }

  equals(other: ProximityFrame): boolean {
    return (
      this.messageId.equals(other.messageId) &&
      constantTimeEqual(this.senderPublicKey, other.senderPublicKey) &&
      this.ttlHops === other.ttlHops &&
      this.status === other.status &&
      this.text === other.text &&
      constantTimeEqual(this.signature, other.signature)
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Deduplication Ring (`ProximityReplayGuard`)
// ---------------------------------------------------------------------------

export class ProximityReplayGuard {
  private readonly seen = new Set<string>()
  readonly maxEntries: number

  constructor(maxEntries = 64) {
    this.maxEntries = Math.min(PROXIMITY_REPLAY_ENTRIES, Math.max(64, Math.trunc(maxEntries)))
  }

  acceptOnce(id: UuidV7): boolean {
    const key = id.toString()
    if (this.seen.has(key)) {
      return false
    }
    if (this.seen.size >= this.maxEntries) {
      let oldest: string | undefined
      for (const existing of this.seen) {
        if (oldest === undefined || existing < oldest) {
          oldest = existing
        }
      }
      if (oldest !== undefined) {
        this.seen.delete(oldest)
      }
    }
    this.seen.add(key)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

// ---------------------------------------------------------------------------
// 4. FIPS 180-4 SHA-256, RFC 2104 HMAC-SHA256 & Rotating Proximity Beacon
// ---------------------------------------------------------------------------

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ])

  const bitLen = BigInt(data.length) * 8n
  const rem = (data.length + 1) % 64
  const zeroPad = rem <= 56 ? 56 - rem : 64 + 56 - rem
  const padded = new Uint8Array(data.length + 1 + zeroPad + 8)
  padded.set(data, 0)
  padded[data.length] = 0x80

  const lenOffset = padded.length - 8
  for (let i = 0; i < 8; i += 1) {
    padded[lenOffset + i] = Number((bitLen >> BigInt((7 - i) * 8)) & 0xffn)
  }

  const w = new Uint32Array(64)
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)

  for (let chunkOffset = 0; chunkOffset < padded.length; chunkOffset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(chunkOffset + i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0
      const w2 = w[i - 2] ?? 0
      const s0 = (rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3)) >>> 0
      const s1 = (rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10)) >>> 0
      w[i] = (((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0)
    }

    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let d = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const s0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (s0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0
    h[1] = ((h[1] ?? 0) + b) >>> 0
    h[2] = ((h[2] ?? 0) + c) >>> 0
    h[3] = ((h[3] ?? 0) + d) >>> 0
    h[4] = ((h[4] ?? 0) + e) >>> 0
    h[5] = ((h[5] ?? 0) + f) >>> 0
    h[6] = ((h[6] ?? 0) + g) >>> 0
    h[7] = ((h[7] ?? 0) + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i] ?? 0, false)
  }
  return out
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const keyBlock = new Uint8Array(64)
  if (key.length > 64) {
    keyBlock.set(sha256(key), 0)
  } else {
    keyBlock.set(key, 0)
  }

  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i += 1) {
    const kb = keyBlock[i] ?? 0
    ipad[i] = 0x36 ^ kb
    opad[i] = 0x5c ^ kb
  }

  const inner = new Uint8Array(64 + message.length)
  inner.set(ipad, 0)
  inner.set(message, 64)
  const innerHash = sha256(inner)

  const outer = new Uint8Array(96)
  outer.set(opad, 0)
  outer.set(innerHash, 64)
  return sha256(outer)
}

export function computeProximityBeacon(
  orgBeaconSalt: Uint8Array,
  unixSecs: number
): Uint8Array {
  if (orgBeaconSalt.length !== 32) {
    throw new ProximityCodecError('CryptoFailure', 'orgBeaconSalt must be 32 bytes')
  }
  // Historical wire data (beacon v1): label 0..16, big-endian bucket 16..24, first 8 MAC bytes.
  const bucket = BigInt(Math.floor(Math.max(0, Math.trunc(unixSecs)) / BEACON_ROTATION_WINDOW_SECS))
  const msg = new Uint8Array(24)
  msg.set(BEACON_DOMAIN_PREFIX, 0)
  for (let i = 0; i < 8; i += 1) {
    msg[16 + i] = Number((bucket >> BigInt((7 - i) * 8)) & 0xffn)
  }
  const mac = hmacSha256(orgBeaconSalt, msg)
  return mac.slice(0, 8)
}

export function createKeyedMacSigner(
  secret: Uint8Array,
  publicKey: Uint8Array
): DeviceIdentitySigner {
  if (secret.length !== 32 || publicKey.length !== 32) {
    throw new ProximityCodecError('CryptoFailure', 'Keyed MAC signer requires 32-byte keys')
  }
  const secretCopy = new Uint8Array(secret)
  const pkCopy = new Uint8Array(publicKey)
  return {
    publicKey(): Uint8Array {
      return new Uint8Array(pkCopy)
    },
    sign(message: Uint8Array): Uint8Array {
      const left = hmacSha256(secretCopy, message)
      const right = hmacSha256(left, pkCopy)
      const sig = new Uint8Array(64)
      sig.set(left, 0)
      sig.set(right, 32)
      return sig
    },
  }
}

export function createKeyedMacVerifier(secret: Uint8Array): SignatureVerifier {
  if (secret.length !== 32) {
    throw new ProximityCodecError('CryptoFailure', 'Keyed MAC verifier requires 32-byte secret')
  }
  const secretCopy = new Uint8Array(secret)
  return {
    verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
      if (publicKey.length !== 32 || signature.length !== 64) return false
      const left = hmacSha256(secretCopy, message)
      const right = hmacSha256(left, publicKey)
      return (
        constantTimeEqual(signature.subarray(0, 32), left) &&
        constantTimeEqual(signature.subarray(32, 64), right)
      )
    },
  }
}
