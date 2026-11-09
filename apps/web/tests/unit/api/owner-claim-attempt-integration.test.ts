// Controlled interoperability only: the explicit driver below is not a mounted claim flow.
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProblem, NetworkError, coreApi, setTokenProvider } from '@/api/client'
import { mutate } from '@/api/mutations'
import type { components } from '@/api/schema'
import type { AuthAdapter, AuthSessionSnapshot } from '@/auth/AuthAdapter'
import { createClaimAttempt } from '@/features/owner-claim/claimAttempt'
import type {
  ClaimAttemptContext,
  ClaimAttemptOutcome,
  ClaimAttemptRequest,
} from '@/features/owner-claim/claimAttempt'
import {
  createFreshOrderContextReader,
  OrderOwnershipUnavailable,
} from '@/features/order/freshOwner'
import { EXAMPLES } from '@/mocks/generated/examples'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { server } from '@/mocks/server'

const BASE = 'https://core.claim-integration.test/api/v1'
const KEY = '00000000-0000-4000-8000-000000000052'
const ORG = '147a4b91-b9d4-44aa-976d-de45882ac0c1'
const MEMBERSHIP = '147a4b91-b9d4-44aa-976d-de45882ac0c2'
const IDENTITY = '147a4b91-b9d4-44aa-976d-de45882ac0c3'
const ISSUER = 'https://identity.example/realms/invited-org'
const BODY = { token: 'synthetic-opaque-invitation' }
const problemType = (suffix: string) => `https://kodera.io/problems/${suffix}`
type Me = components['schemas']['Me']
type Attempt = ReturnType<typeof createClaimAttempt>

interface WireRequest {
  method: string
  key: string | null
  body: string
  bearer: string | null
  contentType: string | null
  signal: AbortSignal
}

let wire: WireRequest[] = []
let unexpected: string[] = []
const auditRequest = ({ request }: { request: Request }) => {
  const url = new URL(request.url)
  if (
    url.origin !== 'https://core.claim-integration.test' ||
    url.search ||
    url.hash ||
    !(
      (request.method === 'POST' && url.pathname === '/api/v1/owner-claims/actions/consume') ||
      (request.method === 'GET' && url.pathname === '/api/v1/me')
    )
  )
    unexpected.push('unexpected Core request')
}
const auditUnhandled = () => {
  unexpected.push('unhandled request')
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
  server.events.on('request:start', auditRequest)
  server.events.on('request:unhandled', auditUnhandled)
})
beforeEach(() => {
  wire = []
  unexpected = []
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(() => undefined)
})
afterEach(() => {
  const effects = [...unexpected]
  server.resetHandlers()
  resetIdempotencyStore()
  setTokenProvider(() => undefined)
  vi.unstubAllEnvs()
  // Outside the client: wrapped NetworkError must not hide an unexpected effect.
  expect(effects).toEqual([])
})
afterAll(() => {
  server.events.removeListener('request:start', auditRequest)
  server.events.removeListener('request:unhandled', auditUnhandled)
  server.close()
})

async function capture(request: Request) {
  wire.push({
    method: request.method,
    key: request.headers.get('Idempotency-Key'),
    body: request.method === 'POST' ? await request.clone().text() : '',
    bearer: request.headers.get('Authorization'),
    contentType: request.headers.get('Content-Type'),
    signal: request.signal,
  })
}
function consume(reply: () => Response | Promise<Response>) {
  server.use(
    http.post(`${BASE}/owner-claims/actions/consume`, async ({ request }) => {
      await capture(request)
      return reply()
    })
  )
}
function readMe(reply: () => Response | Promise<Response>) {
  server.use(
    http.get(`${BASE}/me`, async ({ request }) => {
      await capture(request)
      return reply()
    })
  )
}
function acceptedResponse() {
  // Reuse the complete generated response shape; it is still only a fixture.
  const result = structuredClone(
    EXAMPLES['consumeOwnerClaim']!.body
  ) as components['schemas']['OwnerClaimResult']
  result.organisation.id = ORG
  result.organisation.slug = 'invited-org'
  result.organisation.name = 'Synthetic organisation'
  result.organisation.realm = 'invited-org'
  result.membership.id = MEMBERSHIP
  result.membership.organisation_id = ORG
  result.membership.identity_id = IDENTITY
  result.membership.person_id = me().id
  result.membership.email = 'person@example.test'
  return HttpResponse.json(result)
}
function refusal(suffix: string, status: number, delay?: number | string) {
  return HttpResponse.json(
    {
      type: problemType(suffix),
      title: 'Synthetic refusal',
      status,
      ...(delay === undefined ? {} : { retry_after_s: delay }),
      request_id: '00000000-0000-4000-8000-000000000051',
    },
    { status }
  )
}
function me(): Me {
  return {
    id: '147a4b91-b9d4-44aa-976d-de45882ac0c4',
    email: 'person@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: IDENTITY,
        issuer: ISSUER,
        subject: 'subject',
        realm: 'invited-org',
        email: 'person@example.test',
      },
    ],
    organisations: [
      {
        organisation: { id: ORG, slug: 'invited-org', name: 'Synthetic organisation' },
        membership_id: MEMBERSHIP,
        identity_id: IDENTITY,
        state: 'active',
        role: 'org_owner',
      },
    ],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let accessToken = 'synthetic-current-access'
  let session: AuthSessionSnapshot = {
    status: 'ready',
    generation: 4,
    credentialGeneration: 1,
    user: {
      realm: 'invited-org',
      identity: { issuer: ISSUER, subject: 'subject' },
    },
  }
  const listeners = new Set<() => void>()
  const adapter: Pick<AuthAdapter, 'getSnapshot' | 'getAccessToken' | 'subscribe'> = {
    getSnapshot: () => session,
    getAccessToken: () => accessToken,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  // Existing API-test fixture wiring, never a second production token-provider installation.
  setTokenProvider(() => adapter.getAccessToken())
  const current = (): ClaimAttemptContext => ({
    issuer: session.user!.identity!.issuer,
    subject: session.user!.identity!.subject,
    generation: session.generation,
    accessToken: adapter.getAccessToken()!,
    organisationId: ORG,
    organisationSlug: 'invited-org',
  })
  const attempt = (body: { token: string; display_name?: string } = BODY) =>
    createClaimAttempt({ idempotencyKey: KEY, body, context: current() })
  const sendRequest = (ticket: ClaimAttemptRequest) =>
    mutate(
      { method: 'post', path: '/owner-claims/actions/consume' },
      { params: { header: { 'Idempotency-Key': ticket.idempotencyKey } }, body: ticket.body }
    )
  // One explicit dispatch only: no retry loop, key generation, navigation or grant.
  const dispatch = async (owner: Attempt, now: number, settledAt: number) => {
    const ticket = owner.begin(current(), now)
    expect(ticket).toBeDefined()
    if (ticket === undefined) throw new Error('No explicit consume ticket')
    try {
      const result = await sendRequest(ticket)
      return {
        ticket,
        result,
        error: undefined,
        accepted: owner.settle(ticket, current(), { kind: 'response', status: 200 }, settledAt),
      }
    } catch (error) {
      let outcome: ClaimAttemptOutcome
      if (error instanceof ApiProblem)
        outcome = {
          kind: 'response',
          status: error.status,
          problem: { type: error.type, retryAfterS: error.retryAfterS },
        }
      else if (error instanceof NetworkError) outcome = { kind: 'network' }
      else throw error
      return {
        ticket,
        result: undefined,
        error,
        accepted: owner.settle(ticket, current(), outcome, settledAt),
      }
    }
  }
  const reader = createFreshOrderContextReader(
    adapter,
    async (signal) => (await coreApi().GET('/me', { signal })).data
  )
  return {
    attempt,
    current,
    dispatch,
    read: (signal = new AbortController().signal) =>
      reader({ organisationSlug: 'invited-org', signal }),
    replace(change: (previous: AuthSessionSnapshot) => AuthSessionSnapshot) {
      session = change(session)
      for (const listener of listeners) listener()
    },
    rotateToken(token: string) {
      accessToken = token
      session = { ...session, credentialGeneration: session.credentialGeneration + 1 }
      for (const listener of listeners) listener()
    },
  }
}

describe('controlled owner-claim HTTP interoperability without an authority grant', () => {
  it('sends only an explicit immutable tuple through mutate and exposes a bad caller missing its key', async () => {
    const f = fixture()
    const owner = f.attempt()
    owner.snapshot()
    expect(wire).toEqual([])
    consume(acceptedResponse)
    await f.dispatch(owner, 0, 1)
    expect(wire).toHaveLength(1)
    expect(wire[0]).toMatchObject({
      key: KEY,
      body: JSON.stringify(BODY),
      bearer: 'Bearer synthetic-current-access',
      contentType: 'application/json',
    })
    // Controlled negative caller, not an existing production bug: middleware supplies another key.
    await mutate({ method: 'post', path: '/owner-claims/actions/consume' }, { body: BODY })
    expect(wire[1]!.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(wire[1]!.key).not.toBe(KEY)
  })

  it('maps a real typed503 body to a bounded wait without automatic resend', async () => {
    const f = fixture()
    const owner = f.attempt()
    consume(() => refusal('service-unavailable', 503, 1))
    const result = await f.dispatch(owner, 0, 10)
    expect(result.error).toBeInstanceOf(ApiProblem)
    expect(result.error).toMatchObject({
      type: problemType('service-unavailable'),
      status: 503,
      retryAfterS: 1,
    })
    expect(owner.snapshot()).toEqual({ status: 'waiting', retryAt: 1010 })
    expect(owner.begin(f.current(), 1009)).toBeUndefined()
    expect(wire).toHaveLength(1)
  })

  it('preserves raw key/body bytes on a later deliberate retry', async () => {
    const f = fixture()
    const owner = f.attempt()
    consume(() => refusal('service-unavailable', 503, 1))
    await f.dispatch(owner, 0, 10)
    expect(owner.begin(f.current(), 1009)).toBeUndefined()
    consume(acceptedResponse)
    expect((await f.dispatch(owner, 1010, 1011)).accepted).toBe(true)
    expect(wire).toHaveLength(2)
    expect(wire[1]!.key).toBe(wire[0]!.key)
    expect(wire[1]!.body).toBe(wire[0]!.body)
  })

  it.each([undefined, '', 'Synthetic name'])(
    'preserves optional display_name presence/value %j over network uncertainty',
    async (displayName) => {
      const f = fixture()
      const body = {
        token: BODY.token,
        ...(displayName === undefined ? {} : { display_name: displayName }),
      }
      const owner = f.attempt(body)
      consume(() => HttpResponse.error())
      await f.dispatch(owner, 0, 1)
      consume(acceptedResponse)
      await f.dispatch(owner, 2, 3)
      expect(wire).toHaveLength(2)
      expect(
        wire.every((request) => request.body === JSON.stringify(body) && request.key === KEY)
      ).toBe(true)
    }
  )

  it('keeps actual NetworkError distinct from a known problem and reuses the same operation', async () => {
    const f = fixture()
    const owner = f.attempt()
    consume(() => HttpResponse.error())
    const first = await f.dispatch(owner, 0, 1)
    expect(first.error).toBeInstanceOf(NetworkError)
    expect(first.error).not.toBeInstanceOf(ApiProblem)
    expect(owner.snapshot()).toEqual({ status: 'uncertain' })
    consume(acceptedResponse)
    await f.dispatch(owner, 2, 3)
    expect(wire[1]!.key).toBe(wire[0]!.key)
  })

  it.each([
    [403, 'mfa-required', 'refused'],
    [403, 'owner-claim-contact-unverified', 'refused'],
    [403, 'owner-claim-identity-mismatch', 'refused'],
    [409, 'idempotency-key-reuse', 'refused'],
    [409, 'owner-claim-consumed', 'terminal'],
    [410, 'owner-claim-expired', 'terminal'],
    [410, 'owner-claim-revoked', 'terminal'],
  ] as const)('keeps actual%s/%s final for this attempt', async (status, suffix, expected) => {
    const f = fixture()
    const owner = f.attempt()
    consume(() => refusal(suffix, status))
    expect((await f.dispatch(owner, 0, 1)).error).toBeInstanceOf(ApiProblem)
    expect(owner.snapshot()).toEqual({ status: expected })
    expect(owner.begin(f.current(), 10000)).toBeUndefined()
    expect(wire).toHaveLength(1)
  })

  it('composes accepted consume with explicit fresh GET and keeps missing/failed reads unresolved without another POST', async () => {
    const f = fixture()
    const owner = f.attempt()
    const reached = deferred<void>()
    const answer = deferred<Response>()
    consume(() => {
      reached.resolve()
      return answer.promise
    })
    const pending = f.dispatch(owner, 0, 2)
    await reached.promise
    expect(owner.begin(f.current(), 1)).toBeUndefined()
    expect(wire).toHaveLength(1)
    answer.resolve(acceptedResponse())
    expect((await pending).accepted).toBe(true)
    expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    // Explicit test driver only, not a mounted production handoff.
    readMe(() => HttpResponse.json(me()))
    expect((await f.read()).owner.organisationId).toBe(ORG)
    expect(wire.map((request) => request.method)).toEqual(['POST', 'GET'])
    const missing = me()
    missing.organisations = []
    readMe(() => HttpResponse.json(missing))
    await expect(f.read()).rejects.toBeInstanceOf(OrderOwnershipUnavailable)
    readMe(() => refusal('service-unavailable', 503, 1))
    await expect(f.read()).rejects.toBeInstanceOf(ApiProblem)
    expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    expect(wire.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('fences old tickets and an actual delayed200 after the current token changes', async () => {
    const f = fixture()
    const owner = f.attempt()
    consume(() => HttpResponse.error())
    const first = await f.dispatch(owner, 0, 1)
    const current = owner.begin(f.current(), 2)!
    expect(owner.settle(first.ticket, f.current(), { kind: 'response', status: 200 }, 100000)).toBe(
      false
    )
    expect(owner.settle(current, f.current(), { kind: 'response', status: 200 }, 3)).toBe(true)
    expect(owner.settle(current, f.current(), { kind: 'response', status: 200 }, 4)).toBe(false)
    const replacement = f.attempt()
    const reached = deferred<void>()
    const answer = deferred<Response>()
    consume(() => {
      reached.resolve()
      return answer.promise
    })
    const pending = f.dispatch(replacement, 5, 6)
    await reached.promise
    f.rotateToken('synthetic-new-access')
    answer.resolve(acceptedResponse())
    expect((await pending).accepted).toBe(false)
    expect(replacement.snapshot()).toEqual({ status: 'unresolved' })
    expect(wire).toHaveLength(2)
    expect(wire.every((request) => request.method === 'POST')).toBe(true)
  })

  it('requests real GET/me every time instead of reusing a previous successful membership', async () => {
    const f = fixture()
    readMe(() => HttpResponse.json(me()))
    expect((await f.read()).owner.organisationId).toBe(ORG)
    const removed = me()
    removed.organisations[0]!.state = 'removed'
    readMe(() => HttpResponse.json(removed))
    await expect(f.read()).rejects.toBeInstanceOf(OrderOwnershipUnavailable)
    expect(wire.map((request) => request.method)).toEqual(['GET', 'GET'])
  })

  it('rejects mismatched identities but characterizes the existing reader role/UUID limits without granting access', async () => {
    const f = fixture()
    for (const mismatch of ['issuer', 'subject', 'duplicate', 'identity-id']) {
      const invalid = me()
      if (mismatch === 'issuer') invalid.identities[0]!.issuer = 'https://other.example/realm'
      if (mismatch === 'subject') invalid.identities[0]!.subject = 'other-subject'
      if (mismatch === 'duplicate') invalid.identities.push({ ...invalid.identities[0]! })
      if (mismatch === 'identity-id')
        invalid.organisations[0]!.identity_id = '147a4b91-b9d4-44aa-976d-de45882ac0c9'
      readMe(() => HttpResponse.json(invalid))
      await expect(f.read()).rejects.toBeInstanceOf(OrderOwnershipUnavailable)
    }
    const neutral = me()
    neutral.organisations[0]!.role = 'org_member'
    neutral.organisations[0]!.organisation.id = '147a4b91-b9d4-44aa-976d-de45882ac0c8'
    readMe(() => HttpResponse.json(neutral))
    const observed = await f.read()
    expect(observed.membership.role).toBe('org_member')
    expect(observed.owner.organisationId).not.toBe(ORG)
    expect(observed.me.identities[0]).not.toHaveProperty('mfa_enrolled')
  })

  it.each(['token', 'generation', 'caller-abort', 'identity'] as const)(
    'rejects deferred real read after%s ends its context',
    async (mode) => {
      const f = fixture()
      const reached = deferred<void>()
      const answer = deferred<Response>()
      const controller = new AbortController()
      readMe(() => {
        reached.resolve()
        return answer.promise
      })
      const pending = f.read(controller.signal).then(
        () => undefined,
        (error: unknown) => error
      )
      await reached.promise
      if (mode === 'token') f.rotateToken('synthetic-renewed-access')
      if (mode === 'generation')
        f.replace((session) => ({ ...session, generation: session.generation + 1 }))
      if (mode === 'caller-abort') controller.abort()
      if (mode === 'identity')
        f.replace((session) => ({
          ...session,
          user: {
            ...session.user!,
            identity: { ...session.user!.identity!, subject: 'changed-subject' },
          },
        }))
      answer.resolve(HttpResponse.json(me()))
      const error = await pending
      expect(error).toBeDefined()
      expect(
        error instanceof NetworkError ||
          error instanceof OrderOwnershipUnavailable ||
          (error instanceof Error && error.name === 'AbortError')
      ).toBe(true)
      if (mode !== 'identity') expect(wire[0]!.signal.aborted).toBe(true)
    }
  )

  it('does not relabel unknown503 or malformed body delay as known contention', async () => {
    const f = fixture()
    for (const [type, delay] of [
      ['https://unknown.example/problem', 1],
      [problemType('service-unavailable'), '1'],
      [problemType('service-unavailable'), undefined],
    ] as const) {
      const owner = f.attempt()
      consume(() =>
        HttpResponse.json(
          {
            type,
            title: 'Unknown refusal',
            status: 503,
            ...(delay === undefined ? {} : { retry_after_s: delay }),
          },
          { status: 503 }
        )
      )
      const result = await f.dispatch(owner, 0, 1)
      expect(result.error).toBeInstanceOf(ApiProblem)
      expect(owner.snapshot()).toEqual({ status: 'uncertain' })
      if (typeof delay !== 'number') expect(result.error).toMatchObject({ retryAfterS: undefined })
    }
  })
})

import { dispatchOwnerClaim as dispatchNativeAttempt } from '@/api/client'
import type { operations as NativeAttemptOperations } from '@/api/schema'

type NativeAttemptResult =
  NativeAttemptOperations['consumeOwnerClaim']['responses'][200]['content']['application/json']
type NativeAttemptSource = Parameters<typeof dispatchNativeAttempt>[0]
type NativeAttemptBorrow = Exclude<ReturnType<NativeAttemptSource['borrow']>, undefined>

async function dispatchNativeTicket(
  existing: ReturnType<typeof fixture>,
  owner: Attempt,
  now: number,
  settledAt: number
) {
  const context = existing.current()
  const ticket = owner.begin(context, now)
  expect(ticket, 'A_INTEROP_EXPLICIT_TICKET').toBeDefined()
  if (ticket === undefined) throw Error('A_INTEROP_TICKET')
  const controller = new AbortController()
  const loan: NativeAttemptBorrow = {
    idempotencyKey: ticket.idempotencyKey,
    body: ticket.body,
    expectedAccessToken: context.accessToken,
    signal: controller.signal,
  }
  let releases = 0
  const source: NativeAttemptSource = {
    isCurrent: () => {
      const current = existing.current()
      return (
        owner.snapshot().status === 'sending' &&
        current.issuer === context.issuer &&
        current.subject === context.subject &&
        current.generation === context.generation &&
        current.accessToken === context.accessToken &&
        current.organisationId === context.organisationId &&
        current.organisationSlug === context.organisationSlug
      )
    },
    borrow: () => loan,
    releaseBorrow: (returned) => {
      expect(returned, 'A_INTEROP_ACTUAL_LOAN').toBe(loan)
      releases++
      try {
        expect(returned.body).toBe(ticket.body)
      } finally {
        returned.idempotencyKey = undefined
        returned.body = undefined
        returned.expectedAccessToken = undefined
        returned.signal = undefined
      }
    },
  }
  let work: Extract<ReturnType<typeof dispatchNativeAttempt>, { kind: 'started' }> | undefined
  let observed:
    Promise<{ ok: true; value: NativeAttemptResult } | { ok: false; error: unknown }> | undefined
  let primaryFailed = false
  let primary: unknown
  let result: NativeAttemptResult | undefined
  let error: unknown
  let accepted = false
  try {
    const dispatched = dispatchNativeAttempt(source)
    expect(dispatched.kind, 'A_INTEROP_ACTUAL_START').toBe('started')
    if (dispatched.kind !== 'started') throw Error('A_INTEROP_START')
    work = dispatched
    observed = work.result.then(
      (value) => ({ ok: true as const, value }),
      (failure: unknown) => ({ ok: false as const, error: failure })
    )
    expect((work as typeof work & { then?: unknown }).then).toBeUndefined()
    const outcome = await observed
    if (outcome.ok) {
      result = outcome.value
      accepted = owner.settle(
        ticket,
        existing.current(),
        { kind: 'response', status: 200 },
        settledAt
      )
    } else {
      error = outcome.error
      let attemptOutcome: ClaimAttemptOutcome
      if (error instanceof ApiProblem)
        attemptOutcome = {
          kind: 'response',
          status: error.status,
          problem: { type: error.type, retryAfterS: error.retryAfterS },
        }
      else if (error instanceof NetworkError) attemptOutcome = { kind: 'network' }
      else throw error
      accepted = owner.settle(ticket, existing.current(), attemptOutcome, settledAt)
    }
  } catch (failure) {
    primaryFailed = true
    primary = failure
  }
  const cleanup: unknown[] = []
  const finalize = async (operation: () => void | Promise<void>) => {
    try {
      await operation()
    } catch (failure) {
      cleanup.push(failure)
    }
  }
  await finalize(() => work?.retire())
  await finalize(() => controller.abort())
  await finalize(async () => {
    await observed
  })
  await finalize(() => {
    expect(releases, 'A_INTEROP_RELEASE_ONCE').toBe(1)
    expect(loan).toEqual({
      idempotencyKey: undefined,
      body: undefined,
      expectedAccessToken: undefined,
      signal: undefined,
    })
    expect(ticket.idempotencyKey).toBe(KEY)
  })
  if (cleanup.length !== 0)
    throw new AggregateError(primaryFailed ? [primary, ...cleanup] : cleanup, 'A_INTEROP_CLEANUP')
  if (primaryFailed) throw primary
  return { ticket, result, error, accepted }
}

describe('unused native dispatch with the existing explicit claim attempt', () => {
  it('A13 honors declared503 waiting without automatic resend and retries the original tuple explicitly', async () => {
    const existing = fixture()
    const owner = existing.attempt()
    consume(() => refusal('service-unavailable', 503, 1))
    const first = await dispatchNativeTicket(existing, owner, 0, 10)
    expect(wire.length).toBe(1)
    expect(first.error).toBeInstanceOf(ApiProblem)
    expect(first.accepted).toBe(true)
    expect(owner.snapshot()).toEqual({ status: 'waiting', retryAt: 1010 })
    expect(owner.begin(existing.current(), 1009)).toBeUndefined()
    await Promise.resolve()
    expect(wire.length).toBe(1)
    consume(acceptedResponse)
    const second = await dispatchNativeTicket(existing, owner, 1010, 1011)
    expect(wire.length).toBe(2)
    expect(second.result).toBeDefined()
    expect(second.accepted).toBe(true)
    expect(second.ticket.idempotencyKey).toBe(first.ticket.idempotencyKey)
    expect(second.ticket.body).toBe(first.ticket.body)
    expect(wire.map((request) => ({ key: request.key, body: request.body }))).toEqual([
      { key: KEY, body: JSON.stringify(BODY) },
      { key: KEY, body: JSON.stringify(BODY) },
    ])
    expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
  })

  it.each([
    ['omitted', { token: 'NO_LOG' }],
    ['empty', { token: 'NO_LOG', display_name: '' }],
    ['value', { token: 'NO_LOG', display_name: 'Synthetic' }],
  ] as const)(
    'A14 keeps %s original presence across transport uncertainty and explicit retry',
    async (_label, body) => {
      const existing = fixture()
      const owner = existing.attempt(body)
      consume(() => HttpResponse.error())
      const first = await dispatchNativeTicket(existing, owner, 0, 1)
      expect(wire.length).toBe(1)
      expect(first.error).toBeInstanceOf(NetworkError)
      expect((first.error as Error).cause).toBeUndefined()
      expect(first.accepted).toBe(true)
      expect(owner.snapshot()).toEqual({ status: 'uncertain' })
      await Promise.resolve()
      expect(wire.length).toBe(1)
      consume(acceptedResponse)
      const second = await dispatchNativeTicket(existing, owner, 2, 3)
      expect(wire.length).toBe(2)
      expect(second.accepted).toBe(true)
      expect(second.ticket.idempotencyKey).toBe(first.ticket.idempotencyKey)
      expect(second.ticket.body).toBe(first.ticket.body)
      expect(wire.map((request) => ({ key: request.key, body: request.body }))).toEqual([
        { key: KEY, body: JSON.stringify(body) },
        { key: KEY, body: JSON.stringify(body) },
      ])
      expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    }
  )

  it('A15 requires a separate explicit fresh me read after native consume200', async () => {
    const existing = fixture()
    const owner = existing.attempt()
    consume(acceptedResponse)
    const consumed = await dispatchNativeTicket(existing, owner, 0, 1)
    expect(wire.map((request) => request.method)).toEqual(['POST'])
    expect(consumed.result).toBeDefined()
    expect(consumed.accepted).toBe(true)
    expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
    expect(owner.begin(existing.current(), 2)).toBeUndefined()
    readMe(() => HttpResponse.json(me()))
    const fresh = await existing.read()
    expect(wire.map((request) => request.method)).toEqual(['POST', 'GET'])
    expect(wire[1]!.body).toBe('')
    expect(fresh.owner).toEqual({
      issuer: ISSUER,
      subject: 'subject',
      organisationId: ORG,
      membershipId: MEMBERSHIP,
      identityId: IDENTITY,
      generation: existing.current().generation,
    })
    expect(owner.snapshot()).toEqual({ status: 'success-awaiting-owner-read' })
  })
})
