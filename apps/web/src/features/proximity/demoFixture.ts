// Demonstration inputs for the « Autour de moi » panel. Only the demo and the tests import
// this file: the product has no proximity transport yet, so it never mounts a connected panel,
// and these fixed keys, this roster and this clock must never stand in for a real device.

import { createKeyedMacSigner } from './codec'
import type { ProximityPanelTransport } from './ProximityRoomPanel'
import {
  type ProximityMemberDirectoryEntry,
  type ProximityRosterCheckIn,
  SafetyStatus,
} from './types'

export const DEMO_ORG_BEACON_SALT = new Uint8Array(32).fill(0x42)
const DEMO_LOCAL_SECRET = new Uint8Array(32).fill(0x07)
const DEMO_LOCAL_PUBLIC_KEY = new Uint8Array(32).fill(0x09)
export const DEMO_UNIX_SECS = 1_762_520_100
// One signer for the demo's life: the panel labels its roster once per signer.
const DEMO_LOCAL_SIGNER = createKeyedMacSigner(DEMO_LOCAL_SECRET, DEMO_LOCAL_PUBLIC_KEY)

export const DEMO_PEER_ROSTER: readonly ProximityRosterCheckIn[] = [
  {
    messageId: '019a6004-bedc-7101-8101-010101010101',
    senderPublicKeyHex: '11'.repeat(32),
    status: SafetyStatus.MusterPoint,
    text: 'Cour Nord, près de l’accueil',
    ttlHops: 5,
    timestampMs: 1_762_520_050_000,
    isLocal: false,
  },
  {
    messageId: '019a6004-be14-7202-8202-020202020202',
    senderPublicKeyHex: '22'.repeat(32),
    status: SafetyStatus.Safe,
    text: 'Salle Atlas, 2e étage',
    ttlHops: 4,
    timestampMs: 1_762_520_020_000,
    isLocal: false,
  },
]

/**
 * The demo organisation's provisioned roster: the two peers above and a third member who has not
 * checked in. No one has a name here. One peer picked a pseudonym; the others show the handle
 * generated for them in this organisation.
 */
export const DEMO_PROVISIONED_MEMBERS: readonly ProximityMemberDirectoryEntry[] = [
  { publicKey: new Uint8Array(32).fill(0x11) },
  { publicKey: new Uint8Array(32).fill(0x22), dedicatedHandle: 'north-wing-3' },
  { publicKey: new Uint8Array(32).fill(0x33) },
]

export function demoProximityTransport(
  overrides: Partial<ProximityPanelTransport> = {}
): ProximityPanelTransport {
  return {
    orgBeaconSalt: DEMO_ORG_BEACON_SALT,
    unixSecs: DEMO_UNIX_SECS,
    localSigner: DEMO_LOCAL_SIGNER,
    provisionedMembers: DEMO_PROVISIONED_MEMBERS,
    initialRoster: DEMO_PEER_ROSTER,
    ...overrides,
  }
}
