import { afterEach, expect, it } from 'vitest'
import { createChannelPoll, parsePollCommand, pollPayloadOf, POLL_FIELD } from './pollState'
import { pollStore, type TimelinePollMessage } from './pollStore'

afterEach(() => pollStore.clearAll())
const message = (responses: Record<string, number[]>): TimelinePollMessage => ({
  eventId: '$poll',
  sender: '@creator',
  ts: 1,
  redacted: false,
  poll: { question: 'Lunch?', options: ['A', 'B'], allowMultiple: false, anonymous: true },
  pollResponses: responses,
})
it('refuses anonymous commands and normalizes untrusted Matrix polls', () => {
  for (const command of ['/poll "Lunch?" "A" "B" --anonymous', '/poll Lunch? --anon\nA\nB']) {
    expect(parsePollCommand(command, 'en')).toMatchObject({
      ok: false,
      error: expect.stringContaining('sender'),
    })
  }
  expect(pollPayloadOf({ [POLL_FIELD]: message({}).poll })?.anonymous).toBe(false)
  expect(
    createChannelPoll({
      id: 'p',
      roomId: 'r',
      question: 'Q',
      options: ['A', 'B'],
      createdBy: 'u',
      createdByName: 'U',
      anonymous: true,
    }).anonymous
  ).toBe(false)
})
it('overrides only the pending voter and retires the override after the echo', () => {
  const initial = pollStore.derivePolls('r', [message({ alice: [0], bob: [1] })], '')[0]!
  pollStore.vote(initial, initial.options[1]!.id, 'alice')
  const pending = pollStore.derivePolls('r', [message({ alice: [0], bob: [] })], '')[0]!
  expect(pending.options.map((o) => o.voterIds)).toEqual([[], ['alice']])
  pollStore.derivePolls('r', [message({ alice: [1] })], '')
  const withdrawn = pollStore.derivePolls('r', [message({ alice: [] })], '')[0]!
  expect(withdrawn.options.map((o) => o.voterIds)).toEqual([[], []])
})
