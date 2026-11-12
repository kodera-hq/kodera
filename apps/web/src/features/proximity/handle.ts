// Pseudonymous sender labels for proximity check-ins.
//
// A proximity frame carries its sender's device public half and nothing else about the person.
// What is shown next to a check-in is a handle: a pseudonym the member picked for this purpose
// (`dedicated`) or one derived for the sender inside one organisation (`generated`). A real name
// is never required, never read and never shown by this feature. The frozen frame v1 is
// untouched: a handle is display metadata held beside a frame, never inside it.
//
// A handle is a DISPLAY LABEL, never an identity and never an authorisation input. Identity stays
// the signing half: the roster and the signature decide what is admitted, and nothing here may
// grant, refuse, deduplicate or look anything up by handle. Two senders can show the same handle,
// by accident or on purpose, so a roster is labelled with `labelObservedProximitySenders`, which
// shows equal handles with a fingerprint of each signing half. Equality is judged over the whole
// provisioned roster, absent members included: a sender cannot borrow the handle of a member who
// has not checked in yet, and no label changes when that member appears.
//
// Both derivations are keyed with the organisation's beacon salt: the same device shows another
// handle, and another fingerprint, in another organisation. Nothing shown for a sender is
// linkable across organisations, and there is no unkeyed fingerprint to show.
//
// This module agrees byte for byte with `packages/kodera-rs/src/proximity_handle.rs` and its
// Swift and Kotlin ports through `packages/kodera-rs/vectors/proximity-handle-v1.txt`
// (`tests/unit/proximity/handle.test.ts` holds it to every line).

import type { components } from '../../api/schema'
import { bytesToHex } from './codec'
import type { ProximityMemberDirectoryEntry } from './types'

/** The contract's pseudonymous handle: 3 to 24 characters of `^[a-z0-9]+(?:-[a-z0-9]+)*$`. */
export type ProximityCheckInHandle = components['schemas']['ProximityCheckInHandle']
/** How a person appears in a check-in: a handle and where it came from, and no name. */
export type ProximityHandle = Readonly<components['schemas']['ProximityCheckInPseudonym']>
export type ProximityHandleOrigin = ProximityHandle['origin']

/** Fewest characters in a handle. */
export const MIN_PROXIMITY_HANDLE_CHARS = 3
/** Most characters in a handle. The grammar is ASCII, so characters and bytes agree. */
export const MAX_PROXIMITY_HANDLE_CHARS = 24
/** Characters after the two words of a generated handle: 45 bits, five per character. */
export const PROXIMITY_HANDLE_SUFFIX_CHARS = 9
/** Digest bits a generated handle keeps: five per word and 45 in the suffix. */
export const PROXIMITY_HANDLE_DIGEST_BITS = 55
/** Shortest fingerprint prefix shown beside a handle that is not unique in its roster. */
export const MIN_PROXIMITY_FINGERPRINT_HEX_CHARS = 8

const ASCII = new TextEncoder()
/** MACed with the sender's public half under the organisation's beacon salt. Display only. */
const GENERATED_HANDLE_LABEL = ASCII.encode('kodera-proximity-handle-v1:')
/** MACed with the sender's public half, under the same salt, for the fingerprint that tells equal
 * handles apart inside one organisation. */
const FINGERPRINT_LABEL = ASCII.encode('kodera-proximity-fingerprint-v1:')
/** Lowercase, digits first, without `i`, `l`, `o` and `u`: five bits per character. */
const SUFFIX_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const HANDLE_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const PROXIMITY_HANDLE_ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'clear',
  'coral',
  'crisp',
  'dusky',
  'early',
  'fair',
  'gentle',
  'golden',
  'green',
  'hazel',
  'ivory',
  'jade',
  'keen',
  'light',
  'lunar',
  'mellow',
  'misty',
  'noble',
  'olive',
  'pale',
  'quiet',
  'rapid',
  'royal',
  'sandy',
  'silver',
  'solar',
  'steady',
  'swift',
  'vivid',
] as const

export const PROXIMITY_HANDLE_NOUNS = [
  'alder',
  'aspen',
  'badger',
  'birch',
  'brook',
  'cedar',
  'comet',
  'crane',
  'delta',
  'dune',
  'ember',
  'falcon',
  'fern',
  'finch',
  'glade',
  'harbor',
  'heron',
  'island',
  'juniper',
  'lark',
  'lynx',
  'maple',
  'meadow',
  'otter',
  'pebble',
  'pine',
  'quartz',
  'raven',
  'reef',
  'river',
  'sparrow',
  'willow',
] as const

export type ProximityHandleErrorCode =
  'InvalidProximityHandle' | 'UnauthorizedSender' | 'InvalidKeyMaterial' | 'CryptoUnavailable'

export class ProximityHandleError extends Error {
  readonly code: ProximityHandleErrorCode

  constructor(code: ProximityHandleErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ProximityHandleError'
    this.code = code
  }
}

/**
 * Accepts exactly `^[a-z0-9]+(?:-[a-z0-9]+)*$` with 3 to 24 characters: lowercase ASCII letters
 * and digits in groups joined by single hyphens. Nothing is trimmed, folded or normalised, so a
 * display name, an email address or any non-ASCII text is refused rather than repaired.
 */
export function isProximityHandle(raw: unknown): raw is ProximityCheckInHandle {
  return (
    typeof raw === 'string' &&
    raw.length >= MIN_PROXIMITY_HANDLE_CHARS &&
    raw.length <= MAX_PROXIMITY_HANDLE_CHARS &&
    HANDLE_GRAMMAR.test(raw)
  )
}

function subtle(): SubtleCrypto {
  const api = (globalThis as { readonly crypto?: { readonly subtle?: SubtleCrypto } }).crypto
    ?.subtle
  if (api === undefined)
    throw new ProximityHandleError('CryptoUnavailable', 'Web Crypto is not available here')
  return api
}

/** The 32 bytes of a beacon salt or of a sender's public half, copied; anything else is refused. */
function exactly32(bytes: Uint8Array, what: string): Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    throw new ProximityHandleError('InvalidKeyMaterial', `${what} must be 32 bytes`)
  return new Uint8Array(bytes)
}

function labelled(label: Uint8Array, sender: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(label.length + sender.length)
  out.set(label, 0)
  out.set(sender, label.length)
  return out
}

/** `HMAC-SHA256(binding, label || sender)`: every derivation here is bound to an organisation. */
async function boundDigest(
  binding: Uint8Array<ArrayBuffer>,
  label: Uint8Array,
  sender: Uint8Array
): Promise<Uint8Array> {
  const api = subtle()
  const key = await api.importKey('raw', binding, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await api.sign('HMAC', key, labelled(label, sender)))
}

/**
 * `<adjective>-<noun>-<9 characters>` from `HMAC-SHA256(binding, label || sender)`: the adjective
 * is entry `d[0] & 31`, the noun entry `d[1] & 31`, and the suffix spells the top 45 bits of
 * `d[2..8]`, most significant character first.
 */
async function deriveGeneratedHandle(
  binding: Uint8Array<ArrayBuffer>,
  sender: Uint8Array
): Promise<string> {
  const digest = await boundDigest(binding, GENERATED_HANDLE_LABEL, sender)
  let bits = 0n
  for (let index = 2; index < 8; index += 1) bits = (bits << 8n) | BigInt(digest[index] ?? 0)
  bits >>= 3n
  let suffix = ''
  for (let index = 0; index < PROXIMITY_HANDLE_SUFFIX_CHARS; index += 1) {
    suffix = (SUFFIX_ALPHABET[Number(bits & 31n)] ?? '') + suffix
    bits >>= 5n
  }
  const adjective = PROXIMITY_HANDLE_ADJECTIVES[(digest[0] ?? 0) & 31]
  const noun = PROXIMITY_HANDLE_NOUNS[(digest[1] ?? 0) & 31]
  return `${adjective}-${noun}-${suffix}`
}

/** A pseudonym the member picked. Refused, never repaired, when it is outside the grammar. */
export function dedicatedProximityHandle(raw: string): ProximityHandle {
  if (!isProximityHandle(raw)) throw new ProximityHandleError('InvalidProximityHandle')
  return { handle: raw, origin: 'dedicated' }
}

/**
 * The handle every device of one organisation derives for a sender. `orgBeaconSalt` is the salt
 * the proximity beacon takes: the same sender gives the same handle on every platform inside that
 * organisation, and another one outside it.
 */
export async function generatedProximityHandle(
  orgBeaconSalt: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<ProximityHandle> {
  const handle = await deriveGeneratedHandle(
    exactly32(orgBeaconSalt, 'orgBeaconSalt'),
    exactly32(senderPublicKey, 'senderPublicKey')
  )
  return { handle, origin: 'generated' }
}

/**
 * The dedicated handle when the member picked one, the generated one otherwise. An invalid
 * dedicated handle is an error: it is not silently replaced, and it is never shown.
 */
export async function resolveProximityHandle(
  dedicated: string | undefined,
  orgBeaconSalt: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<ProximityHandle> {
  return dedicated === undefined
    ? generatedProximityHandle(orgBeaconSalt, senderPublicKey)
    : dedicatedProximityHandle(dedicated)
}

/**
 * Rebuilds a handle received with its origin, for instance from a provisioned roster. A
 * `generated` handle must be the one this organisation derives for this sender.
 */
export async function proximityHandleFromParts(
  raw: string,
  origin: ProximityHandleOrigin,
  orgBeaconSalt: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<ProximityHandle> {
  if (origin === 'dedicated') return dedicatedProximityHandle(raw)
  if (origin !== 'generated') throw new ProximityHandleError('InvalidProximityHandle')
  const expected = await generatedProximityHandle(orgBeaconSalt, senderPublicKey)
  if (expected.handle !== raw) throw new ProximityHandleError('InvalidProximityHandle')
  return expected
}

/**
 * The 64 lowercase hex characters a sender is told apart by, inside one organisation, when
 * handles are equal: `HMAC-SHA256(organisation beacon salt, "kodera-proximity-fingerprint-v1:" ||
 * sender)`. A prefix of it is shown. It is keyed like the handle: the same device shows another
 * fingerprint in another organisation, so a fingerprint seen in one says nothing in another.
 */
export async function proximityKeyFingerprint(
  orgBeaconSalt: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<string> {
  return bytesToHex(
    await boundDigest(
      exactly32(orgBeaconSalt, 'orgBeaconSalt'),
      FINGERPRINT_LABEL,
      exactly32(senderPublicKey, 'senderPublicKey')
    )
  )
}

/** One provisioned sender of a roster: its public half and the handle it resolves to. */
export interface ProvisionedProximitySender {
  readonly senderPublicKey: Uint8Array
  readonly handle: ProximityHandle
}

/**
 * What a roster view shows for one sender: the handle, and a fingerprint prefix of the signing
 * half when another sender of the same roster shows the same handle.
 */
export interface ProximityRosterLabel {
  readonly senderPublicKeyHex: string
  readonly handle: ProximityHandle
  /** `undefined` when the handle is unique in the roster it was computed for. */
  readonly fingerprint: string | undefined
  /**
   * `handle`, or `handle [fingerprint]` when the handle alone would be ambiguous. The second form
   * is a display string, not a handle: it is outside the handle grammar on purpose.
   */
  readonly display: string
}

/**
 * Labels for every provisioned sender of one roster, in the order given. When two or more
 * distinct senders resolve to the same handle, whatever its origin, each of them carries a
 * fingerprint prefix: 8 hex characters, lengthened two at a time until the prefixes of that group
 * differ. A sender listed twice is one sender and does not collide with itself.
 *
 * `provisioned` must be the whole provisioned roster, never only the senders seen so far. To
 * label the senders that have checked in, use `labelObservedProximitySenders`. `orgBeaconSalt` is
 * the organisation the roster belongs to: its fingerprints are that organisation's.
 */
export async function disambiguateProximityHandles(
  orgBeaconSalt: Uint8Array,
  provisioned: readonly ProvisionedProximitySender[]
): Promise<ProximityRosterLabel[]> {
  // Handle text to the distinct senders showing it.
  const groups = new Map<string, Map<string, Uint8Array>>()
  for (const { senderPublicKey, handle } of provisioned) {
    const sender = exactly32(senderPublicKey, 'senderPublicKey')
    const group = groups.get(handle.handle) ?? new Map<string, Uint8Array>()
    group.set(bytesToHex(sender), sender)
    groups.set(handle.handle, group)
  }
  // For each shared handle, the prefix length that separates its senders, and their fingerprints.
  const lengths = new Map<string, number>()
  const fingerprints = new Map<string, string>()
  for (const [handle, group] of groups) {
    if (group.size < 2) continue
    const full: string[] = []
    for (const [senderHex, sender] of group) {
      const fingerprint = await proximityKeyFingerprint(orgBeaconSalt, sender)
      fingerprints.set(senderHex, fingerprint)
      full.push(fingerprint)
    }
    let length = MIN_PROXIMITY_FINGERPRINT_HEX_CHARS
    while (length < 64 && new Set(full.map((one) => one.slice(0, length))).size < full.length)
      length += 2
    lengths.set(handle, length)
  }
  return provisioned.map(({ senderPublicKey, handle }) => {
    const senderPublicKeyHex = bytesToHex(senderPublicKey)
    const length = lengths.get(handle.handle)
    const fingerprint =
      length === undefined ? undefined : fingerprints.get(senderPublicKeyHex)?.slice(0, length)
    return {
      senderPublicKeyHex,
      handle,
      fingerprint,
      display: fingerprint === undefined ? handle.handle : `${handle.handle} [${fingerprint}]`,
    }
  })
}

/**
 * Labels for the senders that have checked in, in the order of `observed`, with the collision
 * groups computed over the whole `provisioned` roster. A sender whose handle equals that of any
 * provisioned member carries its fingerprint whether or not that member has checked in. An
 * observed sender outside the provisioned roster is refused: nothing is labelled for a sender the
 * roster does not hold.
 */
export async function labelObservedProximitySenders(
  orgBeaconSalt: Uint8Array,
  provisioned: readonly ProvisionedProximitySender[],
  observed: readonly Uint8Array[]
): Promise<ProximityRosterLabel[]> {
  const labels = new Map<string, ProximityRosterLabel>()
  for (const label of await disambiguateProximityHandles(orgBeaconSalt, provisioned))
    labels.set(label.senderPublicKeyHex, label)
  return observed.map((sender) => {
    const label = labels.get(bytesToHex(sender))
    if (label === undefined) throw new ProximityHandleError('UnauthorizedSender')
    return label
  })
}

/**
 * The provisioned roster with the handle each member resolves to in this organisation. One
 * invalid dedicated handle refuses the whole roster: it is not replaced, and nothing is shown.
 */
export async function resolveProvisionedProximityRoster(
  orgBeaconSalt: Uint8Array,
  members: readonly ProximityMemberDirectoryEntry[]
): Promise<ProvisionedProximitySender[]> {
  const provisioned: ProvisionedProximitySender[] = []
  for (const member of members) {
    provisioned.push({
      senderPublicKey: member.publicKey,
      handle: await resolveProximityHandle(member.dedicatedHandle, orgBeaconSalt, member.publicKey),
    })
  }
  return provisioned
}

/**
 * What to show for each sender of a provisioned roster, by the hex of its public half: the whole
 * roster's labels at once, since no label depends on who has checked in.
 */
export async function proximityRosterDisplays(
  orgBeaconSalt: Uint8Array,
  members: readonly ProximityMemberDirectoryEntry[]
): Promise<ReadonlyMap<string, ProximityRosterLabel>> {
  const provisioned = await resolveProvisionedProximityRoster(orgBeaconSalt, members)
  const displays = new Map<string, ProximityRosterLabel>()
  for (const label of await disambiguateProximityHandles(orgBeaconSalt, provisioned))
    displays.set(label.senderPublicKeyHex, label)
  return displays
}
