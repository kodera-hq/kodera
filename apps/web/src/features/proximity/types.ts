/**
 * Proximity check-in types (`packages/kodera-rs` wire parity): an everyday presence channel with a
 * voluntary, pseudonymous check-in. It is not an emergency service.
 *
 * Wire format v1 (`"KE"` magic, version `1`, `118 B` fixed header + Ed25519 signature,
 * `<= 256 B` BLE GATT MTU, `TTL <= 6` hops, and 5-minute rotating `HMAC-SHA256`
 * proximity beacon). The format is FROZEN: it was fixed when the feature was called `#urgence`,
 * and every value below that reaches the wire or the signed input keeps the value it had then.
 * Only the names in this code changed.
 */

// Historical wire data (frame v1): the largest frame, text and hop count a peer accepts.
export const MAX_PROXIMITY_FRAME_BYTES = 256
export const MAX_PROXIMITY_TEXT_BYTES = 138
export const MAX_PROXIMITY_TTL_HOPS = 6
// Historical wire data (beacon v1): the window the beacon's bucket is counted in.
export const BEACON_ROTATION_WINDOW_SECS = 300
// Historical wire data (frame v1): the bytes around the text, and the version octet.
export const PROXIMITY_FIXED_OVERHEAD_BYTES = 118
export const PROXIMITY_PROTOCOL_VERSION = 1

// The proximity v1 bounds and clock rule shared with `kodera-rs` through
// `packages/kodera-rs/vectors/emergency-v1-rules.txt`, which the tests read. That file keeps its
// historical name: the native ports read it under it.
/** The most frames an outbox may be configured to hold (`queue_capacity`). */
export const PROXIMITY_QUEUE_CAPACITY = 128
/** The most device keys an organisation's roster tracks (`roster_members`). */
export const PROXIMITY_ROSTER_MEMBERS = 4096
/** The most message IDs a replay guard remembers (`replay_entries`). */
export const PROXIMITY_REPLAY_ENTRIES = 4096
/** A frame dated more than this far ahead of the verifier's clock is refused (`max_future_skew_ms`). */
export const PROXIMITY_MAX_FUTURE_SKEW_MS = 300_000

/** True when the frame's UUIDv7 time is more than the skew bound ahead of the verifier's clock. */
export function isTooFarAhead(frameTimestampMs: number, nowMs: number): boolean {
  return frameTimestampMs > nowMs + PROXIMITY_MAX_FUTURE_SKEW_MS
}

// Historical wire data (frame v1, octet 52, and the signed input): the four status values.
export enum SafetyStatus {
  MessageOnly = 0,
  Safe = 1,
  NeedAssistance = 2,
  MusterPoint = 3,
}

export type ProximityErrorCode =
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

export class ProximityCodecError extends Error {
  readonly code: ProximityErrorCode

  constructor(code: ProximityErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ProximityCodecError'
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

/**
 * One provisioned sender of an organisation's proximity roster: its device's public half, and the
 * pseudonym its member picked for check-ins, if any. It holds no name, no role and no account:
 * a check-in never requires one, and this feature has nowhere to keep one.
 */
export interface ProximityMemberDirectoryEntry {
  readonly publicKey: Uint8Array
  /** A handle of the contract's `ProximityCheckInHandle` grammar; with none, one is generated. */
  readonly dedicatedHandle?: string | undefined
}

/**
 * One check-in as heard: who sent it is the sender's public half, nothing else. What is shown in
 * its place is a pseudonymous handle, computed for the whole roster (`handle.ts`).
 */
export interface ProximityRosterCheckIn {
  readonly messageId: string
  readonly senderPublicKeyHex: string
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

export interface ProximityMeshEnvelope {
  readonly beaconHex: string
  readonly frameHex: string
}
