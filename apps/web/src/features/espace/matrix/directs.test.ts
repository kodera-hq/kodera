import { describe, expect, it } from 'vitest'
import { directMap, directPeople, directRooms, existingDirect, withDirect } from './directs'

const ME = '@me:kodera.test'
const ALICE = '@alice:kodera.test'
const BOB = '@bob:kodera.test'

describe('direct conversations', () => {
  it('reads m.direct, dropping what is not a user id or a room id', () => {
    const map = directMap({
      [ALICE]: ['!a:kodera.test', '!a:kodera.test', 'not-a-room', 4],
      [BOB]: ['!g:kodera.test'],
      'not a user': ['!x:kodera.test'],
      '@carol:kodera.test': 'x',
    })
    expect([...map]).toEqual([
      [ALICE, ['!a:kodera.test']],
      [BOB, ['!g:kodera.test']],
    ])
    expect(directMap(null).size).toBe(0)
    expect(directMap(['x']).size).toBe(0)
  })

  it('lists a group conversation once, under all its people', () => {
    const rooms = directRooms(
      directMap({ [BOB]: ['!g:kodera.test'], [ALICE]: ['!g:kodera.test', '!a:kodera.test'] })
    )
    expect(rooms.get('!g:kodera.test')).toEqual([ALICE, BOB])
    expect(rooms.get('!a:kodera.test')).toEqual([ALICE])
  })

  it('finds the joined room already held with exactly those people', () => {
    const rooms = directRooms(
      directMap({ [ALICE]: ['!a:kodera.test', '!g:kodera.test'], [BOB]: ['!g:kodera.test'] })
    )
    expect(existingDirect(rooms, [ALICE], () => true)).toBe('!a:kodera.test')
    expect(existingDirect(rooms, [ALICE, BOB], () => true)).toBe('!g:kodera.test')
    expect(existingDirect(rooms, [ALICE], () => false)).toBeUndefined()
  })

  it('starts a conversation with one to eight valid others, never with oneself alone', () => {
    expect(directPeople([` ${BOB}`, ALICE, ALICE, ME], ME)).toEqual([ALICE, BOB])
    expect(() => directPeople([ME], ME)).toThrow()
    expect(() => directPeople(['alice'], ME)).toThrow('Invalid Matrix user ID')
    expect(() =>
      directPeople(
        Array.from({ length: 9 }, (_, n) => `@p${n}:kodera.test`),
        ME
      )
    ).toThrow()
  })

  it('writes the next map without losing the others', () => {
    const map = directMap({ [ALICE]: ['!a:kodera.test'] })
    expect(withDirect(map, '!g:kodera.test', [ALICE, BOB])).toEqual({
      [ALICE]: ['!a:kodera.test', '!g:kodera.test'],
      [BOB]: ['!g:kodera.test'],
    })
  })
})
