import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { bytesToHex } from './codec'
import { ProximityCheckInView } from './ProximityCheckInView'
import {
  InMemoryProximityVoluntaryBroker,
  ProximityVoluntaryError,
  RssiDistanceClassifier,
  assertZeroGpsPayload,
  hkdfSha256,
  mintRotatingProximityToken,
  verifyRotatingProximityToken,
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
