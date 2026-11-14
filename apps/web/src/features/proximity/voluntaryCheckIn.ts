import { bytesToHex, constantTimeEqual, hexToBytes, hmacSha256 } from './codec'

export const PROXIMITY_EPOCH_ROTATION_SECS = 900
export const PROXIMITY_EPOCH_SKEW_SECS = 60
export const PROXIMITY_TOKEN_BYTE_LENGTH = 32
export const PROXIMITY_MAX_STATUS_NOTE_CHARS = 80
export const PROXIMITY_DEFAULT_TTL_SECS = 1800
export const PROXIMITY_MAX_TTL_SECS = 7200

export const PROXIMITY_DURATION_PRESETS = [900, 1800, 3600, 7200] as const
export type ProximityDurationSeconds = (typeof PROXIMITY_DURATION_PRESETS)[number]

export type ProximityDistanceBand = 'immediate' | 'near' | 'ambient'

export type ProximityVoluntaryErrorCode =
  | 'InvalidOrganisation'
  | 'InvalidKeyMaterial'
  | 'InvalidStatusNote'
  | 'InvalidDuration'
  | 'InvalidRssi'
  | 'ForbiddenGpsCoordinates'
  | 'MalformedToken'
  | 'ExpiredToken'
  | 'AuthenticationFailed'
  | 'CallerNotCheckedIn'

export class ProximityVoluntaryError extends Error {
  readonly code: ProximityVoluntaryErrorCode

  constructor(code: ProximityVoluntaryErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ProximityVoluntaryError'
    this.code = code
  }
}

const UTF8_ENCODER = new TextEncoder()
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FORBIDDEN_GPS_KEYS = new Set([
  'lat',
  'latitude',
  'lon',
  'lng',
  'long',
  'longitude',
  'gps',
  'gpscoordinates',
  'coord',
  'coords',
  'coordinates',
  'geo',
  'geolocation',
  'location',
  'alt',
  'altitude',
  'accuracy',
  'heading',
  'bssid',
])

function normalizeFieldKey(rawKey: string): string {
  return rawKey
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

/**
 * Recursive client-side Zero-GPS privacy guard mirroring `/api/v1/proximity/*` (`422`).
 */
export function assertZeroGpsPayload(payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return
  if (Array.isArray(payload)) {
    for (const item of payload) assertZeroGpsPayload(item)
    return
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_GPS_KEYS.has(normalizeFieldKey(key))) {
      throw new ProximityVoluntaryError('ForbiddenGpsCoordinates', `Forbidden field: ${key}`)
    }
    assertZeroGpsPayload(value)
  }
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export function validateProximityStatusNote(rawNote: string): string {
  const trimmed = rawNote.trim()
  if (trimmed.length > PROXIMITY_MAX_STATUS_NOTE_CHARS || hasControlCharacters(trimmed)) {
    throw new ProximityVoluntaryError('InvalidStatusNote')
  }
  return trimmed
}

export function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  const effectiveSalt = salt.length === 0 ? new Uint8Array(32) : salt
  const prk = hmacSha256(effectiveSalt, ikm)
  const okm = new Uint8Array(length)
  let previous: Uint8Array = new Uint8Array(0)
  let written = 0
  let blockIndex = 1
  while (written < length) {
    const input = new Uint8Array(previous.length + info.length + 1)
    input.set(previous, 0)
    input.set(info, previous.length)
    input[previous.length + info.length] = blockIndex & 0xff
    previous = hmacSha256(prk, input)
    const take = Math.min(previous.length, length - written)
    okm.set(previous.subarray(0, take), written)
    written += take
    blockIndex += 1
  }
  return okm
}

function encodeUint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint32(0, value >>> 0, false)
  return buf
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0)
}

export interface DecodedRotatingProximityToken {
  readonly raw: Uint8Array
  readonly tokenHex: string
  readonly epoch: number
  readonly counter: number
  readonly rollingPseudonymHex: string
}

/**
 * Mints a wire-compatible 32-byte `KT\x01` 15-minute rotating HKDF-SHA256 proximity token.
 */
export function mintRotatingProximityToken(params: {
  readonly workspaceId: string
  readonly eventScope?: string | undefined
  readonly workspaceMasterKey: Uint8Array
  readonly deviceSeed: Uint8Array
  readonly nowUnixSeconds: number
  readonly counter?: number | undefined
}): DecodedRotatingProximityToken {
  const workspaceId = params.workspaceId.trim().toLowerCase()
  if (
    !CANONICAL_UUID_RE.test(workspaceId) ||
    workspaceId === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new ProximityVoluntaryError('InvalidOrganisation')
  }
  if (
    params.workspaceMasterKey.length !== 32 ||
    params.deviceSeed.length !== 32 ||
    isAllZero(params.workspaceMasterKey) ||
    isAllZero(params.deviceSeed) ||
    constantTimeEqual(params.workspaceMasterKey, params.deviceSeed)
  ) {
    throw new ProximityVoluntaryError('InvalidKeyMaterial')
  }
  const eventScope = (params.eventScope ?? 'default').trim() || 'default'
  const counter = (params.counter ?? 0) >>> 0
  const epoch =
    Math.floor(Math.max(0, Math.trunc(params.nowUnixSeconds)) / PROXIMITY_EPOCH_ROTATION_SECS) >>> 0
  const epochBytes = encodeUint32BE(epoch)

  const pseudonym = hkdfSha256(
    epochBytes,
    params.deviceSeed,
    UTF8_ENCODER.encode(`kodera.proximity.w9.pseudonym.v1:${workspaceId}:${eventScope}`),
    8
  )

  const header = concatBytes(
    new Uint8Array([0x4b, 0x54, 0x01, 0x00]),
    epochBytes,
    encodeUint32BE(counter),
    pseudonym
  )

  const epochMacKey = hkdfSha256(
    UTF8_ENCODER.encode(`${workspaceId}:${eventScope}`),
    params.workspaceMasterKey,
    concatBytes(UTF8_ENCODER.encode('kodera.proximity.w9.epoch-mac.v1:'), epochBytes),
    32
  )
  const orgBytes = UTF8_ENCODER.encode(workspaceId)
  const scopeBytes = UTF8_ENCODER.encode(eventScope)
  const macInput = concatBytes(
    UTF8_ENCODER.encode('kodera.proximity.w9.token-mac.v1:'),
    new Uint8Array([orgBytes.length & 0xff]),
    orgBytes,
    new Uint8Array([scopeBytes.length & 0xff]),
    scopeBytes,
    header
  )
  const macTag = hmacSha256(epochMacKey, macInput).subarray(0, 12)
  const raw = concatBytes(header, macTag)

  return {
    raw,
    tokenHex: bytesToHex(raw),
    epoch,
    counter,
    rollingPseudonymHex: bytesToHex(pseudonym),
  }
}

export function verifyRotatingProximityToken(params: {
  readonly tokenHex: string
  readonly workspaceId: string
  readonly eventScope?: string | undefined
  readonly workspaceMasterKey: Uint8Array
  readonly nowUnixSeconds: number
}): DecodedRotatingProximityToken {
  const workspaceId = params.workspaceId.trim().toLowerCase()
  if (
    !CANONICAL_UUID_RE.test(workspaceId) ||
    workspaceId === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new ProximityVoluntaryError('InvalidOrganisation')
  }
  if (params.workspaceMasterKey.length !== 32 || isAllZero(params.workspaceMasterKey)) {
    throw new ProximityVoluntaryError('InvalidKeyMaterial')
  }
  let raw: Uint8Array
  try {
    raw = hexToBytes(params.tokenHex)
  } catch {
    throw new ProximityVoluntaryError('MalformedToken')
  }
  if (
    raw.length !== PROXIMITY_TOKEN_BYTE_LENGTH ||
    raw[0] !== 0x4b ||
    raw[1] !== 0x54 ||
    raw[2] !== 0x01 ||
    raw[3] !== 0x00
  ) {
    throw new ProximityVoluntaryError('MalformedToken')
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const epoch = view.getUint32(4, false)
  const counter = view.getUint32(8, false)
  const pseudonym = raw.subarray(12, 20)
  const suppliedMac = raw.subarray(20, 32)

  const now = Math.max(0, Math.trunc(params.nowUnixSeconds))
  const currentEpoch = Math.floor(now / PROXIMITY_EPOCH_ROTATION_SECS) >>> 0
  const allowedEpochs = [currentEpoch]
  const offset = now % PROXIMITY_EPOCH_ROTATION_SECS
  if (offset < PROXIMITY_EPOCH_SKEW_SECS && currentEpoch > 0) allowedEpochs.push(currentEpoch - 1)
  if (offset >= PROXIMITY_EPOCH_ROTATION_SECS - PROXIMITY_EPOCH_SKEW_SECS) {
    allowedEpochs.push(currentEpoch + 1)
  }
  if (!allowedEpochs.includes(epoch)) {
    throw new ProximityVoluntaryError('ExpiredToken')
  }

  const eventScope = (params.eventScope ?? 'default').trim() || 'default'
  const epochBytes = encodeUint32BE(epoch)
  const epochMacKey = hkdfSha256(
    UTF8_ENCODER.encode(`${workspaceId}:${eventScope}`),
    params.workspaceMasterKey,
    concatBytes(UTF8_ENCODER.encode('kodera.proximity.w9.epoch-mac.v1:'), epochBytes),
    32
  )
  const orgBytes = UTF8_ENCODER.encode(workspaceId)
  const scopeBytes = UTF8_ENCODER.encode(eventScope)
  const macInput = concatBytes(
    UTF8_ENCODER.encode('kodera.proximity.w9.token-mac.v1:'),
    new Uint8Array([orgBytes.length & 0xff]),
    orgBytes,
    new Uint8Array([scopeBytes.length & 0xff]),
    scopeBytes,
    raw.subarray(0, 20)
  )
  const expectedMac = hmacSha256(epochMacKey, macInput).subarray(0, 12)
  if (!constantTimeEqual(expectedMac, suppliedMac)) {
    throw new ProximityVoluntaryError('AuthenticationFailed')
  }

  return {
    raw,
    tokenHex: bytesToHex(raw),
    epoch,
    counter,
    rollingPseudonymHex: bytesToHex(pseudonym),
  }
}

/**
 * Stateful BLE RSSI distance-band classifier (`[-127, 20]` dBm, rejecting Bluetooth `127` sentinel)
 * with dead-zone hysteresis (`-55/-61` and `-75/-81`).
 */
export class RssiDistanceClassifier {
  private currentBand: ProximityDistanceBand | null = null
  readonly immediateEnterDbm: number
  readonly immediateExitDbm: number
  readonly nearEnterDbm: number
  readonly nearExitDbm: number

  constructor(options?: {
    readonly immediateEnterDbm?: number | undefined
    readonly immediateExitDbm?: number | undefined
    readonly nearEnterDbm?: number | undefined
    readonly nearExitDbm?: number | undefined
  }) {
    this.immediateEnterDbm = options?.immediateEnterDbm ?? -55
    this.immediateExitDbm = options?.immediateExitDbm ?? -61
    this.nearEnterDbm = options?.nearEnterDbm ?? -75
    this.nearExitDbm = options?.nearExitDbm ?? -81
  }

  observe(rssiDbm: number): ProximityDistanceBand {
    if (!Number.isInteger(rssiDbm) || rssiDbm < -127 || rssiDbm > 20) {
      throw new ProximityVoluntaryError('InvalidRssi')
    }
    let next: ProximityDistanceBand
    if (this.currentBand === null) {
      next =
        rssiDbm >= this.immediateEnterDbm
          ? 'immediate'
          : rssiDbm >= this.nearEnterDbm
            ? 'near'
            : 'ambient'
    } else if (this.currentBand === 'immediate') {
      next =
        rssiDbm >= this.immediateExitDbm
          ? 'immediate'
          : rssiDbm >= this.nearExitDbm
            ? 'near'
            : 'ambient'
    } else if (this.currentBand === 'near') {
      next =
        rssiDbm >= this.immediateEnterDbm
          ? 'immediate'
          : rssiDbm >= this.nearExitDbm
            ? 'near'
            : 'ambient'
    } else {
      next =
        rssiDbm >= this.immediateEnterDbm
          ? 'immediate'
          : rssiDbm >= this.nearEnterDbm
            ? 'near'
            : 'ambient'
    }
    this.currentBand = next
    return next
  }

  reset(): void {
    this.currentBand = null
  }
}

export interface VoluntaryProximityPeer {
  readonly peerId: string
  readonly handle: string
  readonly statusNote: string
  readonly distanceBand: ProximityDistanceBand
  readonly viaLanMdnsQuic: boolean
  readonly rssiDbm?: number | undefined
  readonly expiresAtUnixSeconds: number
}

export interface VoluntaryCheckInRecord {
  readonly workspaceId: string
  readonly eventScope: string
  readonly rollingPseudonymHex: string
  readonly tokenHex: string
  readonly statusNote: string
  readonly checkedInAtUnixSeconds: number
  readonly expiresAtUnixSeconds: number
  readonly durationSeconds: ProximityDurationSeconds
}

export interface ProximityVoluntaryCheckInInput {
  readonly workspaceId: string
  readonly eventScope?: string | undefined
  readonly durationSeconds: ProximityDurationSeconds
  readonly statusNote: string
  readonly nowUnixSeconds?: number | undefined
}

export interface ProximityVoluntaryBrokerAdapter {
  checkIn(input: ProximityVoluntaryCheckInInput): Promise<{
    readonly record: VoluntaryCheckInRecord
    readonly peers: readonly VoluntaryProximityPeer[]
  }>
  listNearby(params: {
    readonly workspaceId: string
    readonly eventScope?: string | undefined
    readonly nowUnixSeconds?: number | undefined
  }): Promise<readonly VoluntaryProximityPeer[]>
  leaveProximity(params: {
    readonly workspaceId: string
    readonly eventScope?: string | undefined
  }): Promise<void>
}

interface StoredParticipant {
  readonly participantId: string
  readonly workspaceId: string
  readonly eventScope: string
  readonly record: VoluntaryCheckInRecord
  readonly distanceBand: ProximityDistanceBand
  readonly viaLanMdnsQuic: boolean
  readonly rssiDbm?: number | undefined
}

/**
 * Deterministic zero-persistence voluntary check-in broker matching `/api/v1/proximity/*` rules:
 * strict Zero-GPS refusal, workspace + eventScope isolation, mutual opt-in visibility, TTL auto-purge,
 * and instant wipe on `leaveProximity`.
 */
export class InMemoryProximityVoluntaryBroker {
  private readonly workspaceMasterKey: Uint8Array
  private readonly entries = new Map<string, StoredParticipant>()
  private emissionCounter = 0

  constructor(workspaceMasterKey: Uint8Array) {
    if (workspaceMasterKey.length !== 32 || isAllZero(workspaceMasterKey)) {
      throw new ProximityVoluntaryError('InvalidKeyMaterial')
    }
    this.workspaceMasterKey = new Uint8Array(workspaceMasterKey)
  }

  forParticipant(
    participantId: string,
    deviceSeed: Uint8Array,
    radioMeta?: {
      readonly rssiDbm?: number | undefined
      readonly viaLanMdnsQuic?: boolean | undefined
    }
  ): ProximityVoluntaryBrokerAdapter {
    const classifier = new RssiDistanceClassifier()
    return {
      checkIn: async (input) => {
        assertZeroGpsPayload(input)
        if (!PROXIMITY_DURATION_PRESETS.includes(input.durationSeconds)) {
          throw new ProximityVoluntaryError('InvalidDuration')
        }
        const now = Math.trunc(input.nowUnixSeconds ?? Date.now() / 1000)
        this.purgeExpired(now)
        const eventScope = (input.eventScope ?? 'default').trim() || 'default'
        const statusNote = validateProximityStatusNote(input.statusNote)
        const minted = mintRotatingProximityToken({
          workspaceId: input.workspaceId,
          eventScope,
          workspaceMasterKey: this.workspaceMasterKey,
          deviceSeed,
          nowUnixSeconds: now,
          counter: this.emissionCounter,
        })
        this.emissionCounter = (this.emissionCounter + 1) >>> 0

        const verified = verifyRotatingProximityToken({
          tokenHex: minted.tokenHex,
          workspaceId: input.workspaceId,
          eventScope,
          workspaceMasterKey: this.workspaceMasterKey,
          nowUnixSeconds: now,
        })

        const record: VoluntaryCheckInRecord = {
          workspaceId: input.workspaceId.trim().toLowerCase(),
          eventScope,
          rollingPseudonymHex: verified.rollingPseudonymHex,
          tokenHex: verified.tokenHex,
          statusNote,
          checkedInAtUnixSeconds: now,
          expiresAtUnixSeconds: now + input.durationSeconds,
          durationSeconds: input.durationSeconds,
        }
        const band =
          radioMeta?.rssiDbm !== undefined ? classifier.observe(radioMeta.rssiDbm) : 'near'

        this.entries.set(this.keyOf(record.workspaceId, eventScope, participantId), {
          participantId,
          workspaceId: record.workspaceId,
          eventScope,
          record,
          distanceBand: band,
          viaLanMdnsQuic: radioMeta?.viaLanMdnsQuic ?? true,
          rssiDbm: radioMeta?.rssiDbm,
        })

        return {
          record,
          peers: this.peersFor(record.workspaceId, eventScope, participantId, now),
        }
      },

      listNearby: async (params) => {
        assertZeroGpsPayload(params)
        const now = Math.trunc(params.nowUnixSeconds ?? Date.now() / 1000)
        this.purgeExpired(now)
        const workspaceId = params.workspaceId.trim().toLowerCase()
        const eventScope = (params.eventScope ?? 'default').trim() || 'default'
        if (!this.entries.has(this.keyOf(workspaceId, eventScope, participantId))) {
          throw new ProximityVoluntaryError('CallerNotCheckedIn')
        }
        return this.peersFor(workspaceId, eventScope, participantId, now)
      },

      leaveProximity: async (params) => {
        assertZeroGpsPayload(params)
        const workspaceId = params.workspaceId.trim().toLowerCase()
        const eventScope = (params.eventScope ?? 'default').trim() || 'default'
        this.entries.delete(this.keyOf(workspaceId, eventScope, participantId))
        classifier.reset()
      },
    }
  }

  private keyOf(workspaceId: string, eventScope: string, participantId: string): string {
    return `${workspaceId}::${eventScope}::${participantId}`
  }

  private purgeExpired(nowUnixSeconds: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (nowUnixSeconds >= entry.record.expiresAtUnixSeconds) {
        this.entries.delete(key)
      }
    }
  }

  private peersFor(
    workspaceId: string,
    eventScope: string,
    callerId: string,
    nowUnixSeconds: number
  ): VoluntaryProximityPeer[] {
    this.purgeExpired(nowUnixSeconds)
    const out: VoluntaryProximityPeer[] = []
    for (const entry of this.entries.values()) {
      if (
        entry.workspaceId === workspaceId &&
        entry.eventScope === eventScope &&
        entry.participantId !== callerId
      ) {
        out.push({
          peerId: entry.record.rollingPseudonymHex,
          handle: `prox-${entry.record.rollingPseudonymHex.slice(0, 8)}`,
          statusNote: entry.record.statusNote,
          distanceBand: entry.distanceBand,
          viaLanMdnsQuic: entry.viaLanMdnsQuic,
          rssiDbm: entry.rssiDbm,
          expiresAtUnixSeconds: entry.record.expiresAtUnixSeconds,
        })
      }
    }
    return out
  }
}
