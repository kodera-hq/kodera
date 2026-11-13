import { describe, expect, it } from 'vitest'
import type { MessageView } from './matrix/timeline'
import { excerptOf, foldForSearch, MAX_RESULTS, queryTerms, searchMessages } from './searchMatching'

function message(index: number, body: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    key: `$m${index}`,
    eventId: `$m${index}`,
    sender: '@alice:matrix.acme.kodera.test',
    senderName: 'Alice Martin',
    body,
    ts: index,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...overrides,
  }
}

describe('message search', () => {
  it('folds case, accents and spaces', () => {
    expect(foldForSearch('  Élève   ÇA  va ')).toBe(' eleve ca va ')
    expect(queryTerms('Élève  café')).toEqual(['eleve', 'cafe'])
  })

  it('searches nothing for a query shorter than two characters', () => {
    const timeline = [message(1, 'a b c')]
    expect(searchMessages(timeline, 'a').messages).toEqual([])
    expect(searchMessages(timeline, '  ').messages).toEqual([])
  })

  it('finds a message holding every word, whatever their case and accents, newest first', () => {
    const timeline = [
      message(1, 'Réunion du café demain'),
      message(2, 'le cafe est prêt'),
      message(3, 'reunion annulée'),
      message(4, 'CAFÉ et réunion à 10 h'),
    ]
    expect(searchMessages(timeline, 'cafe reunion').messages.map((m) => m.key)).toEqual([
      '$m4',
      '$m1',
    ])
  })

  it("finds a message by its author's name", () => {
    const timeline = [message(1, 'bonjour'), message(2, 'salut', { senderName: 'Bruno' })]
    expect(searchMessages(timeline, 'martin').messages.map((m) => m.key)).toEqual(['$m1'])
  })

  it('never finds a deleted message', () => {
    const timeline = [message(1, 'secret', { redacted: true })]
    expect(searchMessages(timeline, 'secret').messages).toEqual([])
  })

  it('lists at most fifty results and says when there are more', () => {
    const timeline = Array.from({ length: 80 }, (_, index) => message(index, `match ${index}`))
    const result = searchMessages(timeline, 'match')
    expect(result.messages).toHaveLength(MAX_RESULTS)
    expect(result.more).toBe(true)
    expect(result.messages[0]!.key).toBe('$m79')
    expect(searchMessages(timeline.slice(0, 10), 'match').more).toBe(false)
  })

  it('searches ten thousand messages well within a frame once folded', () => {
    const timeline = Array.from({ length: 10_000 }, (_, index) =>
      message(index, `message numéro ${index} à propos de choses diverses`)
    )
    searchMessages(timeline, 'warm up')
    const started = performance.now()
    searchMessages(timeline, 'propos 9999')
    expect(performance.now() - started).toBeLessThan(16)
  })

  it('cuts a long message on a word', () => {
    expect(excerptOf('short')).toBe('short')
    const long = 'word '.repeat(60)
    const excerpt = excerptOf(long, 40)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(41)
    expect(excerpt).not.toMatch(/wor…$/)
  })
})
