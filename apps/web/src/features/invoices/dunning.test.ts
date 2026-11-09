import { describe, expect, it } from 'vitest'
import {
  activeHoldUntil,
  classifyDunningSteps,
  displayedLadder,
  isPastDue,
  ladderSteps,
  overdueSinceDate,
  upcomingSuspensionDate,
} from './dunning'

describe('classifyDunningSteps', () => {
  it('tells the two reminder steps apart by order, not by days_overdue', () => {
    const classified = classifyDunningSteps([
      { state: 'past_due', due_at: '2027-01-01T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-01-08T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-01-22T00:00:00Z', done: false },
      { state: 'formal_notice', due_at: '2027-02-05T00:00:00Z', done: false },
      { state: 'suspension_notice', due_at: '2027-03-01T00:00:00Z', done: false },
      { state: 'suspended', due_at: '2027-03-08T00:00:00Z', done: false },
    ])

    expect(classified.map((step) => step.kind)).toEqual([
      'past-due',
      'reminder-1',
      'reminder-2',
      'formal-notice',
      'suspension-notice',
      'suspension',
    ])
  })

  it('classifies an unmapped state as other rather than throwing', () => {
    const classified = classifyDunningSteps([{ state: 'terminated', due_at: null, done: false }])
    expect(classified[0]?.kind).toBe('other')
  })
})

describe('overdueSinceDate', () => {
  it('reads the past_due step’s own due date', () => {
    const classified = classifyDunningSteps([
      { state: 'past_due', due_at: '2027-01-01T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-01-08T00:00:00Z', done: true },
    ])
    expect(overdueSinceDate(classified)).toBe('2027-01-01T00:00:00Z')
  })

  it('is undefined when the ladder carries no past_due step', () => {
    const classified = classifyDunningSteps([
      { state: 'notice', due_at: '2027-01-08T00:00:00Z', done: true },
    ])
    expect(overdueSinceDate(classified)).toBeUndefined()
  })
})

describe('ladderSteps', () => {
  it('drops the past_due step, since the header line already states it', () => {
    const classified = classifyDunningSteps([
      { state: 'past_due', due_at: '2027-01-01T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-01-08T00:00:00Z', done: true },
      { state: 'formal_notice', due_at: '2027-02-05T00:00:00Z', done: false },
    ])
    expect(ladderSteps(classified).map((step) => step.kind)).toEqual([
      'reminder-1',
      'formal-notice',
    ])
  })
})

// Ruling E: a dispute holds the ladder; a hold or a suspension date that has
// passed is never shown as one to come.
describe('dates that are still ahead', () => {
  const NOW = Date.parse('2027-04-20T09:00:00Z')

  it('treats a hold as active only while its date is ahead', () => {
    expect(activeHoldUntil('2027-05-01T00:00:00Z', NOW)).toBe('2027-05-01T00:00:00Z')
    expect(activeHoldUntil('2027-04-01T00:00:00Z', NOW)).toBeUndefined()
    expect(activeHoldUntil(null, NOW)).toBeUndefined()
  })

  it('names a suspension date only when the step is not done and still ahead', () => {
    const at = (due_at: string, done = false) =>
      classifyDunningSteps([{ state: 'suspended', due_at, done }])
    expect(upcomingSuspensionDate(at('2027-06-06T00:00:00Z'), NOW)).toBe('2027-06-06T00:00:00Z')
    expect(upcomingSuspensionDate(at('2027-04-10T00:00:00Z'), NOW)).toBeUndefined()
    expect(upcomingSuspensionDate(at('2027-06-06T00:00:00Z', true), NOW)).toBeUndefined()
  })

  it('pauses every step not done while a dispute is open, and none otherwise', () => {
    const steps = classifyDunningSteps([
      { state: 'past_due', due_at: '2027-03-31T23:59:59Z', done: true },
      { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
      { state: 'formal_notice', due_at: '2027-05-05T00:00:00Z', done: false },
      { state: 'suspension_notice', due_at: '2027-05-30T00:00:00Z', done: false },
      { state: 'suspended', due_at: '2027-06-06T00:00:00Z', done: false },
    ])
    expect(displayedLadder(steps, true).map((step) => [step.kind, step.held])).toEqual([
      ['reminder-1', false],
      ['formal-notice', true],
      ['suspension-notice', true],
      ['suspension', true],
    ])
    expect(displayedLadder(steps, false).every((step) => !step.held)).toBe(true)
  })

  it('calls a step past due only when it is not done and its date has gone', () => {
    const [done, past, ahead] = classifyDunningSteps([
      { state: 'notice', due_at: '2027-04-07T00:00:00Z', done: true },
      { state: 'notice', due_at: '2027-04-14T00:00:00Z', done: false },
      { state: 'formal_notice', due_at: '2027-05-05T00:00:00Z', done: false },
    ])
    expect(isPastDue(done!, NOW)).toBe(false)
    expect(isPastDue(past!, NOW)).toBe(true)
    expect(isPastDue(ahead!, NOW)).toBe(false)
  })
})
