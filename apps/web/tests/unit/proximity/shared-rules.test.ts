import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROXIMITY_MAX_FUTURE_SKEW_MS,
  PROXIMITY_QUEUE_CAPACITY,
  PROXIMITY_REPLAY_ENTRIES,
  PROXIMITY_ROSTER_MEMBERS,
  ProximityCodecError,
  ProximityFrame,
  ProximityReplayGuard,
  ProximityRoomController,
  SafetyStatus,
  UuidV7,
  createKeyedMacSigner,
  createKeyedMacVerifier,
  isTooFarAhead,
} from '@/features/proximity'

// The same file the Rust, Swift and Kotlin tests read: every platform agrees line for line.
const RULES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages/kodera-rs/vectors/emergency-v1-rules.txt'
)

interface Rules {
  readonly bounds: Record<string, number>
  readonly rules: Record<string, number>
  readonly cases: { name: string; now: number; frame: number; refuse: boolean }[]
}

function readRules(): Rules {
  const bounds: Record<string, number> = {}
  const rules: Record<string, number> = {}
  const cases: Rules['cases'] = []
  for (const line of readFileSync(RULES, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split(' ')
    const [kind] = fields
    if (kind === 'bound' && fields.length === 3) {
      bounds[fields[1] ?? ''] = Number(fields[2])
    } else if (kind === 'rule' && fields.length === 3) {
      rules[fields[1] ?? ''] = Number(fields[2])
    } else if (kind === 'case' && fields.length === 6 && fields[1] === 'max_future_skew_ms') {
      const verdict = fields[5]
      if (verdict !== 'accept' && verdict !== 'refuse') throw new Error(`bad verdict: ${line}`)
      cases.push({
        name: fields[2] ?? '',
        now: Number(fields[3]),
        frame: Number(fields[4]),
        refuse: verdict === 'refuse',
      })
    } else {
      throw new Error(`unknown line in the shared rules: ${line}`)
    }
  }
  return { bounds, rules, cases }
}

describe('proximity v1 shared rules (packages/kodera-rs/vectors/emergency-v1-rules.txt)', () => {
  const shared = readRules()

  it('states the same bounds and clock rule as Rust', () => {
    expect(shared.bounds).toEqual({
      queue_capacity: PROXIMITY_QUEUE_CAPACITY,
      roster_members: PROXIMITY_ROSTER_MEMBERS,
      replay_entries: PROXIMITY_REPLAY_ENTRIES,
    })
    expect(shared.rules).toEqual({ max_future_skew_ms: PROXIMITY_MAX_FUTURE_SKEW_MS })
  })

  it('decides every shared clock case as Rust does', () => {
    expect(shared.cases.length).toBeGreaterThan(0)
    for (const c of shared.cases) {
      expect({ name: c.name, refuse: isTooFarAhead(c.frame, c.now) }).toEqual({
        name: c.name,
        refuse: c.refuse,
      })
    }
  })

  it('caps the replay guard at the shared bound', () => {
    expect(new ProximityReplayGuard(1_000_000).maxEntries).toBe(PROXIMITY_REPLAY_ENTRIES)
  })
})

describe('ProximityRoomController clock and roster bounds', () => {
  const salt = new Uint8Array(32).fill(0x42)
  const secret = new Uint8Array(32).fill(0x07)
  const pkLocal = new Uint8Array(32).fill(0x0a)
  const pkPeer = new Uint8Array(32).fill(0x0b)
  const clockMs = 1_762_520_100_000

  function controller(members = [{ publicKey: pkPeer, displayName: 'Marina Loiseau' }]) {
    return new ProximityRoomController({
      orgBeaconSalt: salt,
      localSigner: createKeyedMacSigner(secret, pkLocal),
      verifier: createKeyedMacVerifier(secret),
      members,
      nowMs: () => clockMs,
      broadcastChannelFactory: () => null,
    })
  }

  function frame(timestampMs: number, status: SafetyStatus, fill: number) {
    return ProximityFrame.newSigned(
      UuidV7.fromParts(timestampMs, new Uint8Array(10).fill(fill)),
      4,
      status,
      '',
      createKeyedMacSigner(secret, pkPeer)
    )
  }

  it('refuses a frame dated past the skew bound before it can mask a real check-in', () => {
    const node = controller()
    const beacon = node.currentBeacon()
    const ahead = frame(clockMs + PROXIMITY_MAX_FUTURE_SKEW_MS + 1, SafetyStatus.Safe, 9)
    expect(node.ingestPeerFrame(beacon, ahead.encode())).toEqual({
      accepted: false,
      reason: 'future_frame',
    })
    expect(node.getRoster()).toHaveLength(0)
    expect(node.peekRelayQueue()).toHaveLength(0)

    const real = frame(clockMs, SafetyStatus.NeedAssistance, 1)
    expect(node.ingestPeerFrame(beacon, real.encode()).accepted).toBe(true)
    const atBound = frame(clockMs + PROXIMITY_MAX_FUTURE_SKEW_MS, SafetyStatus.Safe, 2)
    expect(node.ingestPeerFrame(beacon, atBound.encode()).accepted).toBe(true)
    node.close()
  })

  it('judges the skew against the clock the caller passes', () => {
    const node = controller()
    const beacon = node.currentBeacon()
    // 400 s ahead of the controller's clock, but only 200 s ahead of the clock the caller passes.
    const ahead = frame(clockMs + 400_000, SafetyStatus.Safe, 3)
    const callerSecs = Math.floor(clockMs / 1000) + 200
    expect(node.ingestPeerFrame(beacon, ahead.encode(), callerSecs).accepted).toBe(true)
    const further = frame(
      clockMs + 200_000 + PROXIMITY_MAX_FUTURE_SKEW_MS + 1,
      SafetyStatus.Safe,
      4
    )
    expect(node.ingestPeerFrame(beacon, further.encode(), callerSecs)).toEqual({
      accepted: false,
      reason: 'future_frame',
    })
    node.close()
  })

  it('refuses a roster larger than the shared bound', () => {
    const members = Array.from({ length: PROXIMITY_ROSTER_MEMBERS }, (_, index) => {
      const key = new Uint8Array(32)
      key[0] = index & 0xff
      key[1] = index >> 8
      key[31] = 0xee
      return { publicKey: key, displayName: `member ${index}` }
    })
    expect(() => controller(members.slice(0, PROXIMITY_ROSTER_MEMBERS - 1)).close()).not.toThrow()
    expect(() => controller(members)).toThrow(ProximityCodecError)
  })
})
