import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { bytesToHex } from './codec'
import { ProximityCheckInView } from './ProximityCheckInView'
import {
  InMemoryProximityVoluntaryBroker,
  PROXIMITY_EPOCH_ROTATION_SECS,
  ProximityVoluntaryError,
  RssiDistanceClassifier,
  assertZeroGpsPayload,
  bootstrapAndCheckInProximity,
  createHttpProximityVoluntaryBroker,
  hkdfSha256,
  mintRotatingProximityToken,
  verifyRotatingProximityToken,
  type ProximityApiTransport,
} from './voluntaryCheckIn'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const MASTER_KEY = Uint8Array.from({ length: 32 }, (_, idx) => idx + 1)
const ALICE_SEED = Uint8Array.from({ length: 32 }, (_, idx) => idx + 65)
const BOB_SEED = Uint8Array.from({ length: 32 }, (_, idx) => idx + 129)

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
              workspace_beacon_key: bytesToHex(MASTER_KEY),
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
                type: 'https://kodera.io/problems/opt-in-required',
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

  it('bootstraps workspace beacon key, mints valid KT\\x01 token, resolves peers, and enforces tenant isolation', async () => {
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
    expect(bobSession.bootstrap.workspaceBeaconKeyHex).toBe(bytesToHex(MASTER_KEY))

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
