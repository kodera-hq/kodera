import { describe, expect, it, vi } from 'vitest'
import { createClaimAttempt } from './claimAttempt'
import type { ClaimAttemptContext, ClaimAttemptOutcome } from './claimAttempt'

const context: ClaimAttemptContext = {
  issuer: 'https://identity.example/realms/invited',
  subject: 'intended-owner',
  generation: 4,
  accessToken: 'current-in-memory-access',
  organisationId: '147a4b91-b9d4-44aa-976d-de45882ac0c1',
  organisationSlug: 'invited-org',
}
const body = { token: 'opaque-invitation-fragment' }
const response = (status: number, suffix?: string, retryAfterS?: number): ClaimAttemptOutcome => ({
  kind: 'response',
  status,
  ...(suffix === undefined
    ? {}
    : { problem: { type: `https://kodera.io/problems/${suffix}`, retryAfterS } }),
})
const create = (requestBody: { token: string; display_name?: string } = body) =>
  createClaimAttempt({ idempotencyKey: 'logical-consume-operation', body: requestBody, context })

describe('logical owner-claim attempt', () => {
  it('emits one immutable request only on explicit begin and waits for a fresh owner read after200', () => {
    const attempt = create()
    expect(attempt.snapshot()).toEqual({ status: 'ready' })
    expect(Object.isFrozen(attempt.snapshot())).toBe(true)
    const request = attempt.begin(context, 0)!
    expect(request).toEqual({ idempotencyKey: 'logical-consume-operation', body })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.body)).toBe(true)
    expect(attempt.begin(context, 1)).toBeUndefined()
    expect(attempt.settle({ ...request }, context, response(200), 2)).toBe(false)
    expect(attempt.settle(request, context, response(200), 3)).toBe(true)
    expect(attempt.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    expect(attempt.settle(request, context, response(200), 4)).toBe(false)
    expect(attempt.begin(context, 5)).toBeUndefined()
    const changed = { ...context, accessToken: 'renewed-after-success' }
    expect(attempt.begin(changed, NaN)).toBeUndefined()
    expect(attempt.settle(request, changed, response(200), NaN)).toBe(false)
    expect(attempt.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
  })

  it.each([undefined, '', 'Chosen display name'])(
    'preserves exact optional display_name %j during uncertain retry',
    (displayName) => {
      const input = {
        token: body.token,
        ...(displayName === undefined ? {} : { display_name: displayName }),
      }
      const attempt = create(input)
      const first = attempt.begin(context, 0)!
      input.token = 'caller-changed-token'
      input.display_name = 'caller-changed-name'
      expect(attempt.settle(first, context, { kind: 'network' }, 1)).toBe(true)
      expect(attempt.snapshot()).toEqual({ status: 'uncertain' })
      const retry = attempt.begin(context, 2)!
      expect(retry).not.toBe(first)
      expect(retry.body).toBe(first.body)
      expect(retry.idempotencyKey).toBe(first.idempotencyKey)
      expect(retry.body.token).toBe(body.token)
      expect(Object.hasOwn(retry.body, 'display_name')).toBe(displayName !== undefined)
      expect(retry.body.display_name).toBe(displayName)
      expect(attempt.settle(first, context, response(200), 3)).toBe(false)
      expect(attempt.snapshot()).toEqual({ status: 'sending' })
    }
  )

  it.each(['old', 'copied'])('a %s ticket cannot advance the live request clock', (kind) => {
    const attempt = create()
    const first = attempt.begin(context, 0)!
    attempt.settle(first, context, { kind: 'network' }, 1)
    const current = attempt.begin(context, 2)!
    const stale = kind === 'old' ? first : { ...current }
    expect(attempt.settle(stale, context, response(200), 100000)).toBe(false)
    expect(attempt.settle(current, context, response(200), 3)).toBe(true)
    expect(attempt.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
  })

  it('a rejected concurrent begin cannot advance the live request clock', () => {
    const attempt = create()
    const request = attempt.begin(context, 0)!
    expect(attempt.begin(context, 100000)).toBeUndefined()
    expect(attempt.settle(request, context, response(200), 1)).toBe(true)
  })

  it.each([
    [response(503, 'service-unavailable', 1), 1000],
    [response(409, 'idempotency-key-in-flight', 3), 3000],
  ] satisfies [ClaimAttemptOutcome, number][])(
    'honors explicit retry delay and refuses invalid/rollback time',
    (outcome, delay) => {
      const attempt = create()
      const first = attempt.begin(context, 0)!
      expect(attempt.settle(first, context, outcome, 10)).toBe(true)
      expect(attempt.snapshot()).toEqual({ status: 'waiting', retryAt: 10 + delay })
      expect(attempt.begin(context, 9 + delay)).toBeUndefined()
      for (const invalid of [0, -1, NaN, Infinity, 0.5, 1e20])
        expect(attempt.begin(context, invalid)).toBeUndefined()
      const retry = attempt.begin(context, 10 + delay)!
      expect(retry.body).toBe(first.body)
      expect(retry.idempotencyKey).toBe(first.idempotencyKey)
    }
  )

  it.each([NaN, Infinity, -1, 0.5, 1e20])(
    'refuses invalid initial clock %s without starting',
    (now) => {
      const attempt = create()
      expect(attempt.begin(context, now)).toBeUndefined()
      expect(attempt.snapshot()).toEqual({ status: 'ready' })
      expect(attempt.begin(context, 0)).toBeDefined()
    }
  )

  it.each([0, -1, 0.5, NaN, Infinity, 1e20])(
    'retires unsafe declared in-flight delay %s without immediate retry',
    (delay) => {
      const attempt = create()
      const request = attempt.begin(context, 0)!
      expect(
        attempt.settle(request, context, response(409, 'idempotency-key-in-flight', delay), 1)
      ).toBe(false)
      expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
      expect(attempt.begin(context, 1000)).toBeUndefined()
    }
  )

  it.each([
    response(503, 'service-unavailable', 1),
    response(409, 'idempotency-key-in-flight', Number.MAX_SAFE_INTEGER),
  ])(
    'retires a backoff with an unrepresentable deadline rather than dropping the wait',
    (outcome) => {
      const attempt = create()
      const request = attempt.begin(context, Number.MAX_SAFE_INTEGER)!
      expect(attempt.settle(request, context, outcome, Number.MAX_SAFE_INTEGER)).toBe(false)
      expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
      expect(attempt.begin(context, Number.MAX_SAFE_INTEGER)).toBeUndefined()
    }
  )

  it.each([
    response(503),
    response(503, 'upstream-unavailable', 1),
    response(503, 'service-unavailable'),
    response(503, 'service-unavailable', 0),
    response(503, 'service-unavailable', 2),
    response(503, 'service-unavailable', NaN),
    response(502, 'service-unavailable', 1),
    {
      kind: 'response',
      status: 503,
      problem: { type: 'https://other.example/problems/service-unavailable', retryAfterS: 1 },
    },
  ] satisfies ClaimAttemptOutcome[])(
    'keeps unrecognized response uncertain without claiming known contention',
    (outcome) => {
      const attempt = create()
      const request = attempt.begin(context, 0)!
      attempt.settle(request, context, outcome, 1)
      expect(attempt.snapshot()).toEqual({ status: 'uncertain' })
      expect(attempt.begin(context, 2)?.body).toBe(request.body)
    }
  )

  it.each([
    [403, 'mfa-required', 'refused'],
    [403, 'owner-claim-contact-unverified', 'refused'],
    [403, 'owner-claim-identity-mismatch', 'refused'],
    [409, 'idempotency-key-reuse', 'refused'],
    [409, 'owner-claim-consumed', 'terminal'],
    [410, 'owner-claim-expired', 'terminal'],
    [410, 'owner-claim-revoked', 'terminal'],
  ] as const)('never retries or grants access after%s/%s', (status, suffix, expected) => {
    const attempt = create()
    const request = attempt.begin(context, 0)!
    expect(attempt.settle(request, context, response(status, suffix), 1)).toBe(true)
    expect(attempt.snapshot()).toEqual({ status: expected })
    expect(attempt.begin(context, 100000)).toBeUndefined()
    expect(attempt.settle(request, context, response(200), 100001)).toBe(false)
  })

  const contextChanges = [
    { issuer: 'https://other.example' },
    { subject: 'other-person' },
    { generation: context.generation + 1 },
    { accessToken: 'new-in-memory-access' },
    { organisationId: 'af4b3801-ee7c-4918-a084-3a13621ca31b' },
    { organisationSlug: 'other-org' },
  ]
  it.each(contextChanges)(
    'retires on begin context change %j and fences outstanding response',
    (change) => {
      const attempt = create()
      const request = attempt.begin(context, 0)!
      expect(attempt.begin({ ...context, ...change }, 1)).toBeUndefined()
      expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
      expect(attempt.settle(request, context, response(200), 2)).toBe(false)
      expect(attempt.begin(context, 3)).toBeUndefined()
    }
  )
  it.each(contextChanges)('retires on settlement context change %j', (change) => {
    const attempt = create()
    const request = attempt.begin(context, 0)!
    expect(attempt.settle(request, { ...context, ...change }, response(200), 1)).toBe(false)
    expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
    expect(attempt.begin(context, 2)).toBeUndefined()
  })

  it('copies the initial context rather than accepting later caller mutation', () => {
    const input = { ...context }
    const attempt = createClaimAttempt({
      idempotencyKey: 'logical-operation',
      body,
      context: input,
    })
    input.subject = 'changed-after-construction'
    expect(attempt.begin(input, 0)).toBeUndefined()
    expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
  })

  it.each([
    ['begin', NaN],
    ['begin', 9],
    ['settle', NaN],
    ['settle', 9],
  ] as const)('retires changed authority before invalid-clock refusal on%s/%s', (method, now) => {
    const attempt = create()
    const request = attempt.begin(context, 10)!
    const changed = { ...context, accessToken: 'renewed-current-access' }
    if (method === 'begin') expect(attempt.begin(changed, now)).toBeUndefined()
    else expect(attempt.settle(request, changed, response(200), now)).toBe(false)
    expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
    expect(attempt.settle(request, context, response(200), 11)).toBe(false)
    expect(attempt.begin(context, 12)).toBeUndefined()
  })

  it.each([9, -1, NaN, Infinity, 0.5, 1e20])(
    'refuses invalid settlement time %s without consuming the ticket',
    (now) => {
      const attempt = create()
      const request = attempt.begin(context, 10)!
      expect(attempt.settle(request, context, response(200), now)).toBe(false)
      expect(attempt.snapshot()).toEqual({ status: 'sending' })
      expect(attempt.settle(request, context, response(200), 11)).toBe(true)
      expect(attempt.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    }
  )

  it.each([
    response(503, 'service-unavailable', 1),
    response(409, 'idempotency-key-in-flight', 1),
    response(200),
    response(403, 'mfa-required'),
    response(410, 'owner-claim-revoked'),
    { kind: 'network' } as const,
  ])('never schedules or sends while constructing, settling or reading any outcome', (outcome) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof globalThis.setTimeout>)
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof globalThis.setInterval>)
    try {
      const attempt = create()
      attempt.snapshot()
      const request = attempt.begin(context, 0)!
      expect(attempt.settle(request, context, outcome, 1)).toBe(true)
      attempt.snapshot()
      // Even explicit eligibility checks past the wait return only a description.
      attempt.begin(context, 1001)
      attempt.snapshot()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(timeoutSpy).not.toHaveBeenCalled()
      expect(intervalSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      timeoutSpy.mockRestore()
      intervalSpy.mockRestore()
    }
  })

  it('leaves lost or retired attempts unresolved without effects or secret-bearing public state', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    const timerSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof globalThis.setTimeout>)
    try {
      const attempt = create()
      const request = attempt.begin(context, 0)!
      attempt.settle(request, context, { kind: 'network' }, 1)
      attempt.retire()
      expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
      expect(attempt.begin(context, 100000)).toBeUndefined()
      expect(attempt.settle(request, context, response(200), 100001)).toBe(false)
      expect(JSON.stringify(attempt.snapshot())).not.toContain(body.token)
      expect(JSON.stringify(attempt.snapshot())).not.toContain(context.accessToken)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(timerSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      timerSpy.mockRestore()
    }
  })
})

import type { components } from '../../api/schema'

type NullableClaimBody = components['schemas']['OwnerClaimConsumeRequest']

const nullableBodies = [
  { label: 'omitted', body: { token: 'NO_LOG' }, json: '{"token":"NO_LOG"}' },
  {
    label: 'null',
    body: { token: 'NO_LOG', display_name: null },
    json: '{"token":"NO_LOG","display_name":null}',
  },
  {
    label: 'empty',
    body: { token: 'NO_LOG', display_name: '' },
    json: '{"token":"NO_LOG","display_name":""}',
  },
  {
    label: 'value',
    body: { token: 'NO_LOG', display_name: 'Chosen' },
    json: '{"token":"NO_LOG","display_name":"Chosen"}',
  },
] satisfies { label: string; body: NullableClaimBody; json: string }[]

it.each(nullableBodies)('keeps the exact nullable $label tuple on deliberate retry', (row) => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw Error('NULLABLE_UNEXPECTED_FETCH')
  })
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
    throw Error('NULLABLE_UNEXPECTED_TIMEOUT')
  })
  const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
    throw Error('NULLABLE_UNEXPECTED_INTERVAL')
  })
  try {
    const outcomes: { outcome: ClaimAttemptOutcome; retryAt: number }[] = [
      { outcome: { kind: 'network' }, retryAt: 2 },
      { outcome: response(503, 'service-unavailable', 1), retryAt: 1001 },
      { outcome: response(409, 'idempotency-key-in-flight', 3), retryAt: 3001 },
    ]
    for (const { outcome, retryAt } of outcomes) {
      const input: NullableClaimBody = { ...row.body }
      const attempt = createClaimAttempt({
        idempotencyKey: 'nullable-claim-intent',
        body: input,
        context,
      })
      expect(attempt.snapshot()).toEqual({ status: 'ready' })
      const first = attempt.begin(context, 0)
      expect(first).toBeDefined()
      if (first === undefined) throw Error('NULLABLE_FIRST_REQUEST')
      expect(JSON.stringify(first.body), 'NULLABLE_INITIAL_BYTES').toBe(row.json)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.body)).toBe(true)
      expect(attempt.begin(context, 1)).toBeUndefined()
      input.token = 'CALLER_CHANGED'
      input.display_name = 'Changed'
      expect(attempt.settle(first, context, outcome, 1)).toBe(true)
      expect(attempt.snapshot()).toEqual(
        outcome.kind === 'network' ? { status: 'uncertain' } : { status: 'waiting', retryAt }
      )
      if (outcome.kind === 'response') expect(attempt.begin(context, retryAt - 1)).toBeUndefined()
      const retry = attempt.begin(context, retryAt)
      expect(retry).toBeDefined()
      if (retry === undefined) throw Error('NULLABLE_RETRY_REQUEST')
      expect(JSON.stringify(retry.body), 'NULLABLE_RETRY_BYTES').toBe(row.json)
      expect(retry.body).toBe(first.body)
      expect(retry).not.toBe(first)
      expect(retry.idempotencyKey).toBe('nullable-claim-intent')
      expect(retry.idempotencyKey).toBe(first.idempotencyKey)
      expect(Object.hasOwn(retry.body, 'display_name')).toBe(row.label !== 'omitted')
      expect(retry.body.display_name).toBe(row.body.display_name)
      expect(attempt.settle(first, context, response(200), retryAt + 1)).toBe(false)
      expect(attempt.snapshot()).toEqual({ status: 'sending' })
      expect(attempt.settle(retry, context, response(200), retryAt + 1)).toBe(true)
      expect(attempt.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
      expect(attempt.begin(context, retryAt + 2)).toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(timeoutSpy).not.toHaveBeenCalled()
      expect(intervalSpy).not.toHaveBeenCalled()
      attempt.retire()
      expect(attempt.snapshot()).toEqual({ status: 'unresolved' })
    }
  } finally {
    fetchSpy.mockRestore()
    timeoutSpy.mockRestore()
    intervalSpy.mockRestore()
  }
})
