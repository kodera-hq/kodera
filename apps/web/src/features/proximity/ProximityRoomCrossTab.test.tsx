import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { useEffect, useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { ProximityRoomPanel } from './ProximityRoomPanel'
import { ProximityFrame, UuidV7, bytesToHex, computeProximityBeacon, hexToBytes } from './codec'
import {
  type BroadcastChannelLike,
  PROXIMITY_MESH_CHANNEL_NAME,
  ProximityRoomController,
  verifyProximityBeacon,
} from './transport'
import {
  type DeviceIdentitySigner,
  type ProximityMemberDirectoryEntry,
  type ProximityMeshEnvelope,
  MAX_PROXIMITY_TTL_HOPS,
  SafetyStatus,
  type SignatureVerifier,
} from './types'

/**
 * ASN.1 DER SubjectPublicKeyInfo (SPKI) 12-byte prefix for RFC 8410 Ed25519 32-byte raw public keys.
 */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

function createRuntimeEd25519Identity(): {
  readonly signer: DeviceIdentitySigner
  readonly publicKeyBytes: Uint8Array
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' })
  const publicKeyBytes = new Uint8Array(
    spkiDer.buffer,
    spkiDer.byteOffset + spkiDer.byteLength - 32,
    32
  ).slice()

  const signer: DeviceIdentitySigner = {
    publicKey(): Uint8Array {
      return new Uint8Array(publicKeyBytes)
    },
    sign(message: Uint8Array): Uint8Array {
      const sigBuf = sign(null, message, privateKey)
      return new Uint8Array(sigBuf.buffer, sigBuf.byteOffset, sigBuf.byteLength).slice()
    },
  }

  return { signer, publicKeyBytes }
}

const NODE_CRYPTO_ED25519_VERIFIER: SignatureVerifier = {
  verify(publicKeyBytes: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    if (publicKeyBytes.length !== 32 || signature.length !== 64) {
      return false
    }
    try {
      const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32)
      spki.set(ED25519_SPKI_PREFIX, 0)
      spki.set(publicKeyBytes, ED25519_SPKI_PREFIX.length)
      const keyObject = createPublicKey({
        key: Buffer.from(spki),
        format: 'der',
        type: 'spki',
      })
      return verify(null, message, keyObject, signature)
    } catch {
      return false
    }
  },
}

class InMemoryBroadcastHub {
  private readonly endpointsByChannel = new Map<string, Set<InMemoryBroadcastEndpoint>>()
  readonly wireEnvelopes: ProximityMeshEnvelope[] = []

  createChannel = (name: string): BroadcastChannelLike => {
    let peers = this.endpointsByChannel.get(name)
    if (peers === undefined) {
      peers = new Set()
      this.endpointsByChannel.set(name, peers)
    }
    const endpoint = new InMemoryBroadcastEndpoint(name, peers, (data) => {
      if (typeof data === 'object' && data !== null && 'beaconHex' in data && 'frameHex' in data) {
        this.wireEnvelopes.push(data as ProximityMeshEnvelope)
      }
    })
    peers.add(endpoint)
    return endpoint
  }
}

class InMemoryBroadcastEndpoint implements BroadcastChannelLike {
  readonly name: string
  private readonly peers: Set<InMemoryBroadcastEndpoint>
  private readonly onRecord: (data: unknown) => void
  private closed = false
  onmessage: ((event: { readonly data: unknown }) => void) | null = null

  constructor(
    name: string,
    peers: Set<InMemoryBroadcastEndpoint>,
    onRecord: (data: unknown) => void
  ) {
    this.name = name
    this.peers = peers
    this.onRecord = onRecord
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return
    }
    this.onRecord(data)
    for (const peer of [...this.peers]) {
      if (peer !== this && !peer.closed && peer.onmessage !== null) {
        peer.onmessage({ data })
      }
    }
  }

  close(): void {
    this.closed = true
    this.onmessage = null
    this.peers.delete(this)
  }
}

interface ConnectedProximityTabProps {
  readonly testId: string
  readonly controller: ProximityRoomController
  readonly orgBeaconSalt: Uint8Array
  readonly unixSecs: number
  readonly localDisplayName: string
  readonly localSigner: DeviceIdentitySigner
}

function ConnectedProximityTab({
  testId,
  controller,
  orgBeaconSalt,
  unixSecs,
  localDisplayName,
  localSigner,
}: ConnectedProximityTabProps) {
  const [roster, setRoster] = useState(() => controller.getRoster())

  useEffect(() => {
    return controller.subscribe(() => {
      setRoster(controller.getRoster())
    })
  }, [controller])

  const remoteRevisionKey = roster
    .filter((entry) => !entry.isLocal)
    .map((entry) => `${entry.messageId}:${entry.status}:${entry.ttlHops}`)
    .join('|')

  return (
    <div data-testid={testId}>
      <ProximityRoomPanel
        key={remoteRevisionKey}
        channelName="#proximity"
        transport={{ orgBeaconSalt, unixSecs, localSigner, initialRoster: roster }}
        localDisplayName={localDisplayName}
        onCheckIn={(checkIn) => {
          controller.emitCheckIn(checkIn.status, checkIn.text, checkIn.ttlHops)
        }}
      />
    </div>
  )
}

describe('ProximityRoomCrossTab — BroadcastChannel + node:crypto Ed25519 integration', () => {
  const FIXED_UNIX_SECS = 1_762_520_100
  const ORG_SALT = new Uint8Array(32).fill(0x5a)

  it('propagates signed Ed25519 KE v1 frames across tabs, verifies rotating HMAC-SHA256 beacons, queues TTL-decremented relays, and converges on NeedAssistance > Safe priority ordering', async () => {
    const user = userEvent.setup()
    const hub = new InMemoryBroadcastHub()

    const aliceIdentity = createRuntimeEd25519Identity()
    const karimIdentity = createRuntimeEd25519Identity()

    const directory: readonly ProximityMemberDirectoryEntry[] = [
      {
        publicKey: aliceIdentity.publicKeyBytes,
        displayName: 'Poste Alice',
        roleLabel: 'Secours Étage 3',
      },
      {
        publicKey: karimIdentity.publicKeyBytes,
        displayName: 'Poste Karim',
        roleLabel: 'Coordinateur Rez-de-chaussée',
      },
    ]

    let clockMs = FIXED_UNIX_SECS * 1000
    const nextClockMs = () => {
      clockMs += 10
      return clockMs
    }

    const aliceController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: aliceIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Alice',
      nowMs: nextClockMs,
      broadcastChannelFactory: hub.createChannel,
    })

    const karimController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: karimIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Karim',
      nowMs: nextClockMs,
      broadcastChannelFactory: hub.createChannel,
    })

    render(
      <div>
        <ConnectedProximityTab
          testId="tab-alice"
          controller={aliceController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Alice"
          localSigner={aliceIdentity.signer}
        />
        <ConnectedProximityTab
          testId="tab-karim"
          controller={karimController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Karim"
          localSigner={karimIdentity.signer}
        />
      </div>
    )

    const tabAlice = screen.getByTestId('tab-alice')
    const tabKarim = screen.getByTestId('tab-karim')

    // 1. Alice types an proximity note and clicks "Besoin d’assistance" in Tab A
    const aliceInput = within(tabAlice).getByLabelText('Message court (facultatif)')
    await user.type(aliceInput, 'Ascenseur bloqué palier nord')

    const aliceActionGroup = within(tabAlice).getByRole('group', {
      name: 'Signaler votre situation',
    })
    await user.click(within(aliceActionGroup).getByRole('button', { name: /Besoin d’assistance/i }))

    // Verify wire frame sent over BroadcastChannel is a valid "KE" v1 binary frame with valid beacon & Ed25519 signature
    expect(hub.wireEnvelopes).toHaveLength(1)
    const firstEnvelope = hub.wireEnvelopes[0]!
    const wireBeacon = hexToBytes(firstEnvelope.beaconHex)
    const wireFrameBytes = hexToBytes(firstEnvelope.frameHex)

    expect(wireBeacon).toEqual(computeProximityBeacon(ORG_SALT, FIXED_UNIX_SECS))
    expect(verifyProximityBeacon(wireBeacon, ORG_SALT, FIXED_UNIX_SECS)).toBe(true)

    const decodedAliceFrame = ProximityFrame.decode(wireFrameBytes)
    expect(decodedAliceFrame.status).toBe(SafetyStatus.NeedAssistance)
    expect(decodedAliceFrame.ttlHops).toBe(MAX_PROXIMITY_TTL_HOPS)
    expect(decodedAliceFrame.text).toBe('Ascenseur bloqué palier nord')
    expect(
      decodedAliceFrame.verifySender([aliceIdentity.publicKeyBytes], NODE_CRYPTO_ED25519_VERIFIER)
    ).toBe(true)

    // Verify Tab B (Karim) queued a relay frame with decremented TTL (ttlHops === 5)
    const karimRelayQueue = karimController.peekRelayQueue()
    expect(karimRelayQueue).toHaveLength(1)
    expect(karimRelayQueue[0]!.frame.ttlHops).toBe(5)
    expect(karimRelayQueue[0]!.frame.status).toBe(SafetyStatus.NeedAssistance)
    expect(karimRelayQueue[0]!.priority).toBe(3)

    // Verify Tab B's roster UI immediately renders Alice's NeedAssistance check-in at the top
    const karimRosterAfterAlice = within(tabKarim).getAllByRole('listitem')
    expect(karimRosterAfterAlice).toHaveLength(1)
    expect(karimRosterAfterAlice[0]).toHaveTextContent('Poste Alice')
    expect(karimRosterAfterAlice[0]).toHaveTextContent('Besoin d’assistance')
    expect(karimRosterAfterAlice[0]).toHaveTextContent('Ascenseur bloqué palier nord')

    // 2. Karim clicks "En sécurité" (SafetyStatus.Safe) in Tab B
    const karimInput = within(tabKarim).getByLabelText('Message court (facultatif)')
    await user.type(karimInput, 'Hall principal dégagé')

    const karimActionGroup = within(tabKarim).getByRole('group', {
      name: 'Signaler votre situation',
    })
    await user.click(within(karimActionGroup).getByRole('button', { name: /En sécurité/i }))

    expect(hub.wireEnvelopes).toHaveLength(2)

    // Both Tab A and Tab B must converge on the exact same 2-member roster with NeedAssistance (Alice) ordered above Safe (Karim)
    const aliceRosterItems = within(tabAlice).getAllByRole('listitem')
    const karimRosterItems = within(tabKarim).getAllByRole('listitem')

    expect(aliceRosterItems).toHaveLength(2)
    expect(karimRosterItems).toHaveLength(2)

    expect(aliceRosterItems[0]).toHaveTextContent('Poste Alice')
    expect(aliceRosterItems[0]).toHaveTextContent('Besoin d’assistance')
    expect(aliceRosterItems[1]).toHaveTextContent('Poste Karim')
    expect(aliceRosterItems[1]).toHaveTextContent('En sécurité')

    expect(karimRosterItems[0]).toHaveTextContent('Poste Alice')
    expect(karimRosterItems[0]).toHaveTextContent('Besoin d’assistance')
    expect(karimRosterItems[1]).toHaveTextContent('Poste Karim')
    expect(karimRosterItems[1]).toHaveTextContent('En sécurité')

    aliceController.close()
    karimController.close()
  })

  it('enforces cross-organization isolation and rejects forged or unauthorized packets on the shared BroadcastChannel', () => {
    const hub = new InMemoryBroadcastHub()
    const aliceIdentity = createRuntimeEd25519Identity()
    const karimIdentity = createRuntimeEd25519Identity()
    const outsiderIdentity = createRuntimeEd25519Identity()

    const directory: readonly ProximityMemberDirectoryEntry[] = [
      { publicKey: aliceIdentity.publicKeyBytes, displayName: 'Poste Alice' },
      { publicKey: karimIdentity.publicKeyBytes, displayName: 'Poste Karim' },
    ]

    const fixedNow = () => FIXED_UNIX_SECS * 1000

    const aliceController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: aliceIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Alice',
      nowMs: fixedNow,
      broadcastChannelFactory: hub.createChannel,
    })

    const karimController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: karimIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Karim',
      nowMs: fixedNow,
      broadcastChannelFactory: hub.createChannel,
    })

    render(
      <div>
        <ConnectedProximityTab
          testId="tab-alice"
          controller={aliceController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Alice"
          localSigner={aliceIdentity.signer}
        />
        <ConnectedProximityTab
          testId="tab-karim"
          controller={karimController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Karim"
          localSigner={karimIdentity.signer}
        />
      </div>
    )

    // Case A: A third controller ("Organisation Externe") with a different 32-byte orgBeaconSalt broadcasts on the same channel
    const foreignOrgSalt = new Uint8Array(32).fill(0x99)
    const externalController = new ProximityRoomController({
      orgBeaconSalt: foreignOrgSalt,
      localSigner: outsiderIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: [
        { publicKey: outsiderIdentity.publicKeyBytes, displayName: 'Organisation Externe' },
      ],
      localDisplayName: 'Organisation Externe',
      nowMs: fixedNow,
      broadcastChannelFactory: hub.createChannel,
    })

    act(() => {
      externalController.emitCheckIn(SafetyStatus.NeedAssistance, 'Intrusion inter-organisation')
    })

    // Verify direct ingestion reason is invalid_beacon
    const foreignBeacon = computeProximityBeacon(foreignOrgSalt, FIXED_UNIX_SECS)
    const validOrgBeacon = computeProximityBeacon(ORG_SALT, FIXED_UNIX_SECS)
    const outsiderFrame = ProximityFrame.newSigned(
      UuidV7.fromParts(FIXED_UNIX_SECS * 1000 + 50, new Uint8Array(10).fill(0x11)),
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.NeedAssistance,
      'Intrusion directe',
      outsiderIdentity.signer
    ).encode()

    expect(aliceController.ingestPeerFrame(foreignBeacon, outsiderFrame, FIXED_UNIX_SECS)).toEqual({
      accepted: false,
      reason: 'invalid_beacon',
    })

    // Case B: Correct org beacon, but signed by an unauthorized Ed25519 keypair not in the org directory
    expect(aliceController.ingestPeerFrame(validOrgBeacon, outsiderFrame, FIXED_UNIX_SECS)).toEqual(
      {
        accepted: false,
        reason: 'unauthorized_sender',
      }
    )

    // Case C: Authorized sender public key (Alice), but forged signature bytes
    const validAliceFrame = ProximityFrame.newSigned(
      UuidV7.fromParts(FIXED_UNIX_SECS * 1000 + 60, new Uint8Array(10).fill(0x22)),
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.NeedAssistance,
      'Trame authentique',
      aliceIdentity.signer
    ).encode()
    const forgedAliceFrame = new Uint8Array(validAliceFrame)
    forgedAliceFrame[forgedAliceFrame.length - 1] =
      (forgedAliceFrame[forgedAliceFrame.length - 1]! ^ 0xff) & 0xff

    expect(
      karimController.ingestPeerFrame(validOrgBeacon, forgedAliceFrame, FIXED_UNIX_SECS)
    ).toEqual({
      accepted: false,
      reason: 'invalid_signature',
    })

    // Broadcast the unauthorized and forged frames on the shared BroadcastChannel hub
    const rawInjector = hub.createChannel(PROXIMITY_MESH_CHANNEL_NAME)
    act(() => {
      rawInjector.postMessage({
        beaconHex: bytesToHex(validOrgBeacon),
        frameHex: bytesToHex(outsiderFrame),
      })
      rawInjector.postMessage({
        beaconHex: bytesToHex(validOrgBeacon),
        frameHex: bytesToHex(forgedAliceFrame),
      })
    })

    // Both Alice's and Karim's UIs and relay queues remain completely untouched (0 roster entries, 0 relay queue entries)
    expect(aliceController.getRoster()).toHaveLength(0)
    expect(karimController.getRoster()).toHaveLength(0)
    expect(aliceController.peekRelayQueue()).toHaveLength(0)
    expect(karimController.peekRelayQueue()).toHaveLength(0)

    expect(within(screen.getByTestId('tab-alice')).queryAllByRole('listitem')).toHaveLength(0)
    expect(within(screen.getByTestId('tab-karim')).queryAllByRole('listitem')).toHaveLength(0)

    rawInjector.close()
    externalController.close()
    aliceController.close()
    karimController.close()
  })

  it('rejects stale UuidV7 replay frames without downgrading live NeedAssistance UI state and preempts full relay queues by priority', async () => {
    const user = userEvent.setup()
    const hub = new InMemoryBroadcastHub()

    const aliceIdentity = createRuntimeEd25519Identity()
    const karimIdentity = createRuntimeEd25519Identity()
    const sylvainIdentity = createRuntimeEd25519Identity()

    const directory: readonly ProximityMemberDirectoryEntry[] = [
      { publicKey: aliceIdentity.publicKeyBytes, displayName: 'Poste Alice' },
      { publicKey: karimIdentity.publicKeyBytes, displayName: 'Poste Karim' },
      { publicKey: sylvainIdentity.publicKeyBytes, displayName: 'Poste Sylvain' },
    ]

    const clockMs = FIXED_UNIX_SECS * 1000 + 5_000
    const aliceController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: aliceIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Alice',
      nowMs: () => clockMs,
      broadcastChannelFactory: hub.createChannel,
      maxQueueCapacity: 2,
    })

    const karimController = new ProximityRoomController({
      orgBeaconSalt: ORG_SALT,
      localSigner: karimIdentity.signer,
      verifier: NODE_CRYPTO_ED25519_VERIFIER,
      members: directory,
      localDisplayName: 'Poste Karim',
      nowMs: () => clockMs,
      broadcastChannelFactory: hub.createChannel,
      maxQueueCapacity: 2,
    })

    render(
      <div>
        <ConnectedProximityTab
          testId="tab-alice"
          controller={aliceController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Alice"
          localSigner={aliceIdentity.signer}
        />
        <ConnectedProximityTab
          testId="tab-karim"
          controller={karimController}
          orgBeaconSalt={ORG_SALT}
          unixSecs={FIXED_UNIX_SECS}
          localDisplayName="Poste Karim"
          localSigner={karimIdentity.signer}
        />
      </div>
    )

    const tabAlice = screen.getByTestId('tab-alice')
    const tabKarim = screen.getByTestId('tab-karim')

    // Alice emits a live NeedAssistance check-in at t = +5000ms
    const aliceActionGroup = within(tabAlice).getByRole('group', {
      name: 'Signaler votre situation',
    })
    await user.click(within(aliceActionGroup).getByRole('button', { name: /Besoin d’assistance/i }))

    expect(within(tabKarim).getAllByRole('listitem')[0]).toHaveTextContent('Besoin d’assistance')

    // Craft an older signed frame from Alice (Safe at t = +1000ms, earlier UuidV7 timestamp)
    const olderMessageId = UuidV7.fromParts(
      FIXED_UNIX_SECS * 1000 + 1_000,
      new Uint8Array(10).fill(0x01)
    )
    const staleAliceSafeFrame = ProximityFrame.newSigned(
      olderMessageId,
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.Safe,
      'Ancien pointage en sécurité',
      aliceIdentity.signer
    ).encode()

    const validBeacon = computeProximityBeacon(ORG_SALT, FIXED_UNIX_SECS)

    // Direct ingestion returns stale_frame
    const staleResult = karimController.ingestPeerFrame(
      validBeacon,
      staleAliceSafeFrame,
      FIXED_UNIX_SECS
    )
    expect(staleResult).toEqual({
      accepted: false,
      reason: 'stale_frame',
    })

    // Re-injecting over BroadcastChannel also leaves Karim's live UI untouched (Alice stays NeedAssistance)
    const rawChannel = hub.createChannel(PROXIMITY_MESH_CHANNEL_NAME)
    act(() => {
      rawChannel.postMessage({
        beaconHex: bytesToHex(validBeacon),
        frameHex: bytesToHex(staleAliceSafeFrame),
      })
    })

    const karimItems = within(tabKarim).getAllByRole('listitem')
    expect(karimItems).toHaveLength(1)
    expect(karimItems[0]).toHaveTextContent('Poste Alice')
    expect(karimItems[0]).toHaveTextContent('Besoin d’assistance')
    expect(karimItems[0]).not.toHaveTextContent('Ancien pointage en sécurité')

    // Verify full relay queue preemption: fill Alice's 2-slot relay queue with Safe and MusterPoint, then preempt with NeedAssistance
    const karimSafeFrame = ProximityFrame.newSigned(
      UuidV7.fromParts(FIXED_UNIX_SECS * 1000 + 6_000, new Uint8Array(10).fill(0x02)),
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.Safe,
      'Karim OK',
      karimIdentity.signer
    ).encode()
    const loursMusterFrame = ProximityFrame.newSigned(
      UuidV7.fromParts(FIXED_UNIX_SECS * 1000 + 7_000, new Uint8Array(10).fill(0x03)),
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.MusterPoint,
      'Sylvain Ellenstein Cour Nord',
      sylvainIdentity.signer
    ).encode()
    const karimAssistFrame = ProximityFrame.newSigned(
      UuidV7.fromParts(FIXED_UNIX_SECS * 1000 + 8_000, new Uint8Array(10).fill(0x04)),
      MAX_PROXIMITY_TTL_HOPS,
      SafetyStatus.NeedAssistance,
      'Karim demande de l’aide',
      karimIdentity.signer
    ).encode()

    act(() => {
      expect(
        aliceController.ingestPeerFrame(validBeacon, karimSafeFrame, FIXED_UNIX_SECS).accepted
      ).toBe(true)
      expect(
        aliceController.ingestPeerFrame(validBeacon, loursMusterFrame, FIXED_UNIX_SECS).accepted
      ).toBe(true)
    })
    expect(aliceController.peekRelayQueue()).toHaveLength(2)

    // Injecting higher-priority NeedAssistance preempts the lowest-priority Safe entry in the 2-slot queue
    act(() => {
      const preemptResult = aliceController.ingestPeerFrame(
        validBeacon,
        karimAssistFrame,
        FIXED_UNIX_SECS
      )
      expect(preemptResult.accepted).toBe(true)
    })

    const aliceQueue = aliceController.peekRelayQueue()
    expect(aliceQueue).toHaveLength(2)
    expect(aliceQueue[0]!.frame.status).toBe(SafetyStatus.NeedAssistance)
    expect(aliceQueue[1]!.frame.status).toBe(SafetyStatus.MusterPoint)

    rawChannel.close()
    aliceController.close()
    karimController.close()
  })
})
