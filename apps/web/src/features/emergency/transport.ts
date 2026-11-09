import {
  EmergencyFrame,
  UuidV7,
  bytesToHex,
  computeProximityBeacon,
  constantTimeEqual,
  formatBeaconPreview,
  hexToBytes,
} from './codec'
import {
  BEACON_ROTATION_WINDOW_SECS,
  type BleGattTransportAdapter,
  EMERGENCY_QUEUE_CAPACITY,
  EMERGENCY_REPLAY_ENTRIES,
  EMERGENCY_ROSTER_MEMBERS,
  type DeviceIdentitySigner,
  EmergencyCodecError,
  type EmergencyMemberDirectoryEntry,
  type EmergencyMeshEnvelope,
  type EmergencyRosterCheckIn,
  MAX_EMERGENCY_TTL_HOPS,
  SafetyStatus,
  type SignatureVerifier,
  isTooFarAhead,
} from './types'

export const EMERGENCY_MESH_CHANNEL_NAME = 'kodera-emergency-mesh-v1'
export const KODERA_BLE_SERVICE_UUID = '00004b45-0000-1000-8000-00805f9b34fb'

export interface BroadcastChannelLike {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
}

export interface QueuedRelayFrame {
  readonly frame: EmergencyFrame
  readonly wireBytes: Uint8Array
  readonly priority: number
  readonly enqueuedOrder: number
}

export type IngestPeerFrameResult =
  | {
      readonly accepted: true
      readonly checkIn: EmergencyRosterCheckIn
      readonly relayedFrame: EmergencyFrame | null
    }
  | {
      readonly accepted: false
      readonly reason:
        | 'invalid_beacon'
        | 'malformed_frame'
        | 'unauthorized_sender'
        | 'invalid_signature'
        | 'duplicate_replay'
        | 'stale_frame'
        | 'future_frame'
    }

export interface EmergencyRoomControllerOptions {
  readonly orgBeaconSalt: Uint8Array
  readonly localSigner: DeviceIdentitySigner
  readonly verifier: SignatureVerifier
  readonly members: readonly EmergencyMemberDirectoryEntry[]
  readonly localDisplayName?: string | undefined
  readonly nowMs?: (() => number) | undefined
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined
  readonly bleAdapter?: BleGattTransportAdapter | undefined
  readonly broadcastChannelFactory?: ((name: string) => BroadcastChannelLike | null) | undefined
  readonly defaultTtlHops?: number | undefined
  readonly maxQueueCapacity?: number | undefined
  readonly maxReplayEntries?: number | undefined
}

export function safetyStatusPriority(status: SafetyStatus): number {
  switch (status) {
    case SafetyStatus.NeedAssistance:
      return 3
    case SafetyStatus.MusterPoint:
      return 2
    case SafetyStatus.Safe:
      return 1
    case SafetyStatus.MessageOnly:
      return 0
  }
}

/**
 * Verifies an 8-byte pseudonymous BLE proximity beacon against the current 5-minute window
 * and adjacent `±300s` windows to tolerate device clock skew during an outage.
 */
export function verifyProximityBeacon(
  candidateBeacon: Uint8Array,
  orgBeaconSalt: Uint8Array,
  unixSecs: number
): boolean {
  if (candidateBeacon.length !== 8 || orgBeaconSalt.length !== 32) {
    return false
  }
  const baseSecs = Math.max(0, Math.trunc(unixSecs))
  const windows = [
    baseSecs,
    Math.max(0, baseSecs - BEACON_ROTATION_WINDOW_SECS),
    baseSecs + BEACON_ROTATION_WINDOW_SECS,
  ]
  let matched = false
  for (const windowSecs of windows) {
    const expected = computeProximityBeacon(orgBeaconSalt, windowSecs)
    if (constantTimeEqual(candidateBeacon, expected)) {
      matched = true
    }
  }
  return matched
}

function defaultRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  const cryptoGlobal = (
    globalThis as { readonly crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } }
  ).crypto
  if (cryptoGlobal?.getRandomValues !== undefined) {
    cryptoGlobal.getRandomValues(out)
    return out
  }
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 37 + 0x5a) & 0xff
  }
  return out
}

function defaultBroadcastChannelFactory(name: string): BroadcastChannelLike | null {
  const ChannelCtor = (
    globalThis as {
      readonly BroadcastChannel?: new (channelName: string) => BroadcastChannelLike
    }
  ).BroadcastChannel
  if (typeof ChannelCtor !== 'function') {
    return null
  }
  try {
    return new ChannelCtor(name)
  } catch {
    return null
  }
}

const DEFAULT_MAX_QUEUE_CAPACITY = EMERGENCY_QUEUE_CAPACITY
const DEFAULT_MAX_REPLAY_ENTRIES = 1024
const MAX_ALLOWED_REPLAY_ENTRIES = EMERGENCY_REPLAY_ENTRIES

function clampCapacity(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function compareRelayFrames(a: EmergencyFrame, b: EmergencyFrame): number {
  const prioDiff = safetyStatusPriority(a.status) - safetyStatusPriority(b.status)
  if (prioDiff !== 0) {
    return prioDiff
  }
  return a.messageId.compareTo(b.messageId)
}

class BoundedReplayGuard {
  private readonly seen = new Set<string>()
  readonly maxEntries: number

  constructor(maxEntries: number | undefined) {
    this.maxEntries = clampCapacity(
      maxEntries,
      DEFAULT_MAX_REPLAY_ENTRIES,
      1,
      MAX_ALLOWED_REPLAY_ENTRIES
    )
  }

  has(id: UuidV7 | string): boolean {
    const key = typeof id === 'string' ? id : id.toString()
    return this.seen.has(key)
  }

  acceptOnce(id: UuidV7 | string): boolean {
    const key = typeof id === 'string' ? id : id.toString()
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
}

export class EmergencyRoomController {
  private readonly orgBeaconSalt: Uint8Array
  private readonly localSigner: DeviceIdentitySigner
  private readonly verifier: SignatureVerifier
  private readonly memberDirectory = new Map<string, EmergencyMemberDirectoryEntry>()
  private readonly rosterBySender = new Map<string, EmergencyRosterCheckIn>()
  private readonly replayGuard: BoundedReplayGuard
  private readonly maxQueueCapacity: number
  private readonly relayQueue: QueuedRelayFrame[] = []
  private readonly listeners = new Set<() => void>()
  private readonly nowMs: () => number
  private readonly randomBytes: (length: number) => Uint8Array
  private readonly bleAdapter: BleGattTransportAdapter | undefined
  private readonly broadcastChannel: BroadcastChannelLike | null
  private readonly unsubscribeBle: (() => void) | undefined
  private readonly defaultTtlHops: number
  private readonly localPublicKeyHex: string
  private readonly localDisplayName: string
  private enqueueSeq = 0

  constructor(options: EmergencyRoomControllerOptions) {
    if (options.orgBeaconSalt.length !== 32) {
      throw new EmergencyCodecError('CryptoFailure', 'orgBeaconSalt must be 32 bytes')
    }
    this.orgBeaconSalt = new Uint8Array(options.orgBeaconSalt)
    this.localSigner = options.localSigner
    this.verifier = options.verifier
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.randomBytes = options.randomBytes ?? defaultRandomBytes
    this.bleAdapter = options.bleAdapter
    this.defaultTtlHops = options.defaultTtlHops ?? MAX_EMERGENCY_TTL_HOPS
    this.maxQueueCapacity = clampCapacity(
      options.maxQueueCapacity,
      DEFAULT_MAX_QUEUE_CAPACITY,
      1,
      DEFAULT_MAX_QUEUE_CAPACITY
    )
    this.replayGuard = new BoundedReplayGuard(options.maxReplayEntries)

    const localPk = this.localSigner.publicKey()
    this.localPublicKeyHex = bytesToHex(localPk)
    this.localDisplayName = options.localDisplayName ?? 'Vous (cet appareil)'

    this.memberDirectory.set(this.localPublicKeyHex, {
      publicKey: localPk,
      displayName: this.localDisplayName,
    })

    if (options.members.length + 1 > EMERGENCY_ROSTER_MEMBERS) {
      throw new EmergencyCodecError(
        'InvalidConfiguration',
        `an emergency roster tracks at most ${EMERGENCY_ROSTER_MEMBERS} device keys`
      )
    }
    for (const member of options.members) {
      const hex = bytesToHex(member.publicKey)
      this.memberDirectory.set(hex, member)
    }

    const factory = options.broadcastChannelFactory ?? defaultBroadcastChannelFactory
    this.broadcastChannel = factory(EMERGENCY_MESH_CHANNEL_NAME)
    if (this.broadcastChannel !== null) {
      this.broadcastChannel.onmessage = (event) => {
        this.handleMeshEnvelope(event.data)
      }
    }

    if (this.bleAdapter?.onFrameReceived !== undefined) {
      this.unsubscribeBle = this.bleAdapter.onFrameReceived((beaconId, frameBytes) => {
        this.ingestPeerFrame(beaconId, frameBytes)
      })
    }
  }

  currentBeacon(unixSecs?: number): Uint8Array {
    const secs = unixSecs ?? Math.floor(this.nowMs() / 1000)
    return computeProximityBeacon(this.orgBeaconSalt, secs)
  }

  currentBeaconHex(unixSecs?: number): string {
    return bytesToHex(this.currentBeacon(unixSecs))
  }

  currentBeaconPreview(unixSecs?: number): string {
    return formatBeaconPreview(this.currentBeacon(unixSecs))
  }

  beaconRemainingSecs(unixSecs?: number): number {
    const secs = Math.max(0, Math.trunc(unixSecs ?? Math.floor(this.nowMs() / 1000)))
    return BEACON_ROTATION_WINDOW_SECS - (secs % BEACON_ROTATION_WINDOW_SECS)
  }

  containsMessageId(messageId: UuidV7 | string): boolean {
    const target = typeof messageId === 'string' ? messageId : messageId.toString()
    return this.relayQueue.some((entry) => entry.frame.messageId.toString() === target)
  }

  emitCheckIn(
    status: SafetyStatus,
    text: string = '',
    ttlHops: number = this.defaultTtlHops
  ): { readonly checkIn: EmergencyRosterCheckIn; readonly frame: EmergencyFrame; readonly wireBytes: Uint8Array } {
    const tsMs = this.nowMs()
    const messageId = UuidV7.fromParts(tsMs, this.randomBytes(10))
    const frame = EmergencyFrame.newSigned(
      messageId,
      ttlHops,
      status,
      text,
      this.localSigner
    )
    const wireBytes = frame.encode()
    if (!this.containsMessageId(frame.messageId)) {
      this.replayGuard.acceptOnce(frame.messageId)
    }

    const member = this.memberDirectory.get(this.localPublicKeyHex)
    const checkIn: EmergencyRosterCheckIn = {
      messageId: frame.messageId.toString(),
      senderPublicKeyHex: this.localPublicKeyHex,
      displayName: member?.displayName ?? this.localDisplayName,
      ...(member?.roleLabel !== undefined ? { roleLabel: member.roleLabel } : {}),
      status: frame.status,
      text: frame.text,
      ttlHops: frame.ttlHops,
      timestampMs: frame.messageId.timestampMs(),
      isLocal: true,
    }

    this.rosterBySender.set(this.localPublicKeyHex, checkIn)

    const beacon = this.currentBeacon(Math.floor(tsMs / 1000))
    this.publishOverTransports(beacon, wireBytes)
    this.notifyListeners()

    return { checkIn, frame, wireBytes }
  }

  ingestPeerFrame(
    beaconId: Uint8Array,
    wireBytes: Uint8Array,
    nowUnixSecs?: number
  ): IngestPeerFrameResult {
    const secs = nowUnixSecs ?? Math.floor(this.nowMs() / 1000)
    if (!verifyProximityBeacon(beaconId, this.orgBeaconSalt, secs)) {
      return { accepted: false, reason: 'invalid_beacon' }
    }

    let frame: EmergencyFrame
    try {
      frame = EmergencyFrame.decode(wireBytes)
    } catch {
      return { accepted: false, reason: 'malformed_frame' }
    }

    // A frame dated far ahead would outrank every real check-in from its sender until the
    // clock caught up, so it is refused before it reaches the roster or the replay guard.
    const nowMs = nowUnixSecs === undefined ? this.nowMs() : nowUnixSecs * 1000
    if (isTooFarAhead(frame.messageId.timestampMs(), nowMs)) {
      return { accepted: false, reason: 'future_frame' }
    }

    try {
      frame.verifySender(this.memberDirectory.keys(), this.verifier)
    } catch (error) {
      if (error instanceof EmergencyCodecError && error.code === 'UnauthorizedSender') {
        return { accepted: false, reason: 'unauthorized_sender' }
      }
      return { accepted: false, reason: 'invalid_signature' }
    }

    const messageIdStr = frame.messageId.toString()
    if (this.replayGuard.has(messageIdStr) || this.containsMessageId(messageIdStr)) {
      return { accepted: false, reason: 'duplicate_replay' }
    }

    const senderHex = bytesToHex(frame.senderPublicKey)
    const existing = this.rosterBySender.get(senderHex)
    if (existing !== undefined && messageIdStr <= existing.messageId) {
      if (messageIdStr === existing.messageId) {
        return { accepted: false, reason: 'duplicate_replay' }
      }
      return { accepted: false, reason: 'stale_frame' }
    }

    this.replayGuard.acceptOnce(frame.messageId)

    const member = this.memberDirectory.get(senderHex)
    const timestampMs = frame.messageId.timestampMs()
    const checkIn: EmergencyRosterCheckIn = {
      messageId: messageIdStr,
      senderPublicKeyHex: senderHex,
      displayName: member?.displayName ?? `Appareil ${senderHex.slice(0, 8)}`,
      ...(member?.roleLabel !== undefined ? { roleLabel: member.roleLabel } : {}),
      status: frame.status,
      text: frame.text,
      ttlHops: frame.ttlHops,
      timestampMs,
      isLocal: senderHex === this.localPublicKeyHex,
    }

    this.rosterBySender.set(senderHex, checkIn)

    const decremented = frame.decrementHop()
    const relayedFrame =
      decremented !== null && this.enqueueRelayFrame(decremented) ? decremented : null

    this.notifyListeners()
    return { accepted: true, checkIn, relayedFrame }
  }

  private enqueueRelayFrame(frame: EmergencyFrame): boolean {
    if (this.containsMessageId(frame.messageId)) {
      return false
    }
    const priority = safetyStatusPriority(frame.status)
    if (this.relayQueue.length >= this.maxQueueCapacity) {
      let lowestIndex = 0
      for (let i = 1; i < this.relayQueue.length; i += 1) {
        const current = this.relayQueue[i]
        const lowest = this.relayQueue[lowestIndex]
        if (
          current !== undefined &&
          lowest !== undefined &&
          compareRelayFrames(current.frame, lowest.frame) < 0
        ) {
          lowestIndex = i
        }
      }
      const lowestEntry = this.relayQueue[lowestIndex]
      if (lowestEntry === undefined || compareRelayFrames(frame, lowestEntry.frame) <= 0) {
        return false
      }
      this.relayQueue.splice(lowestIndex, 1)
    }

    const wireBytes = frame.encode()
    this.enqueueSeq += 1
    this.relayQueue.push({
      frame,
      wireBytes,
      priority,
      enqueuedOrder: this.enqueueSeq,
    })
    this.relayQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      const idCmp = b.frame.messageId.compareTo(a.frame.messageId)
      if (idCmp !== 0) return idCmp
      return a.enqueuedOrder - b.enqueuedOrder
    })
    return true
  }

  peekRelayQueue(): readonly QueuedRelayFrame[] {
    return [...this.relayQueue]
  }

  drainRelayQueue(maxFrames?: number): QueuedRelayFrame[] {
    const count =
      maxFrames === undefined
        ? this.relayQueue.length
        : Math.max(0, Math.min(this.relayQueue.length, Math.trunc(maxFrames)))
    const drained = this.relayQueue.splice(0, count)
    const beacon = this.currentBeacon()
    for (const item of drained) {
      this.publishOverTransports(beacon, item.wireBytes)
    }
    return drained
  }

  getRoster(): readonly EmergencyRosterCheckIn[] {
    const entries = [...this.rosterBySender.values()]
    entries.sort((a, b) => {
      const prioDiff = safetyStatusPriority(b.status) - safetyStatusPriority(a.status)
      if (prioDiff !== 0) return prioDiff
      return b.timestampMs - a.timestampMs
    })
    return entries
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.unsubscribeBle?.()
    this.bleAdapter?.close?.()
    if (this.broadcastChannel !== null) {
      this.broadcastChannel.onmessage = null
      this.broadcastChannel.close()
    }
    this.listeners.clear()
  }

  private publishOverTransports(beacon: Uint8Array, wireBytes: Uint8Array): void {
    if (this.broadcastChannel !== null) {
      const envelope: EmergencyMeshEnvelope = {
        beaconHex: bytesToHex(beacon),
        frameHex: bytesToHex(wireBytes),
      }
      try {
        this.broadcastChannel.postMessage(envelope)
      } catch {
        // Ignore closed channel errors during teardown
      }
    }
    if (this.bleAdapter !== undefined) {
      void this.bleAdapter.advertiseBeacon?.(beacon)
      void this.bleAdapter.writeFrame(beacon, wireBytes)
    }
  }

  private handleMeshEnvelope(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return
    }
    const record = raw as Record<string, unknown>
    const beaconHex = record['beaconHex']
    const frameHex = record['frameHex']
    if (typeof beaconHex !== 'string' || typeof frameHex !== 'string') {
      return
    }
    try {
      const beacon = hexToBytes(beaconHex)
      const wireBytes = hexToBytes(frameHex)
      this.ingestPeerFrame(beacon, wireBytes)
    } catch {
      // Ignore malformed cross-tab frames
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
