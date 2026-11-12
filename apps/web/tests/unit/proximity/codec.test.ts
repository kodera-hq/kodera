import { createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BEACON_ROTATION_WINDOW_SECS,
  type BroadcastChannelLike,
  PROXIMITY_FIXED_OVERHEAD_BYTES,
  PROXIMITY_MESH_CHANNEL_NAME,
  ProximityCodecError,
  ProximityFrame,
  ProximityReplayGuard,
  ProximityRoomController,
  MAX_PROXIMITY_FRAME_BYTES,
  MAX_PROXIMITY_TEXT_BYTES,
  MAX_PROXIMITY_TTL_HOPS,
  SafetyStatus,
  type SignatureVerifier,
  UuidV7,
  bytesToHex,
  computeProximityBeacon,
  createKeyedMacSigner,
  createKeyedMacVerifier,
  formatBeaconPreview,
  hexToBytes,
  hmacSha256,
  sha256,
  verifyProximityBeacon,
} from '@/features/proximity'

const UTF8 = new TextEncoder()
const ED25519_SPKI_PREFIX = hexToBytes('302a300506032b6570032100')

const nodeEd25519Verifier: SignatureVerifier = {
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    if (publicKey.length !== 32 || signature.length !== 64) return false
    const spkiDer = new Uint8Array(ED25519_SPKI_PREFIX.length + publicKey.length)
    spkiDer.set(ED25519_SPKI_PREFIX, 0)
    spkiDer.set(publicKey, ED25519_SPKI_PREFIX.length)
    const spkiKey = createPublicKey({
      key: Buffer.from(spkiDer),
      format: 'der',
      type: 'spki',
    })
    return ed25519Verify(null, message, spkiKey, signature)
  },
}

describe('proximity BLE wire codec & cryptographic parity (packages/kodera-rs)', () => {
  describe('FIPS 180-4 SHA-256 & RFC 4231 HMAC-SHA256', () => {
    it('computes canonical SHA-256 digests', () => {
      const abcDigest = sha256(UTF8.encode('abc'))
      expect(bytesToHex(abcDigest)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      )
    })

    it('matches RFC 4231 Test Case 2 (identical to kodera-rs)', () => {
      const mac = hmacSha256(UTF8.encode('Jefe'), UTF8.encode('what do ya want for nothing?'))
      const expected = new Uint8Array([
        0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95, 0x75,
        0xc7, 0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec,
        0x38, 0x43,
      ])
      expect(mac).toEqual(expected)
    })
  })

  describe('UuidV7 (RFC 9562)', () => {
    it('preserves monotonic millisecond timestamp and rejects v4 bytes', () => {
      const earlier = UuidV7.fromParts(1_762_520_000_000, new Uint8Array(10).fill(1))
      const later = UuidV7.fromParts(1_762_520_000_001, new Uint8Array(10).fill(0))

      expect(later.compareTo(earlier)).toBeGreaterThan(0)
      expect(earlier.timestampMs()).toBe(1_762_520_000_000)
      expect(earlier.toString()).toHaveLength(36)
      expect(earlier.toString()).toBe('019a5e60-e600-7101-8101-010101010101')

      const roundtripped = UuidV7.fromBytesChecked(earlier.asBytes())
      expect(roundtripped.equals(earlier)).toBe(true)

      const invalidV4 = earlier.asBytes()
      invalidV4[6] = 0x40
      expect(() => UuidV7.fromBytesChecked(invalidV4)).toThrowError(
        expect.objectContaining({ code: 'InvalidUuidV7' })
      )
    })
  })

  describe('computeProximityBeacon & Shared Cross-Platform Test Vector (ROADMAP §3)', () => {
    it('matches the shared cross-platform beacon vector and rotates every 5 minutes', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const unixSecs = 1_762_520_100 // bucket 5_875_067 (0x000000000059a57b)

      // Verify exact HMAC input construction from ROADMAP §3:
      // "kodera-beacon-v1" (16B) || 0x000000000059a57b (8B)
      const manualMsg = new Uint8Array(24)
      manualMsg.set(UTF8.encode('kodera-beacon-v1'), 0)
      manualMsg.set(hexToBytes('000000000059a57b'), 16)
      const expectedBeacon = hmacSha256(salt, manualMsg).slice(0, 8)

      const b1 = computeProximityBeacon(salt, unixSecs)
      const b2 = computeProximityBeacon(salt, 1_762_520_299)
      const b3 = computeProximityBeacon(salt, 1_762_520_400)

      expect(b1).toEqual(expectedBeacon)
      expect(bytesToHex(b1)).toBe('1be3967637ebb0ea')
      expect(b1).toHaveLength(8)
      expect(b1).toEqual(b2)
      expect(b1).not.toEqual(b3)
      expect(formatBeaconPreview(b1)).toBe('1be3:9676:37eb:b0ea')
      expect(formatBeaconPreview(b1)).toMatch(/^[0-9a-f]{4}(?::[0-9a-f]{4}){3}$/)
    })

    it('accepts beacons within ±300s clock skew and rejects expired windows', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const nowSecs = 1_762_520_100
      const currentBeacon = computeProximityBeacon(salt, nowSecs)
      const prevWindowBeacon = computeProximityBeacon(salt, nowSecs - BEACON_ROTATION_WINDOW_SECS)
      const nextWindowBeacon = computeProximityBeacon(salt, nowSecs + BEACON_ROTATION_WINDOW_SECS)
      const staleBeacon = computeProximityBeacon(salt, nowSecs - BEACON_ROTATION_WINDOW_SECS * 2)

      expect(verifyProximityBeacon(currentBeacon, salt, nowSecs)).toBe(true)
      expect(verifyProximityBeacon(prevWindowBeacon, salt, nowSecs)).toBe(true)
      expect(verifyProximityBeacon(nextWindowBeacon, salt, nowSecs)).toBe(true)
      expect(verifyProximityBeacon(staleBeacon, salt, nowSecs)).toBe(false)
    })
  })

  describe('ProximityFrame v1 wire codec ("KE" magic, 118B fixed overhead, <= 256B MTU)', () => {
    const secret = new Uint8Array(32).fill(7)
    const pk = new Uint8Array(32).fill(9)
    const signer = createKeyedMacSigner(secret, pk)
    const verifier = createKeyedMacVerifier(secret)
    const roster = [pk]

    it('encodes exact header offsets, survives TTL hop decrement, and rejects tampering', () => {
      const id = UuidV7.fromParts(1_762_520_000_500, new Uint8Array(10).fill(3))
      const text = 'Floor 3 clear - gathering at north courtyard'
      const frame = ProximityFrame.newSigned(id, 4, SafetyStatus.Safe, text, signer)

      const wire = frame.encode()
      expect(wire.length).toBe(PROXIMITY_FIXED_OVERHEAD_BYTES + text.length)
      expect(wire.length).toBeLessThanOrEqual(MAX_PROXIMITY_FRAME_BYTES)

      // Exact wire header layout check (ROADMAP §3):
      expect(wire[0]).toBe(0x4b) // 'K'
      expect(wire[1]).toBe(0x45) // 'E'
      expect(wire[2]).toBe(0x01) // version 1
      expect(wire.slice(3, 19)).toEqual(id.asBytes())
      expect(wire.slice(19, 51)).toEqual(pk)
      expect(wire[51]).toBe(4) // ttl_hops
      expect(wire[52]).toBe(SafetyStatus.Safe) // status = 1
      expect(wire[53]).toBe(text.length) // text_len

      const decoded = ProximityFrame.decode(wire)
      expect(decoded.equals(frame)).toBe(true)
      expect(decoded.verifySender(roster, verifier)).toBe(true)

      // Relaying decrements TTL without invalidating author signature
      const relayed = decoded.decrementHop()
      expect(relayed).not.toBeNull()
      expect(relayed?.ttlHops).toBe(3)
      expect(relayed?.verifySender(roster, verifier)).toBe(true)

      // TTL=1 frame stops relaying on decrementHop()
      const finalHop = ProximityFrame.newSigned(id, 1, SafetyStatus.Safe, 'Last hop', signer)
      expect(finalHop.decrementHop()).toBeNull()

      // Mutation self-test 1: tampered text MUST fail signature verification
      const forged = new ProximityFrame({
        messageId: decoded.messageId,
        senderPublicKey: decoded.senderPublicKey,
        ttlHops: decoded.ttlHops,
        status: decoded.status,
        text: 'Forged evacuation order',
        signature: decoded.signature,
      })
      expect(() => forged.verifySender(roster, verifier)).toThrowError(
        expect.objectContaining({ code: 'InvalidSignature' })
      )

      // Mutation self-test 2: non-member public key MUST fail roster check
      expect(() => decoded.verifySender([], verifier)).toThrowError(
        expect.objectContaining({ code: 'UnauthorizedSender' })
      )
    })

    it('enforces TTL bounds (1..=6) and UTF-8 text payload bounds (<= 138B)', () => {
      const id = UuidV7.fromParts(1_762_520_000_500, new Uint8Array(10).fill(3))

      expect(() => ProximityFrame.newSigned(id, 0, SafetyStatus.Safe, 'ok', signer)).toThrowError(
        expect.objectContaining({ code: 'InvalidTtl' })
      )

      expect(() =>
        ProximityFrame.newSigned(id, MAX_PROXIMITY_TTL_HOPS + 1, SafetyStatus.Safe, 'ok', signer)
      ).toThrowError(expect.objectContaining({ code: 'InvalidTtl' }))

      const maxText = 'a'.repeat(MAX_PROXIMITY_TEXT_BYTES)
      const maxFrame = ProximityFrame.newSigned(
        id,
        MAX_PROXIMITY_TTL_HOPS,
        SafetyStatus.NeedAssistance,
        maxText,
        signer
      )
      expect(maxFrame.encode().length).toBe(MAX_PROXIMITY_FRAME_BYTES)

      const oversizedText = 'a'.repeat(MAX_PROXIMITY_TEXT_BYTES + 1)
      expect(() =>
        ProximityFrame.newSigned(id, 3, SafetyStatus.Safe, oversizedText, signer)
      ).toThrowError(expect.objectContaining({ code: 'PayloadTooLarge' }))
    })

    it('verifies the canonical cross-platform 129-byte RFC 8032 Ed25519 signed frame (Rust/iOS/Android/Web parity)', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const unixSecs = 1_762_520_100 // bucket 5_875_067 -> beacon 1be3967637ebb0ea
      const beacon = computeProximityBeacon(salt, unixSecs)
      expect(bytesToHex(beacon)).toBe('1be3967637ebb0ea')

      const canonicalPublicKeyHex =
        'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
      const canonicalPublicKey = hexToBytes(canonicalPublicKeyHex)
      const canonicalFrameHex =
        '4b4501019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a03010bc380206ce2809961627269de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005'
      const raw = hexToBytes(canonicalFrameHex)
      expect(raw.byteLength).toBe(129)

      // 1. Decode exact fields from the canonical 129-byte frame
      const decoded = ProximityFrame.decode(raw)
      expect(decoded.messageId.toString()).toBe('019a5e62-6ca0-7303-8303-030303030303')
      expect(bytesToHex(decoded.messageId.asBytes())).toBe('019a5e626ca073038303030303030303')
      expect(bytesToHex(decoded.senderPublicKey)).toBe(canonicalPublicKeyHex)
      expect(decoded.ttlHops).toBe(3)
      expect(decoded.status).toBe(SafetyStatus.Safe)
      expect(decoded.text).toBe('À l’abri')
      expect(bytesToHex(UTF8.encode(decoded.text))).toBe('c380206ce2809961627269')
      expect(decoded.encode()).toEqual(raw)

      // 2. Verify authentic RFC 8032 Ed25519 signature via Node crypto SPKI verifier
      expect(decoded.verifySender([canonicalPublicKey], nodeEd25519Verifier)).toBe(true)

      // 3. Decrementing TTL hop produces ttlHops === 2 and preserves Ed25519 signature validity
      const decremented = decoded.decrementHop()
      expect(decremented).not.toBeNull()
      expect(decremented?.ttlHops).toBe(2)
      expect(decremented?.verifySender([canonicalPublicKey], nodeEd25519Verifier)).toBe(true)

      // 4. Mutating text, status, or senderPublicKey fails verifySender
      const mutatedText = new ProximityFrame({
        messageId: decoded.messageId,
        senderPublicKey: decoded.senderPublicKey,
        ttlHops: decoded.ttlHops,
        status: decoded.status,
        text: 'À l’abri !',
        signature: decoded.signature,
      })
      expect(() =>
        mutatedText.verifySender([canonicalPublicKey], nodeEd25519Verifier)
      ).toThrowError(expect.objectContaining({ code: 'InvalidSignature' }))

      const mutatedStatus = new ProximityFrame({
        messageId: decoded.messageId,
        senderPublicKey: decoded.senderPublicKey,
        ttlHops: decoded.ttlHops,
        status: SafetyStatus.NeedAssistance,
        text: decoded.text,
        signature: decoded.signature,
      })
      expect(() =>
        mutatedStatus.verifySender([canonicalPublicKey], nodeEd25519Verifier)
      ).toThrowError(expect.objectContaining({ code: 'InvalidSignature' }))

      const mutatedSenderKey = new Uint8Array(canonicalPublicKey)
      mutatedSenderKey[0] = (mutatedSenderKey[0] ?? 0) ^ 0xff
      const mutatedKeyFrame = new ProximityFrame({
        messageId: decoded.messageId,
        senderPublicKey: mutatedSenderKey,
        ttlHops: decoded.ttlHops,
        status: decoded.status,
        text: decoded.text,
        signature: decoded.signature,
      })
      expect(() =>
        mutatedKeyFrame.verifySender([canonicalPublicKey], nodeEd25519Verifier)
      ).toThrowError(expect.objectContaining({ code: 'UnauthorizedSender' }))
      expect(() =>
        mutatedKeyFrame.verifySender([mutatedSenderKey], nodeEd25519Verifier)
      ).toThrowError(expect.objectContaining({ code: 'InvalidSignature' }))
    })
  })

  describe('ProximityReplayGuard', () => {
    it('deduplicates seen UUIDv7 frames and evicts the oldest ID when exceeding capacity', () => {
      const guard = new ProximityReplayGuard(64)
      const firstId = UuidV7.fromParts(1_762_520_000_000, new Uint8Array(10).fill(5))
      expect(guard.acceptOnce(firstId)).toBe(true)
      expect(guard.acceptOnce(firstId)).toBe(false)

      for (let i = 1; i <= 64; i += 1) {
        const nextId = UuidV7.fromParts(1_762_520_000_000 + i, new Uint8Array(10).fill(5))
        expect(guard.acceptOnce(nextId)).toBe(true)
      }
      expect(guard.size).toBe(64)
      // Oldest entry (firstId) was evicted once 64 newer IDs arrived
      expect(guard.acceptOnce(firstId)).toBe(true)
    })
  })

  describe('ProximityRoomController mesh relay & priority ordering', () => {
    it('orders relay queue by priority (NeedAssistance > MusterPoint > Safe > MessageOnly) and syncs across BroadcastChannel', () => {
      const channels = new Map<string, Set<BroadcastChannelLike>>()
      const createMockChannel = (name: string): BroadcastChannelLike => {
        const peerSet = channels.get(name) ?? new Set<BroadcastChannelLike>()
        channels.set(name, peerSet)
        const channel: BroadcastChannelLike = {
          onmessage: null,
          postMessage(data: unknown) {
            for (const peer of peerSet) {
              if (peer !== channel) {
                peer.onmessage?.({ data })
              }
            }
          },
          close() {
            peerSet.delete(channel)
          },
        }
        peerSet.add(channel)
        return channel
      }

      const salt = new Uint8Array(32).fill(0x42)
      const secret = new Uint8Array(32).fill(0x07)
      const pkNodeA = new Uint8Array(32).fill(0x0a)
      const pkNodeB = new Uint8Array(32).fill(0x0b)
      const pkNodeC = new Uint8Array(32).fill(0x0c)

      const signerA = createKeyedMacSigner(secret, pkNodeA)
      const signerB = createKeyedMacSigner(secret, pkNodeB)
      const signerC = createKeyedMacSigner(secret, pkNodeC)
      const verifier = createKeyedMacVerifier(secret)

      const members = [{ publicKey: pkNodeA }, { publicKey: pkNodeB }, { publicKey: pkNodeC }]

      let clockMs = 1_762_520_100_000
      const controllerA = new ProximityRoomController({
        orgBeaconSalt: salt,
        localSigner: signerA,
        verifier,
        members,
        nowMs: () => clockMs,
        broadcastChannelFactory: createMockChannel,
      })

      const controllerB = new ProximityRoomController({
        orgBeaconSalt: salt,
        localSigner: signerB,
        verifier,
        members,
        nowMs: () => clockMs,
        broadcastChannelFactory: createMockChannel,
      })

      expect(channels.has(PROXIMITY_MESH_CHANNEL_NAME)).toBe(true)

      // Alice emits a Safe check-in -> Bruno receives it over BroadcastChannel
      controllerA.emitCheckIn(SafetyStatus.Safe, 'Alice au RDC', 4)
      expect(controllerB.getRoster()).toHaveLength(1)
      // Who checked in is the sender's public half: a check-in carries no name.
      expect(controllerB.getRoster()[0]?.senderPublicKeyHex).toBe(bytesToHex(pkNodeA))
      expect(controllerB.getRoster()[0]).not.toHaveProperty('displayName')
      expect(controllerB.getRoster()[0]?.ttlHops).toBe(4)

      // Chloé injects a MusterPoint frame and a NeedAssistance frame into Bruno
      clockMs += 1000
      const beacon = controllerB.currentBeacon()
      const musterFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs, new Uint8Array(10).fill(1)),
        5,
        SafetyStatus.MusterPoint,
        'Cour Nord ouverte',
        signerC
      )
      const assistFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 100, new Uint8Array(10).fill(2)),
        3,
        SafetyStatus.NeedAssistance,
        'Ascenseur bloqué au 2e',
        signerC
      )

      const resMuster = controllerB.ingestPeerFrame(beacon, musterFrame.encode())
      const resAssist = controllerB.ingestPeerFrame(beacon, assistFrame.encode())
      expect(resMuster.accepted).toBe(true)
      expect(resAssist.accepted).toBe(true)

      // Relay queue in Bruno MUST prioritize NeedAssistance first, then MusterPoint, then Safe
      const queue = controllerB.peekRelayQueue()
      expect(queue.map((q) => q.frame.status)).toEqual([
        SafetyStatus.NeedAssistance,
        SafetyStatus.MusterPoint,
        SafetyStatus.Safe,
      ])
      // And each relayed frame has its TTL decremented by 1 hop
      expect(queue.map((q) => q.frame.ttlHops)).toEqual([2, 4, 3])

      // Replay of the exact same frame is rejected
      const duplicate = controllerB.ingestPeerFrame(beacon, assistFrame.encode())
      expect(duplicate).toEqual({ accepted: false, reason: 'duplicate_replay' })

      controllerA.close()
      controllerB.close()
      expect(ProximityCodecError).toBeDefined()
    })

    it('rejects out-of-order stale frames without overwriting newer roster status or enqueueing relay frames', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const secret = new Uint8Array(32).fill(0x07)
      const pkLocal = new Uint8Array(32).fill(0x0a)
      const pkPeer = new Uint8Array(32).fill(0x0b)

      const localSigner = createKeyedMacSigner(secret, pkLocal)
      const peerSigner = createKeyedMacSigner(secret, pkPeer)
      const verifier = createKeyedMacVerifier(secret)

      const clockMs = 1_762_520_100_000
      const controller = new ProximityRoomController({
        orgBeaconSalt: salt,
        localSigner,
        verifier,
        members: [{ publicKey: pkPeer }],
        nowMs: () => clockMs,
        broadcastChannelFactory: () => null,
      })

      const beacon = controller.currentBeacon()
      const newerFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 5_000, new Uint8Array(10).fill(2)),
        4,
        SafetyStatus.Safe,
        'Sorti du bâtiment',
        peerSigner
      )
      const olderStaleFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 1_000, new Uint8Array(10).fill(1)),
        4,
        SafetyStatus.NeedAssistance,
        'Ancien statut en retard',
        peerSigner
      )

      const newerRes = controller.ingestPeerFrame(beacon, newerFrame.encode())
      expect(newerRes.accepted).toBe(true)
      expect(controller.getRoster()).toHaveLength(1)
      expect(controller.getRoster()[0]?.status).toBe(SafetyStatus.Safe)
      expect(controller.getRoster()[0]?.messageId).toBe(newerFrame.messageId.toString())
      expect(controller.peekRelayQueue()).toHaveLength(1)

      const staleRes = controller.ingestPeerFrame(beacon, olderStaleFrame.encode())
      expect(staleRes).toEqual({ accepted: false, reason: 'stale_frame' })

      // Roster and relay queue remain untouched by the stale frame
      expect(controller.getRoster()).toHaveLength(1)
      expect(controller.getRoster()[0]?.status).toBe(SafetyStatus.Safe)
      expect(controller.getRoster()[0]?.text).toBe('Sorti du bâtiment')
      expect(controller.peekRelayQueue()).toHaveLength(1)
      expect(controller.peekRelayQueue()[0]?.frame.messageId.toString()).toBe(
        newerFrame.messageId.toString()
      )

      controller.close()
    })

    it('preempts lower-priority relay frames at maxQueueCapacity and preserves peer roster updates when relay is full', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const secret = new Uint8Array(32).fill(0x07)
      const pkLocal = new Uint8Array(32).fill(0x0a)
      const pkPeerB = new Uint8Array(32).fill(0x0b)
      const pkPeerC = new Uint8Array(32).fill(0x0c)
      const pkPeerD = new Uint8Array(32).fill(0x0d)
      const pkPeerE = new Uint8Array(32).fill(0x0e)

      const localSigner = createKeyedMacSigner(secret, pkLocal)
      const signerB = createKeyedMacSigner(secret, pkPeerB)
      const signerC = createKeyedMacSigner(secret, pkPeerC)
      const signerD = createKeyedMacSigner(secret, pkPeerD)
      const signerE = createKeyedMacSigner(secret, pkPeerE)
      const verifier = createKeyedMacVerifier(secret)

      const clockMs = 1_762_520_100_000
      const controller = new ProximityRoomController({
        orgBeaconSalt: salt,
        localSigner,
        verifier,
        members: [
          { publicKey: pkPeerB },
          { publicKey: pkPeerC },
          { publicKey: pkPeerD },
          { publicKey: pkPeerE },
        ],
        nowMs: () => clockMs,
        maxQueueCapacity: 2,
        broadcastChannelFactory: () => null,
      })

      const beacon = controller.currentBeacon()

      // Fill the 2-slot relay queue with MusterPoint (priority 2) and Safe (priority 1)
      const musterFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 100, new Uint8Array(10).fill(1)),
        4,
        SafetyStatus.MusterPoint,
        'Rassemblement parking',
        signerB
      )
      const safeFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 200, new Uint8Array(10).fill(2)),
        4,
        SafetyStatus.Safe,
        'Couloir dégagé',
        signerC
      )

      expect(controller.ingestPeerFrame(beacon, musterFrame.encode()).accepted).toBe(true)
      expect(controller.ingestPeerFrame(beacon, safeFrame.encode()).accepted).toBe(true)
      expect(controller.peekRelayQueue()).toHaveLength(2)

      // A lower-priority MessageOnly frame from David is refused by the full relay queue
      // (relayedFrame === null) yet still updates David's verified status in the roster
      const messageOnlyFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 300, new Uint8Array(10).fill(3)),
        4,
        SafetyStatus.MessageOnly,
        'Escalier secondaire fermé',
        signerD
      )
      const refusedRelayRes = controller.ingestPeerFrame(beacon, messageOnlyFrame.encode())
      expect(refusedRelayRes.accepted).toBe(true)
      if (refusedRelayRes.accepted) {
        expect(refusedRelayRes.relayedFrame).toBeNull()
        expect(refusedRelayRes.checkIn.senderPublicKeyHex).toBe(bytesToHex(pkPeerD))
        expect(refusedRelayRes.checkIn.status).toBe(SafetyStatus.MessageOnly)
      }
      expect(
        controller.getRoster().some((entry) => entry.senderPublicKeyHex === bytesToHex(pkPeerD))
      ).toBe(true)
      expect(controller.peekRelayQueue().map((q) => q.frame.status)).toEqual([
        SafetyStatus.MusterPoint,
        SafetyStatus.Safe,
      ])

      // A higher-priority NeedAssistance frame from Emma preempts and evicts the lowest queued frame (Safe)
      const assistFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 400, new Uint8Array(10).fill(4)),
        4,
        SafetyStatus.NeedAssistance,
        'Besoin secours salle serveur',
        signerE
      )
      const preemptRes = controller.ingestPeerFrame(beacon, assistFrame.encode())
      expect(preemptRes.accepted).toBe(true)
      if (preemptRes.accepted) {
        expect(preemptRes.relayedFrame).not.toBeNull()
        expect(preemptRes.relayedFrame?.ttlHops).toBe(3)
      }
      expect(controller.peekRelayQueue().map((q) => q.frame.status)).toEqual([
        SafetyStatus.NeedAssistance,
        SafetyStatus.MusterPoint,
      ])

      controller.close()
    })

    it('deduplicates a frame still pending in relayQueue even after maxReplayEntries: 1 evicts it from replayGuard', () => {
      const salt = new Uint8Array(32).fill(0x42)
      const secret = new Uint8Array(32).fill(0x07)
      const pkLocal = new Uint8Array(32).fill(0x0a)
      const pkPeer = new Uint8Array(32).fill(0x0b)

      const localSigner = createKeyedMacSigner(secret, pkLocal)
      const peerSigner = createKeyedMacSigner(secret, pkPeer)
      const verifier = createKeyedMacVerifier(secret)

      const clockMs = 1_762_520_100_000
      const controller = new ProximityRoomController({
        orgBeaconSalt: salt,
        localSigner,
        verifier,
        members: [{ publicKey: pkPeer }],
        nowMs: () => clockMs,
        maxReplayEntries: 1,
        maxQueueCapacity: 4,
        broadcastChannelFactory: () => null,
      })

      const beacon = controller.currentBeacon()
      const firstFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 100, new Uint8Array(10).fill(1)),
        4,
        SafetyStatus.NeedAssistance,
        'Premier signal',
        peerSigner
      )
      const secondFrame = ProximityFrame.newSigned(
        UuidV7.fromParts(clockMs + 200, new Uint8Array(10).fill(2)),
        4,
        SafetyStatus.Safe,
        'Second signal après évacuation',
        peerSigner
      )

      expect(controller.ingestPeerFrame(beacon, firstFrame.encode()).accepted).toBe(true)
      // Ingesting secondFrame with maxReplayEntries: 1 evicts firstFrame from replayGuard
      // and advances Bruno's roster entry to secondFrame, while firstFrame remains in relayQueue
      expect(controller.ingestPeerFrame(beacon, secondFrame.encode()).accepted).toBe(true)
      expect(controller.containsMessageId(firstFrame.messageId)).toBe(true)

      // Replaying firstFrame while it is still pending in relayQueue MUST return duplicate_replay
      const replayWhileQueued = controller.ingestPeerFrame(beacon, firstFrame.encode())
      expect(replayWhileQueued).toEqual({ accepted: false, reason: 'duplicate_replay' })

      controller.close()
    })
  })
})
