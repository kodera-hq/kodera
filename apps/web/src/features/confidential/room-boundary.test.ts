import { describe, expect, it } from 'vitest'
import { CONFIDENTIAL_MARKER, RoomBoundaryTracker, permitsPlaintext } from './room-boundary'

const agent = '@kodera-agent:matrix.example.test'
const create = (content: unknown, sender = agent) => ({ content, sender })
const algorithms = ['io.kodera.mls.v1', 'm.megolm.v1.aes-sha2'] as const

describe('the immutable confidential room boundary', () => {
  it.each(algorithms)('requires a session for %s even with matching trusted state', (algorithm) => {
    const boundary = new RoomBoundaryTracker().observe(
      'room',
      create({ [CONFIDENTIAL_MARKER]: algorithm }),
      create({ algorithm }),
      agent
    )
    expect(boundary).toBe('confidential-unavailable')
    expect(permitsPlaintext(boundary)).toBe(false)
  })

  it.each(['unknown', null, true, {}, ['io.kodera.mls.v1']])(
    'quarantines malformed markers %j',
    (marker) => {
      expect(
        new RoomBoundaryTracker().observe(
          'room',
          create({ [CONFIDENTIAL_MARKER]: marker }),
          create({ algorithm: 'io.kodera.mls.v1' }),
          agent
        )
      ).toBe('invalid')
    }
  )

  it('refuses mismatched algorithms, extra fields, missing encryption and untrusted state authors', () => {
    const tracker = new RoomBoundaryTracker()
    const creation = create({ [CONFIDENTIAL_MARKER]: algorithms[0] })
    for (const encryption of [
      undefined,
      create({ algorithm: algorithms[1] }),
      create({ algorithm: algorithms[0], body: 'plaintext' }),
      create({ algorithm: algorithms[0] }, '@other:example.test'),
    ]) {
      expect(tracker.observe('room', creation, encryption, agent)).toBe('invalid')
    }
    expect(
      tracker.observe(
        'room',
        create(creation.content, '@other:example.test'),
        create({ algorithm: algorithms[0] }),
        agent
      )
    ).toBe('invalid')
  })

  it('never downgrades a previously marked room to ordinary after marker removal', () => {
    const tracker = new RoomBoundaryTracker()
    tracker.observe(
      'room',
      create({ [CONFIDENTIAL_MARKER]: algorithms[0] }),
      create({ algorithm: algorithms[0] }),
      agent
    )
    expect(tracker.observe('room', create({}), undefined, agent)).toBe('invalid')
    expect(tracker.observe('room', undefined, undefined, agent)).toBe('invalid')
    expect(tracker.observe('another-room', create({}), undefined, agent)).toBe('ordinary')
  })

  it('quarantines encryption without an immutable marker including a later state removal', () => {
    const tracker = new RoomBoundaryTracker()
    expect(tracker.observe('room', create({}), create({ algorithm: algorithms[0] }), agent)).toBe(
      'invalid'
    )
    expect(tracker.observe('room', create({}), undefined, agent)).toBe('invalid')
  })

  it('waits for creation state and distinguishes ordinary workspace and public Community transport', () => {
    const tracker = new RoomBoundaryTracker()
    expect(tracker.observe('room', undefined, undefined, agent)).toBe('unknown')
    expect(permitsPlaintext('unknown')).toBe(false)
    expect(tracker.observe('room', create({}), undefined, agent)).toBe('ordinary')
    expect(tracker.observe('community', create({}), undefined, agent, true)).toBe('community')
    expect(permitsPlaintext('ordinary')).toBe(true)
    expect(permitsPlaintext('community')).toBe(true)
  })
})
