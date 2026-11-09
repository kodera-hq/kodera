import { describe, expect, it } from 'vitest'
import { MENTION_LIMIT, insertMention, matchingMembers, mentionAt, mentionedIn } from './mentions'

const ALICE = { userId: '@henri.duflot:kodera.test', label: 'Henri Duflot' }
const ALICE_SHORT = { userId: '@henri:kodera.test', label: 'Henri' }
const ELODIE = { userId: '@e.roux:kodera.test', label: 'Élodie Roux' }

describe('the mention typed at the caret', () => {
  it('starts at an « @ » at the start or after a space, and runs to the caret', () => {
    expect(mentionAt('@al', 3)).toEqual({ start: 0, query: 'al' })
    expect(mentionAt('Salut @al et', 9)).toEqual({ start: 6, query: 'al' })
    expect(mentionAt('Salut @', 7)).toEqual({ start: 6, query: '' })
  })

  it('is none inside a word, after a space typed past it, or with the caret before it', () => {
    expect(mentionAt('mail@al', 7)).toBeNull()
    expect(mentionAt('@al ', 4)).toBeNull()
    expect(mentionAt('x @al', 1)).toBeNull()
    expect(mentionAt('@a@b', 4)).toBeNull()
  })
})

describe('the members offered', () => {
  it('match by the start of any word of the name, or of the id, without case or accents', () => {
    const members = [ALICE, ELODIE]
    expect(matchingMembers(members, 'duf')).toEqual([ALICE])
    expect(matchingMembers(members, 'ELO')).toEqual([ELODIE])
    expect(matchingMembers(members, 'e.r')).toEqual([ELODIE])
    expect(matchingMembers(members, 'lot')).toEqual([])
    expect(matchingMembers(members, '')).toEqual(members)
  })

  it(`are at most ${MENTION_LIMIT}`, () => {
    const many = Array.from({ length: MENTION_LIMIT + 2 }, (_, i) => ({
      userId: `@m${i}:kodera.test`,
      label: `Membre ${i}`,
    }))
    expect(matchingMembers(many, 'mem')).toHaveLength(MENTION_LIMIT)
  })
})

describe('choosing a member', () => {
  it('replaces the typed word with « @Name » and a space, keeping what follows', () => {
    expect(insertMention('Salut @al', { start: 6 }, 9, 'Henri Duflot')).toEqual({
      text: 'Salut @Henri Duflot ',
      caret: 20,
    })
    expect(insertMention('@al et toi', { start: 0 }, 3, 'Henri Duflot')).toEqual({
      text: '@Henri Duflot et toi',
      caret: 14,
    })
  })
})

describe('the members a text names', () => {
  it('are those written in full after an « @ », ended by the end, a space or punctuation', () => {
    const members = [ALICE, ELODIE]
    expect(mentionedIn('@Henri Duflot', members)).toEqual([ALICE.userId])
    expect(mentionedIn('Merci @Élodie Roux, et @Henri Duflot !', members)).toEqual([
      ELODIE.userId,
      ALICE.userId,
    ])
    expect(mentionedIn('@Henri Duflote', members)).toEqual([])
    expect(mentionedIn('mail@Henri Duflot', members)).toEqual([])
    expect(mentionedIn('Henri Duflot', members)).toEqual([])
  })

  it('takes the longest name at each « @ », and names a member once', () => {
    const members = [ALICE_SHORT, ALICE]
    expect(mentionedIn('@Henri Duflot', members)).toEqual([ALICE.userId])
    expect(mentionedIn('@Henri, @Henri', members)).toEqual([ALICE_SHORT.userId])
  })
})
