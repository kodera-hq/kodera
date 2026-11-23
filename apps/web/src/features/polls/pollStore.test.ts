import { afterEach, expect, it, vi } from 'vitest'
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

it.each([
  ['A', 'B'],
  ['C', 'D'],
])('keeps a repeated question separate from an older poll (%s, %s)', (a, b) => {
  const older = { ...message({}), poll: { ...message({}).poll!, anonymous: false } }
  pollStore.derivePolls('r', [older], '')
  const local = pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: 'Creator',
    createdAt: 1,
    payload: { ...older.poll, options: [a, b] },
  })
  pollStore.vote(local, local.options[0]!.id, 'alice')
  pollStore.close(local)
  const sink = { sendEvent: vi.fn().mockResolvedValue(undefined) }
  const pending = pollStore.derivePolls('r', [older], '', { sink })
  expect(pending).toHaveLength(2)
  expect(pending.find((poll) => poll.id === older.eventId)).toMatchObject({ closed: false })
  expect(sink.sendEvent).not.toHaveBeenCalled()
  const echo = { ...older, eventId: '$second', poll: { ...older.poll, options: [a, b] } }
  const synced = pollStore.derivePolls('r', [older, echo], '', { sink })
  expect(synced).toHaveLength(2)
  expect(synced.find((poll) => poll.id === '$second')).toMatchObject({ closed: true })
  expect(sink.sendEvent.mock.calls.map((call) => call[2].pollId)).toEqual(['$second', '$second'])
  // Re-reading the same echo cannot claim another optimistic poll.
  pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: 'Creator',
    payload: echo.poll,
  })
  expect(pollStore.derivePolls('r', [older, echo], '')).toHaveLength(3)
})

it('reconciles identical optimistic polls in FIFO order and matches the full option tuple', () => {
  const payload = { ...message({}).poll!, anonymous: false }
  const first = pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: '',
    createdAt: 1,
    payload,
  })
  const second = pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: '',
    createdAt: 1,
    payload,
  })
  pollStore.close(first)
  const different = {
    ...message({}),
    eventId: '$different',
    poll: { ...payload, options: ['B', 'A'] },
  }
  expect(pollStore.derivePolls('r', [different], '')).toHaveLength(3)
  const echo = { ...message({}), poll: payload }
  const polls = pollStore.derivePolls('r', [different, echo], '')
  expect(polls.find((poll) => poll.id === '$poll')?.closed).toBe(true)
  expect(polls.find((poll) => poll.id === second.id)?.closed).toBe(false)
})

it('refuses unseen paginated historical polls when correlated by clientPollId or timestamp', () => {
  const payload = { ...message({}).poll!, anonymous: false }
  const local = pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: 'Creator',
    createdAt: 5_000,
    requireClientPollId: true,
    payload,
  })
  pollStore.vote(local, local.options[0]!.id, 'alice')
  pollStore.close(local)
  const sink = { sendEvent: vi.fn().mockResolvedValue(undefined) }

  // Backfilled unseen historical poll (even with matching sender/question/options and no clientPollId,
  // or a spoofed wrong clientPollId) must NEVER claim the pending optimistic poll!
  const paginatedHistorical: TimelinePollMessage = {
    eventId: '$old-backfilled',
    sender: '@creator',
    ts: 1_000,
    redacted: false,
    poll: payload,
  }
  const wrongCorrelation: TimelinePollMessage = {
    eventId: '$other-poll',
    sender: '@creator',
    ts: 6_000,
    redacted: false,
    poll: { ...payload, clientPollId: 'local-poll-other' },
  }
  const beforeEcho = pollStore.derivePolls('r', [paginatedHistorical, wrongCorrelation], '', { sink })
  expect(beforeEcho).toHaveLength(3)
  expect(beforeEcho.find((p) => p.id === '$old-backfilled')?.closed).toBe(false)
  expect(sink.sendEvent).not.toHaveBeenCalled()

  // Actual server echo carrying `clientPollId: local.id` claims the optimistic poll cleanly!
  const realEcho: TimelinePollMessage = {
    eventId: '$new-echo',
    sender: '@creator',
    ts: 5_100,
    redacted: false,
    poll: pollPayloadOf({ [POLL_FIELD]: { ...payload, clientPollId: local.id } }),
  }
  const afterEcho = pollStore.derivePolls(
    'r',
    [paginatedHistorical, wrongCorrelation, realEcho],
    '',
    { sink }
  )
  expect(afterEcho).toHaveLength(3)
  expect(afterEcho.find((p) => p.id === '$new-echo')?.closed).toBe(true)
  expect(sink.sendEvent.mock.calls.map((call) => call[2].pollId)).toEqual(['$new-echo', '$new-echo'])

  // Also verify the timestamp fallback directly on an uncorrelated local poll (`requireClientPollId` omitted):
  pollStore.clearAll()
  const uncorrelated = pollStore.recordLocalPoll({
    roomId: 'r',
    createdBy: '@creator',
    createdByName: 'Creator',
    createdAt: 10_000,
    payload,
  })
  pollStore.vote(uncorrelated, uncorrelated.options[1]!.id, 'bob')
  pollStore.close(uncorrelated)
  const sink2 = { sendEvent: vi.fn().mockResolvedValue(undefined) }

  const olderUnseen: TimelinePollMessage = {
    eventId: '$older-unseen',
    sender: '@creator',
    ts: 9_999,
    redacted: false,
    poll: payload,
  }
  const withOlder = pollStore.derivePolls('r', [olderUnseen], '', { sink: sink2 })
  expect(withOlder).toHaveLength(2)
  expect(withOlder.find((p) => p.id === '$older-unseen')?.closed).toBe(false)
  expect(sink2.sendEvent).not.toHaveBeenCalled()

  const newerEcho: TimelinePollMessage = {
    eventId: '$newer-echo',
    sender: '@creator',
    ts: 10_000,
    redacted: false,
    poll: payload,
  }
  const withNewer = pollStore.derivePolls('r', [olderUnseen, newerEcho], '', { sink: sink2 })
  expect(withNewer).toHaveLength(2)
  expect(withNewer.find((p) => p.id === '$newer-echo')?.closed).toBe(true)
  expect(sink2.sendEvent.mock.calls.map((call) => call[2].pollId)).toEqual([
    '$newer-echo',
    '$newer-echo',
  ])
})
