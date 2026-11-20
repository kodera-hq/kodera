import { describe, expect, it } from 'vitest'
import {
  directMap,
  directPeople,
  directRooms,
  existingDirect,
  isMatrixRoomId,
  withDirect,
} from './directs'

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

  it('accepts room version 12 opaque room ids, which carry no server name', () => {
    const V12 = '!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM'
    expect(isMatrixRoomId(V12)).toBe(true)
    expect(isMatrixRoomId('!a:kodera.test')).toBe(true)
    expect(isMatrixRoomId('!')).toBe(false)
    expect(isMatrixRoomId('!has space')).toBe(false)
    expect(isMatrixRoomId('!a:')).toBe(false)
    expect(isMatrixRoomId('!a/b')).toBe(false)
    expect(isMatrixRoomId('!a..b')).toBe(false)
    expect(isMatrixRoomId('!a?query=1')).toBe(false)
    expect(isMatrixRoomId('!a#frag')).toBe(false)
    expect(isMatrixRoomId('!a\u202eb')).toBe(false)
    expect(isMatrixRoomId('!a:https://evil.test')).toBe(false)
    expect(isMatrixRoomId('!a:-bad.host')).toBe(false)
    expect(isMatrixRoomId(`!${'a'.repeat(255)}`)).toBe(false)
    expect(isMatrixRoomId('#alias:kodera.test')).toBe(false)
    expect(isMatrixRoomId(4)).toBe(false)
    const map = directMap({ [ALICE]: [V12, '!a:kodera.test', V12], [BOB]: ['!bad id'] })
    expect([...map]).toEqual([[ALICE, [V12, '!a:kodera.test']]])
    const rooms = directRooms(map)
    expect(existingDirect(rooms, [ALICE], (id) => id === V12)).toBe(V12)
    expect(withDirect(map, V12, [BOB])[BOB]).toEqual([V12])
  })

  it('guards withDirect against prototype keys and malformed room or user identifiers', () => {
    const poisoned = new Map<string, readonly string[]>([
      ['__proto__', ['!evil:kodera.test']],
      ['toString', ['!evil:kodera.test']],
      [ALICE, ['!a:kodera.test', '!bad/path']],
    ])
    const result = withDirect(poisoned, V12_SAFE, ['__proto__', 'toString', 'constructor', BOB])
    expect(result).toEqual({
      [ALICE]: ['!a:kodera.test'],
      [BOB]: [V12_SAFE],
    })
    expect(({} as Record<string, unknown>)['!evil:kodera.test']).toBeUndefined()
    expect(withDirect(directMap({ [ALICE]: ['!a:kodera.test'] }), '!bad/room', [BOB])).toEqual({
      [ALICE]: ['!a:kodera.test'],
    })
  })
})

const V12_SAFE = '!yQ3LoeaSVpUe_valid-v12'
