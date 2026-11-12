// Demonstration inputs for the « Autour de moi » panel. Only the demo and the tests import
// this file: the product has no proximity transport yet, so it never mounts a connected panel,
// and these fixed keys, this roster and this clock must never stand in for a real device.

import { createKeyedMacSigner } from './codec'
import type { ProximityPanelTransport } from './ProximityRoomPanel'
import { type ProximityRosterCheckIn, SafetyStatus } from './types'

export const DEMO_ORG_BEACON_SALT = new Uint8Array(32).fill(0x42)
const DEMO_LOCAL_SECRET = new Uint8Array(32).fill(0x07)
const DEMO_LOCAL_PUBLIC_KEY = new Uint8Array(32).fill(0x09)
export const DEMO_UNIX_SECS = 1_762_520_100

export const DEMO_PEER_ROSTER: readonly ProximityRosterCheckIn[] = [
  {
    messageId: '019a6004-bedc-7101-8101-010101010101',
    senderPublicKeyHex: '11'.repeat(32),
    displayName: 'Sylvain Ellenstein',
    roleLabel: 'SRE, Réseau & Infrastructure',
    status: SafetyStatus.MusterPoint,
    text: 'Point de rassemblement ouvert — Cour Nord',
    ttlHops: 5,
    timestampMs: 1_762_520_050_000,
    isLocal: false,
  },
  {
    messageId: '019a6004-be14-7202-8202-020202020202',
    senderPublicKeyHex: '22'.repeat(32),
    displayName: 'Marina Loiseau',
    roleLabel: 'Ingénierie & Cryptographie',
    status: SafetyStatus.Safe,
    text: 'Étage 2 évacué, escalier B dégagé',
    ttlHops: 4,
    timestampMs: 1_762_520_020_000,
    isLocal: false,
  },
]

export function demoProximityTransport(
  overrides: Partial<ProximityPanelTransport> = {}
): ProximityPanelTransport {
  return {
    orgBeaconSalt: DEMO_ORG_BEACON_SALT,
    unixSecs: DEMO_UNIX_SECS,
    localSigner: createKeyedMacSigner(DEMO_LOCAL_SECRET, DEMO_LOCAL_PUBLIC_KEY),
    initialRoster: DEMO_PEER_ROSTER,
    ...overrides,
  }
}
