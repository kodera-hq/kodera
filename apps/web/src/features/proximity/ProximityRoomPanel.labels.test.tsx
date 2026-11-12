// Who checked in, as the panel shows it: a pseudonymous handle, never a name. The handle rules
// are held to the shared vectors in `tests/unit/proximity/handle.test.ts`; this file holds the
// panel to using them, with the senders and the expected labels of those vectors:
//   - two members under one pseudonym are told apart by a fingerprint, each from the first
//     check-in, an absent member included;
//   - a sender the provisioned roster does not hold is not listed;
//   - a roster holding something that is not a pseudonym (a name) lists no one.

import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { ProximityRoomPanel, type ProximityPanelTransport } from './ProximityRoomPanel'
import { createKeyedMacSigner, createKeyedMacVerifier, hexToBytes } from './codec'
import { ProximityRoomController } from './transport'
import {
  ProximityCodecError,
  type ProximityMemberDirectoryEntry,
  type ProximityRosterCheckIn,
  SafetyStatus,
} from './types'

// The organisation and the senders of `proximity-handle-v1.txt`.
const SALT = new Uint8Array(32).fill(0x42)
const FIRST = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const SECOND = '09'.repeat(32)
const THIRD = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const OUTSIDER = 'ab'.repeat(32)
// The device the panel runs on: none of the above.
const LOCAL = createKeyedMacSigner(new Uint8Array(32).fill(0x07), new Uint8Array(32).fill(0x77))

const member = (hex: string, dedicatedHandle?: string): ProximityMemberDirectoryEntry =>
  dedicatedHandle === undefined
    ? { publicKey: hexToBytes(hex) }
    : { publicKey: hexToBytes(hex), dedicatedHandle }

let sequence = 0
function checkIn(hex: string, status = SafetyStatus.Safe): ProximityRosterCheckIn {
  sequence += 1
  return {
    messageId: `019a6004-be14-7202-8202-${String(sequence).padStart(12, '0')}`,
    senderPublicKeyHex: hex,
    status,
    text: '',
    ttlHops: 4,
    timestampMs: 1_762_520_020_000 - sequence,
    isLocal: false,
  }
}

function transport(
  provisionedMembers: readonly ProximityMemberDirectoryEntry[],
  initialRoster: readonly ProximityRosterCheckIn[]
): ProximityPanelTransport {
  return {
    orgBeaconSalt: SALT,
    unixSecs: 1_762_520_100,
    localSigner: LOCAL,
    provisionedMembers,
    initialRoster,
  }
}

/** The roster's rows once it is labelled: the list is marked busy until then. */
async function labelled(): Promise<string[]> {
  const roster = screen.getByRole('list', { name: 'Personnes à proximité' })
  await waitFor(() => expect(roster).not.toHaveAttribute('aria-busy'))
  return within(roster)
    .queryAllByRole('listitem')
    .map((row) => row.textContent)
}

describe('who checked in is a handle', () => {
  it('shows the generated handle of a member who picked none, and the pseudonym of one who did', async () => {
    render(
      <ProximityRoomPanel
        channelName="proximity"
        transport={transport(
          [member(FIRST), member(SECOND), member(THIRD, 'north-wing-3')],
          [checkIn(FIRST), checkIn(SECOND), checkIn(THIRD)]
        )}
      />
    )
    expect(await labelled()).toEqual([
      'gentle-ember-jn24grqygSur place',
      'steady-brook-ah3fccbghSur place',
      'north-wing-3Sur place',
    ])
  })

  it('tells two members under one pseudonym apart by a fingerprint of each device', async () => {
    render(
      <ProximityRoomPanel
        channelName="proximity"
        transport={transport(
          [member(FIRST, 'north-wing-3'), member(SECOND, 'north-wing-3'), member(THIRD)],
          [checkIn(FIRST), checkIn(SECOND), checkIn(THIRD)]
        )}
      />
    )
    expect(await labelled()).toEqual([
      'north-wing-3 [95043981]Sur place',
      'north-wing-3 [790b4513]Sur place',
      'mellow-river-pmgj8v226Sur place',
    ])
  })

  it('shows the fingerprint from the first check-in, while the other member is still absent', async () => {
    // Only the first of the two has checked in: it must not pass for the absent one.
    render(
      <ProximityRoomPanel
        channelName="proximity"
        transport={transport(
          [member(FIRST, 'north-wing-3'), member(SECOND, 'north-wing-3')],
          [checkIn(FIRST)]
        )}
      />
    )
    expect(await labelled()).toEqual(['north-wing-3 [95043981]Sur place'])
  })

  it('lists nothing for a sender the provisioned roster does not hold', async () => {
    render(
      <ProximityRoomPanel
        channelName="proximity"
        transport={transport([member(FIRST)], [checkIn(OUTSIDER), checkIn(FIRST)])}
      />
    )
    expect(await labelled()).toEqual(['gentle-ember-jn24grqygSur place'])
    expect(screen.getByTestId('proximity-roster-toggle')).toHaveTextContent(
      '1 personne à proximité'
    )
  })

  it('lists no one, and never the name, when a roster holds a name in place of a pseudonym', async () => {
    render(
      <ProximityRoomPanel
        channelName="proximity"
        transport={transport(
          [member(FIRST, 'Jean Dupont'), member(SECOND)],
          [checkIn(FIRST), checkIn(SECOND)]
        )}
      />
    )
    expect(await labelled()).toEqual([])
    expect(document.body).not.toHaveTextContent(/Jean|Dupont/)
  })

  it('takes no name: the panel has no property to give one through', () => {
    render(
      <ProximityRoomPanel
        channelName="proximity"
        // @ts-expect-error A check-in never requires or shows a name; the property is gone.
        localDisplayName="Jean Dupont"
        transport={transport([member(FIRST)], [])}
      />
    )
    expect(document.body).not.toHaveTextContent(/Jean|Dupont/)
  })
})

describe('the roster a controller is provisioned with', () => {
  const secret = new Uint8Array(32).fill(0x07)
  const options = (members: readonly ProximityMemberDirectoryEntry[]) => ({
    orgBeaconSalt: SALT,
    localSigner: LOCAL,
    verifier: createKeyedMacVerifier(secret),
    members,
    broadcastChannelFactory: () => null,
  })

  it('holds devices and pseudonyms, the local device included, and no name', () => {
    const controller = new ProximityRoomController(
      options([member(FIRST, 'north-wing-3'), member(SECOND)])
    )
    const provisioned = controller.provisionedMembers()
    expect(provisioned).toHaveLength(3)
    for (const entry of provisioned)
      expect(Object.keys(entry).sort().join(',')).toMatch(/^(dedicatedHandle,)?publicKey$/)
    const emitted = controller.emitCheckIn(SafetyStatus.Safe, 'ok')
    expect(Object.keys(emitted.checkIn).sort()).toEqual([
      'isLocal',
      'messageId',
      'senderPublicKeyHex',
      'status',
      'text',
      'timestampMs',
      'ttlHops',
    ])
    controller.close()
  })

  it('refuses a roster whose pseudonym is outside the handle grammar', () => {
    for (const raw of ['Jean Dupont', 'jean@example.org', 'north-wing-3 [95043981]', 'ab'])
      expect(() => new ProximityRoomController(options([member(FIRST, raw)]))).toThrowError(
        ProximityCodecError
      )
  })
})
