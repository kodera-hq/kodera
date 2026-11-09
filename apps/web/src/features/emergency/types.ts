/**
 * `#urgence` offline building-blackout lifeline types (`packages/kodera-rs` wire parity).
 *
 * Wire format v1 (`"KE"` magic, version `1`, `118 B` fixed header + Ed25519 signature,
 * `<= 256 B` BLE GATT MTU, `TTL <= 6` hops, and 5-minute rotating `HMAC-SHA256`
 * proximity beacon).
 */

export const MAX_EMERGENCY_FRAME_BYTES = 256
export const MAX_EMERGENCY_TEXT_BYTES = 138
export const MAX_EMERGENCY_TTL_HOPS = 6
export const BEACON_ROTATION_WINDOW_SECS = 300
export const EMERGENCY_FIXED_OVERHEAD_BYTES = 118
export const EMERGENCY_PROTOCOL_VERSION = 1

// The emergency v1 bounds and clock rule shared with `kodera-rs` through
// `packages/kodera-rs/vectors/emergency-v1-rules.txt`, which the tests read.
/** The most frames an outbox may be configured to hold (`queue_capacity`). */
export const EMERGENCY_QUEUE_CAPACITY = 128
/** The most device keys an organisation's roster tracks (`roster_members`). */
export const EMERGENCY_ROSTER_MEMBERS = 4096
/** The most message IDs a replay guard remembers (`replay_entries`). */
export const EMERGENCY_REPLAY_ENTRIES = 4096
/** A frame dated more than this far ahead of the verifier's clock is refused (`max_future_skew_ms`). */
export const EMERGENCY_MAX_FUTURE_SKEW_MS = 300_000

/** True when the frame's UUIDv7 time is more than the skew bound ahead of the verifier's clock. */
export function isTooFarAhead(frameTimestampMs: number, nowMs: number): boolean {
  return frameTimestampMs > nowMs + EMERGENCY_MAX_FUTURE_SKEW_MS
}

export enum SafetyStatus {
  MessageOnly = 0,
  Safe = 1,
  NeedAssistance = 2,
  MusterPoint = 3,
}

export type EmergencyErrorCode =
  | 'InvalidUuidV7'
  | 'InvalidTtl'
  | 'InvalidStatusBadge'
  | 'PayloadTooLarge'
  | 'MalformedFrame'
  | 'UnauthorizedSender'
  | 'InvalidSignature'
  | 'CryptoFailure'
  | 'TransportUnavailable'
  | 'InvalidConfiguration'

export class EmergencyCodecError extends Error {
  readonly code: EmergencyErrorCode

  constructor(code: EmergencyErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'EmergencyCodecError'
    this.code = code
  }
}

export interface DeviceIdentitySigner {
  publicKey(): Uint8Array
  sign(message: Uint8Array): Uint8Array
}

export interface SignatureVerifier {
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean | void
}

export interface EmergencyMemberDirectoryEntry {
  readonly publicKey: Uint8Array
  readonly displayName: string
  readonly roleLabel?: string | undefined
}

export interface EmergencyRosterCheckIn {
  readonly messageId: string
  readonly senderPublicKeyHex: string
  readonly displayName: string
  readonly roleLabel?: string | undefined
  readonly status: SafetyStatus
  readonly text: string
  readonly ttlHops: number
  readonly timestampMs: number
  readonly isLocal: boolean
}

export interface BleGattTransportAdapter {
  advertiseBeacon?(beaconId: Uint8Array): void | Promise<void>
  writeFrame(beaconId: Uint8Array, frameBytes: Uint8Array): void | Promise<void>
  onFrameReceived?(listener: (beaconId: Uint8Array, frameBytes: Uint8Array) => void): () => void
  close?(): void
}

export interface EmergencyMeshEnvelope {
  readonly beaconHex: string
  readonly frameHex: string
}
