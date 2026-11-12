import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ProximityRoomPanel } from './ProximityRoomPanel'
import { ProximityFrame } from './codec'
import { DEMO_ORG_BEACON_SALT, demoProximityTransport } from './demoFixture'
import { generatedProximityHandle } from './handle'
import { MAX_PROXIMITY_FRAME_BYTES, MAX_PROXIMITY_TEXT_BYTES, SafetyStatus } from './types'

describe('ProximityRoomPanel', () => {
  it('without a transport, draws one line « Non connecté » and offers nothing to send', () => {
    render(<ProximityRoomPanel channelName="around-me" />)

    const bar = screen.getByTestId('proximity-disconnected')
    expect(within(bar).getByRole('heading', { name: 'Autour de moi' })).toBeInTheDocument()
    expect(bar).toHaveTextContent('Non connecté')
    expect(bar).toHaveTextContent('Le relais de proximité est en développement.')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('says, connected or not, that it is not an emergency service and replaces no emergency number', () => {
    const NOTICE =
      'Ceci n’est pas un service d’urgence et ne remplace pas les numéros d’urgence. En cas de danger, appelez les secours.'
    const { unmount } = render(<ProximityRoomPanel channelName="around-me" />)
    const disconnected = screen.getByRole('note')
    expect(disconnected).toHaveTextContent(NOTICE)
    expect(screen.getByTestId('proximity-disconnected')).toContainElement(disconnected)
    unmount()

    render(<ProximityRoomPanel channelName="around-me" transport={demoProximityTransport()} />)
    const connected = screen.getByRole('note')
    expect(connected).toHaveTextContent(NOTICE)
    expect(connected).toBeVisible()
    // A sentence that is always there: never an alert that interrupts a screen reader.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(connected).not.toHaveAttribute('aria-live')
  })

  it('tells who checks in that it is voluntary and shown under a pseudonym', () => {
    render(<ProximityRoomPanel channelName="around-me" transport={demoProximityTransport()} />)
    expect(screen.getByTestId('proximity-pseudonym-hint')).toHaveTextContent(
      'Le pointage est volontaire. Il s’affiche sous un pseudonyme, dédié ou généré, et non sous votre nom.'
    )
  })

  it('words nothing as an alarm outside that notice: statuses, actions and the demo roster', async () => {
    const { container } = render(
      <ProximityRoomPanel channelName="around-me" transport={demoProximityTransport()} />
    )
    const roster = screen.getByRole('list', { name: 'Personnes à proximité' })
    await waitFor(() => expect(within(roster).getAllByRole('listitem')).toHaveLength(2))
    const actions = screen.getByRole('group', { name: 'Indiquer votre présence' })
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Sur place', 'Besoin d’un coup de main', 'Point de rencontre'])
    const outsideTheNotice = container.cloneNode(true) as HTMLElement
    outsideTheNotice.querySelector('[role="note"]')?.remove()
    expect(outsideTheNotice.textContent).not.toMatch(
      /urgen|crise|évacu|alerte|sécurité|assistance|rassembl|signalement|secours|danger/i
    )
  })

  it('claims no transport technology, signature scheme or frame format in its copy', () => {
    const { container: disconnected } = render(<ProximityRoomPanel channelName="around-me" />)
    const { container: connected } = render(
      <ProximityRoomPanel channelName="around-me" transport={demoProximityTransport()} />
    )
    for (const text of [disconnected.textContent ?? '', connected.textContent ?? '']) {
      expect(text).not.toMatch(/\bBLE\b|Wi-Fi Direct|Ed25519|HMAC|SHA-?256|KE v1|\bTTL\b/)
      expect(text).not.toMatch(/maillage|octets|signature/i)
    }
  })

  it('with a transport, lists the people nearby by priority, each under a pseudonymous handle', async () => {
    render(<ProximityRoomPanel channelName="around-me" transport={demoProximityTransport()} />)
    expect(screen.getByText('Connecté')).toBeInTheDocument()
    const roster = screen.getByRole('list', { name: 'Personnes à proximité' })
    await waitFor(() => expect(within(roster).getAllByRole('listitem')).toHaveLength(2))
    const items = within(roster).getAllByRole('listitem')
    // The first peer picked no pseudonym: the handle this organisation derives for its device.
    const generated = await generatedProximityHandle(
      DEMO_ORG_BEACON_SALT,
      new Uint8Array(32).fill(0x11)
    )
    expect(items[0]).toHaveTextContent(generated.handle)
    expect(items[0]).toHaveTextContent('Point de rencontre')
    // The second picked one.
    expect(items[1]).toHaveTextContent('north-wing-3')
    expect(roster).not.toHaveTextContent(/Sylvain|Ellenstein|Marina|Loiseau|SRE|Ingénierie/)
  })

  it('emits a signed frame on one tap and puts « Besoin d’un coup de main » at the top', async () => {
    const user = userEvent.setup()
    const onCheckIn = vi.fn()
    render(
      <ProximityRoomPanel
        channelName="around-me"
        transport={demoProximityTransport()}
        onCheckIn={onCheckIn}
      />
    )

    await user.type(
      screen.getByLabelText('Zone ou message court (facultatif)'),
      'Porte bloquée aile ouest'
    )
    const actions = screen.getByRole('group', { name: 'Indiquer votre présence' })
    const assist = within(actions).getByRole('button', { name: 'Besoin d’un coup de main' })
    await user.click(assist)

    expect(assist).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Présence partagée : Besoin d’un coup de main'
    )
    expect(onCheckIn).toHaveBeenCalledTimes(1)
    const [checkIn, wireBytes] = onCheckIn.mock.calls[0] as [
      { status: SafetyStatus; text: string; ttlHops: number },
      Uint8Array,
    ]
    expect(checkIn.status).toBe(SafetyStatus.NeedAssistance)
    expect(checkIn.ttlHops).toBe(6)
    const decoded = ProximityFrame.decode(wireBytes)
    expect(decoded.status).toBe(SafetyStatus.NeedAssistance)
    expect(decoded.text).toBe('Porte bloquée aile ouest')
    // The member's own check-in is listed under their own handle, the one the vectors give this
    // device in this organisation, marked as theirs; never under a name.
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    const own = screen.getAllByRole('listitem')[0]
    expect(own).toHaveTextContent('steady-brook-ah3fccbgh')
    expect(own).toHaveTextContent('Vous (cet appareil)')
    expect(checkIn).not.toHaveProperty('displayName')
  })

  it('bounds the message so a frame never exceeds its maximum size', async () => {
    const user = userEvent.setup()
    const onCheckIn = vi.fn()
    render(
      <ProximityRoomPanel
        channelName="around-me"
        transport={demoProximityTransport()}
        onCheckIn={onCheckIn}
      />
    )
    const input = screen.getByLabelText('Zone ou message court (facultatif)') as HTMLInputElement
    await user.type(input, 'x'.repeat(MAX_PROXIMITY_TEXT_BYTES + 25))
    expect(input.value.length).toBe(MAX_PROXIMITY_TEXT_BYTES)
    await user.click(screen.getByRole('button', { name: 'Sur place' }))
    const [, wireBytes] = onCheckIn.mock.calls[0] as [unknown, Uint8Array]
    expect(wireBytes.length).toBe(MAX_PROXIMITY_FRAME_BYTES)
  })
})
