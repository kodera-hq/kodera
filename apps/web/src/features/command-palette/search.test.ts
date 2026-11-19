import { describe, expect, it } from 'vitest'
import { fuzzyEntries } from './search'
const entries = (...labels: string[]) =>
  labels.map((label) => ({ id: label, label, kind: 'text' as const }))
describe('command ranking', () => {
  it('ranks an accent-folded prefix ahead of word boundaries and infixes', () => {
    expect(
      fuzzyEntries(entries('urgence générale', 'agenda gen', 'général', 'agent'), 'gen')[0]?.label
    ).toBe('général')
  })
  it('rewards word boundaries and compact subsequences', () => {
    expect(fuzzyEntries(entries('agent', 'équipe gen'), 'gen')[0]?.label).toBe('équipe gen')
    expect(fuzzyEntries(entries('g---e---n', 'g-en'), 'gen')[0]?.label).toBe('g-en')
  })
  it('keeps ties stable, ignores category matches and treats punctuation literally', () => {
    const list = entries('alpha', 'alpha', 'a[b')
    expect(fuzzyEntries(list, '')).toEqual(list)
    expect(fuzzyEntries(list, '[')).toEqual([list[2]])
    expect(
      fuzzyEntries([{ id: '1', label: 'alpha', kind: 'text', category: 'general' }], 'gen')
    ).toEqual([])
  })
})
