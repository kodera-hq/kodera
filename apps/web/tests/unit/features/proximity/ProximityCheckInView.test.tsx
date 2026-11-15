import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { bytesToHex } from '@/features/proximity/codec'
import { ProximityCheckInView } from '@/features/proximity/ProximityCheckInView'
import {
  InMemoryProximityVoluntaryBroker,
  PROXIMITY_EPOCH_ROTATION_SECS,
  ProximityVoluntaryError,
  RssiDistanceClassifier,
  assertZeroGpsPayload,
  bootstrapAndCheckInProximity,
  bootstrapProximityWorkspace,
  createHttpProximityVoluntaryBroker,
  hkdfSha256,
  mintEpochProximityToken,
  mintRotatingProximityToken,
  verifyEpochProximityToken,
  verifyRotatingProximityToken,
  type ProximityApiTransport,
  type ProximityVoluntaryBrokerAdapter,
  type VoluntaryCheckInRecord,
  type VoluntaryProximityPeer,
} from '@/features/proximity/voluntaryCheckIn'

interface EpochLeaseFixture {
  readonly reference_workspace_master_key: string
  readonly device_seed: string
  readonly now_unix_seconds: number
  readonly counter: number
  readonly bootstrap: {
    readonly workspace_id: string
    readonly event_scope: string
    readonly epoch: number
    readonly epoch_mac_key: string
    readonly epoch_expires_at: number
    readonly epoch_rotation_seconds: number
  }
  readonly token_hex: string
}

const EPOCH_LEASE_VECTOR_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages/kodera-rs/vectors/proximity-epoch-lease-v1.json'
)

const epochLeaseFixture = JSON.parse(
  readFileSync(EPOCH_LEASE_VECTOR_PATH, 'utf8')
) as EpochLeaseFixture

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_B_ID = '22222222-2222-4222-8222-222222222222'
const MASTER_KEY = Uint8Array.from({ length: 32 }, (_, idx) => idx + 1)
const ALICE_SEED = Uint8Array.from({ length: 32 }, (_, idx) => idx + 65)
const BOB_SEED = Uint8Array.from({ length: 32 }, (_, idx) => idx + 129)

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeRecord(
  workspaceId: string,
  eventScope: string,
  pseudonymPrefix: string,
  nowUnixSeconds = 1_760_000_100
): VoluntaryCheckInRecord {
  const rollingPseudonymHex = pseudonymPrefix.padEnd(32, 'a').slice(0, 32)
  return {
    workspaceId,
    eventScope,
    rollingPseudonymHex,
    tokenHex: '4b5401'.padEnd(64, '0'),
    statusNote: 'Note A',
    checkedInAtUnixSeconds: nowUnixSeconds,
    expiresAtUnixSeconds: nowUnixSeconds + 1800,
    durationSeconds: 1800,
  }
}

function makePeer(handle: string, statusNote: string): VoluntaryProximityPeer {
  return {
    peerId: `peer-${handle}`,
    handle,
    statusNote,
    distanceBand: 'immediate',
    viaLanMdnsQuic: true,
    expiresAtUnixSeconds: 1_760_001_900,
  }
}

function referenceEpochKey(workspace: string, scope: string, epoch: number): Uint8Array {
  const epochBytes = new Uint8Array(4)
  new DataView(epochBytes.buffer).setUint32(0, epoch, false)
  return hkdfSha256(
    new TextEncoder().encode(`${workspace}:${scope}`),
    MASTER_KEY,
    new Uint8Array([
      ...new TextEncoder().encode('kodera.proximity.w9.epoch-mac.v1:'),
      ...epochBytes,
    ]),
    32
  )
}

afterEach(async () => {
  if (i18n.language !== 'fr') {
    await i18n.changeLanguage('fr')
  }
})

describe('voluntaryCheckIn cryptographic & privacy primitives', () => {
  it('matches RFC 5869 Appendix A.1 HKDF-SHA256 vector and rotates unlinkable 15-min pseudonyms', () => {
    const ikm = new Uint8Array(22).fill(0x0b)
    const salt = Uint8Array.from({ length: 13 }, (_, idx) => idx)
    const info = Uint8Array.from({ length: 10 }, (_, idx) => 0xf0 + idx)
    const okm = hkdfSha256(salt, ikm, info, 42)
    expect(bytesToHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
    )

    const t0 = 1_760_000_100
    const token0 = mintRotatingProximityToken({
      workspaceId: WORKSPACE_ID,
      eventScope: 'paris-floor-2',
      workspaceMasterKey: MASTER_KEY,
      deviceSeed: ALICE_SEED,
      nowUnixSeconds: t0,
      counter: 0,
    })
    const token1 = mintRotatingProximityToken({
      workspaceId: WORKSPACE_ID,
      eventScope: 'paris-floor-2',
      workspaceMasterKey: MASTER_KEY,
      deviceSeed: ALICE_SEED,
      nowUnixSeconds: t0 + 900,
      counter: 0,
    })
    expect(token0.raw).toHaveLength(32)
    expect(token0.epoch).not.toBe(token1.epoch)
    expect(token0.rollingPseudonymHex).not.toBe(token1.rollingPseudonymHex)

    const verified = verifyRotatingProximityToken({
      tokenHex: token0.tokenHex,
      workspaceId: WORKSPACE_ID,
      eventScope: 'paris-floor-2',
      workspaceMasterKey: MASTER_KEY,
      nowUnixSeconds: t0 + 25,
    })
    expect(verified.rollingPseudonymHex).toBe(token0.rollingPseudonymHex)

    expect(() =>
      verifyRotatingProximityToken({
        tokenHex: token0.tokenHex,
        workspaceId: WORKSPACE_ID,
        eventScope: 'paris-floor-2',
        workspaceMasterKey: MASTER_KEY,
        nowUnixSeconds: t0 + 1800,
      })
    ).toThrow(ProximityVoluntaryError)
  })

  it('classifies RSSI distance bands with dead-zone hysteresis and rejects GPS coordinate payloads', () => {
    const classifier = new RssiDistanceClassifier()
    expect(classifier.observe(-49)).toBe('immediate')
    expect(classifier.observe(-58)).toBe('immediate')
    expect(classifier.observe(-64)).toBe('near')
    expect(classifier.observe(-78)).toBe('near')
    expect(classifier.observe(-85)).toBe('ambient')
    expect(() => classifier.observe(127)).toThrow(ProximityVoluntaryError)

    expect(() => assertZeroGpsPayload({ note: 'ok', nested: { latitude: 48.8566 } })).toThrow(
      ProximityVoluntaryError
    )
    expect(() => assertZeroGpsPayload({ coords: [2.3522, 48.8566] })).toThrow(
      ProximityVoluntaryError
    )
  })
})

describe('ProximityCheckInView component & voluntary flow', () => {
  it('renders privacy pledge, zero emojis, duration presets, mutual peer badges, 1-click actions, and instant leave wipe in FR and EN', async () => {
    const user = userEvent.setup()
    const brokerHub = new InMemoryProximityVoluntaryBroker(MASTER_KEY)
    const aliceAdapter = brokerHub.forParticipant('alice', ALICE_SEED, {
      rssiDbm: -48,
      viaLanMdnsQuic: true,
    })
    const bobAdapter = brokerHub.forParticipant('bob', BOB_SEED, {
      rssiDbm: -48,
      viaLanMdnsQuic: true,
    })

    // Bob checks in voluntarily in the same workspace & event scope.
    await bobAdapter.checkIn({
      workspaceId: WORKSPACE_ID,
      eventScope: 'cafe-zone',
      durationSeconds: 1800,
      statusNote: 'Salle B · café',
      nowUnixSeconds: 1_760_000_100,
    })

    const onOpenEphemeralThread = vi.fn()
    const onStartEphemeralCall = vi.fn()

    const { container, rerender } = render(
      <ProximityCheckInView
        workspaceId={WORKSPACE_ID}
        eventScope="cafe-zone"
        broker={aliceAdapter}
        nowUnixSeconds={1_760_000_105}
        onOpenEphemeralThread={onOpenEphemeralThread}
        onStartEphemeralCall={onStartEphemeralCall}
      />
    )

    // Strict zero-emoji check on rendered DOM text.
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u)
    expect(screen.getByTestId('proximity-radar-pledge')).toHaveTextContent(
      'zéro coordonnée géographique, expiration automatique'
    )
    expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()

    // Select 1 h duration preset and type custom status note.
    const durationGroup = screen.getByRole('group', { name: 'Durée de présence' })
    const oneHourBtn = within(durationGroup).getByRole('button', { name: '1 h' })
    await user.click(oneHourBtn)
    expect(oneHourBtn).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByLabelText('Note de présence (facultative)'), 'Table fenêtre')
    await user.click(screen.getByTestId('proximity-radar-join'))

    await waitFor(() => {
      expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
    })

    // Bob's card appears with Immediate BLE + LAN mDNS/QUIC badges and status note.
    const peerList = screen.getByTestId('proximity-radar-peer-list')
    expect(peerList).toHaveTextContent('Salle B · café')
    expect(peerList).toHaveTextContent('Immédiat · radio courte portée')
    expect(peerList).toHaveTextContent('Réseau local vérifié')
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u)

    // 1-click ephemeral thread & call actions invoke callbacks with resolved peer.
    await user.click(within(peerList).getByRole('button', { name: 'Fil #proximité' }))
    await user.click(within(peerList).getByRole('button', { name: 'Appel éphémère' }))
    expect(onOpenEphemeralThread).toHaveBeenCalledTimes(1)
    expect(onStartEphemeralCall).toHaveBeenCalledTimes(1)

    // Switch runtime locale to English and verify full EN catalogue parity.
    await i18n.changeLanguage('en')
    rerender(
      <ProximityCheckInView
        workspaceId={WORKSPACE_ID}
        eventScope="cafe-zone"
        broker={aliceAdapter}
        nowUnixSeconds={1_760_000_110}
        onOpenEphemeralThread={onOpenEphemeralThread}
        onStartEphemeralCall={onStartEphemeralCall}
      />
    )
    expect(screen.getByText('Ephemeral visibility active')).toBeInTheDocument()
    expect(screen.getByTestId('proximity-radar-pledge')).toHaveTextContent(
      'zero location coordinates'
    )
    expect(screen.getByRole('button', { name: 'Leave proximity' })).toBeInTheDocument()

    // Instant kill-switch wipes local state and removes Alice from Bob's nearby list immediately.
    await user.click(screen.getByTestId('proximity-radar-leave'))
    await waitFor(() => {
      expect(screen.getByText('Local radio off')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
    const bobNearbyAfterLeave = await bobAdapter.listNearby({
      workspaceId: WORKSPACE_ID,
      eventScope: 'cafe-zone',
      nowUnixSeconds: 1_760_000_115,
    })
    expect(bobNearbyAfterLeave).toEqual([])
  })

  it('auto-expires check-in when wall-clock passes the selected TTL', async () => {
    const user = userEvent.setup()
    const brokerHub = new InMemoryProximityVoluntaryBroker(MASTER_KEY)
    const aliceAdapter = brokerHub.forParticipant('alice', ALICE_SEED)

    const { rerender } = render(
      <ProximityCheckInView
        workspaceId={WORKSPACE_ID}
        broker={aliceAdapter}
        nowUnixSeconds={1_760_000_000}
      />
    )

    const durationGroup = screen.getByRole('group', { name: 'Durée de présence' })
    await user.click(within(durationGroup).getByRole('button', { name: '15 min' }))
    await user.click(screen.getByTestId('proximity-radar-join'))

    await waitFor(() => {
      expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
    })

    // Advance past 15 min (900s) -> session auto-expires cleanly.
    rerender(
      <ProximityCheckInView
        workspaceId={WORKSPACE_ID}
        broker={aliceAdapter}
        nowUnixSeconds={1_760_000_905}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
    })
  })

  it('renders cleanly across ciel and nuit themes with crisp monochrome SVG icons and surfaces Zero-GPS refusal', async () => {
    const user = userEvent.setup()
    const gpsFailingBroker = {
      checkIn: () => Promise.reject(new ProximityVoluntaryError('ForbiddenGpsCoordinates')),
      listNearby: () => Promise.resolve([]),
      leaveProximity: () => Promise.resolve(),
    }

    for (const theme of ['ciel', 'nuit'] as const) {
      document.documentElement.dataset.theme = theme
      const { container, unmount } = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          broker={gpsFailingBroker}
          nowUnixSeconds={1_760_000_000}
        />
      )
      expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
      expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u)

      await user.click(screen.getByTestId('proximity-radar-join'))
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          'Coordonnées géographiques refusées par la paroi de confidentialité.'
        )
      })
      unmount()
    }
    delete document.documentElement.dataset.theme
  })

  it('immediately hides existing scope-A presence and peers on rerender to workspace B, event B, or a replacement broker', async () => {
    const user = userEvent.setup()
    const recordA = makeRecord(WORKSPACE_ID, 'floor-a', 'a11ce001')
    const peerA = makePeer('bob-scope-a', 'Scope A desk')

    const makeBroker = (): ProximityVoluntaryBrokerAdapter => ({
      checkIn: vi.fn().mockResolvedValue({ record: recordA, peers: [peerA] }),
      listNearby: vi.fn().mockResolvedValue([peerA]),
      leaveProximity: vi.fn().mockResolvedValue(undefined),
    })

    for (const variant of ['workspace', 'event', 'broker'] as const) {
      const brokerA = makeBroker()
      const brokerB = makeBroker()
      const { rerender, unmount } = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="floor-a"
          broker={brokerA}
          nowUnixSeconds={1_760_000_105}
        />
      )

      await user.click(screen.getByTestId('proximity-radar-join'))
      await waitFor(() => {
        expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
      })
      expect(screen.getByTestId('proximity-radar-peer-list')).toHaveTextContent('bob-scope-a')
      expect(screen.getByText('prox-a11ce001')).toBeInTheDocument()

      if (variant === 'workspace') {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_B_ID}
            eventScope="floor-a"
            broker={brokerA}
            nowUnixSeconds={1_760_000_105}
          />
        )
      } else if (variant === 'event') {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_ID}
            eventScope="floor-b"
            broker={brokerA}
            nowUnixSeconds={1_760_000_105}
          />
        )
      } else {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_ID}
            eventScope="floor-a"
            broker={brokerB}
            nowUnixSeconds={1_760_000_105}
          />
        )
      }

      // Synchronous render check: scope-A beacon and peers must vanish immediately.
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      expect(screen.queryByText('prox-a11ce001')).toBeNull()

      // Returning to scope A must NOT resurrect retired scope-A presence without a fresh opt-in.
      rerender(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="floor-a"
          broker={brokerA}
          nowUnixSeconds={1_760_000_105}
        />
      )
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      unmount()
    }
  })

  it('ignores deferred scope-A checkIn completions resolving after rerender to workspace B, event B, or a replacement broker', async () => {
    const user = userEvent.setup()
    const recordA = makeRecord(WORKSPACE_ID, 'floor-a', 'a11ce002')
    const peerA = makePeer('stale-join-peer', 'Stale scope A join')

    for (const variant of ['workspace', 'event', 'broker'] as const) {
      const deferredJoinA = createDeferred<{
        record: VoluntaryCheckInRecord
        peers: readonly VoluntaryProximityPeer[]
      }>()
      const brokerA: ProximityVoluntaryBrokerAdapter = {
        checkIn: vi.fn(() => deferredJoinA.promise),
        listNearby: vi.fn().mockResolvedValue([peerA]),
        leaveProximity: vi.fn().mockResolvedValue(undefined),
      }
      const brokerB: ProximityVoluntaryBrokerAdapter = {
        checkIn: vi.fn().mockResolvedValue({
          record: makeRecord(WORKSPACE_B_ID, 'floor-b', 'b0b00002'),
          peers: [],
        }),
        listNearby: vi.fn().mockResolvedValue([]),
        leaveProximity: vi.fn().mockResolvedValue(undefined),
      }

      const { rerender, unmount } = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="floor-a"
          broker={brokerA}
          nowUnixSeconds={1_760_000_105}
        />
      )

      await user.click(screen.getByTestId('proximity-radar-join'))
      expect(brokerA.checkIn).toHaveBeenCalledTimes(1)

      if (variant === 'workspace') {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_B_ID}
            eventScope="floor-a"
            broker={brokerA}
            nowUnixSeconds={1_760_000_105}
          />
        )
      } else if (variant === 'event') {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_ID}
            eventScope="floor-b"
            broker={brokerA}
            nowUnixSeconds={1_760_000_105}
          />
        )
      } else {
        rerender(
          <ProximityCheckInView
            workspaceId={WORKSPACE_ID}
            eventScope="floor-a"
            broker={brokerB}
            nowUnixSeconds={1_760_000_105}
          />
        )
      }

      await act(async () => {
        deferredJoinA.resolve({ record: recordA, peers: [peerA] })
        await deferredJoinA.promise
      })

      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      expect(screen.queryByText('prox-a11ce002')).toBeNull()
      expect(screen.queryByText('stale-join-peer')).toBeNull()
      unmount()
    }
  })

  it('ignores deferred scope-A listNearby completions resolving after rerender to scope B', async () => {
    const user = userEvent.setup()
    const deferredNearbyA = createDeferred<readonly VoluntaryProximityPeer[]>()
    const recordA = makeRecord(WORKSPACE_ID, 'floor-a', 'a11ce003')
    const recordB = makeRecord(WORKSPACE_B_ID, 'floor-b', 'b0b00003')
    const stalePeerA = makePeer('stale-nearby-a', 'From workspace A')

    const broker: ProximityVoluntaryBrokerAdapter = {
      checkIn: vi.fn(async ({ workspaceId, eventScope }) => ({
        record: workspaceId === WORKSPACE_ID ? recordA : { ...recordB, workspaceId, eventScope },
        peers: [],
      })),
      listNearby: vi.fn(({ workspaceId }) =>
        workspaceId === WORKSPACE_ID ? deferredNearbyA.promise : Promise.resolve([])
      ),
      leaveProximity: vi.fn().mockResolvedValue(undefined),
    }

    const { rerender } = render(
      <ProximityCheckInView
        workspaceId={WORKSPACE_ID}
        eventScope="floor-a"
        broker={broker}
        nowUnixSeconds={1_760_000_105}
      />
    )

    await user.click(screen.getByTestId('proximity-radar-join'))
    await waitFor(() => {
      expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
    })
    expect(broker.listNearby).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      eventScope: 'floor-a',
      nowUnixSeconds: 1_760_000_105,
    })

    // Switch to workspace B and join workspace B while scope-A listNearby is still pending.
    rerender(
      <ProximityCheckInView
        workspaceId={WORKSPACE_B_ID}
        eventScope="floor-b"
        broker={broker}
        nowUnixSeconds={1_760_000_105}
      />
    )
    expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()

    await user.click(screen.getByTestId('proximity-radar-join'))
    await waitFor(() => {
      expect(screen.getByText('prox-b0b00003')).toBeInTheDocument()
    })

    // Late resolution of scope-A listNearby must NOT leak scope-A peers into scope B.
    await act(async () => {
      deferredNearbyA.resolve([stalePeerA])
      await deferredNearbyA.promise
    })

    expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
    expect(screen.queryByText('stale-nearby-a')).toBeNull()
  })

  it('clears local presence synchronously before leaveProximity resolves, fences in-flight listNearby, and handles checkout rejection without unhandled rejection', async () => {
    const user = userEvent.setup()
    const unhandledNode: unknown[] = []
    const unhandledWindow: PromiseRejectionEvent[] = []
    const onNodeUnhandled = (reason: unknown) => {
      unhandledNode.push(reason)
    }
    const onWindowUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault()
      unhandledWindow.push(event)
    }
    process.on('unhandledRejection', onNodeUnhandled)
    window.addEventListener('unhandledrejection', onWindowUnhandled)

    try {
      const recordA = makeRecord(WORKSPACE_ID, 'cafe-zone', 'a11ce004')
      const initialPeer = makePeer('bob-initial', 'Initial peer')
      const latePollPeer = makePeer('bob-late-poll', 'Late poll peer')
      const deferredPoll = createDeferred<readonly VoluntaryProximityPeer[]>()
      const deferredLeave = createDeferred<void>()
      let nearbyCalls = 0

      const broker: ProximityVoluntaryBrokerAdapter = {
        checkIn: vi.fn().mockResolvedValue({ record: recordA, peers: [initialPeer] }),
        listNearby: vi.fn(() => {
          nearbyCalls += 1
          if (nearbyCalls === 1) {
            return Promise.resolve([initialPeer])
          }
          return deferredPoll.promise
        }),
        leaveProximity: vi.fn(() => deferredLeave.promise),
      }

      const { rerender } = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="cafe-zone"
          broker={broker}
          nowUnixSeconds={1_760_000_105}
        />
      )

      await user.click(screen.getByTestId('proximity-radar-join'))
      await waitFor(() => {
        expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
      })
      expect(screen.getByTestId('proximity-radar-peer-list')).toHaveTextContent('bob-initial')

      // Trigger a second listNearby poll that stays in flight when the user clicks Leave.
      rerender(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="cafe-zone"
          broker={broker}
          nowUnixSeconds={1_760_000_120}
        />
      )
      expect(nearbyCalls).toBe(2)

      // Click Leave while BOTH deferredPoll and deferredLeave remain pending.
      await user.click(screen.getByTestId('proximity-radar-leave'))
      expect(broker.leaveProximity).toHaveBeenCalledTimes(1)

      // Local presence and peer list MUST already be cleared before deferredLeave settles.
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      expect(screen.queryByText('prox-a11ce004')).toBeNull()

      // Resolving the retired listNearby poll while checkout is pending cannot repopulate peers.
      await act(async () => {
        deferredPoll.resolve([latePollPeer])
        await deferredPoll.promise
      })
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      expect(screen.queryByText('bob-late-poll')).toBeNull()

      // Rejecting leaveProximity is consumed cleanly, keeps presence off, and renders bounded UI feedback.
      await act(async () => {
        deferredLeave.reject(new Error('broker socket unavailable'))
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          'Visibilité locale coupée sur cet appareil, mais le retrait côté serveur n’a pas pu être confirmé ; la balise expirera automatiquement.'
        )
      })
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()

      // Verify English parity for the bounded checkout notice too.
      await i18n.changeLanguage('en')
      rerender(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="cafe-zone"
          broker={broker}
          nowUnixSeconds={1_760_000_120}
        />
      )
      expect(screen.getByRole('status')).toHaveTextContent(
        'Local radio visibility is off on this device, but server removal could not be confirmed; active beacon state expires automatically.'
      )

      // Allow microtask queue to settle completely and verify zero unhandled rejections escaped.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandledNode).toEqual([])
      expect(unhandledWindow).toEqual([])
    } finally {
      process.off('unhandledRejection', onNodeUnhandled)
      window.removeEventListener('unhandledrejection', onWindowUnhandled)
    }
  })

  it('discards deferred checkIn and listNearby completions after component unmount without unhandled rejections or state warnings', async () => {
    const user = userEvent.setup()
    const unhandledNode: unknown[] = []
    const unhandledWindow: PromiseRejectionEvent[] = []
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onNodeUnhandled = (reason: unknown) => {
      unhandledNode.push(reason)
    }
    const onWindowUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault()
      unhandledWindow.push(event)
    }
    process.on('unhandledRejection', onNodeUnhandled)
    window.addEventListener('unhandledrejection', onWindowUnhandled)

    try {
      const deferredJoin = createDeferred<{
        readonly record: VoluntaryCheckInRecord
        readonly peers: readonly VoluntaryProximityPeer[]
      }>()
      const recordA = makeRecord(WORKSPACE_ID, 'unmount-zone', 'a11ce009')
      const initialPeer = makePeer('bob-mounted', 'Initial peer')
      const latePollPeer = makePeer('bob-after-unmount', 'Late poll peer')
      const deferredPoll = createDeferred<readonly VoluntaryProximityPeer[]>()

      // Part 1: Deferred checkIn resolves after unmount.
      const joinBroker: ProximityVoluntaryBrokerAdapter = {
        checkIn: vi.fn(() => deferredJoin.promise),
        listNearby: vi.fn().mockResolvedValue([]),
        leaveProximity: vi.fn().mockResolvedValue(undefined),
      }

      const firstRender = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="unmount-zone"
          broker={joinBroker}
          nowUnixSeconds={1_760_000_105}
        />
      )

      await user.click(screen.getByTestId('proximity-radar-join'))
      expect(joinBroker.checkIn).toHaveBeenCalledTimes(1)

      firstRender.unmount()

      await act(async () => {
        deferredJoin.resolve({ record: recordA, peers: [initialPeer] })
        await deferredJoin.promise
      })

      // Part 2: Deferred listNearby poll resolves after unmount.
      let pollCalls = 0
      const pollBroker: ProximityVoluntaryBrokerAdapter = {
        checkIn: vi.fn().mockResolvedValue({ record: recordA, peers: [initialPeer] }),
        listNearby: vi.fn(() => {
          pollCalls += 1
          if (pollCalls === 1) {
            return Promise.resolve([initialPeer])
          }
          return deferredPoll.promise
        }),
        leaveProximity: vi.fn().mockResolvedValue(undefined),
      }

      const secondRender = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="unmount-zone"
          broker={pollBroker}
          nowUnixSeconds={1_760_000_105}
        />
      )

      await user.click(screen.getByTestId('proximity-radar-join'))
      await waitFor(() => {
        expect(screen.getByText('Visibilité éphémère active')).toBeInTheDocument()
      })
      expect(screen.getByTestId('proximity-radar-peer-list')).toHaveTextContent('bob-mounted')

      secondRender.rerender(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="unmount-zone"
          broker={pollBroker}
          nowUnixSeconds={1_760_000_120}
        />
      )
      expect(pollCalls).toBe(2)

      secondRender.unmount()

      await act(async () => {
        deferredPoll.resolve([latePollPeer])
        await deferredPoll.promise
      })

      // Fresh mount in the same scope starts completely inactive without leaked presence or peers.
      const freshRender = render(
        <ProximityCheckInView
          workspaceId={WORKSPACE_ID}
          eventScope="unmount-zone"
          broker={pollBroker}
          nowUnixSeconds={1_760_000_130}
        />
      )
      expect(screen.getByText('Radio locale inactive')).toBeInTheDocument()
      expect(screen.queryByTestId('proximity-radar-peer-list')).toBeNull()
      freshRender.unmount()

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandledNode).toEqual([])
      expect(unhandledWindow).toEqual([])
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    } finally {
      consoleErrorSpy.mockRestore()
      process.off('unhandledRejection', onNodeUnhandled)
      window.removeEventListener('unhandledrejection', onWindowUnhandled)
    }
  })
})

describe('HTTP proximity bootstrap & broker session seam', () => {
  const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
  const NOW = 1_760_000_100

  function createWireServerHarness() {
    const activeByUser = new Map<
      string,
      {
        readonly handle: string
        readonly statusNote: string
        readonly rollingPseudonym: string
        readonly tokenHex: string
        readonly transport: string
        readonly distanceBand: string
        readonly expiresAt: number
      }
    >()

    const transportFor = (callerId: string, allowedWorkspaceId: string): ProximityApiTransport => {
      return async (req) => {
        const wsId =
          req.method === 'GET'
            ? (req.query?.['workspace_id'] ?? '')
            : String(req.body?.['workspace_id'] ?? '')
        const scope =
          req.method === 'GET'
            ? (req.query?.['event_scope'] ?? 'default')
            : String(req.body?.['event_scope'] ?? 'default')

        if (wsId !== allowedWorkspaceId) {
          return {
            status: 404,
            body: {
              type: 'https://kodera.io/problems/not-found',
              status: 404,
            },
          }
        }

        if (req.path === '/api/v1/proximity/bootstrap' && req.method === 'POST') {
          return {
            status: 200,
            body: {
              workspace_id: wsId,
              event_scope: scope,
              epoch_mac_key: bytesToHex(referenceEpochKey(wsId, scope, Math.floor(NOW / 900))),
              epoch_expires_at: (Math.floor(NOW / 900) + 1) * 900,
              epoch: Math.floor(NOW / PROXIMITY_EPOCH_ROTATION_SECS),
              epoch_rotation_seconds: PROXIMITY_EPOCH_ROTATION_SECS,
            },
          }
        }

        if (req.path === '/api/v1/proximity/checkin' && req.method === 'POST') {
          const verified = verifyRotatingProximityToken({
            tokenHex: String(req.body?.['beacon_token'] ?? ''),
            workspaceId: wsId,
            eventScope: scope,
            workspaceMasterKey: MASTER_KEY,
            nowUnixSeconds: NOW,
          })
          const ttl = Number(req.body?.['ttl_seconds'] ?? 1800)
          const entry = {
            handle: String(
              req.body?.['handle'] ?? `prox-${verified.rollingPseudonymHex.slice(0, 8)}`
            ),
            statusNote: String(req.body?.['status_note'] ?? ''),
            rollingPseudonym: verified.rollingPseudonymHex,
            tokenHex: verified.tokenHex,
            transport: String(req.body?.['transport'] ?? 'hybrid'),
            distanceBand: String(req.body?.['distance_band'] ?? 'near'),
            expiresAt: NOW + ttl,
          }
          activeByUser.set(callerId, entry)
          return {
            status: 201,
            body: {
              workspace_id: wsId,
              event_scope: scope,
              handle: entry.handle,
              status_note: entry.statusNote,
              rolling_pseudonym: entry.rollingPseudonym,
              epoch: verified.epoch,
              ttl_seconds: ttl,
              expires_at: entry.expiresAt,
              gps_persisted: false,
            },
          }
        }

        if (req.path === '/api/v1/proximity/nearby' && req.method === 'GET') {
          const caller = activeByUser.get(callerId)
          if (!caller) {
            return {
              status: 403,
              body: {
                type: 'https://kodera.io/problems/forbidden',
                reason: 'caller_not_checked_in',
                status: 403,
              },
            }
          }
          const peers = [...activeByUser.entries()]
            .filter(([id]) => id !== callerId)
            .map(([, p]) => ({
              handle: p.handle,
              status_note: p.statusNote,
              rolling_pseudonym: p.rollingPseudonym,
              transport: p.transport,
              distance_band: p.distanceBand,
              expires_in_seconds: p.expiresAt - NOW,
              expires_at: p.expiresAt,
            }))
          return {
            status: 200,
            body: { workspace_id: wsId, event_scope: scope, peers },
          }
        }

        if (req.path === '/api/v1/proximity/resolve' && req.method === 'POST') {
          const observed = Array.isArray(req.body?.['observed_tokens'])
            ? (req.body?.['observed_tokens'] as Record<string, unknown>[])
            : []
          const peers = []
          for (const item of observed) {
            const verified = verifyRotatingProximityToken({
              tokenHex: String(item['beacon_token'] ?? ''),
              workspaceId: wsId,
              eventScope: scope,
              workspaceMasterKey: MASTER_KEY,
              nowUnixSeconds: NOW,
            })
            for (const [id, p] of activeByUser.entries()) {
              if (id !== callerId && p.rollingPseudonym === verified.rollingPseudonymHex) {
                peers.push({
                  handle: p.handle,
                  status_note: p.statusNote,
                  rolling_pseudonym: p.rollingPseudonym,
                  transport: String(item['transport'] ?? p.transport),
                  distance_band: String(item['distance_band'] ?? p.distanceBand),
                  expires_in_seconds: p.expiresAt - NOW,
                  expires_at: p.expiresAt,
                })
              }
            }
          }
          return {
            status: 200,
            body: { workspace_id: wsId, event_scope: scope, peers },
          }
        }

        if (req.path === '/api/v1/proximity/checkout' && req.method === 'POST') {
          const existed = activeByUser.delete(callerId)
          return {
            status: 200,
            body: { workspace_id: wsId, checked_out: true, purged_records: existed ? 1 : 0 },
          }
        }

        return { status: 404, body: {} }
      }
    }

    return { transportFor }
  }

  it('bootstraps an epoch capability, mints valid KT\\x01 token, resolves peers, and enforces tenant isolation', async () => {
    const harness = createWireServerHarness()
    const aliceTransport = harness.transportFor('alice', WORKSPACE_ID)
    const bobTransport = harness.transportFor('bob', WORKSPACE_ID)

    // Cross-tenant bootstrap attempt by Alice targeting OTHER_WORKSPACE_ID is refused (WorkspaceAccessDenied).
    await expect(
      bootstrapAndCheckInProximity({
        transport: aliceTransport,
        workspaceId: OTHER_WORKSPACE_ID,
        deviceSeed: ALICE_SEED,
        durationSeconds: 1800,
        statusNote: 'Cross-tenant probe',
        nowUnixSeconds: NOW,
      })
    ).rejects.toMatchObject({ code: 'WorkspaceAccessDenied' })

    // Bob checks in via bootstrapAndCheckInProximity, then Alice joins via createHttpProximityVoluntaryBroker.
    const bobSession = await bootstrapAndCheckInProximity({
      transport: bobTransport,
      workspaceId: WORKSPACE_ID,
      eventScope: 'floor-2',
      deviceSeed: BOB_SEED,
      durationSeconds: 1800,
      statusNote: 'Salle B · café',
      handle: 'bob-http',
      radioTransport: 'mdns_quic',
      distanceBand: 'immediate',
      nowUnixSeconds: NOW,
    })
    expect(bobSession.bootstrap.epochMacKey.every((byte) => byte === 0)).toBe(true)

    const aliceBroker = createHttpProximityVoluntaryBroker({
      transport: aliceTransport,
      deviceSeed: ALICE_SEED,
      handle: 'alice-http',
      radioTransport: 'ble',
      rssiDbm: -49,
    })

    const aliceJoined = await aliceBroker.checkIn({
      workspaceId: WORKSPACE_ID,
      eventScope: 'floor-2',
      durationSeconds: 900,
      statusNote: 'Coin lecture',
      nowUnixSeconds: NOW,
    })
    expect(aliceJoined.peers).toHaveLength(1)
    expect(aliceJoined.peers[0]?.handle).toBe('bob-http')
    expect(aliceJoined.peers[0]?.viaLanMdnsQuic).toBe(true)

    const resolved = await aliceBroker.resolveObservedTokens({
      workspaceId: WORKSPACE_ID,
      eventScope: 'floor-2',
      observedTokens: [
        {
          beaconTokenHex: bobSession.record.tokenHex,
          distanceBand: 'immediate',
          transport: 'ble',
        },
      ],
    })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.handle).toBe('bob-http')
    expect(resolved[0]?.distanceBand).toBe('immediate')

    await aliceBroker.leaveProximity({ workspaceId: WORKSPACE_ID, eventScope: 'floor-2' })
    await expect(
      aliceBroker.listNearby({ workspaceId: WORKSPACE_ID, eventScope: 'floor-2' })
    ).rejects.toMatchObject({ code: 'CallerNotCheckedIn' })
  })
})

describe('authenticated epoch-limited radio capability', () => {
  const lease = epochLeaseFixture.bootstrap
  const key = Uint8Array.from(
    lease.epoch_mac_key.match(/../g)!.map((v: string) => Number.parseInt(v, 16))
  )
  const seed = Uint8Array.from(
    epochLeaseFixture.device_seed.match(/../g)!.map((v: string) => Number.parseInt(v, 16))
  )
  const input = {
    workspaceId: lease.workspace_id,
    eventScope: lease.event_scope,
    epochMacKey: key,
    epoch: lease.epoch,
    epochExpiresAt: lease.epoch_expires_at,
    deviceSeed: seed,
    nowUnixSeconds: epochLeaseFixture.now_unix_seconds,
    counter: epochLeaseFixture.counter,
  }

  it('holds the server/Rust/native transcript to the exact shared bytes', () => {
    const minted = mintEpochProximityToken(input)
    expect(minted.tokenHex).toBe(epochLeaseFixture.token_hex)
    expect(mintRotatingProximityToken({ ...input, workspaceMasterKey: MASTER_KEY }).tokenHex).toBe(
      minted.tokenHex
    )
    expect(verifyEpochProximityToken({ ...input, tokenHex: minted.tokenHex }).counter).toBe(7)
    for (const changed of [{ eventScope: 'other' }, { workspaceId: WORKSPACE_ID }]) {
      expect(() =>
        verifyEpochProximityToken({ ...input, ...changed, tokenHex: minted.tokenHex })
      ).toThrow('AuthenticationFailed')
    }
  })

  it.each([
    lease.epoch * 900 - 1,
    lease.epoch_expires_at,
    lease.epoch_expires_at + 60,
    lease.epoch_expires_at + 365 * 86400,
  ])(
    'refuses future or expired material at wall clock %s without skew extension',
    (nowUnixSeconds) => {
      expect(() => mintEpochProximityToken({ ...input, nowUnixSeconds })).toThrow('ExpiredToken')
      expect(() =>
        verifyEpochProximityToken({ ...input, nowUnixSeconds, tokenHex: epochLeaseFixture.token_hex })
      ).toThrow('ExpiredToken')
    }
  )

  it.each([
    { workspace_id: WORKSPACE_ID },
    { event_scope: 'other' },
    { epoch_mac_key: lease.epoch_mac_key.toUpperCase() },
    { epoch_expires_at: lease.epoch_expires_at + 60 },
    { epoch_mac_key: lease.epoch_mac_key + '\n' },
    { workspace_beacon_key: '11'.repeat(32) },
    { epoch: lease.epoch + 1 },
    { epoch_rotation_seconds: 901 },
  ])('refuses malformed or mismatched authenticated bootstrap material %j', async (change) => {
    await expect(
      bootstrapProximityWorkspace({
        workspaceId: lease.workspace_id,
        nowUnixSeconds: input.nowUnixSeconds,
        transport: async () => ({ status: 200, body: { ...lease, ...change } }),
      })
    ).rejects.toBeInstanceOf(ProximityVoluntaryError)
  })
})
