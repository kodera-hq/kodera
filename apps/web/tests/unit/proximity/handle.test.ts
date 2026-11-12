// The proximity sender handle, held to the vectors every platform reads.
//
// `proximity-handle-v1.vectors.txt`, beside this file, holds the entries of
// `packages/kodera-rs/vectors/proximity-handle-v1.txt`: the grammar, the word lists, the generated
// handles of five senders in two organisations, and the roster cases. The web implementation
// (`src/features/proximity/handle.ts`, Web Crypto) must agree with every line. When the source
// file is in the checkout, its entries must equal the fixture's line for line; when it is not,
// that comparison is reported as skipped, never as passed.
//
// The checks carry their own refusals (docs/dev/TESTING.md §« Writing a test that can actually
// fail »): each mutant is the implementation with one guard removed, and `MUTANTS` names the
// words `checkVectors` must refuse it with.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PROXIMITY_HANDLE_CHARS,
  MIN_PROXIMITY_FINGERPRINT_HEX_CHARS,
  MIN_PROXIMITY_HANDLE_CHARS,
  PROXIMITY_HANDLE_ADJECTIVES,
  PROXIMITY_HANDLE_DIGEST_BITS,
  PROXIMITY_HANDLE_NOUNS,
  PROXIMITY_HANDLE_SUFFIX_CHARS,
  ProximityHandleError,
  dedicatedProximityHandle,
  disambiguateProximityHandles,
  generatedProximityHandle,
  isProximityHandle,
  labelObservedProximitySenders,
  proximityHandleFromParts,
  proximityKeyFingerprint,
  proximityRosterDisplays,
  resolveProximityHandle,
  resolveProvisionedProximityRoster,
  type ProvisionedProximitySender,
  type ProximityRosterLabel,
} from '@/features/proximity/handle'
import { hexToBytes } from '@/features/proximity/codec'

const FIXTURE = join(import.meta.dirname, 'proximity-handle-v1.vectors.txt')
/** The file the Rust, Swift and Kotlin implementations read, when this checkout holds it. */
const SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages/kodera-rs/vectors/proximity-handle-v1.txt'
)

/** A vector file's entries: every line but blank ones and comments, in order. */
function entriesOf(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
}

interface RosterLine {
  readonly salt: string
  readonly sender: string
  readonly dedicated: string | undefined
  readonly handle: string
  readonly fingerprint: string | undefined
  readonly present: boolean
}

interface Vectors {
  readonly bounds: Record<string, number>
  readonly origins: string[]
  readonly adjectives: string[]
  readonly nouns: string[]
  readonly valid: string[]
  readonly refuse: { name: string; text: string }[]
  readonly generated: { salt: string; sender: string; handle: string }[]
  readonly rosters: Map<string, RosterLine[]>
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

function parse(entries: readonly string[]): Vectors {
  const vectors: Vectors = {
    bounds: {},
    origins: [],
    adjectives: [],
    nouns: [],
    valid: [],
    refuse: [],
    generated: [],
    rosters: new Map(),
  }
  for (const line of entries) {
    const fields = line.split(' ')
    const [kind, a = '', b = '', c = '', d = '', e = '', f = '', g = ''] = fields
    if (kind === 'bound' && fields.length === 3) vectors.bounds[a] = Number(b)
    else if (kind === 'origin' && fields.length === 2) vectors.origins.push(a)
    else if (kind === 'adjective' && fields.length === 3) vectors.adjectives[Number(a)] = b
    else if (kind === 'noun' && fields.length === 3) vectors.nouns[Number(a)] = b
    else if (kind === 'valid' && fields.length === 2) vectors.valid.push(a)
    else if (kind === 'refuse' && fields.length === 3)
      vectors.refuse.push({ name: a, text: b === '-' ? '' : UTF8.decode(hexToBytes(b)) })
    else if (kind === 'generated' && fields.length === 4)
      vectors.generated.push({ salt: a, sender: b, handle: c })
    else if (kind === 'roster' && fields.length === 8 && (g === 'present' || g === 'absent')) {
      const lines = vectors.rosters.get(a) ?? []
      lines.push({
        salt: b,
        sender: c,
        dedicated: d === '-' ? undefined : d,
        handle: e,
        fingerprint: f === '-' ? undefined : f,
        present: g === 'present',
      })
      vectors.rosters.set(a, lines)
    } else throw new Error(`not an entry of the handle vectors: ${line}`)
  }
  return vectors
}

const VECTORS = parse(entriesOf(FIXTURE))

/** The four things the vectors hold an implementation to. */
interface HandleImplementation {
  validate(raw: string): boolean
  generate(orgBeaconSalt: Uint8Array, sender: Uint8Array): Promise<string>
  fingerprint(orgBeaconSalt: Uint8Array, sender: Uint8Array): Promise<string>
  labelObserved(
    orgBeaconSalt: Uint8Array,
    provisioned: readonly ProvisionedProximitySender[],
    observed: readonly Uint8Array[]
  ): Promise<ProximityRosterLabel[]>
}

const SHIPPED: HandleImplementation = {
  validate: isProximityHandle,
  generate: async (salt, sender) => (await generatedProximityHandle(salt, sender)).handle,
  fingerprint: proximityKeyFingerprint,
  labelObserved: labelObservedProximitySenders,
}

/**
 * Each mutant is the shipped implementation with one guard removed, and nothing else:
 *   - `organisation-binding-removed`: every organisation derives handles under one fixed salt, so
 *     a sender shows the same handle everywhere;
 *   - `groups-over-observed-only`: equal handles are told apart among the senders seen so far
 *     only, so a sender can pass for a member who has not checked in;
 *   - `foreign-character-accepted`: the grammar takes any lowercase letter or digit, of any script;
 *   - `fingerprint-ignores-the-salt`: every organisation computes fingerprints under one fixed
 *     salt, so a member shows the same fingerprint everywhere and can be followed across them.
 * The value is the message `checkVectors` must refuse it with.
 */
const MUTANTS = {
  'organisation-binding-removed': 'a generated handle is not bound to its organisation',
  'fingerprint-ignores-the-salt': 'a fingerprint is not bound to its organisation',
  'groups-over-observed-only': 'equal handles are not told apart from an absent member',
  'foreign-character-accepted': 'a handle outside the grammar is accepted',
} as const
type Mutant = keyof typeof MUTANTS

const ANY_SCRIPT = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u

function mutated(mutant: Mutant): HandleImplementation {
  switch (mutant) {
    case 'organisation-binding-removed':
      return {
        ...SHIPPED,
        generate: (_salt, sender) => SHIPPED.generate(new Uint8Array(32), sender),
      }
    case 'fingerprint-ignores-the-salt':
      return {
        ...SHIPPED,
        fingerprint: (_salt, sender) => SHIPPED.fingerprint(new Uint8Array(32), sender),
        labelObserved: (_salt, provisioned, observed) =>
          SHIPPED.labelObserved(new Uint8Array(32), provisioned, observed),
      }
    case 'groups-over-observed-only':
      return {
        ...SHIPPED,
        labelObserved: (salt, provisioned, observed) => {
          const seen = new Set(observed.map((sender) => sender.join(',')))
          return SHIPPED.labelObserved(
            salt,
            provisioned.filter((one) => seen.has(one.senderPublicKey.join(','))),
            observed
          )
        },
      }
    case 'foreign-character-accepted':
      return {
        ...SHIPPED,
        validate: (raw) =>
          SHIPPED.validate(raw) ||
          ([...raw].length >= MIN_PROXIMITY_HANDLE_CHARS &&
            [...raw].length <= MAX_PROXIMITY_HANDLE_CHARS &&
            ANY_SCRIPT.test(raw)),
      }
  }
}

/** Holds an implementation to every entry. Each kind of disagreement has its own words. */
async function checkVectors(implementation: HandleImplementation, vectors: Vectors = VECTORS) {
  for (const handle of vectors.valid)
    if (!implementation.validate(handle))
      throw new Error(`a handle inside the grammar is refused (${handle})`)
  for (const { name, text } of vectors.refuse)
    if (implementation.validate(text))
      throw new Error(`a handle outside the grammar is accepted (${name})`)

  // The organisation binding, on its own: one sender, two organisations, two handles.
  const bySender = new Map<string, Set<string>>()
  const salts = new Set<string>()
  for (const { salt, sender } of vectors.generated) {
    salts.add(salt)
    const shown = bySender.get(sender) ?? new Set<string>()
    shown.add(await implementation.generate(hexToBytes(salt), hexToBytes(sender)))
    bySender.set(sender, shown)
  }
  for (const [sender, shown] of bySender)
    if (shown.size < salts.size)
      throw new Error(
        `a generated handle is not bound to its organisation (sender ${sender.slice(0, 8)} shows ` +
          `${[...shown].join(', ')} in ${salts.size} organisations)`
      )

  // The same binding for the fingerprint: one sender, two organisations, two fingerprints.
  for (const sender of bySender.keys()) {
    const shown = new Set<string>()
    for (const salt of salts)
      shown.add(await implementation.fingerprint(hexToBytes(salt), hexToBytes(sender)))
    if (shown.size < salts.size)
      throw new Error(
        `a fingerprint is not bound to its organisation (sender ${sender.slice(0, 8)} shows ` +
          `${[...shown][0]?.slice(0, 8)} in ${salts.size} organisations)`
      )
  }

  for (const { salt, sender, handle } of vectors.generated) {
    const derived = await implementation.generate(hexToBytes(salt), hexToBytes(sender))
    if (derived !== handle)
      throw new Error(`a generated handle differs from its vector (${derived}, expected ${handle})`)
  }

  for (const [name, lines] of vectors.rosters) {
    const provisioned: ProvisionedProximitySender[] = []
    for (const line of lines) {
      const sender = hexToBytes(line.sender)
      const handle =
        line.dedicated === undefined
          ? await implementation.generate(hexToBytes(line.salt), sender)
          : dedicatedProximityHandle(line.dedicated).handle
      if (handle !== line.handle)
        throw new Error(`a roster handle differs from its vector (${name}: ${handle})`)
      provisioned.push({
        senderPublicKey: sender,
        handle: { handle, origin: line.dedicated === undefined ? 'generated' : 'dedicated' },
      })
    }
    const present = lines.filter((line) => line.present)
    const labels = await implementation.labelObserved(
      hexToBytes(lines[0]?.salt ?? ''),
      provisioned,
      present.map((line) => hexToBytes(line.sender))
    )
    const someoneAbsent = lines.some((line) => !line.present)
    present.forEach((line, index) => {
      const label = labels[index]
      const shown = label?.display ?? '(no label)'
      const expected =
        line.fingerprint === undefined ? line.handle : `${line.handle} [${line.fingerprint}]`
      if (label?.fingerprint === line.fingerprint && shown === expected) return
      throw new Error(
        someoneAbsent
          ? `equal handles are not told apart from an absent member (${name}: shown ` +
              `« ${shown} », expected « ${expected} »)`
          : `a roster label differs from its vector (${name}: shown « ${shown} », ` +
              `expected « ${expected} »)`
      )
    })
  }
}

describe('proximity handle v1 vectors', () => {
  it('holds every kind of entry, so no check below is vacuous', () => {
    expect(VECTORS.valid.length).toBeGreaterThanOrEqual(12)
    expect(VECTORS.refuse.length).toBeGreaterThanOrEqual(31)
    expect(VECTORS.generated).toHaveLength(10)
    expect([...VECTORS.rosters.keys()]).toEqual([
      'all_distinct',
      'shared_dedicated_handle',
      'dedicated_equals_a_generated_one',
      'fingerprints_extend_until_distinct',
      'shared_handle_with_an_absent_member',
      'generated_handle_taken_by_an_absent_member',
    ])
  })

  it('agrees on the bounds, the origins and both word lists', () => {
    expect(VECTORS.bounds).toEqual({
      min_chars: MIN_PROXIMITY_HANDLE_CHARS,
      max_chars: MAX_PROXIMITY_HANDLE_CHARS,
      generated_suffix_chars: PROXIMITY_HANDLE_SUFFIX_CHARS,
      generated_digest_bits: PROXIMITY_HANDLE_DIGEST_BITS,
      min_fingerprint_hex_chars: MIN_PROXIMITY_FINGERPRINT_HEX_CHARS,
    })
    expect(VECTORS.origins).toEqual(['dedicated', 'generated'])
    expect(VECTORS.adjectives).toEqual([...PROXIMITY_HANDLE_ADJECTIVES])
    expect(VECTORS.nouns).toEqual([...PROXIMITY_HANDLE_NOUNS])
    expect(VECTORS.adjectives).toHaveLength(32)
    expect(VECTORS.nouns).toHaveLength(32)
  })

  it('agrees with every grammar case, generated handle and roster case', async () => {
    await expect(checkVectors(SHIPPED)).resolves.toBeUndefined()
  })

  it('generates only handles the grammar accepts, within the 24-character bound', async () => {
    for (const { salt, sender } of VECTORS.generated) {
      const { handle, origin } = await generatedProximityHandle(
        hexToBytes(salt),
        hexToBytes(sender)
      )
      expect(origin).toBe('generated')
      expect(isProximityHandle(handle)).toBe(true)
      expect(handle.length).toBeLessThanOrEqual(MAX_PROXIMITY_HANDLE_CHARS)
    }
  })

  const sourcePresent = existsSync(SOURCE)
  it.skipIf(!sourcePresent)(
    'equals packages/kodera-rs/vectors/proximity-handle-v1.txt entry for entry (skipped while that file is not in this checkout)',
    () => {
      expect(entriesOf(FIXTURE)).toEqual(entriesOf(SOURCE))
    }
  )
})

describe('proximity handles, beyond the vectors', () => {
  const SALT = new Uint8Array(32).fill(0x42)
  const ALICE = new Uint8Array(32).fill(0x09)
  const BRUNO = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')

  it('refuses, never repairs, a dedicated handle outside the grammar', async () => {
    for (const raw of ['Jean Dupont', 'jean@example.org', ' north-wing-3', 'café', 'ab'])
      expect(() => dedicatedProximityHandle(raw)).toThrowError(ProximityHandleError)
    await expect(resolveProximityHandle('Jean Dupont', SALT, ALICE)).rejects.toMatchObject({
      code: 'InvalidProximityHandle',
    })
    expect(dedicatedProximityHandle('north-wing-3')).toEqual({
      handle: 'north-wing-3',
      origin: 'dedicated',
    })
  })

  it('resolves to the dedicated handle when one was picked, to the generated one otherwise', async () => {
    expect(await resolveProximityHandle('north-wing-3', SALT, ALICE)).toEqual({
      handle: 'north-wing-3',
      origin: 'dedicated',
    })
    expect(await resolveProximityHandle(undefined, SALT, ALICE)).toEqual({
      handle: 'steady-brook-ah3fccbgh',
      origin: 'generated',
    })
  })

  it('rebuilds a generated handle only when it is the one this organisation derives', async () => {
    await expect(
      proximityHandleFromParts('steady-brook-ah3fccbgh', 'generated', SALT, ALICE)
    ).resolves.toMatchObject({ origin: 'generated' })
    await expect(
      proximityHandleFromParts('misty-sparrow-yn6kxpknp', 'generated', SALT, ALICE)
    ).rejects.toMatchObject({ code: 'InvalidProximityHandle' })
    await expect(
      proximityHandleFromParts('x-y-z', 'dedicated', SALT, ALICE)
    ).resolves.toMatchObject({ handle: 'x-y-z', origin: 'dedicated' })
  })

  it('refuses a salt or a sender that is not 32 bytes', async () => {
    await expect(generatedProximityHandle(new Uint8Array(31), ALICE)).rejects.toMatchObject({
      code: 'InvalidKeyMaterial',
    })
    await expect(generatedProximityHandle(SALT, new Uint8Array(33))).rejects.toMatchObject({
      code: 'InvalidKeyMaterial',
    })
    await expect(proximityKeyFingerprint(SALT, new Uint8Array(0))).rejects.toMatchObject({
      code: 'InvalidKeyMaterial',
    })
    await expect(proximityKeyFingerprint(new Uint8Array(16), ALICE)).rejects.toMatchObject({
      code: 'InvalidKeyMaterial',
    })
  })

  it('shows a sender under another fingerprint in another organisation', async () => {
    // The two values were computed a second way, outside this repository, with Node's `crypto`:
    // HMAC-SHA256(salt, "kodera-proximity-fingerprint-v1:" || sender), salts 0x42 and 0x43.
    const sender = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
    const here = await proximityKeyFingerprint(SALT, sender)
    const elsewhere = await proximityKeyFingerprint(new Uint8Array(32).fill(0x43), sender)
    expect(here).toBe('95043981b19ae962c90146b1352d52b80a8fe7def49c8cf57ddd4c609fb1e226')
    expect(elsewhere).toBe('80f17f3a96f22d4e7d8fc1331341f5198ae3b76c9da937b121c9151985a1ed51')
    expect(here.slice(0, 8)).not.toBe(elsewhere.slice(0, 8))
    // And in a roster: the same two members, the same pseudonym, two organisations.
    const members = [
      { publicKey: sender, dedicatedHandle: 'north-wing-3' },
      { publicKey: ALICE, dedicatedHandle: 'north-wing-3' },
    ]
    const inOne = await proximityRosterDisplays(SALT, members)
    const inOther = await proximityRosterDisplays(new Uint8Array(32).fill(0x43), members)
    expect([...inOne.values()].map((label) => label.display)).toEqual([
      'north-wing-3 [95043981]',
      'north-wing-3 [790b4513]',
    ])
    expect([...inOther.values()].map((label) => label.display)).toEqual([
      'north-wing-3 [80f17f3a]',
      'north-wing-3 [efd69830]',
    ])
  })

  it('labels nothing for a sender the provisioned roster does not hold', async () => {
    const provisioned = await resolveProvisionedProximityRoster(SALT, [{ publicKey: ALICE }])
    await expect(labelObservedProximitySenders(SALT, provisioned, [BRUNO])).rejects.toMatchObject({
      code: 'UnauthorizedSender',
    })
  })

  it('does not make a sender listed twice collide with itself', async () => {
    const provisioned = await resolveProvisionedProximityRoster(SALT, [
      { publicKey: ALICE },
      { publicKey: ALICE },
    ])
    const labels = await disambiguateProximityHandles(SALT, provisioned)
    expect(labels.map((label) => label.display)).toEqual([
      'steady-brook-ah3fccbgh',
      'steady-brook-ah3fccbgh',
    ])
  })

  it('refuses a whole roster holding one invalid dedicated handle, and shows nothing of it', async () => {
    await expect(
      proximityRosterDisplays(SALT, [
        { publicKey: ALICE },
        { publicKey: BRUNO, dedicatedHandle: 'Bruno Lefèvre' },
      ])
    ).rejects.toMatchObject({ code: 'InvalidProximityHandle' })
  })

  it('keeps the disambiguated display outside the handle grammar, so it is never taken for a handle', async () => {
    const displays = await proximityRosterDisplays(SALT, [
      { publicKey: ALICE, dedicatedHandle: 'north-wing-3' },
      { publicKey: BRUNO, dedicatedHandle: 'north-wing-3' },
    ])
    for (const label of displays.values()) {
      expect(label.display).toMatch(/^north-wing-3 \[[0-9a-f]{8}\]$/)
      expect(isProximityHandle(label.display)).toBe(false)
      expect(isProximityHandle(label.handle.handle)).toBe(true)
    }
    expect(displays.size).toBe(2)
  })
})

// The refusals: each mutant removes one guard, and the vectors must refuse it in its own words.
// The control runs the same check on the shipped implementation, so a refusal is the mutant's.
describe('the vectors refuse each mutant', () => {
  it('control: the shipped implementation passes', async () => {
    await expect(checkVectors(SHIPPED)).resolves.toBeUndefined()
  })

  it.each(Object.entries(MUTANTS) as [Mutant, string][])(
    'mutant %s is refused: %s',
    async (mutant, refusal) => {
      await expect(checkVectors(mutated(mutant))).rejects.toThrow(refusal)
    }
  )

  it('mutant foreign-character-accepted would take an accented and a Cyrillic handle', () => {
    const { validate } = mutated('foreign-character-accepted')
    expect(validate('café')).toBe(true)
    expect(validate('аbc')).toBe(true)
    expect(isProximityHandle('café')).toBe(false)
    expect(isProximityHandle('аbc')).toBe(false)
  })
})
