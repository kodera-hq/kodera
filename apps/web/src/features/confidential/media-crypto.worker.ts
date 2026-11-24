// Worker-only encoded media encryption; secret provisioning never uses the SDK key provider.
import {
  ConfidentialCryptoError,
  WorkerFrameCryptor,
  fields,
  integer,
  need,
  ownedBytes,
  text,
} from './crypto-session.worker-core'
if (typeof window !== 'undefined' || Reflect.has(globalThis, 'document'))
  throw new Error('Media crypto requires a worker.')

export const SFRAME_MEDIA_DOMAIN = 'kodera-sframe-media-v1'
export const SFRAME_REPLAY_WINDOW_FRAMES = 1024
export const SFRAME_EPOCH_GRACE_MS = 2000
export const MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES = 64
export const SFRAME_SENDER_GENERATION_BYTES = 8
const SFRAME_RATCHET_BITS = 16n
const MAX_SFRAME_EPOCH = (1n << 48n) - 1n
const MAX_U64 = (1n << 64n) - 1n
const utf8Encoder = new TextEncoder()

export type ConfidentialMediaProtocol = 'ksm1' | 'sframe-v1'
export type ConfidentialTrackKind = 'audio' | 'video'

export interface MediaCryptoContext {
  readonly roomId: string
  readonly epoch: number
  readonly participantIdentity: string
}

export interface SFrameSessionOptions {
  readonly unencryptedPrefixLength?: number
  readonly senderGeneration?: bigint
  readonly now?: () => number
}

export interface SFrameFrameOptions {
  readonly unencryptedPrefixLength?: number
}

export interface SFrameEpochRotationOptions {
  readonly memberRemoved?: boolean
  readonly graceWindowMs?: number
}

export interface MediaSessionCreateOptions extends SFrameSessionOptions {
  readonly protocol?: ConfidentialMediaProtocol
}

export interface SFrameHeader {
  readonly epoch: number
  readonly ratchetStep: number
  readonly counter: bigint
}

export function mediaContext(input: unknown): MediaCryptoContext {
  const value = fields(input, ['roomId', 'epoch', 'participantIdentity'])
  text(value.roomId)
  integer(value.epoch)
  text(value.participantIdentity)
  return Object.freeze({
    roomId: value.roomId,
    epoch: value.epoch,
    participantIdentity: value.participantIdentity,
  })
}

export function defaultUnencryptedPrefixLength(
  kind: ConfidentialTrackKind,
  codec?: string,
  frameType?: string
): number {
  if (kind === 'audio') return 0
  const normalized = codec?.trim().toLowerCase()
  if (normalized === 'vp8') return frameType === 'key' ? 10 : 3
  if (normalized === 'h264' || normalized === 'avc1') return 2
  if (normalized === 'av1' || normalized === 'av01') return 2
  return 0
}

function u16be(value: number): Uint8Array<ArrayBuffer> {
  need(Number.isInteger(value) && value >= 0 && value <= 0xffff)
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, false)
  return out
}

function u64be(value: bigint): Uint8Array<ArrayBuffer> {
  need(value >= 0n && value <= MAX_U64)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, false)
  return out
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function encodeMinimalBigUint64(value: bigint): {
  extended: boolean
  bits: number
  bytes: Uint8Array<ArrayBuffer>
} {
  need(value >= 0n && value <= MAX_U64)
  if (value <= 7n) {
    return { extended: false, bits: Number(value), bytes: new Uint8Array(0) }
  }
  const full = u64be(value)
  let firstNonZero = 0
  while (firstNonZero < 7 && full[firstNonZero] === 0) firstNonZero++
  const minimal = full.slice(firstNonZero)
  return { extended: true, bits: minimal.byteLength - 1, bytes: minimal }
}

function decodeCanonicalBigUint64(
  extended: boolean,
  bits: number,
  source: Uint8Array,
  offset: number
): { value: bigint; nextOffset: number } {
  if (!extended) return { value: BigInt(bits), nextOffset: offset }
  const length = bits + 1
  need(offset + length <= source.byteLength)
  const slice = source.subarray(offset, offset + length)
  need(slice[0] !== 0 && !(length === 1 && slice[0]! <= 7))
  const padded = new Uint8Array(8)
  padded.set(slice, 8 - length)
  const value = new DataView(padded.buffer).getBigUint64(0, false)
  return { value, nextOffset: offset + length }
}

export function encodeSFrameHeader(
  epoch: number,
  ratchetStep: number,
  counter: bigint
): Uint8Array<ArrayBuffer> {
  need(Number.isSafeInteger(epoch) && epoch >= 0 && BigInt(epoch) <= MAX_SFRAME_EPOCH)
  need(Number.isInteger(ratchetStep) && ratchetStep >= 0 && ratchetStep <= 0xffff)
  const keyId = (BigInt(epoch) << SFRAME_RATCHET_BITS) | BigInt(ratchetStep)
  const kid = encodeMinimalBigUint64(keyId)
  const ctr = encodeMinimalBigUint64(counter)
  const configByte =
    ((kid.extended ? 1 : 0) << 7) | (kid.bits << 4) | ((ctr.extended ? 1 : 0) << 3) | ctr.bits
  return concatBytes([new Uint8Array([configByte]), kid.bytes, ctr.bytes])
}

export function decodeSFrameHeader(input: Uint8Array): {
  header: SFrameHeader
  bytesRead: number
} {
  need(input.byteLength >= 1)
  const configByte = input[0]!
  const xFlag = (configByte & 0x80) !== 0
  const kBits = (configByte >> 4) & 0x07
  const yFlag = (configByte & 0x08) !== 0
  const cBits = configByte & 0x07
  const kid = decodeCanonicalBigUint64(xFlag, kBits, input, 1)
  const ctr = decodeCanonicalBigUint64(yFlag, cBits, input, kid.nextOffset)
  const epochBig = kid.value >> SFRAME_RATCHET_BITS
  need(epochBig <= BigInt(Number.MAX_SAFE_INTEGER))
  return {
    header: {
      epoch: Number(epochBig),
      ratchetStep: Number(kid.value & 0xffffn),
      counter: ctr.value,
    },
    bytesRead: ctr.nextOffset,
  }
}

function validateNonZeroSecret(secret: Uint8Array): void {
  let diff = 0
  for (const byte of secret) diff |= byte
  need(diff !== 0)
}

export async function deriveSFrameEpochRootKey(
  mlsEpochSecret: Uint8Array,
  roomId: string,
  epoch: number
): Promise<Uint8Array<ArrayBuffer>> {
  const secretCopy = ownedBytes(mlsEpochSecret, 32, 32)
  text(roomId)
  need(Number.isSafeInteger(epoch) && epoch >= 0 && BigInt(epoch) <= MAX_SFRAME_EPOCH)
  validateNonZeroSecret(secretCopy)
  try {
    const roomBytes = utf8Encoder.encode(roomId)
    const info = concatBytes([
      utf8Encoder.encode(`${SFRAME_MEDIA_DOMAIN}\0epoch-root\0`),
      u16be(roomBytes.byteLength),
      roomBytes,
      u64be(BigInt(epoch)),
    ])
    const baseKey = await crypto.subtle.importKey('raw', secretCopy, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8Encoder.encode(SFRAME_MEDIA_DOMAIN),
        info,
      },
      baseKey,
      256
    )
    return new Uint8Array(bits)
  } finally {
    secretCopy.fill(0)
  }
}

function randomNonZeroU64(): bigint {
  const buf = new Uint8Array(SFRAME_SENDER_GENERATION_BYTES)
  for (let attempt = 0; attempt < 8; attempt++) {
    crypto.getRandomValues(buf)
    const value = new DataView(buf.buffer).getBigUint64(0, false)
    if (value > 0n) return value
  }
  throw new ConfidentialCryptoError()
}

export async function deriveSFrameSenderKeyMaterial(
  epochRootKey: Uint8Array,
  roomId: string,
  epoch: number,
  senderDeviceId: string,
  senderGeneration: bigint,
  kind: ConfidentialTrackKind,
  ratchetStep: number
): Promise<{ cryptoKey: CryptoKey; baseSalt: Uint8Array<ArrayBuffer> }> {
  const rootCopy = ownedBytes(epochRootKey, 32, 32)
  text(roomId)
  text(senderDeviceId)
  need(kind === 'audio' || kind === 'video')
  need(Number.isSafeInteger(epoch) && epoch >= 0 && BigInt(epoch) <= MAX_SFRAME_EPOCH)
  need(typeof senderGeneration === 'bigint' && senderGeneration > 0n && senderGeneration <= MAX_U64)
  need(Number.isInteger(ratchetStep) && ratchetStep >= 0 && ratchetStep <= 0xffff)
  validateNonZeroSecret(rootCopy)
  let okm: Uint8Array<ArrayBuffer> | undefined
  let aeadKeyBytes: Uint8Array<ArrayBuffer> | undefined
  try {
    const roomBytes = utf8Encoder.encode(roomId)
    const senderBytes = utf8Encoder.encode(senderDeviceId)
    const info = concatBytes([
      utf8Encoder.encode(`${SFRAME_MEDIA_DOMAIN}\0sender-key\0`),
      u16be(roomBytes.byteLength),
      roomBytes,
      u64be(BigInt(epoch)),
      u16be(senderBytes.byteLength),
      senderBytes,
      u64be(senderGeneration),
      new Uint8Array([kind === 'audio' ? 1 : 2]),
      u16be(ratchetStep),
    ])
    const hkdfKey = await crypto.subtle.importKey('raw', rootCopy, 'HKDF', false, ['deriveBits'])
    okm = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: utf8Encoder.encode(SFRAME_MEDIA_DOMAIN),
          info,
        },
        hkdfKey,
        352
      )
    )
    aeadKeyBytes = okm.slice(0, 32)
    const baseSalt = okm.slice(32, 44)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      aeadKeyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    return { cryptoKey, baseSalt }
  } finally {
    rootCopy.fill(0)
    okm?.fill(0)
    aeadKeyBytes?.fill(0)
  }
}

export function computeSFrameNonce(
  baseSalt: Uint8Array,
  counter: bigint
): Uint8Array<ArrayBuffer> {
  need(baseSalt.byteLength === 12)
  const nonce = new Uint8Array(baseSalt)
  const ctrBytes = u64be(counter)
  for (let index = 0; index < 8; index++) {
    nonce[4 + index] = nonce[4 + index]! ^ ctrBytes[index]!
  }
  return nonce
}

export function buildSFrameAad(
  roomId: string,
  epoch: number,
  ratchetStep: number,
  kind: ConfidentialTrackKind,
  senderDeviceId: string,
  senderGeneration: bigint,
  unencryptedPrefix: Uint8Array,
  headerBytes: Uint8Array
): Uint8Array<ArrayBuffer> {
  text(roomId)
  text(senderDeviceId)
  need(typeof senderGeneration === 'bigint' && senderGeneration > 0n && senderGeneration <= MAX_U64)
  need(kind === 'audio' || kind === 'video')
  need(
    unencryptedPrefix.byteLength <= MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES &&
      (kind !== 'audio' || unencryptedPrefix.byteLength === 0)
  )
  need(headerBytes.byteLength >= 1 && headerBytes.byteLength <= 17)
  const roomBytes = utf8Encoder.encode(roomId)
  const senderBytes = utf8Encoder.encode(senderDeviceId)
  return concatBytes([
    utf8Encoder.encode(`${SFRAME_MEDIA_DOMAIN}\0aad\0`),
    u16be(roomBytes.byteLength),
    roomBytes,
    u64be(BigInt(epoch)),
    u16be(ratchetStep),
    new Uint8Array([kind === 'audio' ? 1 : 2]),
    u16be(senderBytes.byteLength),
    senderBytes,
    u64be(senderGeneration),
    u16be(unencryptedPrefix.byteLength),
    unencryptedPrefix,
    headerBytes,
  ])
}

class SlidingReplayWindow1024 {
  #highest: bigint | null = null
  #seen = new Set<bigint>()

  check(counter: bigint): void {
    need(counter >= 0n && counter <= MAX_U64)
    if (this.#highest === null) return
    if (counter > this.#highest) return
    const delta = this.#highest - counter
    need(delta < BigInt(SFRAME_REPLAY_WINDOW_FRAMES))
    need(!this.#seen.has(counter))
  }

  commit(counter: bigint): void {
    this.check(counter)
    const nextHighest =
      this.#highest === null || counter > this.#highest ? counter : this.#highest
    this.#highest = nextHighest
    this.#seen.add(counter)
    const floor =
      nextHighest >= BigInt(SFRAME_REPLAY_WINDOW_FRAMES)
        ? nextHighest - BigInt(SFRAME_REPLAY_WINDOW_FRAMES)
        : -1n
    for (const entry of this.#seen) {
      if (entry <= floor) this.#seen.delete(entry)
    }
  }

  clear(): void {
    this.#highest = null
    this.#seen.clear()
  }
}

interface ReceiveEpochSlot {
  epoch: number
  rootKey: Uint8Array<ArrayBuffer>
  expiresAtMs: number | null
  replay: Map<string, SlidingReplayWindow1024>
  generationOwners: Map<bigint, string>
  derivedKeys: Map<string, { cryptoKey: CryptoKey; baseSalt: Uint8Array<ArrayBuffer> }>
}

function purgeReceiveSlot(slot: ReceiveEpochSlot | undefined): void {
  if (!slot) return
  slot.rootKey.fill(0)
  for (const cached of slot.derivedKeys.values()) cached.baseSalt.fill(0)
  slot.derivedKeys.clear()
  slot.replay.clear()
  slot.generationOwners.clear()
}

export interface SFrameMediaSessionHandle {
  readonly epoch: number
  readonly senderGeneration: bigint
  readonly ratchetStep: number
  isActive(): boolean
  close(): void
  seal(
    frame: Uint8Array,
    kind: ConfidentialTrackKind,
    options?: SFrameFrameOptions
  ): Promise<Uint8Array<ArrayBuffer>>
  open(
    frame: Uint8Array,
    kind: ConfidentialTrackKind,
    participantIdentity: string,
    options?: SFrameFrameOptions
  ): Promise<Uint8Array<ArrayBuffer>>
  rotateEpochKey(
    nextEpoch: number,
    nextSecret: Uint8Array,
    options?: SFrameEpochRotationOptions
  ): Promise<void>
  ratchetEpochKey(nextEpoch: number): Promise<void>
  ratchetSenderStep(): Promise<number>
}

export function createSFrameMediaSession(
  context: MediaCryptoContext,
  secret: Uint8Array,
  options: SFrameSessionOptions = {}
): SFrameMediaSessionHandle {
  const scope = mediaContext(context)
  const initialSecret = ownedBytes(secret, 32, 32)
  validateNonZeroSecret(initialSecret)
  const defaultVideoPrefix = options.unencryptedPrefixLength ?? 0
  need(
    Number.isInteger(defaultVideoPrefix) &&
      defaultVideoPrefix >= 0 &&
      defaultVideoPrefix <= MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES
  )
  const initialGeneration = options.senderGeneration ?? randomNonZeroU64()
  need(
    typeof initialGeneration === 'bigint' &&
      initialGeneration > 0n &&
      initialGeneration <= MAX_U64
  )
  const now = options.now ?? (() => Date.now())

  let active = true
  let sendEpoch = scope.epoch
  let sendGeneration = initialGeneration
  let sendRatchetStep = 0
  let sendEpochSecret: Uint8Array<ArrayBuffer> = initialSecret
  let sendRootKey: Uint8Array<ArrayBuffer> | undefined
  const sendDerived = new Map<string, { cryptoKey: CryptoKey; baseSalt: Uint8Array<ArrayBuffer> }>()
  let audioCounter = 0n
  let videoCounter = 0n

  let currentReceive: ReceiveEpochSlot | undefined
  let graceReceive: ReceiveEpochSlot | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()

  const clearGrace = () => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    purgeReceiveSlot(graceReceive)
    graceReceive = undefined
  }

  const close = () => {
    active = false
    sendEpochSecret.fill(0)
    sendRootKey?.fill(0)
    sendRootKey = undefined
    for (const cached of sendDerived.values()) cached.baseSalt.fill(0)
    sendDerived.clear()
    purgeReceiveSlot(currentReceive)
    currentReceive = undefined
    clearGrace()
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function ensureInitialized(): Promise<void> {
    if (sendRootKey && currentReceive) return
    const root = await deriveSFrameEpochRootKey(sendEpochSecret, scope.roomId, sendEpoch)
    need(active)
    sendRootKey = root
    currentReceive = {
      epoch: sendEpoch,
      rootKey: new Uint8Array(root),
      expiresAtMs: null,
      replay: new Map(),
      generationOwners: new Map(),
      derivedKeys: new Map(),
    }
  }

  async function senderMaterialFor(
    slotRootKey: Uint8Array,
    cache: Map<string, { cryptoKey: CryptoKey; baseSalt: Uint8Array<ArrayBuffer> }>,
    epoch: number,
    senderId: string,
    senderGen: bigint,
    kind: ConfidentialTrackKind,
    ratchetStep: number
  ) {
    const cacheKey = `${epoch}:${ratchetStep}:${kind}:${senderGen.toString(16)}:${senderId}`
    const existing = cache.get(cacheKey)
    if (existing) return existing
    need(cache.size < 512)
    const derived = await deriveSFrameSenderKeyMaterial(
      slotRootKey,
      scope.roomId,
      epoch,
      senderId,
      senderGen,
      kind,
      ratchetStep
    )
    cache.set(cacheKey, derived)
    return derived
  }

  function resolvePrefixLength(
    kind: ConfidentialTrackKind,
    frameOptions?: SFrameFrameOptions
  ): number {
    const requested =
      frameOptions?.unencryptedPrefixLength ?? (kind === 'video' ? defaultVideoPrefix : 0)
    need(
      Number.isInteger(requested) &&
        requested >= 0 &&
        requested <= MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES &&
        (kind !== 'audio' || requested === 0)
    )
    return requested
  }

  return Object.freeze({
    get epoch() {
      return sendEpoch
    },
    get senderGeneration() {
      return sendGeneration
    },
    get ratchetStep() {
      return sendRatchetStep
    },
    isActive: () => active,
    close,
    seal(
      frame: Uint8Array,
      kind: ConfidentialTrackKind,
      frameOptions?: SFrameFrameOptions
    ): Promise<Uint8Array<ArrayBuffer>> {
      need(kind === 'audio' || kind === 'video')
      const plaintext = ownedBytes(frame, 0, 1024 * 1024)
      return run(async () => {
        try {
          need(active)
          const prefixLen = resolvePrefixLength(kind, frameOptions)
          need(prefixLen <= plaintext.byteLength)
          await ensureInitialized()
          const epochSnapshot = sendEpoch
          const genSnapshot = sendGeneration
          const ratchetSnapshot = sendRatchetStep
          const counter = kind === 'audio' ? audioCounter : videoCounter
          need(counter < MAX_U64)
          const prefix = plaintext.subarray(0, prefixLen)
          const body = plaintext.subarray(prefixLen)
          const headerBytes = encodeSFrameHeader(epochSnapshot, ratchetSnapshot, counter)
          const genBytes = u64be(genSnapshot)
          const aad = buildSFrameAad(
            scope.roomId,
            epochSnapshot,
            ratchetSnapshot,
            kind,
            scope.participantIdentity,
            genSnapshot,
            prefix,
            headerBytes
          )
          const material = await senderMaterialFor(
            sendRootKey!,
            sendDerived,
            epochSnapshot,
            scope.participantIdentity,
            genSnapshot,
            kind,
            ratchetSnapshot
          )
          need(
            active &&
              epochSnapshot === sendEpoch &&
              genSnapshot === sendGeneration &&
              ratchetSnapshot === sendRatchetStep
          )
          const nonce = computeSFrameNonce(material.baseSalt, counter)
          const encrypted = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
              material.cryptoKey,
              body
            )
          )
          nonce.fill(0)
          need(
            active &&
              epochSnapshot === sendEpoch &&
              genSnapshot === sendGeneration &&
              ratchetSnapshot === sendRatchetStep
          )
          if (kind === 'audio') audioCounter++
          else videoCounter++
          return concatBytes([prefix, headerBytes, genBytes, encrypted])
        } finally {
          plaintext.fill(0)
        }
      })
    },
    open(
      frame: Uint8Array,
      kind: ConfidentialTrackKind,
      participantIdentity: string,
      frameOptions?: SFrameFrameOptions
    ): Promise<Uint8Array<ArrayBuffer>> {
      text(participantIdentity)
      need(kind === 'audio' || kind === 'video')
      const prefixLen = resolvePrefixLength(kind, frameOptions)
      const wire = ownedBytes(
        frame,
        prefixLen + 1 + SFRAME_SENDER_GENERATION_BYTES + 16,
        1024 * 1024 + 2048
      )
      return run(async () => {
        let decrypted: Uint8Array<ArrayBuffer> | undefined
        try {
          need(active && participantIdentity !== scope.participantIdentity)
          await ensureInitialized()
          if (graceReceive?.expiresAtMs !== null && graceReceive?.expiresAtMs !== undefined) {
            if (now() >= graceReceive.expiresAtMs) clearGrace()
          }
          const prefix = wire.subarray(0, prefixLen)
          const remainder = wire.subarray(prefixLen)
          const { header, bytesRead } = decodeSFrameHeader(remainder)
          need(remainder.byteLength >= bytesRead + SFRAME_SENDER_GENERATION_BYTES + 16)
          const headerBytes = remainder.subarray(0, bytesRead)
          const genSlice = remainder.subarray(
            bytesRead,
            bytesRead + SFRAME_SENDER_GENERATION_BYTES
          )
          const senderGen = new DataView(
            genSlice.buffer,
            genSlice.byteOffset,
            SFRAME_SENDER_GENERATION_BYTES
          ).getBigUint64(0, false)
          need(senderGen > 0n && senderGen !== sendGeneration)
          const ciphertextAndTag = remainder.subarray(bytesRead + SFRAME_SENDER_GENERATION_BYTES)

          let slot: ReceiveEpochSlot | undefined
          if (currentReceive && header.epoch === currentReceive.epoch) {
            slot = currentReceive
          } else if (graceReceive && header.epoch === graceReceive.epoch) {
            slot = graceReceive
          }
          need(slot !== undefined)

          const knownOwner = slot.generationOwners.get(senderGen)
          need(knownOwner === undefined || knownOwner === participantIdentity)

          const replayKey = `${participantIdentity}\0${senderGen.toString(16)}\0${kind}\0${header.ratchetStep}`
          const existingWindow = slot.replay.get(replayKey)
          if (existingWindow) existingWindow.check(header.counter)
          else need(slot.replay.size < 512)

          const material = await senderMaterialFor(
            slot.rootKey,
            slot.derivedKeys,
            slot.epoch,
            participantIdentity,
            senderGen,
            kind,
            header.ratchetStep
          )
          need(active && (slot === currentReceive || slot === graceReceive))
          if (slot === graceReceive && slot.expiresAtMs !== null && now() >= slot.expiresAtMs) {
            clearGrace()
            throw new ConfidentialCryptoError()
          }
          const aad = buildSFrameAad(
            scope.roomId,
            slot.epoch,
            header.ratchetStep,
            kind,
            participantIdentity,
            senderGen,
            prefix,
            headerBytes
          )
          const nonce = computeSFrameNonce(material.baseSalt, header.counter)
          decrypted = new Uint8Array(
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
              material.cryptoKey,
              ciphertextAndTag
            )
          )
          nonce.fill(0)
          need(active && (slot === currentReceive || slot === graceReceive))
          const postOwner = slot.generationOwners.get(senderGen)
          need(postOwner === undefined || postOwner === participantIdentity)
          slot.generationOwners.set(senderGen, participantIdentity)
          let window = slot.replay.get(replayKey)
          if (!window) {
            window = new SlidingReplayWindow1024()
            slot.replay.set(replayKey, window)
          }
          window.commit(header.counter)
          const output = concatBytes([prefix, decrypted])
          decrypted.fill(0)
          decrypted = undefined
          return output
        } finally {
          wire.fill(0)
          decrypted?.fill(0)
        }
      })
    },
    rotateEpochKey(
      nextEpoch: number,
      nextSecret: Uint8Array,
      rotationOptions: SFrameEpochRotationOptions = {}
    ): Promise<void> {
      integer(nextEpoch)
      const secretCopy = ownedBytes(nextSecret, 32, 32)
      validateNonZeroSecret(secretCopy)
      const memberRemoved = rotationOptions.memberRemoved === true
      const requestedGrace = rotationOptions.graceWindowMs ?? SFRAME_EPOCH_GRACE_MS
      need(
        Number.isInteger(requestedGrace) &&
          requestedGrace >= 0 &&
          requestedGrace <= SFRAME_EPOCH_GRACE_MS
      )
      return run(async () => {
        try {
          need(active && nextEpoch > sendEpoch)
          await ensureInitialized()
          const nextRoot = await deriveSFrameEpochRootKey(secretCopy, scope.roomId, nextEpoch)
          need(active && nextEpoch > sendEpoch)
          const nextGeneration = randomNonZeroU64()

          // Immediately retire prior send keys, refresh senderGeneration, and reset outgoing counters.
          sendEpochSecret.fill(0)
          sendEpochSecret = new Uint8Array(secretCopy)
          sendRootKey?.fill(0)
          sendRootKey = nextRoot
          for (const cached of sendDerived.values()) cached.baseSalt.fill(0)
          sendDerived.clear()
          sendEpoch = nextEpoch
          sendGeneration = nextGeneration
          sendRatchetStep = 0
          audioCounter = 0n
          videoCounter = 0n

          const previousReceive = currentReceive
          currentReceive = {
            epoch: nextEpoch,
            rootKey: new Uint8Array(nextRoot),
            expiresAtMs: null,
            replay: new Map(),
            generationOwners: new Map(),
            derivedKeys: new Map(),
          }
          clearGrace()
          if (memberRemoved || !previousReceive || requestedGrace === 0) {
            purgeReceiveSlot(previousReceive)
          } else {
            previousReceive.expiresAtMs = now() + requestedGrace
            graceReceive = previousReceive
            graceTimer = setTimeout(() => {
              clearGrace()
            }, requestedGrace)
            if (typeof graceTimer === 'object' && 'unref' in graceTimer) {
              graceTimer.unref()
            }
          }
        } finally {
          secretCopy.fill(0)
        }
      })
    },
    ratchetEpochKey(nextEpoch: number): Promise<void> {
      integer(nextEpoch)
      return run(async () => {
        need(active && nextEpoch > sendEpoch)
        await ensureInitialized()
        const fromEpoch = sendEpoch
        const nextStep = sendRatchetStep + 1
        need(nextStep <= 0xffff)
        const roomBytes = utf8Encoder.encode(scope.roomId)
        const info = concatBytes([
          utf8Encoder.encode(`${SFRAME_MEDIA_DOMAIN}\0epoch-ratchet\0`),
          u16be(roomBytes.byteLength),
          roomBytes,
          u64be(BigInt(fromEpoch)),
          u64be(BigInt(nextEpoch)),
          u16be(nextStep),
        ])
        const oldCopy = new Uint8Array(sendEpochSecret)
        let derivedSecret: Uint8Array<ArrayBuffer> | undefined
        try {
          const hkdfKey = await crypto.subtle.importKey('raw', oldCopy, 'HKDF', false, [
            'deriveBits',
          ])
          derivedSecret = new Uint8Array(
            await crypto.subtle.deriveBits(
              {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: utf8Encoder.encode(SFRAME_MEDIA_DOMAIN),
                info,
              },
              hkdfKey,
              256
            )
          )
          const nextRoot = await deriveSFrameEpochRootKey(derivedSecret, scope.roomId, nextEpoch)
          need(active && fromEpoch === sendEpoch)
          sendEpochSecret.fill(0)
          sendEpochSecret = derivedSecret
          derivedSecret = undefined
          sendRootKey?.fill(0)
          sendRootKey = nextRoot
          for (const cached of sendDerived.values()) cached.baseSalt.fill(0)
          sendDerived.clear()
          sendEpoch = nextEpoch
          sendRatchetStep = nextStep
          audioCounter = 0n
          videoCounter = 0n
          clearGrace()
          purgeReceiveSlot(currentReceive)
          currentReceive = {
            epoch: nextEpoch,
            rootKey: new Uint8Array(nextRoot),
            expiresAtMs: null,
            replay: new Map(),
            generationOwners: new Map(),
            derivedKeys: new Map(),
          }
        } finally {
          oldCopy.fill(0)
          derivedSecret?.fill(0)
        }
      })
    },
    ratchetSenderStep(): Promise<number> {
      return run(async () => {
        need(active)
        await ensureInitialized()
        need(sendRatchetStep < 0xffff)
        sendRatchetStep++
        audioCounter = 0n
        videoCounter = 0n
        for (const cached of sendDerived.values()) cached.baseSalt.fill(0)
        sendDerived.clear()
        return sendRatchetStep
      })
    },
  })
}

export function createMediaCryptoSession(
  context: MediaCryptoContext,
  secret: Uint8Array,
  options?: MediaSessionCreateOptions
) {
  if (options?.protocol === 'sframe-v1') {
    return createSFrameMediaSession(context, secret, options)
  }
  const scope = mediaContext(context)
  const cryptor = new WorkerFrameCryptor(
    'KSM1',
    'kodera-confidential-media',
    [scope.roomId],
    scope.epoch,
    scope.participantIdentity,
    secret
  )
  return Object.freeze({
    get epoch() {
      return cryptor.epoch
    },
    isActive: () => cryptor.isActive(),
    close: () => cryptor.close(),
    seal: (
      frame: Uint8Array,
      kind: ConfidentialTrackKind,
      _frameOptions?: SFrameFrameOptions
    ) => {
      need(kind === 'audio' || kind === 'video')
      return cryptor.seal(frame, kind)
    },
    open: (
      frame: Uint8Array,
      kind: ConfidentialTrackKind,
      participantIdentity: string,
      _frameOptions?: SFrameFrameOptions
    ) => {
      text(participantIdentity)
      need(kind === 'audio' || kind === 'video')
      return cryptor.open(frame, (value) => value === kind, participantIdentity)
    },
    ratchetEpochKey: (nextEpoch: number) => cryptor.ratchetEpochKey(nextEpoch),
  })
}

export function provisionMediaEpochKey(
  port: MessagePort,
  context: MediaCryptoContext,
  secret: Uint8Array,
  options?: { protocol?: ConfidentialMediaProtocol; unencryptedPrefixLength?: number }
): void {
  const scope = mediaContext(context),
    copy = ownedBytes(secret, 32, 32)
  const message =
    options === undefined
      ? { kind: 'epoch-key', context: scope, secret: copy }
      : {
          kind: 'epoch-key',
          context: scope,
          secret: copy,
          ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
          ...(options.unencryptedPrefixLength !== undefined
            ? { unencryptedPrefixLength: options.unencryptedPrefixLength }
            : {}),
        }
  port.postMessage(message, [copy.buffer])
}

export function rotateMediaEpochKey(
  port: MessagePort,
  context: MediaCryptoContext,
  secret: Uint8Array,
  options?: { memberRemoved?: boolean; graceWindowMs?: number }
): void {
  const scope = mediaContext(context),
    copy = ownedBytes(secret, 32, 32)
  port.postMessage(
    {
      kind: 'rotate-epoch-key',
      context: scope,
      secret: copy,
      memberRemoved: options?.memberRemoved === true,
      ...(options?.graceWindowMs !== undefined ? { graceWindowMs: options.graceWindowMs } : {}),
    },
    [copy.buffer]
  )
}

interface EncodedFrame {
  data: ArrayBuffer
  type?: string
}
interface TransformOptions {
  kind: 'encode' | 'decode'
  participantIdentity: string
  trackId: string
  codec?: string
  encrypted?: boolean
}
interface FrameTransformer {
  readonly readable: ReadableStream<EncodedFrame>
  readonly writable: WritableStream<EncodedFrame>
  readonly options: TransformOptions
}
interface MediaWorkerScope {
  postMessage(message: unknown): void
  addEventListener(kind: string, listener: (event: MessageEvent<unknown>) => void): void
}

export interface HostMediaSessionOptions {
  readonly protocol?: ConfidentialMediaProtocol
  readonly unencryptedPrefixLength?: number
  readonly now?: () => number
}

export function hostMediaCryptoSession(
  control: MessagePort,
  epochPort: MessagePort,
  context: MediaCryptoContext,
  workerScope?: MediaWorkerScope,
  hostOptions?: HostMediaSessionOptions
) {
  const scope = mediaContext(context)
  let session:
      | ReturnType<typeof createMediaCryptoSession>
      | SFrameMediaSessionHandle
      | undefined,
    activeProtocol: ConfidentialMediaProtocol = hostOptions?.protocol ?? 'ksm1',
    configuredPrefixLen: number | undefined = hostOptions?.unencryptedPrefixLength,
    closed = false,
    enabled = false
  interface Pipeline {
    options: TransformOptions
    revision: number
    admitted: boolean
    settled: boolean
    abort: AbortController
  }
  const pipelines = new Set<Pipeline>()
  const close = () => {
    if (closed) return
    closed = true
    enabled = false
    session?.close()
    for (const pipeline of pipelines) {
      pipeline.admitted = false
      pipeline.revision++
      pipeline.abort.abort()
    }
    pipelines.clear()
    control.close()
    epochPort.close()
  }
  const refuse = () => {
    if (closed) return
    control.postMessage({ kind: 'closed' })
    workerScope?.postMessage({
      kind: 'error',
      data: { error: new Error('Confidential media closed.') },
    })
    close()
  }
  epochPort.onmessage = (event: MessageEvent<unknown>) => {
    let secret: Uint8Array<ArrayBuffer> | undefined
    try {
      need(!closed && event.data !== null && typeof event.data === 'object')
      const raw = event.data as Record<string, unknown>
      if (raw.kind === 'epoch-key') {
        need(!session)
        const allowedKeys = ['kind', 'context', 'secret']
        if ('protocol' in raw) allowedKeys.push('protocol')
        if ('unencryptedPrefixLength' in raw) allowedKeys.push('unencryptedPrefixLength')
        const value = fields(event.data, allowedKeys)
        secret = ownedBytes(value.secret, 32, 32)
        ;(value.secret as Uint8Array).fill(0)
        need(JSON.stringify(mediaContext(value.context)) === JSON.stringify(scope))
        if (value.protocol !== undefined) {
          need(value.protocol === 'ksm1' || value.protocol === 'sframe-v1')
          activeProtocol = value.protocol
        }
        if (value.unencryptedPrefixLength !== undefined) {
          need(
            typeof value.unencryptedPrefixLength === 'number' &&
              Number.isInteger(value.unencryptedPrefixLength) &&
              value.unencryptedPrefixLength >= 0 &&
              value.unencryptedPrefixLength <= MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES
          )
          configuredPrefixLen = value.unencryptedPrefixLength
        }
        session =
          activeProtocol === 'sframe-v1'
            ? createSFrameMediaSession(scope, secret, {
                ...(configuredPrefixLen !== undefined
                  ? { unencryptedPrefixLength: configuredPrefixLen }
                  : {}),
                ...(hostOptions?.now !== undefined ? { now: hostOptions.now } : {}),
              })
            : createMediaCryptoSession(scope, secret)
        control.postMessage({ kind: 'ready' })
        if (activeProtocol !== 'sframe-v1') epochPort.close()
        return
      }
      if (raw.kind === 'rotate-epoch-key') {
        need(session !== undefined && activeProtocol === 'sframe-v1' && 'rotateEpochKey' in session)
        const allowedKeys = ['kind', 'context', 'secret', 'memberRemoved']
        if ('graceWindowMs' in raw) allowedKeys.push('graceWindowMs')
        const value = fields(event.data, allowedKeys)
        secret = ownedBytes(value.secret, 32, 32)
        ;(value.secret as Uint8Array).fill(0)
        const nextScope = mediaContext(value.context)
        need(
          nextScope.roomId === scope.roomId &&
            nextScope.participantIdentity === scope.participantIdentity &&
            nextScope.epoch > session.epoch &&
            typeof value.memberRemoved === 'boolean'
        )
        const copyForRotation = new Uint8Array(secret)
        const sframeSession = session
        void sframeSession
          .rotateEpochKey(nextScope.epoch, copyForRotation, {
            memberRemoved: value.memberRemoved,
            ...(typeof value.graceWindowMs === 'number'
              ? { graceWindowMs: value.graceWindowMs }
              : {}),
          })
          .then(
            () => {
              copyForRotation.fill(0)
              if (!closed && sframeSession.isActive()) {
                control.postMessage({ kind: 'epoch-rotated', epoch: nextScope.epoch })
              }
            },
            () => {
              copyForRotation.fill(0)
              refuse()
            }
          )
        return
      }
      refuse()
    } catch {
      refuse()
    } finally {
      secret?.fill(0)
    }
  }
  control.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data as { kind?: unknown }
    if (value?.kind === 'close') close()
    else refuse()
  }
  function transform(transformer: FrameTransformer): void {
    try {
      need(!closed && session && enabled)
      const options = { ...transformer.options }
      need(options.kind === 'encode' || options.kind === 'decode')
      text(options.participantIdentity)
      text(options.trackId)
      need(options.kind !== 'encode' || options.participantIdentity === scope.participantIdentity)
      need(options.kind !== 'decode' || options.encrypted !== false)
      need(
        pipelines.size < 256 &&
          ![...pipelines].some(
            (pipeline) =>
              pipeline.options.kind === options.kind &&
              pipeline.options.participantIdentity === options.participantIdentity &&
              pipeline.options.trackId === options.trackId
          )
      )
      const active = session,
        abort = new AbortController()
      const binding: Pipeline = { options, revision: 0, admitted: true, settled: false, abort }
      pipelines.add(binding)
      const pipeline = new TransformStream<EncodedFrame, EncodedFrame>({
        async transform(frame, controller) {
          let output: Uint8Array<ArrayBuffer> | undefined
          const original = frame.data
          if (!binding.admitted || binding.settled) {
            if (frame.data instanceof ArrayBuffer) new Uint8Array(frame.data).fill(0)
            return
          }
          const revision = binding.revision,
            options = binding.options
          try {
            need(!closed && enabled && active.isActive() && frame.data instanceof ArrayBuffer)
            const kind: ConfidentialTrackKind =
              options.codec !== undefined || typeof frame.type === 'string' ? 'video' : 'audio'
            const input = new Uint8Array(frame.data)
            const frameOpts: SFrameFrameOptions | undefined =
              activeProtocol === 'sframe-v1'
                ? {
                    unencryptedPrefixLength:
                      kind === 'audio'
                        ? 0
                        : (configuredPrefixLen ??
                          defaultUnencryptedPrefixLength(kind, options.codec, frame.type)),
                  }
                : undefined
            output =
              options.kind === 'encode'
                ? await active.seal(input, kind, frameOpts)
                : await active.open(input, kind, options.participantIdentity, frameOpts)
            need(!closed && enabled && active.isActive())
            if (!binding.admitted || revision !== binding.revision) {
              output.fill(0)
              return
            }
            frame.data = output.buffer
            output = undefined
            controller.enqueue(frame)
          } catch {
            output?.fill(0)
            if (!closed && (!binding.admitted || revision !== binding.revision)) return
            refuse()
            controller.error(new Error('Confidential media frame refused.'))
          } finally {
            // Encoded frame storage belongs to this worker. Erase the replaced plaintext
            // and any retired input even when encryption or authority checks reject.
            if (original instanceof ArrayBuffer) new Uint8Array(original).fill(0)
          }
        },
      })
      void transformer.readable
        .pipeThrough(pipeline, { signal: abort.signal })
        .pipeTo(transformer.writable, { signal: abort.signal })
        .catch(() => {
          if (!abort.signal.aborted) refuse()
        })
        .finally(() => {
          binding.settled = true
          binding.admitted = false
          pipelines.delete(binding)
        })
    } catch {
      refuse()
    }
  }
  function sdkMessage(input: unknown): void {
    if (closed) return
    try {
      need(input !== null && typeof input === 'object')
      const message = input as { kind?: unknown; data?: Record<string, unknown> },
        data = message.data
      if (message.kind === 'init') {
        need(session?.isActive())
        workerScope?.postMessage({ kind: 'initAck', data: { enabled: true } })
        return
      }
      if (message.kind === 'enable') {
        need(data && data.enabled === true && session?.isActive())
        if (data.local === true) {
          enabled = true
          control.postMessage({ kind: 'enabled' })
        }
        workerScope?.postMessage({ kind: 'enable', data })
        return
      }
      if (message.kind === 'encode' || message.kind === 'decode') {
        need(
          data &&
            data.readableStream instanceof ReadableStream &&
            data.writableStream instanceof WritableStream
        )
        transform({
          readable: data.readableStream,
          writable: data.writableStream,
          options: { ...data, kind: message.kind } as unknown as TransformOptions,
        })
        return
      }
      if (message.kind === 'updateCodec') {
        need(data && session?.isActive() && enabled)
        const operation = data.operation ?? 'decode'
        need(operation === 'encode' || operation === 'decode')
        text(data.participantIdentity)
        text(data.trackId)
        need(
          data.codec === undefined ||
            (typeof data.codec === 'string' && data.codec.length > 0 && data.codec.length <= 32)
        )
        need(operation !== 'decode' || data.encrypted !== false)
        need(
          operation !== 'encode' ||
            (data.participantIdentity === scope.participantIdentity &&
              data.previousTrackId === undefined)
        )
        if (data.previousTrackId !== undefined) text(data.previousTrackId)
        const candidates = [...pipelines].filter(
          (pipeline) =>
            pipeline.options.kind === operation &&
            (data.previousTrackId === undefined
              ? pipeline.options.trackId === data.trackId &&
                pipeline.options.participantIdentity === data.participantIdentity
              : pipeline.options.trackId === data.previousTrackId)
        )
        need(candidates.length === 1)
        const binding = candidates[0]!
        need(
          !binding.settled &&
            ![...pipelines].some(
              (other) =>
                other !== binding &&
                other.options.kind === operation &&
                other.options.trackId === data.trackId &&
                other.options.participantIdentity === data.participantIdentity
            )
        )
        binding.revision++
        binding.options = {
          kind: operation,
          participantIdentity: data.participantIdentity,
          trackId: data.trackId,
          ...(typeof data.codec === 'string' ? { codec: data.codec } : {}),
          ...(operation === 'decode' && typeof data.encrypted === 'boolean'
            ? { encrypted: data.encrypted }
            : {}),
        }
        binding.admitted = true
        return
      }
      if (message.kind === 'removeTransform') {
        need(data)
        text(data.participantIdentity)
        text(data.trackId)
        for (const binding of pipelines) {
          if (
            binding.options.kind === 'decode' &&
            binding.options.participantIdentity === data.participantIdentity &&
            binding.options.trackId === data.trackId
          ) {
            // Keep the transferred stream for transceiver reuse, but admit no detached frames.
            binding.admitted = false
            binding.revision++
          }
        }
        return
      }
      if (['setRTPMap', 'setSifTrailer', 'setLogLevel'].includes(String(message.kind))) return
      // Main-thread key injection, SDK ratchet export and unsupported data encryption are refused.
      refuse()
    } catch {
      refuse()
    }
  }
  control.onmessageerror = refuse
  epochPort.onmessageerror = refuse
  control.start()
  epochPort.start()
  return Object.freeze({ close, sdkMessage, transform })
}

/** Worker-side deterministic port factory; accepts only a secret-bearing port. */
export function createMediaCryptoSessionPort(
  context: MediaCryptoContext,
  epochPort: MessagePort,
  options?: HostMediaSessionOptions
) {
  const channel = new MessageChannel()
  const host = hostMediaCryptoSession(channel.port2, epochPort, context, undefined, options)
  return Object.freeze({ control: channel.port1, host })
}

if (
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  !Reflect.has(globalThis, 'document')
) {
  let host: ReturnType<typeof hostMediaCryptoSession> | undefined
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    try {
      const input = event.data as { kind?: unknown }
      if (input?.kind === 'bootstrap') {
        need(!host && event.data !== null && typeof event.data === 'object')
        const raw = event.data as Record<string, unknown>
        const allowedKeys = ['kind', 'control', 'epochPort', 'context']
        if ('protocol' in raw) allowedKeys.push('protocol')
        if ('unencryptedPrefixLength' in raw) allowedKeys.push('unencryptedPrefixLength')
        const value = fields(event.data, allowedKeys)
        need(value.control instanceof MessagePort && value.epochPort instanceof MessagePort)
        const protocol =
          value.protocol === 'sframe-v1' || value.protocol === 'ksm1' ? value.protocol : undefined
        const unencryptedPrefixLength =
          typeof value.unencryptedPrefixLength === 'number'
            ? value.unencryptedPrefixLength
            : undefined
        host = hostMediaCryptoSession(
          value.control,
          value.epochPort,
          mediaContext(value.context),
          self as unknown as MediaWorkerScope,
          {
            ...(protocol !== undefined ? { protocol } : {}),
            ...(unencryptedPrefixLength !== undefined ? { unencryptedPrefixLength } : {}),
          }
        )
      } else host?.sdkMessage(event.data)
    } catch {
      host?.close()
    }
  })
  self.addEventListener('rtctransform', (event) => {
    host?.transform((event as unknown as { transformer: FrameTransformer }).transformer)
  })
}
