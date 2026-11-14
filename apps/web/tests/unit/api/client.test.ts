// What the client adds on top of the generated types, against the generated mocks.
//
// Each of these is silent when it breaks: a request that forgets the bearer token
// looks like a permissions bug, a POST that forgets its idempotency key only shows up
// as a duplicate order in production, and a non-2xx returned instead of thrown means
// every caller has to remember to check — and one of them will not.

import { http } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProblem, NetworkError, coreApi, lastRequestId, setTokenProvider } from '@/api/client'
import { concurrencyToken, mutate } from '@/api/mutations'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { problem } from '@/mocks/problem'
import { server } from '@/mocks/server'

/** The example value `contracts/core-api.openapi.yaml` gives `ETag` and `If-Match`. */
const AN_ETAG = '"000000000000000000000000000000000000000000000000000000000000e7a9"'

const BASE = 'https://core.test/api/v1'

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' })
})
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(() => undefined)
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
})
afterAll(() => {
  server.close()
})

/** A body `POST /organisations` accepts: the staff intake, with the recorded instruction and
 * the person who will claim first ownership, both required by the contract. */
function newOrganisationBody() {
  return {
    slug: 'acme-sa',
    name: 'ACME',
    legal_name: 'ACME SAS',
    country: 'FR',
    locale: 'fr' as const,
    instruction_ref: 'SUP-0418',
    intended_owner: { email: 'jeanne@acme.fr' },
  }
}

/** Records the request the handler saw, so the assertions can read its headers. */
function capture(method: 'get' | 'post', path: string): { seen: Request | undefined } {
  const box: { seen: Request | undefined } = { seen: undefined }
  server.use(
    http[method](`*${path}`, ({ request }) => {
      box.seen = request.clone()
      return undefined
    })
  )
  return box
}

describe('the configured base URL', () => {
  it('names the missing variable rather than requesting an undefined host', () => {
    vi.stubEnv('VITE_CORE_API_URL', '')
    expect(() => coreApi()).toThrow(/VITE_CORE_API_URL/)
  })
})

describe('authorisation', () => {
  it('sends the token the provider holds, and nothing when there is none', async () => {
    const anonymous = capture('get', '/api/v1/me')
    await coreApi().GET('/me')
    expect(anonymous.seen?.headers.get('Authorization')).toBeNull()

    setTokenProvider(() => 'a-short-lived-token')
    const authorised = capture('get', '/api/v1/me')
    await coreApi().GET('/me')
    expect(authorised.seen?.headers.get('Authorization')).toBe('Bearer a-short-lived-token')
  })
})

describe('idempotency', () => {
  it('puts a key on every POST, so nobody has to remember one', async () => {
    const box = capture('post', '/api/v1/organisations')
    await mutate({ method: 'post', path: '/organisations' }, { body: newOrganisationBody() })
    expect(box.seen?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps a key the caller supplied, so a deliberate retry stays one intent', async () => {
    const box = capture('post', '/api/v1/organisations')
    await mutate(
      { method: 'post', path: '/organisations' },
      {
        params: { header: { 'Idempotency-Key': 'the-callers-own-key' } },
        body: newOrganisationBody(),
      }
    )
    expect(box.seen?.headers.get('Idempotency-Key')).toBe('the-callers-own-key')
  })
})

describe('the request id', () => {
  it('is captured from the response, so support can be given one', async () => {
    await coreApi().GET('/me')
    const first = lastRequestId()
    expect(first).toBeTruthy()
    await coreApi().GET('/organisations')
    expect(lastRequestId()).not.toBe(first)
  })
})

describe('failures', () => {
  it('raises a non-2xx as ApiProblem, with the registry type and the request id', async () => {
    server.use(
      http.get(`*/api/v1/organisations/:organisation_id`, () =>
        problem('https://kodera.io/problems/forbidden', {
          detail: 'Staff-facing prose no customer reads.',
        })
      )
    )
    const failure = await coreApi()
      .GET('/organisations/{organisation_id}', {
        params: { path: { organisation_id: 'fixture-id' } },
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiProblem)
    const raised = failure as ApiProblem
    expect(raised.type).toBe('https://kodera.io/problems/forbidden')
    expect(raised.status).toBe(403)
    expect(raised.requestId).toBe(lastRequestId())
    expect(raised.detail).toBe('Staff-facing prose no customer reads.')
  })

  it('carries the field errors a validation failure reports', async () => {
    server.use(
      http.post(`*/api/v1/organisations`, () =>
        problem('https://kodera.io/problems/malformed-request', {
          errors: [{ pointer: '/name', code: 'required' }],
        })
      )
    )
    const failure = (await mutate(
      { method: 'post', path: '/organisations' },
      { body: { ...newOrganisationBody(), name: '', legal_name: '' } }
    ).catch((error: unknown) => error)) as ApiProblem

    expect(failure.errors).toEqual([{ pointer: '/name', code: 'required' }])
  })

  it('leaves `type` null rather than inventing one the registry does not contain', async () => {
    // An edge or a proxy answering something that is not a problem document. Mapping it
    // to a registered type would make the console render a message for a condition the
    // API never reported.
    server.use(http.get(`*/api/v1/me`, () => new Response('<html>502</html>', { status: 502 })))
    const failure = (await coreApi()
      .GET('/me')
      .catch((error: unknown) => error)) as ApiProblem

    expect(failure).toBeInstanceOf(ApiProblem)
    expect(failure.type).toBeNull()
    expect(failure.status).toBe(502)
  })

  it('reads identity-unknown on `/me` as its registered type, a 403 (contract 0.28.0)', async () => {
    server.use(
      http.get(`*/api/v1/me`, () => problem('https://kodera.io/problems/identity-unknown'))
    )
    const failure = (await coreApi()
      .GET('/me')
      .catch((error: unknown) => error)) as ApiProblem

    expect(failure).toBeInstanceOf(ApiProblem)
    expect(failure.type).toBe('https://kodera.io/problems/identity-unknown')
    expect(failure.status).toBe(403)
  })

  it('leaves a 403 naming an unregistered type null, so it reads as no known refusal', async () => {
    server.use(
      http.get(
        `*/api/v1/me`,
        () =>
          new Response(
            JSON.stringify({
              type: 'https://kodera.io/problems/not-in-the-registry',
              title: 'Unregistered',
              status: 403,
            }),
            { status: 403, headers: { 'Content-Type': 'application/problem+json' } }
          )
      )
    )
    const failure = (await coreApi()
      .GET('/me')
      .catch((error: unknown) => error)) as ApiProblem

    expect(failure).toBeInstanceOf(ApiProblem)
    expect(failure.type).toBeNull()
    expect(failure.status).toBe(403)
  })

  it('raises an unreachable API as NetworkError, not as a problem', async () => {
    server.use(http.get(`*/api/v1/me`, () => Response.error()))
    const failure = await coreApi()
      .GET('/me')
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NetworkError)
    expect(failure).not.toBeInstanceOf(ApiProblem)
  })

  it('carries current_etag on a stale PATCH (412), so the caller can re-read against it', async () => {
    server.use(
      http.patch(`*/api/v1/me`, () =>
        problem('https://kodera.io/problems/precondition-failed', { currentEtag: AN_ETAG })
      )
    )
    const failure = (await mutate(
      { method: 'patch', path: '/me' },
      { body: { locale: 'fr' }, concurrency: 'a-stale-tag' }
    ).catch((error: unknown) => error)) as ApiProblem

    expect(failure.type).toBe('https://kodera.io/problems/precondition-failed')
    expect(failure.status).toBe(412)
    expect(failure.currentEtag).toBe(AN_ETAG)
  })

  it('carries the free names Core offers on slug-taken, and none on any other problem', async () => {
    server.use(
      http.post(`*/api/v1/organisations/:id/tenants`, () =>
        problem('https://kodera.io/problems/slug-taken', {
          suggestions: ['acme-fr', 'acme-2', 'acme-lab'],
        })
      ),
      http.patch(`*/api/v1/me`, () =>
        problem('https://kodera.io/problems/precondition-failed', { currentEtag: AN_ETAG })
      )
    )
    const taken = (await mutate(
      { method: 'post', path: '/organisations/{organisation_id}/tenants' },
      {
        params: { path: { organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f' } },
        body: {
          name: 'Acme',
          slug: 'acme',
          locale: 'fr',
          legal_acceptances: [
            { code: 'cgv', version: '1', locale: 'fr' },
            { code: 'dpa', version: '1', locale: 'fr' },
          ],
        },
      }
    ).catch((error: unknown) => error)) as ApiProblem
    expect(taken.status).toBe(409)
    expect(taken.suggestions).toEqual(['acme-fr', 'acme-2', 'acme-lab'])

    const stale = (await mutate(
      { method: 'patch', path: '/me' },
      { body: { locale: 'fr' }, concurrency: 'a-stale-tag' }
    ).catch((error: unknown) => error)) as ApiProblem
    expect(stale.suggestions).toEqual([])
  })

  it('leaves currentEtag undefined on precondition-required (428), which carries no tag', async () => {
    server.use(
      http.patch(`*/api/v1/me`, () =>
        problem('https://kodera.io/problems/precondition-required')
      )
    )
    const failure = (await mutate(
      { method: 'patch', path: '/me' },
      { body: { locale: 'fr' }, concurrency: AN_ETAG }
    ).catch((error: unknown) => error)) as ApiProblem

    expect(failure.status).toBe(428)
    expect(failure.currentEtag).toBeUndefined()
  })
})

describe('concurrencyToken', () => {
  it('reads the etag off whatever was last read, and nowhere else', () => {
    expect(concurrencyToken({ etag: AN_ETAG })).toBe(AN_ETAG)
  })
})

describe('mutate', () => {
  it('sends the merge-patch media type a PATCH declares', async () => {
    const box: { seen: Request | undefined } = { seen: undefined }
    server.use(
      http.patch(`*/api/v1/me`, ({ request }) => {
        box.seen = request.clone()
        return undefined
      })
    )
    await mutate({ method: 'patch', path: '/me' }, { body: { locale: 'fr' }, concurrency: AN_ETAG })
    expect(box.seen?.headers.get('Content-Type')).toBe('application/merge-patch+json')
  })

  it('sends no If-Match on a POST, since the contract declares the parameter only on PATCH', async () => {
    const box = capture('post', '/api/v1/organisations')
    await mutate({ method: 'post', path: '/organisations' }, { body: newOrganisationBody() })
    expect(box.seen?.headers.get('If-Match')).toBeNull()
  })

  it('sends the concurrency token as If-Match on a PATCH, every contract PATCH requires it', async () => {
    const box: { seen: Request | undefined } = { seen: undefined }
    server.use(
      http.patch(`*/api/v1/me`, ({ request }) => {
        box.seen = request.clone()
        return undefined
      })
    )
    await mutate({ method: 'patch', path: '/me' }, { body: { locale: 'fr' }, concurrency: AN_ETAG })
    expect(box.seen?.headers.get('If-Match')).toBe(AN_ETAG)
  })

  it('does not leak `concurrency` into the fetch init openapi-fetch receives', async () => {
    const box: { seen: Request | undefined } = { seen: undefined }
    server.use(
      http.patch(`*/api/v1/me`, ({ request }) => {
        box.seen = request.clone()
        return undefined
      })
    )
    await mutate({ method: 'patch', path: '/me' }, { body: { locale: 'fr' }, concurrency: AN_ETAG })
    // The only header carrying the token on the wire is `If-Match`; nothing named
    // `concurrency` reaches the request, whether as a header or as a query parameter.
    expect(box.seen?.url).not.toContain('concurrency')
    expect(box.seen?.headers.has('concurrency')).toBe(false)
  })

  it('is rejected against the real mock when If-Match is absent (428 precondition-required)', async () => {
    // No override here: the generated base handler for `patchMe` enforces the header
    // itself, the same way it enforces `Idempotency-Key` on a POST.
    const failure = await mutate(
      { method: 'patch', path: '/me' },
      // @ts-expect-error - concurrency is required for a PATCH; this drops straight to
      // the wire to prove the *mock* also refuses a request that skipped the type check.
      { body: { locale: 'fr' }, concurrency: undefined }
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiProblem)
    expect((failure as ApiProblem).type).toBe('https://kodera.io/problems/precondition-required')
    expect((failure as ApiProblem).status).toBe(428)
  })

  it('returns the response body, and raises a refusal', async () => {
    const body = await mutate(
      { method: 'patch', path: '/me' },
      { body: { locale: 'fr' }, concurrency: AN_ETAG }
    )
    expect(body).toHaveProperty('email')

    server.use(
      http.patch(`*/api/v1/me`, () => problem('https://kodera.io/problems/mfa-required'))
    )
    await expect(
      mutate({ method: 'patch', path: '/me' }, { body: { locale: 'fr' }, concurrency: AN_ETAG })
    ).rejects.toBeInstanceOf(ApiProblem)
  })
})

// Type-only proof that a PATCH cannot skip its concurrency token. If `concurrency` ever
// became optional again, the call below would compile, and `npm run typecheck` would
// report the directive as unused instead of catching the regression — the same
// provably-breakable shape as every self-test in this repository (docs/dev/TESTING.md).
function _typeOnlyPatchRequiresConcurrency(): void {
  // @ts-expect-error - PATCH requires `concurrency`
  void mutate({ method: 'patch', path: '/me' }, { body: { locale: 'fr' } })
}

import { readFileSync as readNativeSource } from 'node:fs'
import { join as nativeJoin } from 'node:path'
import { runInNewContext as runNativeModule } from 'node:vm'
import * as nativeCompiler from 'typescript'
import nativeCreateClient from 'openapi-fetch'
import * as nativeImported from '@/api/client'
import { coreApiUrl as nativeCoreUrl } from '@/config'
import * as nativeProblems from '@/api/generated/problems'
import type { operations as NativeOperations } from '@/api/schema'
import { EXAMPLES as NATIVE_EXAMPLES } from '@/mocks/generated/examples'

type NativeConsume = NativeOperations['consumeOwnerClaim']
type NativeBody = NativeConsume['requestBody']['content']['application/json']
type NativeKey = NativeConsume['parameters']['header']['Idempotency-Key']
type NativeResult = NativeConsume['responses'][200]['content']['application/json']
type NativeSource = Parameters<typeof nativeImported.dispatchOwnerClaim>[0]
type NativeBorrow = Exclude<ReturnType<NativeSource['borrow']>, undefined>
type NativeWork = Extract<ReturnType<typeof nativeImported.dispatchOwnerClaim>, { kind: 'started' }>
type NativeApi = Pick<
  typeof nativeImported,
  'dispatchOwnerClaim' | 'setTokenProvider' | 'lastRequestId' | 'createOwnerClaimObservation'
>
type NativeOutcome<Value> = { ok: true; value: Value } | { ok: false; error: unknown }
const NATIVE_KEY: NativeKey = '00000000-0000-4000-8000-000000000071'
const NATIVE_ACCESS = 'NO_LOG'
const NATIVE_BODY: NativeBody = { token: 'NO_LOG' }
const NATIVE_SUFFIX = '/owner-claims/actions/consume'
const NATIVE_GUARD =
  /if\s*\(\s*!isCurrent\(\)\s*\|\|\s*cell\.retired\s*\|\|\s*cell\.expectedAccessToken\s*!==\s*observedToken\s*\)\s*return\s+undefined\b/
const nativeClientSource = readNativeSource(
  nativeJoin(import.meta.dirname, '..', '..', '..', 'src', 'api', 'client.ts'),
  'utf8'
)

function nativeDeferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  let settled = false
  const promise = new Promise<Value>((done, fail) => {
    resolve = (value) => {
      if (settled) throw Error('A_FIXTURE_DOUBLE_SETTLEMENT')
      settled = true
      done(value)
    }
    reject = (reason) => {
      if (settled) throw Error('A_FIXTURE_DOUBLE_SETTLEMENT')
      settled = true
      fail(reason)
    }
  })
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled
    },
  }
}

function nativeObserve<Value>(promise: Promise<Value>): Promise<NativeOutcome<Value>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
}

function nativeResult(): NativeResult {
  return structuredClone(NATIVE_EXAMPLES['consumeOwnerClaim']!.body) as NativeResult
}

interface NativeCall {
  url: string
  init: RequestInit
  headers: Record<string, string>
  wire: {
    method: string | undefined
    body: BodyInit | null | undefined
    headers: Record<string, string>
  }
}
function nativePlainData(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor !== undefined && 'value' in descriptor
  })
}
interface NativeFixture {
  source: NativeSource
  loan: NativeBorrow
  original: { key: NativeKey; body: NativeBody; access: string }
  controller: AbortController
  calls: NativeCall[]
  works: NativeWork[]
  outcomes: Promise<NativeOutcome<NativeResult>>[]
  listeners: Set<EventListenerOrEventListenerObject>
  answer: ReturnType<typeof nativeDeferred<Response>>
  parse: ReturnType<typeof nativeDeferred<NativeResult>>
  parsing: ReturnType<typeof nativeDeferred<void>>
  current: boolean
  observedToken: string | undefined
  borrows: number
  releases: number
  lockOwned: boolean
  invocationLocks: boolean[]
  releaseEffect: (() => void) | undefined
  getterEffect: (() => void) | undefined
  borrowFailure: { value: unknown } | undefined
  releaseFailure: { value: unknown } | undefined
  removeFailure: { value: unknown } | undefined
  nativeFailure: { value: unknown; synchronous: boolean } | undefined
  dispatch(): ReturnType<typeof nativeImported.dispatchOwnerClaim>
  start(): NativeWork
  drain(): Promise<void>
}

async function withNativeFixture<Value>(
  api: NativeApi,
  action: (fixture: NativeFixture) => Value | Promise<Value>
): Promise<Value> {
  const controller = new AbortController()
  const original = { key: NATIVE_KEY, body: { ...NATIVE_BODY }, access: NATIVE_ACCESS }
  const loan: NativeBorrow = {
    idempotencyKey: original.key,
    body: original.body,
    expectedAccessToken: NATIVE_ACCESS,
    signal: controller.signal,
  }
  const answer = nativeDeferred<Response>()
  const parse = nativeDeferred<NativeResult>()
  const parsing = nativeDeferred<void>()
  const answerOutcome = nativeObserve(answer.promise)
  const parseOutcome = nativeObserve(parse.promise)
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const unexpected: string[] = []
  const calls: NativeCall[] = []
  const works: NativeWork[] = []
  const outcomes: Promise<NativeOutcome<NativeResult>>[] = []
  const added = controller.signal.addEventListener.bind(controller.signal)
  const removed = controller.signal.removeEventListener.bind(controller.signal)
  const fixture: NativeFixture = {
    source: {
      isCurrent: () => fixture.current,
      borrow: () => {
        if (fixture.borrowFailure !== undefined) throw fixture.borrowFailure.value
        fixture.borrows++
        return loan
      },
      releaseBorrow: (returned) => {
        expect(returned, 'A_ACTUAL_LOAN').toBe(loan)
        fixture.releases++
        try {
          fixture.releaseEffect?.()
          if (fixture.releaseFailure !== undefined) throw fixture.releaseFailure.value
        } finally {
          returned.idempotencyKey = undefined
          returned.body = undefined
          returned.expectedAccessToken = undefined
          returned.signal = undefined
        }
      },
    },
    loan,
    original,
    controller,
    calls,
    works,
    outcomes,
    listeners,
    answer,
    parse,
    parsing,
    current: true,
    observedToken: NATIVE_ACCESS,
    borrows: 0,
    releases: 0,
    lockOwned: false,
    invocationLocks: [],
    releaseEffect: undefined,
    getterEffect: undefined,
    borrowFailure: undefined,
    releaseFailure: undefined,
    removeFailure: undefined,
    nativeFailure: undefined,
    dispatch: () => {
      const work = api.dispatchOwnerClaim(fixture.source)
      if (work.kind === 'started') {
        works.push(work)
        outcomes.push(nativeObserve(work.result))
      }
      return work
    },
    start: () => {
      const work = fixture.dispatch()
      expect(work.kind, 'A_VALID_START').toBe('started')
      if (work.kind !== 'started') throw Error('A_FIXTURE_START')
      return work
    },
    drain: async () => {
      await Promise.all(outcomes)
      await answerOutcome
      await parseOutcome
    },
  }
  const addSpy = vi
    .spyOn(controller.signal, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'abort' || listener === null) unexpected.push('unexpected-listener')
      else listeners.add(listener)
      added(type, listener, options)
    })
  const removeSpy = vi
    .spyOn(controller.signal, 'removeEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'abort' || listener === null || !listeners.delete(listener))
        unexpected.push('unowned-listener-removal')
      removed(type, listener, options)
      if (fixture.removeFailure !== undefined) {
        const failure = fixture.removeFailure
        fixture.removeFailure = undefined
        throw failure.value
      }
    })
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    fixture.invocationLocks.push(fixture.lockOwned)
    const url = typeof input === 'string' ? input : ''
    const headers = init?.headers
    if (
      (!url.startsWith('https://core.test/') && url !== 'https://core.test') ||
      init?.method !== 'POST' ||
      headers === undefined ||
      headers === null ||
      typeof headers !== 'object' ||
      Array.isArray(headers) ||
      headers instanceof Headers ||
      !nativePlainData(headers) ||
      !nativePlainData(init) ||
      !(init.signal instanceof AbortSignal)
    ) {
      unexpected.push('unexpected-native-shape')
      return Promise.reject(Error('A_FIXTURE_NATIVE_SHAPE'))
    }
    const observedInit: RequestInit = init
    const plain = headers as Record<string, string>
    calls.push({
      url,
      init,
      headers: plain,
      wire: { method: init.method, body: observedInit.body, headers: { ...plain } },
    })
    if (calls.length > 1) unexpected.push('unexpected-native-count')
    if (fixture.nativeFailure !== undefined) {
      if (fixture.nativeFailure.synchronous) throw fixture.nativeFailure.value
      return Promise.reject(fixture.nativeFailure.value)
    }
    return answer.promise
  })
  const logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {
      unexpected.push('console-log')
    }),
    vi.spyOn(console, 'debug').mockImplementation(() => {
      unexpected.push('console-debug')
    }),
    vi.spyOn(console, 'warn').mockImplementation(() => {
      unexpected.push('console-warn')
    }),
    vi.spyOn(console, 'error').mockImplementation(() => {
      unexpected.push('console-error')
    }),
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      unexpected.push('storage-write')
    }),
  ]
  api.setTokenProvider(() => {
    fixture.getterEffect?.()
    return fixture.observedToken
  })
  let failed = false
  let primary: unknown
  let value!: Value
  try {
    value = await action(fixture)
  } catch (error) {
    failed = true
    primary = error
  }
  const cleanup: unknown[] = []
  const finalize = async (operation: () => void | Promise<void>) => {
    try {
      await operation()
    } catch (error) {
      cleanup.push(error)
    }
  }
  await finalize(() => {
    for (const work of works) {
      try {
        work.retire()
      } catch (error) {
        cleanup.push(error)
      }
    }
  })
  await finalize(() => controller.abort())
  await finalize(() => {
    if (!answer.settled) answer.resolve(Response.json(nativeResult()))
  })
  await finalize(() => {
    if (!parse.settled) parse.resolve(nativeResult())
  })
  await finalize(() => {
    if (!parsing.settled) parsing.resolve(undefined)
  })
  await finalize(() => fixture.drain())
  await finalize(() => {
    expect([answer.settled, parse.settled, parsing.settled], 'A_UNSETTLED_LATCHES').toEqual([
      true,
      true,
      true,
    ])
    expect(listeners.size, 'A_UNSETTLED_LISTENERS').toBe(0)
    expect(fixture.releases, 'A_LOAN_RELEASES').toBe(fixture.borrows)
    expect(unexpected, 'A_UNEXPECTED_EFFECTS').toEqual([])
  })
  await finalize(() => api.setTokenProvider(() => undefined))
  await finalize(() => fetchSpy.mockRestore())
  await finalize(() => addSpy.mockRestore())
  await finalize(() => removeSpy.mockRestore())
  for (const spy of logSpies) await finalize(() => spy.mockRestore())
  if (cleanup.length !== 0)
    throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'A_FIXTURE_CLEANUP')
  if (failed) throw primary
  return value
}

function nativeStarted(
  work: ReturnType<typeof nativeImported.dispatchOwnerClaim>
): asserts work is NativeWork {
  expect(work.kind, 'A_VALID_START').toBe('started')
  if (work.kind !== 'started') throw Error('A_FIXTURE_START')
}
function nativeLoanGone(fixture: NativeFixture, body: NativeBody = NATIVE_BODY): void {
  expect(fixture.loan).toEqual({
    idempotencyKey: undefined,
    body: undefined,
    expectedAccessToken: undefined,
    signal: undefined,
  })
  expect(fixture.original).toEqual({ key: NATIVE_KEY, body, access: NATIVE_ACCESS })
}
function nativeFailure(outcome: NativeOutcome<unknown>): unknown {
  expect(outcome.ok, 'A_EXPECTED_REJECTION').toBe(false)
  if (outcome.ok) throw Error('A_FIXTURE_EXPECTED_REJECTION')
  return outcome.error
}
function nativeClass(
  error: unknown,
  name: string,
  expectedClass: typeof Error | typeof DOMException = Error
): asserts error is Error {
  expect(error).toBeInstanceOf(expectedClass)
  expect((error as Error).name).toBe(name)
}
function nativeNoCause(error: unknown): void {
  nativeClass(error, 'NetworkError')
  expect(error.message).toBe('The Core API could not be reached.')
  expect(error.cause).toBeUndefined()
  expect(Reflect.ownKeys(error).sort()).toEqual(['cause', 'message', 'name', 'stack'])
  expect(Object.values(error)).not.toContain(NATIVE_ACCESS)
}
function nativeFunction(source: string, name: string) {
  const parsed = nativeCompiler.createSourceFile(
    'client.ts',
    source,
    nativeCompiler.ScriptTarget.ES2022,
    true
  )
  const declarations = parsed.statements.filter(
    (node): node is nativeCompiler.FunctionDeclaration =>
      nativeCompiler.isFunctionDeclaration(node) && node.name?.text === name
  )
  if (declarations.length !== 1 || declarations[0]!.body === undefined)
    throw Error('A_LOADER_ANCHOR')
  const declaration = declarations[0]!
  return {
    start: declaration.getStart(parsed),
    end: declaration.end,
    text: declaration.getText(parsed),
  }
}
function nativeReplace(source: string, name: string, anchor: RegExp, replacement: string): string {
  const window = nativeFunction(source, name)
  const matches = [...window.text.matchAll(new RegExp(anchor.source, 'g'))]
  if (matches.length !== 1) throw Error('A_LOADER_ANCHOR')
  const changed = window.text.replace(anchor, replacement)
  return source.slice(0, window.start) + changed + source.slice(window.end)
}
const nativeHeaderAnchor = /(['"])Idempotency-Key\1\s*:\s*borrow\.idempotencyKey\b/
const nativeThenAnchor = /return\s*\{\s*kind:\s*'started'\s*,/
const nativeDeleteAnchor = /delete\s+cell\.init\.body\b/
function nativeCheckSource(source: string): void {
  if (Buffer.byteLength(source) > 32768) throw Error('A_LOADER_SIZE')
  const syntax = nativeCompiler.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: nativeCompiler.ScriptTarget.ES2022,
      module: nativeCompiler.ModuleKind.CommonJS,
    },
  })
  if (
    syntax.diagnostics?.some(
      (diagnostic) => diagnostic.category === nativeCompiler.DiagnosticCategory.Error
    )
  )
    throw Error('A_LOADER_SYNTAX')
  const parsed = nativeCompiler.createSourceFile(
    'client.ts',
    source,
    nativeCompiler.ScriptTarget.ES2022,
    true
  )
  for (const statement of parsed.statements) {
    if (
      nativeCompiler.isImportDeclaration(statement) &&
      statement.importClause?.isTypeOnly !== true
    ) {
      const specifier = nativeCompiler.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : ''
      if (!['openapi-fetch', '../config', './generated/problems'].includes(specifier))
        throw Error('A_LOADER_IMPORT')
    }
  }
  nativeReplace(source, 'invokeOwnerClaimNative', NATIVE_GUARD, '$&')
  nativeReplace(source, 'dispatchOwnerClaim', nativeHeaderAnchor, '$&')
  nativeReplace(source, 'retireOwnerClaimCell', nativeDeleteAnchor, '$&')
  nativeReplace(source, 'createOwnerClaimWork', nativeThenAnchor, '$&')
  const suffix = source.split("'/owner-claims/actions/consume'").length - 1
  if (suffix !== 1) throw Error('A_LOADER_ANCHOR')
}
function nativeLoad(source: string, control?: number): NativeApi {
  nativeCheckSource(source)
  let actual = source
  if (control === 1)
    actual = source.replace("'/owner-claims/actions/consume'", "'/owner-claims/actions/wrong'")
  if (control === 2) actual = nativeReplace(source, 'invokeOwnerClaimNative', NATIVE_GUARD, '')
  if (control === 3)
    actual = nativeReplace(
      source,
      'dispatchOwnerClaim',
      nativeHeaderAnchor,
      "'Idempotency-Key': crypto.randomUUID()"
    )
  if (control === 4) actual = nativeReplace(source, 'retireOwnerClaimCell', nativeDeleteAnchor, '')
  if (control === 5)
    actual = nativeReplace(
      source,
      'createOwnerClaimWork',
      nativeThenAnchor,
      "return { kind: 'started', then: cell.result.then.bind(cell.result),"
    )
  const compiled = nativeCompiler.transpileModule(actual, {
    reportDiagnostics: true,
    compilerOptions: {
      target: nativeCompiler.ScriptTarget.ES2022,
      module: nativeCompiler.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  })
  if (
    compiled.diagnostics?.some(
      (diagnostic) => diagnostic.category === nativeCompiler.DiagnosticCategory.Error
    )
  )
    throw Error('A_LOADER_SYNTAX')
  if (Buffer.byteLength(compiled.outputText) > 65536) throw Error('A_LOADER_OUTPUT')
  const exports: Record<string, unknown> = {}
  const loaded = { exports }
  runNativeModule(
    compiled.outputText,
    {
      exports,
      module: loaded,
      require: (name: string) => {
        if (name === 'openapi-fetch') return nativeCreateClient
        if (name === '../config') return { coreApiUrl: nativeCoreUrl }
        if (name === './generated/problems') return nativeProblems
        throw Error('A_LOADER_IMPORT')
      },
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
      URL,
      Headers,
      Request,
      Response,
      AbortController,
      AbortSignal,
      DOMException,
      Error,
      AggregateError,
      TypeError,
      SyntaxError,
      Promise,
      crypto,
      performance,
      setTimeout: () => {
        throw Error('A_LOADER_TIMER')
      },
      setInterval: () => {
        throw Error('A_LOADER_TIMER')
      },
      console: {
        log: () => {
          throw Error('A_LOADER_OUTPUT_EFFECT')
        },
      },
    },
    { timeout: 1000, filename: 'client.native-control.cjs' }
  )
  if (
    typeof loaded.exports['dispatchOwnerClaim'] !== 'function' ||
    typeof loaded.exports['setTokenProvider'] !== 'function' ||
    typeof loaded.exports['lastRequestId'] !== 'function' ||
    typeof loaded.exports['createOwnerClaimObservation'] !== 'function'
  )
    throw Error('A_LOADER_EXPORT')
  return loaded.exports as NativeApi
}

function nativeObserverScope(source: string): void {
  const parsed = nativeCompiler.createSourceFile(
    'client.ts',
    source,
    nativeCompiler.ScriptTarget.ES2022,
    true
  )
  const declarations = (name: string) =>
    parsed.statements.filter(
      (node): node is nativeCompiler.FunctionDeclaration =>
        nativeCompiler.isFunctionDeclaration(node) && node.name?.text === name
    )
  const observers = declarations('observeOwnerClaimRejection')
  const factories = declarations('createOwnerClaimCell')
  if (observers.length !== 1 || factories.length !== 1) throw Error('A_OBSERVER_SCOPE')
  const observer = observers[0]!
  const factory = factories[0]!
  if (
    observer.parameters.length !== 0 ||
    observer.asteriskToken !== undefined ||
    observer.modifiers?.some(
      (modifier) =>
        modifier.kind === nativeCompiler.SyntaxKind.AsyncKeyword ||
        modifier.kind === nativeCompiler.SyntaxKind.ExportKeyword ||
        modifier.kind === nativeCompiler.SyntaxKind.DefaultKeyword
    ) ||
    observer.body === undefined ||
    observer.body.statements.length !== 1 ||
    factory.body === undefined
  )
    throw Error('A_OBSERVER_SCOPE')
  const statement = observer.body.statements[0]!
  if (
    !nativeCompiler.isReturnStatement(statement) ||
    statement.expression === undefined ||
    !nativeCompiler.isIdentifier(statement.expression) ||
    statement.expression.text !== 'undefined'
  )
    throw Error('A_OBSERVER_SCOPE')
  const catches: nativeCompiler.CallExpression[] = []
  const visit = (node: nativeCompiler.Node) => {
    if (
      nativeCompiler.isCallExpression(node) &&
      nativeCompiler.isPropertyAccessExpression(node.expression) &&
      nativeCompiler.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'result' &&
      node.expression.name.text === 'catch'
    )
      catches.push(node)
    nativeCompiler.forEachChild(node, visit)
  }
  visit(factory.body)
  if (catches.length !== 1) throw Error('A_OBSERVER_SCOPE')
  const owned = catches[0]!
  const handler = owned.arguments[0]
  if (
    owned.questionDotToken !== undefined ||
    !nativeCompiler.isPropertyAccessExpression(owned.expression) ||
    owned.expression.questionDotToken !== undefined ||
    owned.arguments.length !== 1 ||
    handler === undefined ||
    !nativeCompiler.isIdentifier(handler) ||
    handler.text !== 'observeOwnerClaimRejection' ||
    !nativeCompiler.isVoidExpression(owned.parent) ||
    !nativeCompiler.isExpressionStatement(owned.parent.parent) ||
    owned.parent.parent.parent !== factory.body
  )
    throw Error('A_OBSERVER_SCOPE')
}

async function nativeProbe(api: NativeApi, control: number): Promise<void> {
  await withNativeFixture(api, async (fixture) => {
    if (control === 2) {
      fixture.releaseEffect = () => {
        fixture.current = false
      }
      const work = fixture.dispatch()
      expect(fixture.borrows, 'A_VALID_BORROW').toBe(1)
      expect(fixture.releases, 'A_VALID_RELEASE').toBe(1)
      expect(fixture.current, 'A_ACTUAL_RETIREMENT').toBe(false)
      expect(fixture.calls.length, 'A_RETIRED_BEFORE_NATIVE_COUNT').toBe(0)
      expect(work).toEqual({ kind: 'not-started', reason: 'ineligible' })
      return
    }
    const work = fixture.start()
    expect(fixture.calls.length, 'A_VALID_NATIVE_COUNT').toBe(1)
    if (control === 1) {
      expect(fixture.calls[0]!.url, 'A_CONSUME_ENDPOINT').toBe(BASE + NATIVE_SUFFIX)
    } else if (control === 3) {
      expect(fixture.calls[0]!.wire.headers['Idempotency-Key'], 'A_ORIGINAL_KEY').toBe(NATIVE_KEY)
    } else if (control === 4) {
      expect(fixture.answer.settled, 'A_HELD_NATIVE_RESPONSE').toBe(false)
      expect(fixture.calls[0]!.init.body, 'A_ORIGINAL_BODY_ROOT').toBe(JSON.stringify(NATIVE_BODY))
      work.retire()
      expect(fixture.calls[0]!.init.body, 'A_RETIRED_BODY_ROOT').toBeUndefined()
    } else if (control === 5) {
      expect((work as NativeWork & { then?: unknown }).then, 'A_WORK_THEN').toBeUndefined()
    }
  })
}

describe('unused native owner-claim dispatch boundary', () => {
  it('A00 binds the generated synchronous void-free surface and actual native callsite', async () => {
    const generatedBody: NativeBody = { token: 'NO_LOG', display_name: null }
    const generatedKey: NativeKey = NATIVE_KEY
    expect(generatedBody.display_name).toBeNull()
    expect(generatedKey).toBe(NATIVE_KEY)
    const parsed = nativeCompiler.createSourceFile(
      'client.ts',
      nativeClientSource,
      nativeCompiler.ScriptTarget.ES2022,
      true
    )
    const nativeFunctionNode = parsed.statements.find(
      (node): node is nativeCompiler.FunctionDeclaration =>
        nativeCompiler.isFunctionDeclaration(node) && node.name?.text === 'invokeOwnerClaimNative'
    )
    expect(nativeFunctionNode).toBeDefined()
    expect(nativeFunctionNode!.asteriskToken).toBeUndefined()
    expect(
      nativeFunctionNode!.modifiers?.some(
        (modifier) =>
          modifier.kind === nativeCompiler.SyntaxKind.AsyncKeyword ||
          modifier.kind === nativeCompiler.SyntaxKind.ExportKeyword
      ) ?? false
    ).toBe(false)
    const references: nativeCompiler.Identifier[] = []
    const visit = (node: nativeCompiler.Node) => {
      if (nativeCompiler.isIdentifier(node) && node.text === 'fetch') references.push(node)
      nativeCompiler.forEachChild(node, visit)
    }
    visit(parsed)
    expect(references).toHaveLength(1)
    const call = references[0]!.parent
    expect(nativeCompiler.isCallExpression(call)).toBe(true)
    expect(call.getStart(parsed)).toBeGreaterThan(nativeFunctionNode!.getStart(parsed))
    expect(call.end).toBeLessThan(nativeFunctionNode!.end)
    if (!nativeCompiler.isCallExpression(call)) throw Error('A_NATIVE_CALLSITE')
    expect(call.questionDotToken).toBeUndefined()
    nativeCheckSource(nativeClientSource)
    nativeObserverScope(nativeClientSource)
    const inlineObserver = nativeReplace(
      nativeClientSource,
      'createOwnerClaimCell',
      /result\.catch\(\s*observeOwnerClaimRejection\s*\)/,
      'result.catch(() => undefined)'
    )
    nativeCheckSource(inlineObserver)
    let observerFailed = false
    let observerError: unknown
    try {
      nativeObserverScope(inlineObserver)
    } catch (error) {
      observerFailed = true
      observerError = error
    }
    expect(observerFailed, 'A_OBSERVER_HEALTH_REFUSAL').toBe(true)
    expect(observerError).toBeInstanceOf(Error)
    expect(observerError).not.toBeInstanceOf(AggregateError)
    expect((observerError as Error).message).toBe('A_OBSERVER_SCOPE')
    nativeCheckSource(nativeClientSource)
    nativeObserverScope(nativeClientSource)
    await withNativeFixture(nativeImported, async (fixture) => {
      const work = fixture.dispatch()
      expect(work).not.toBeInstanceOf(Promise)
      nativeStarted(work)
      const typed: Promise<NativeResult> = work.result
      expect(typed).toBe(work.result)
      fixture.answer.resolve(Response.json(nativeResult()))
      expect(await work.result).toEqual(nativeResult())
    })
  })

  it.each([
    ['omitted', { token: 'NO_LOG' }],
    ['null', { token: 'NO_LOG', display_name: null }],
    ['empty', { token: 'NO_LOG', display_name: '' }],
    ['value', { token: 'NO_LOG', display_name: 'Synthetic' }],
  ] as const)(
    'A01 preserves %s generated body presence and the exact configured wire',
    async (_label, body) => {
      await withNativeFixture(nativeImported, async (fixture) => {
        fixture.loan.body = body
        fixture.original.body = body
        const work = fixture.start()
        expect(fixture.calls).toHaveLength(1)
        const call = fixture.calls[0]!
        expect(call.url).toBe(BASE + NATIVE_SUFFIX)
        expect(call.wire).toEqual({
          method: 'POST',
          body: JSON.stringify(body),
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': NATIVE_KEY,
            Authorization: 'Bearer ' + NATIVE_ACCESS,
          },
        })
        expect(Object.getOwnPropertyDescriptors(call.headers)).toEqual(
          Object.getOwnPropertyDescriptors({
            'Content-Type': 'application/json',
            'Idempotency-Key': NATIVE_KEY,
            Authorization: 'Bearer ' + NATIVE_ACCESS,
          })
        )
        nativeLoanGone(fixture, body)
        fixture.answer.resolve(Response.json(nativeResult()))
        expect(await work.result).toEqual(nativeResult())
      })
    }
  )

  it.each(['https://core.test', 'https://core.test/nested/api/v1/'])(
    'A02 joins the fixed suffix once to configured %s',
    async (base) => {
      vi.stubEnv('VITE_CORE_API_URL', base)
      await withNativeFixture(nativeImported, async (fixture) => {
        fixture.start()
        expect(fixture.calls.length).toBe(1)
        expect(fixture.calls[0]!.url).toBe(base.replace(/\/$/, '') + NATIVE_SUFFIX)
      })
    }
  )

  it.each([
    '/relative',
    'file:///tmp/api',
    'https://user@core.test/api',
    BASE + '?mode=1',
    BASE + '#fragment',
  ])('A03 refuses configured base %s without a native invocation', async (base) => {
    vi.stubEnv('VITE_CORE_API_URL', base)
    await withNativeFixture(nativeImported, (fixture) => {
      const work = fixture.dispatch()
      expect(fixture.calls.length).toBe(0)
      expect(work).toEqual({ kind: 'not-started', reason: 'invalid-config' })
      nativeLoanGone(fixture)
    })
  })

  it.each([
    'missing-key',
    'missing-current-token',
    'different-token',
    'not-current',
    'aborted',
  ] as const)('A04 refuses %s admission without invoking native fetch', async (mode) => {
    await withNativeFixture(nativeImported, (fixture) => {
      if (mode === 'missing-key') fixture.loan.idempotencyKey = undefined
      if (mode === 'missing-current-token') fixture.observedToken = undefined
      if (mode === 'different-token') fixture.observedToken = 'OTHER'
      if (mode === 'not-current') fixture.current = false
      if (mode === 'aborted') fixture.controller.abort()
      const work = fixture.dispatch()
      expect(fixture.calls.length).toBe(0)
      expect(work).toEqual({
        kind: 'not-started',
        reason: mode === 'missing-key' ? 'invalid-input' : 'ineligible',
      })
      expect(fixture.releases).toBe(fixture.borrows)
      if (fixture.borrows !== 0) nativeLoanGone(fixture)
    })
  })

  it.each(['release', 'getter'] as const)(
    'A05 observes actual %s retirement before native fetch',
    async (mode) => {
      await withNativeFixture(nativeImported, (fixture) => {
        let effects = 0
        const retire = () => {
          effects++
          fixture.current = false
        }
        if (mode === 'release') fixture.releaseEffect = retire
        else fixture.getterEffect = retire
        const work = fixture.dispatch()
        expect(fixture.borrows).toBe(1)
        expect(fixture.releases).toBe(1)
        expect(effects).toBe(1)
        expect(fixture.current).toBe(false)
        expect(fixture.calls.length, 'A_RETIRED_BEFORE_NATIVE_COUNT').toBe(0)
        expect(work).toEqual({ kind: 'not-started', reason: 'ineligible' })
      })
    }
  )

  it('A06 releases an owned serial lock before the held response and returns nonthenable work', async () => {
    await withNativeFixture(nativeImported, async (fixture) => {
      let tail: Promise<unknown> = Promise.resolve()
      const locked = <Value>(callback: () => Value): Promise<Value> => {
        const next = tail.then(async () => {
          fixture.lockOwned = true
          try {
            return await callback()
          } finally {
            fixture.lockOwned = false
          }
        })
        tail = next.catch(() => undefined)
        return next
      }
      let work!: NativeWork
      await locked(() => {
        work = fixture.start()
        expect(fixture.calls.length).toBe(1)
        expect(fixture.invocationLocks).toEqual([true])
        expect((work as NativeWork & { then?: unknown }).then, 'A_WORK_THEN').toBeUndefined()
        return work
      })
      let secondEntered = false
      await locked(() => {
        secondEntered = true
      })
      expect(secondEntered).toBe(true)
      expect(fixture.answer.settled).toBe(false)
      fixture.answer.resolve(Response.json(nativeResult()))
      expect(await work.result).toEqual(nativeResult())
    })
  })

  it.each(['native-response', 'response-parse'] as const)(
    'A07 retires actual request roots across held %s and refuses late state recreation',
    async (phase) => {
      await withNativeFixture(nativeImported, async (fixture) => {
        const work = fixture.start()
        const call = fixture.calls[0]!
        const actualInit = call.init
        const actualHeaders = call.headers
        if (phase === 'response-parse') {
          const response = Response.json(nativeResult(), {
            headers: { 'X-Request-Id': 'before-retire' },
          })
          vi.spyOn(response, 'json').mockImplementation(() => {
            fixture.parsing.resolve(undefined)
            return fixture.parse.promise
          })
          fixture.answer.resolve(response)
          await fixture.parsing.promise
        }
        expect(call.init).toBe(actualInit)
        expect(call.headers).toBe(actualHeaders)
        expect(actualInit.body).toBe(JSON.stringify(NATIVE_BODY))
        expect(actualHeaders['Idempotency-Key']).toBe(NATIVE_KEY)
        expect(actualHeaders['Authorization']).toBe('Bearer ' + NATIVE_ACCESS)
        const requestIdAtRetirement = nativeImported.lastRequestId()
        work.retire()
        expect(actualInit.body, 'A_RETIRED_BODY_ROOT').toBeUndefined()
        expect(actualHeaders['Idempotency-Key']).toBeUndefined()
        expect(actualHeaders['Authorization']).toBeUndefined()
        nativeLoanGone(fixture)
        const outcome = await fixture.outcomes[0]!
        const error = nativeFailure(outcome)
        nativeClass(error, 'AbortError', DOMException)
        expect(error.message).toBe('Owner-claim dispatch retired.')
        expect((error as DOMException).code).toBe(DOMException.ABORT_ERR)
        expect(fixture.listeners.size).toBe(0)
        if (!fixture.answer.settled)
          fixture.answer.resolve(
            Response.json(nativeResult(), { headers: { 'X-Request-Id': 'late-response' } })
          )
        fixture.parse.resolve(nativeResult())
        await fixture.drain()
        expect(actualInit.body).toBeUndefined()
        expect(actualHeaders['Idempotency-Key']).toBeUndefined()
        expect(actualHeaders['Authorization']).toBeUndefined()
        expect(nativeImported.lastRequestId()).toBe(requestIdAtRetirement)
        expect(fixture.calls).toHaveLength(1)
        expect(await fixture.outcomes[0]!).toBe(outcome)
        work.retire()
      })
    }
  )

  it.each([
    'success',
    'registered503',
    'unregistered',
    'reject-undefined',
    'malformed200',
    'body-read',
    'sync-native',
    'undeclared201',
  ] as const)(
    'A08 classifies %s at its actual native boundary without transport-cause retention',
    async (mode) => {
      await withNativeFixture(nativeImported, async (fixture) => {
        const canary = { marker: 'NO_LOG', body: NATIVE_BODY }
        if (mode === 'reject-undefined')
          fixture.nativeFailure = { value: undefined, synchronous: false }
        if (mode === 'sync-native') fixture.nativeFailure = { value: canary, synchronous: true }
        const work = fixture.start()
        expect(fixture.calls.length).toBe(1)
        if (mode === 'success')
          fixture.answer.resolve(
            Response.json(nativeResult(), { headers: { 'X-Request-Id': 'native-success' } })
          )
        if (mode === 'registered503')
          fixture.answer.resolve(
            Response.json(
              {
                type: 'https://kodera.io/problems/service-unavailable',
                retry_after_s: 1,
                request_id: 'native-problem',
                title: 'Synthetic refusal',
              },
              { status: 503 }
            )
          )
        if (mode === 'unregistered')
          fixture.answer.resolve(new Response('not JSON', { status: 502 }))
        if (mode === 'malformed200') fixture.answer.resolve(new Response('NO_LOG', { status: 200 }))
        if (mode === 'body-read') {
          const response = Response.json(nativeResult())
          vi.spyOn(response, 'json').mockRejectedValue(canary)
          fixture.answer.resolve(response)
        }
        if (mode === 'undeclared201')
          fixture.answer.resolve(Response.json(nativeResult(), { status: 201 }))
        const outcome = await fixture.outcomes[0]!
        if (mode === 'success') {
          expect(outcome).toEqual({ ok: true, value: nativeResult() })
          expect(nativeImported.lastRequestId()).toBe('native-success')
        } else {
          const error = nativeFailure(outcome)
          if (['reject-undefined', 'sync-native', 'body-read'].includes(mode)) {
            nativeNoCause(error)
            expect(error).not.toBe(canary)
            expect(Object.values(error as Error)).not.toContain(canary)
          } else if (mode === 'malformed200') {
            nativeClass(error, 'SyntaxError')
            expect(error.message).toBe('The Core API returned invalid JSON.')
            expect(error.cause).toBeUndefined()
            expect(error.stack).not.toContain('NO_LOG')
          } else {
            nativeClass(error, 'ApiProblem')
            expect(error).toMatchObject({
              status: mode === 'registered503' ? 503 : mode === 'undeclared201' ? 201 : 502,
              type:
                mode === 'registered503'
                  ? 'https://kodera.io/problems/service-unavailable'
                  : null,
            })
            if (mode === 'registered503')
              expect(error).toMatchObject({ retryAfterS: 1, requestId: 'native-problem' })
          }
        }
        expect(work.result).toBeInstanceOf(Promise)
        nativeLoanGone(fixture)
      })
    }
  )

  it.each(['borrow-error', 'release-undefined', 'primary-and-cleanup'] as const)(
    'A09 preserves %s identity while independently finalizing owned resources',
    async (mode) => {
      await withNativeFixture(nativeImported, (fixture) => {
        const primary = Error('A_SETUP')
        const cleanup = Error('A_REMOVE')
        if (mode === 'borrow-error') fixture.borrowFailure = { value: primary }
        if (mode === 'release-undefined') fixture.releaseFailure = { value: undefined }
        if (mode === 'primary-and-cleanup') {
          fixture.getterEffect = () => {
            throw primary
          }
          fixture.removeFailure = { value: cleanup }
        }
        let failed = false
        let observed: unknown
        try {
          fixture.dispatch()
        } catch (error) {
          failed = true
          observed = error
        }
        expect(fixture.calls.length).toBe(0)
        expect(failed).toBe(true)
        if (mode === 'primary-and-cleanup') {
          expect(observed).toBeInstanceOf(AggregateError)
          expect((observed as AggregateError).errors).toEqual([primary, cleanup])
        } else expect(observed).toBe(mode === 'borrow-error' ? primary : undefined)
        expect(fixture.listeners.size).toBe(0)
        expect(fixture.releases).toBe(fixture.borrows)
        if (fixture.borrows !== 0) nativeLoanGone(fixture)
        expect(fixture.original).toEqual({
          key: NATIVE_KEY,
          body: NATIVE_BODY,
          access: NATIVE_ACCESS,
        })
      })
    }
  )

  it.each([1, 2, 3, 4, 5] as const)(
    'A10 source control M0%i refuses only its exact target and restores both pristines',
    async (control) => {
      const targets = {
        1: ['A_CONSUME_ENDPOINT', BASE + '/owner-claims/actions/wrong', BASE + NATIVE_SUFFIX],
        2: ['A_RETIRED_BEFORE_NATIVE_COUNT', 1, 0],
        3: ['A_ORIGINAL_KEY', undefined, NATIVE_KEY],
        4: ['A_RETIRED_BODY_ROOT', JSON.stringify(NATIVE_BODY), undefined],
        5: ['A_WORK_THEN', undefined, undefined],
      } as const
      await nativeProbe(nativeImported, control)
      await nativeProbe(nativeLoad(nativeClientSource), control)
      let failed = false
      let observed: unknown
      try {
        await nativeProbe(nativeLoad(nativeClientSource, control), control)
      } catch (error) {
        failed = true
        observed = error
      }
      expect(failed, 'A_CONTROL_MUST_REFUSE').toBe(true)
      expect(observed).toBeInstanceOf(Error)
      expect(observed).not.toBeInstanceOf(AggregateError)
      const assertion = observed as Error & { actual?: unknown; expected?: unknown }
      expect(assertion.message).toContain(targets[control][0])
      expect(Object.prototype.hasOwnProperty.call(assertion, 'actual')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(assertion, 'expected')).toBe(true)
      const actual = assertion.actual
      expect(assertion.expected).toBe(targets[control][2])
      if (control === 3) {
        expect(typeof actual).toBe('string')
        expect(actual).toMatch(/^[a-f0-9-]{36}$/i)
        expect(actual).not.toBe(NATIVE_KEY)
      } else if (control === 5) expect(typeof actual).toBe('function')
      else expect(actual).toBe(targets[control][1])
      await nativeProbe(nativeLoad(nativeClientSource), control)
      await nativeProbe(nativeImported, control)
    }
  )

  it('A11 refuses four precise loader inputs and freshly restores the actual pristine', async () => {
    const duplicateGuard = nativeReplace(
      nativeClientSource,
      'invokeOwnerClaimNative',
      NATIVE_GUARD,
      '$&\n$&'
    )
    const missingGuard = nativeReplace(
      nativeClientSource,
      'invokeOwnerClaimNative',
      NATIVE_GUARD,
      ''
    )
    const inputs = [
      [missingGuard, 'A_LOADER_ANCHOR'],
      [duplicateGuard, 'A_LOADER_ANCHOR'],
      [
        nativeClientSource + "\nimport unexpectedModule from 'unexpected-module'\n",
        'A_LOADER_IMPORT',
      ],
      [nativeClientSource + '\nexport const =\n', 'A_LOADER_SYNTAX'],
    ] as const
    for (const [source, marker] of inputs) {
      let failed = false
      let observed: unknown
      try {
        nativeLoad(source)
      } catch (error) {
        failed = true
        observed = error
      }
      expect(failed).toBe(true)
      expect(observed).toBeInstanceOf(Error)
      expect((observed as Error).message).toBe(marker)
      await nativeProbe(nativeLoad(nativeClientSource), 1)
      await nativeProbe(nativeImported, 1)
    }
  })

  it.each([
    'required-accessor',
    'optional-accessor',
    'toJSON',
    'unknown-field',
    'required-type',
    'optional-type',
    'short-key',
    'long-key',
    'nonASCII-key',
    'newline-key',
  ] as const)(
    'A12 refuses %s runtime input before executing user properties or native fetch',
    async (mode) => {
      await withNativeFixture(nativeImported, (fixture) => {
        let reads = 0
        const body: Record<string, unknown> = { token: 'NO_LOG' }
        if (mode === 'required-accessor')
          Object.defineProperty(body, 'token', {
            enumerable: true,
            get: () => {
              reads++
              return 'NO_LOG'
            },
          })
        if (mode === 'optional-accessor')
          Object.defineProperty(body, 'display_name', {
            enumerable: true,
            get: () => {
              reads++
              return ''
            },
          })
        if (mode === 'toJSON')
          body['toJSON'] = () => {
            reads++
            return { token: 'NO_LOG' }
          }
        if (mode === 'unknown-field') body['unexpected'] = true
        if (mode === 'required-type') body['token'] = 7
        if (mode === 'optional-type') body['display_name'] = 7
        fixture.loan.body = body as NativeBody
        if (mode === 'short-key') fixture.loan.idempotencyKey = 'a'.repeat(15)
        if (mode === 'long-key') fixture.loan.idempotencyKey = 'a'.repeat(256)
        if (mode === 'nonASCII-key') fixture.loan.idempotencyKey = 'a'.repeat(15) + 'é'
        if (mode === 'newline-key') fixture.loan.idempotencyKey = 'a'.repeat(16) + '\n'
        const work = fixture.dispatch()
        expect(fixture.calls.length).toBe(0)
        expect(work).toEqual({ kind: 'not-started', reason: 'invalid-input' })
        expect(fixture.borrows).toBe(1)
        expect(fixture.releases).toBe(1)
        expect(reads).toBe(0)
        nativeLoanGone(fixture)
      })
    }
  )
})

type LateObservation = ReturnType<typeof nativeImported.createOwnerClaimObservation>
const LATE_GUARD = /if\s*\(\s*!admitOwnerClaimObservation\(cell\)\s*\)\s*return\b/
const LATE_PUBLICATION_GUARD =
  /if\s*\(\s*!admitOwnerClaimPublication\(\s*observation\s*,\s*expectedAccessToken\s*,\s*reject\s*\)\s*\)\s*return\b/

function lateOwned(api: NativeApi, fixture: NativeFixture, observation: LateObservation) {
  const work = api.dispatchOwnerClaim(fixture.source, observation)
  nativeStarted(work)
  fixture.works.push(work)
  const outcome = nativeObserve(work.result)
  fixture.outcomes.push(outcome)
  return { work, observation, outcome }
}

function lateStart(api: NativeApi, fixture: NativeFixture, validBefore: number) {
  return lateOwned(api, fixture, api.createOwnerClaimObservation(validBefore))
}

function lateClosed(fixture: NativeFixture): void {
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.calls[0]!.init.body).toBeUndefined()
  expect(fixture.calls[0]!.headers['Authorization']).toBeUndefined()
  expect(fixture.calls[0]!.headers['Idempotency-Key']).toBeUndefined()
  expect(fixture.calls[0]!.init.signal).toBeUndefined()
  expect(fixture.listeners.size).toBe(0)
  nativeLoanGone(fixture)
}

function lateAbort(outcome: NativeOutcome<unknown>): void {
  const error = nativeFailure(outcome)
  nativeClass(error, 'AbortError', DOMException)
  expect(error.message).toBe('Owner-claim dispatch retired.')
  expect((error as DOMException).code).toBe(DOMException.ABORT_ERR)
}

function lateNoReopen(api: NativeApi, fixture: NativeFixture, observation: LateObservation): void {
  const borrows = fixture.borrows
  const releases = fixture.releases
  const calls = fixture.calls.length
  expect(api.dispatchOwnerClaim(fixture.source, observation)).toEqual({
    kind: 'not-started',
    reason: 'ineligible',
  })
  expect(fixture.borrows).toBe(borrows)
  expect(fixture.releases).toBe(releases)
  expect(fixture.calls.length).toBe(calls)
}

async function lateSuccess(api: NativeApi): Promise<void> {
  let sample = 0.25
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
  try {
    await withNativeFixture(api, async (fixture) => {
      const { work, observation, outcome } = lateStart(api, fixture, 100.5)
      expect(Object.isFrozen(observation)).toBe(true)
      expect(Reflect.ownKeys(observation)).toEqual(['revoke'])
      expect((observation as LateObservation & { then?: unknown }).then).toBeUndefined()
      expect((work as NativeWork & { then?: unknown }).then).toBeUndefined()
      expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
      expect(fixture.calls[0]!.url).toBe(BASE + NATIVE_SUFFIX)
      expect(fixture.calls[0]!.wire).toEqual({
        method: 'POST',
        body: JSON.stringify(NATIVE_BODY),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': NATIVE_KEY,
          Authorization: 'Bearer ' + NATIVE_ACCESS,
        },
      })
      expect(fixture.answer.settled).toBe(false)
      nativeLoanGone(fixture)
      sample = 10.5
      fixture.answer.resolve(
        Response.json(nativeResult(), {
          headers: { 'X-Request-Id': 'CURRENT_OBS' },
        })
      )
      expect(await outcome).toEqual({ ok: true, value: nativeResult() })
      expect(api.lastRequestId()).toBe('CURRENT_OBS')
      lateClosed(fixture)
    })
  } finally {
    clock.mockRestore()
  }
}

async function lateResponseProbe(api: NativeApi, validBefore: number): Promise<void> {
  let sample = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
  try {
    await withNativeFixture(api, async (fixture) => {
      const previousId = api.lastRequestId()
      const { observation, outcome } = lateStart(api, fixture, validBefore)
      expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
      expect(fixture.answer.settled, 'LATE_HELD_RESPONSE').toBe(false)
      expect(fixture.controller.signal.aborted).toBe(false)
      nativeLoanGone(fixture)
      const response = Response.json(nativeResult(), {
        headers: { 'X-Request-Id': 'LATE_OBS' },
      })
      const headers = vi.spyOn(response.headers, 'get')
      const parser = vi.spyOn(response, 'json').mockImplementation(() => {
        fixture.parsing.resolve(undefined)
        return fixture.parse.promise
      })
      try {
        sample = validBefore
        fixture.answer.resolve(response)
        await Promise.race([outcome, fixture.parsing.promise])
        expect(api.lastRequestId(), 'LATE_RESPONSE_LAST_ID').toBe(previousId)
        expect(parser.mock.calls.length, 'LATE_RESPONSE_PARSER_COUNT').toBe(0)
        expect(headers.mock.calls.length).toBe(0)
        lateAbort(await outcome)
        lateClosed(fixture)
        sample = 0
        lateNoReopen(api, fixture, observation)
      } finally {
        parser.mockRestore()
        headers.mockRestore()
      }
    })
  } finally {
    clock.mockRestore()
  }
}

async function lateParserProbe(api: NativeApi): Promise<void> {
  let sample = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
  try {
    await withNativeFixture(api, async (fixture) => {
      const { outcome } = lateStart(api, fixture, 100)
      expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
      const response = Response.json(nativeResult(), {
        headers: { 'X-Request-Id': 'CURRENT_OBS' },
      })
      const parser = vi.spyOn(response, 'json').mockImplementation(() => {
        fixture.parsing.resolve(undefined)
        return fixture.parse.promise
      })
      try {
        fixture.answer.resolve(response)
        const reached = await Promise.race([
          fixture.parsing.promise.then(() => 'parsing'),
          outcome.then(() => 'early'),
        ])
        expect(reached, 'LATE_REQUIRED_PARSER_PHASE').toBe('parsing')
        expect(api.lastRequestId()).toBe('CURRENT_OBS')
        expect(parser.mock.calls.length).toBe(1)
        expect(fixture.parse.settled).toBe(false)
        expect(fixture.controller.signal.aborted).toBe(false)
        sample = 100
        fixture.parse.resolve(nativeResult())
        const settled = await outcome
        expect(settled.ok, 'LATE_SETTLEMENT_REFUSED').toBe(false)
        lateAbort(settled)
        expect(api.lastRequestId()).toBe('CURRENT_OBS')
        lateClosed(fixture)
      } finally {
        parser.mockRestore()
      }
    })
  } finally {
    clock.mockRestore()
  }
}

function lateSourceScope(source: string): void {
  nativeObserverScope(source)
  nativeReplace(source, 'observeOwnerClaimResponse', LATE_GUARD, '$&')
  nativeReplace(source, 'settleOwnerClaimCell', LATE_PUBLICATION_GUARD, '$&')
  const parsed = nativeCompiler.createSourceFile(
    'client.ts',
    source,
    nativeCompiler.ScriptTarget.ES2022,
    true
  )
  const named = (name: string) => {
    const nodes = parsed.statements.filter(
      (node): node is nativeCompiler.FunctionDeclaration =>
        nativeCompiler.isFunctionDeclaration(node) && node.name?.text === name
    )
    if (nodes.length !== 1 || nodes[0]!.body === undefined) throw Error('LATE_SOURCE_SCOPE')
    return nodes[0]!
  }
  const factory = named('createOwnerClaimObservation')
  const guard = named('admitOwnerClaimObservation')
  const publication = named('admitOwnerClaimPublication')
  if (
    publication.parameters.map((parameter) => parameter.name.getText(parsed)).join(',') !==
    'observation,expectedAccessToken,reject'
  )
    throw Error('LATE_SOURCE_SCOPE')
  if (
    factory.modifiers?.filter(
      (modifier) => modifier.kind === nativeCompiler.SyntaxKind.ExportKeyword
    ).length !== 1
  )
    throw Error('LATE_SOURCE_SCOPE')
  if (
    factory.parameters.length !== 1 ||
    factory.parameters[0]!.name.getText(parsed) !== 'validBefore' ||
    guard.parameters.length !== 1 ||
    guard.parameters[0]!.name.getText(parsed) !== 'cell'
  )
    throw Error('LATE_SOURCE_SCOPE')
  for (const node of [factory, guard]) {
    if (
      node.asteriskToken !== undefined ||
      node.modifiers?.some((modifier) => modifier.kind === nativeCompiler.SyntaxKind.AsyncKeyword)
    )
      throw Error('LATE_SOURCE_SCOPE')
  }
  const forbidden = new Set([
    'source',
    'borrow',
    'caller',
    'signal',
    'body',
    'expectedAccessToken',
    'tokenProvider',
    'Response',
    'fetch',
    'setTimeout',
    'setInterval',
  ])
  const inspect = (node: nativeCompiler.Node) => {
    if (nativeCompiler.isIdentifier(node) && forbidden.has(node.text))
      throw Error('LATE_SOURCE_SCOPE')
    nativeCompiler.forEachChild(node, inspect)
  }
  inspect(factory)
  const states = factory
    .body!.statements.filter(nativeCompiler.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => declaration.name.getText(parsed) === 'state')
  if (
    states.length !== 1 ||
    states[0]!.initializer === undefined ||
    !nativeCompiler.isObjectLiteralExpression(states[0]!.initializer)
  )
    throw Error('LATE_SOURCE_SCOPE')
  const fields = states[0]!.initializer.properties.map((property) => {
    if (
      !nativeCompiler.isPropertyAssignment(property) &&
      !nativeCompiler.isShorthandPropertyAssignment(property)
    )
      throw Error('LATE_SOURCE_SCOPE')
    return property.name.getText(parsed)
  })
  if (JSON.stringify(fields) !== JSON.stringify(['active', 'validBefore', 'lastSample']))
    throw Error('LATE_SOURCE_SCOPE')
  const stateTypes = parsed.statements.filter(
    (node): node is nativeCompiler.TypeAliasDeclaration =>
      nativeCompiler.isTypeAliasDeclaration(node) && node.name.text === 'OwnerClaimObservationState'
  )
  if (stateTypes.length !== 1 || !nativeCompiler.isTypeLiteralNode(stateTypes[0]!.type))
    throw Error('LATE_SOURCE_SCOPE')
  const members = stateTypes[0]!.type.members.map((member) => {
    if (!nativeCompiler.isPropertySignature(member) || member.name === undefined)
      throw Error('LATE_SOURCE_SCOPE')
    return member.name.getText(parsed)
  })
  if (JSON.stringify(members) !== JSON.stringify(['active', 'validBefore', 'lastSample']))
    throw Error('LATE_SOURCE_SCOPE')
}

async function lateFault(control: 6 | 7): Promise<void> {
  const name = control === 6 ? 'observeOwnerClaimResponse' : 'settleOwnerClaimCell'
  const probe = control === 6 ? (api: NativeApi) => lateResponseProbe(api, 600000) : lateParserProbe
  lateSourceScope(nativeClientSource)
  await lateSuccess(nativeLoad(nativeClientSource))
  await probe(nativeLoad(nativeClientSource))
  const anchor = control === 6 ? LATE_GUARD : LATE_PUBLICATION_GUARD
  const mutated = nativeReplace(nativeClientSource, name, anchor, '')
  let failed = false
  let observed: unknown
  try {
    await probe(nativeLoad(mutated))
  } catch (error) {
    failed = true
    observed = error
  }
  expect(failed, 'LATE_CONTROL_MUST_REFUSE').toBe(true)
  expect(observed).toBeInstanceOf(Error)
  expect(observed).not.toBeInstanceOf(AggregateError)
  const assertion = observed as Error & { actual?: unknown; expected?: unknown }
  expect(Object.prototype.hasOwnProperty.call(assertion, 'actual')).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(assertion, 'expected')).toBe(true)
  expect(assertion.message).toContain(
    control === 6 ? 'LATE_RESPONSE_LAST_ID' : 'LATE_SETTLEMENT_REFUSED'
  )
  expect(assertion.actual).toBe(control === 6 ? 'LATE_OBS' : true)
  expect(assertion.expected).toBe(control === 6 ? undefined : false)
  await probe(nativeLoad(nativeClientSource))
  await lateSuccess(nativeLoad(nativeClientSource))
}

type LateCleanupMode = 'current' | 'expiry' | 'revoke' | 'token'

async function lateCleanupProbe(api: NativeApi, mode: LateCleanupMode): Promise<void> {
  let sample = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
  try {
    await withNativeFixture(api, async (fixture) => {
      const { observation, outcome } = lateStart(api, fixture, 100)
      expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
      expect(fixture.answer.settled).toBe(false)
      nativeLoanGone(fixture)
      const response = Response.json(nativeResult(), {
        headers: { 'X-Request-Id': 'POST_CLEANUP' },
      })
      const parser = vi.spyOn(response, 'json').mockImplementation(() => {
        fixture.parsing.resolve(undefined)
        return fixture.parse.promise
      })
      const removal = vi.mocked(fixture.controller.signal.removeEventListener)
      const previousRemoval = removal.getMockImplementation()
      expect(typeof previousRemoval).toBe('function')
      if (previousRemoval === undefined) throw Error('LATE_OWNED_REMOVAL_IMPLEMENTATION')
      try {
        fixture.answer.resolve(response)
        const reached = await Promise.race([
          fixture.parsing.promise.then(() => 'parsing'),
          outcome.then(() => 'early'),
        ])
        expect(reached, 'LATE_REQUIRED_PARSER_PHASE').toBe('parsing')
        expect(api.lastRequestId()).toBe('POST_CLEANUP')
        expect(parser.mock.calls.length).toBe(1)
        expect(fixture.parse.settled).toBe(false)
        expect(fixture.controller.signal.aborted).toBe(false)
        const events: string[] = []
        const roots: boolean[] = []
        fixture.getterEffect = () => {
          events.push('getter')
        }
        removal.mockImplementation((type, listener, options) => {
          previousRemoval(type, listener, options)
          events.push('remove')
          roots.push(
            fixture.calls[0]!.init.body === undefined &&
              fixture.calls[0]!.headers['Authorization'] === undefined &&
              fixture.calls[0]!.headers['Idempotency-Key'] === undefined &&
              fixture.listeners.size === 0
          )
          if (mode === 'expiry') sample = 100
          if (mode === 'revoke') observation.revoke()
          if (mode === 'token') fixture.observedToken = 'OTHER'
        })
        fixture.parse.resolve(nativeResult())
        const settled = await outcome
        expect(settled.ok, 'LATE_PUBLICATION_REFUSED').toBe(mode === 'current')
        expect(events).toEqual(['remove', 'getter'])
        expect(roots).toEqual([true])
        expect(api.lastRequestId()).toBe('POST_CLEANUP')
        expect(parser.mock.calls.length).toBe(1)
        if (mode === 'current') expect(settled).toEqual({ ok: true, value: nativeResult() })
        else lateAbort(settled)
        lateClosed(fixture)
        if (mode !== 'current') {
          sample = 0
          fixture.observedToken = NATIVE_ACCESS
          fixture.getterEffect = undefined
          lateNoReopen(api, fixture, observation)
        }
      } finally {
        removal.mockImplementation(previousRemoval)
        parser.mockRestore()
      }
    })
  } finally {
    clock.mockRestore()
  }
}

async function latePublicationFailureProbe(
  api: NativeApi,
  mode: 'getter-undefined' | 'cleanup-success' | 'cleanup-parse'
): Promise<void> {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    await withNativeFixture(api, async (fixture) => {
      const { outcome } = lateStart(api, fixture, 100)
      expect(fixture.calls.length).toBe(1)
      const response = Response.json(nativeResult(), {
        headers: { 'X-Request-Id': 'CLEANUP_FAILURE' },
      })
      const parser = vi.spyOn(response, 'json').mockImplementation(() => {
        fixture.parsing.resolve(undefined)
        return fixture.parse.promise
      })
      const removal = vi.mocked(fixture.controller.signal.removeEventListener)
      const previousRemoval = removal.getMockImplementation()
      expect(typeof previousRemoval).toBe('function')
      if (previousRemoval === undefined) throw Error('LATE_OWNED_REMOVAL_IMPLEMENTATION')
      const failure = Error('REMOVE')
      const events: string[] = []
      try {
        fixture.answer.resolve(response)
        const reached = await Promise.race([
          fixture.parsing.promise.then(() => 'parsing'),
          outcome.then(() => 'early'),
        ])
        expect(reached, 'LATE_REQUIRED_PARSER_PHASE').toBe('parsing')
        expect(api.lastRequestId()).toBe('CLEANUP_FAILURE')
        expect(fixture.parse.settled).toBe(false)
        fixture.getterEffect = () => {
          events.push('getter')
          throw undefined
        }
        removal.mockImplementation((type, listener, options) => {
          try {
            previousRemoval(type, listener, options)
          } finally {
            events.push('remove')
          }
        })
        if (mode !== 'getter-undefined') fixture.removeFailure = { value: failure }
        if (mode === 'cleanup-parse') fixture.parse.reject(undefined)
        else fixture.parse.resolve(nativeResult())
        const settled = await outcome
        expect(settled.ok, 'LATE_PUBLICATION_FAILURE_REQUIRED').toBe(false)
        const error = nativeFailure(settled)
        if (mode === 'getter-undefined') {
          expect(error).toBeUndefined()
          expect(events).toEqual(['remove', 'getter'])
        } else {
          expect(error).toBeInstanceOf(AggregateError)
          const errors = (error as AggregateError).errors
          if (mode === 'cleanup-success') {
            expect(errors).toEqual([failure])
            expect(errors[0]).toBe(failure)
          } else {
            expect(errors).toHaveLength(2)
            nativeNoCause(errors[0])
            expect(errors[1]).toBe(failure)
          }
          expect(events).toEqual(['remove'])
        }
        expect(api.lastRequestId()).toBe('CLEANUP_FAILURE')
        lateClosed(fixture)
      } finally {
        removal.mockImplementation(previousRemoval)
        parser.mockRestore()
      }
    })
  } finally {
    clock.mockRestore()
  }
}

async function lateCleanupFault(mode: Exclude<LateCleanupMode, 'current'>): Promise<void> {
  await lateCleanupProbe(nativeLoad(nativeClientSource), 'current')
  await lateCleanupProbe(nativeLoad(nativeClientSource), mode)
  const changed = nativeReplace(
    nativeClientSource,
    'settleOwnerClaimCell',
    LATE_PUBLICATION_GUARD,
    ''
  )
  let failed = false
  let observed: unknown
  try {
    await lateCleanupProbe(nativeLoad(changed), mode)
  } catch (error) {
    failed = true
    observed = error
  }
  expect(failed, 'LATE_CONTROL_MUST_REFUSE').toBe(true)
  expect(observed).toBeInstanceOf(Error)
  expect(observed).not.toBeInstanceOf(AggregateError)
  const assertion = observed as Error & { actual?: unknown; expected?: unknown }
  expect(assertion.message).toContain('LATE_PUBLICATION_REFUSED')
  expect(Object.prototype.hasOwnProperty.call(assertion, 'actual')).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(assertion, 'expected')).toBe(true)
  expect(assertion.actual).toBe(true)
  expect(assertion.expected).toBe(false)
  await lateCleanupProbe(nativeLoad(nativeClientSource), mode)
  await lateCleanupProbe(nativeLoad(nativeClientSource), 'current')
}

describe('optional source-free late owner-claim observation', () => {
  it('L01 succeeds while current and observes getter ordering and live retirement', async () => {
    lateSourceScope(nativeClientSource)
    await lateSuccess(nativeImported)
    for (const mode of ['clock', 'retire'] as const) {
      let sample = 0
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
      try {
        await withNativeFixture(nativeImported, async (fixture) => {
          const previousId = nativeImported.lastRequestId()
          const { work, outcome } = lateStart(nativeImported, fixture, 100)
          expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
          expect(fixture.answer.settled).toBe(false)
          let effects = 0
          fixture.getterEffect = () => {
            effects++
            if (mode === 'clock') sample = 100
            else work.retire()
          }
          const response = Response.json(nativeResult(), {
            headers: { 'X-Request-Id': 'REENTRANT_OBS' },
          })
          const headers = vi.spyOn(response.headers, 'get')
          const parser = vi.spyOn(response, 'json')
          try {
            fixture.answer.resolve(response)
            lateAbort(await outcome)
            expect(effects).toBe(1)
            expect(nativeImported.lastRequestId()).toBe(previousId)
            expect(headers.mock.calls.length).toBe(0)
            expect(parser.mock.calls.length).toBe(0)
            lateClosed(fixture)
          } finally {
            headers.mockRestore()
            parser.mockRestore()
          }
        })
      } finally {
        clock.mockRestore()
      }
    }
  })

  it.each([600000, 300000])('L02/L03 refuses silent held-response expiry at %i', async (bound) => {
    await lateResponseProbe(nativeImported, bound)
  })

  it('L04 refuses silent parser expiry after legitimate header observation', async () => {
    await lateParserProbe(nativeImported)
  })

  it('L05 refuses expired transport rejection before ordinary error settlement', async () => {
    let sample = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
    try {
      await withNativeFixture(nativeImported, async (fixture) => {
        const previousId = nativeImported.lastRequestId()
        const { outcome } = lateStart(nativeImported, fixture, 100)
        expect(fixture.calls.length).toBe(1)
        expect(fixture.answer.settled).toBe(false)
        expect(fixture.controller.signal.aborted).toBe(false)
        sample = 100
        fixture.answer.reject(undefined)
        lateAbort(await outcome)
        expect(nativeImported.lastRequestId()).toBe(previousId)
        expect(fixture.parsing.settled).toBe(false)
        lateClosed(fixture)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('L06 permanently closes token mismatch and distinguishes revoke from retirement', async () => {
    let sample = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
    try {
      await withNativeFixture(nativeImported, async (fixture) => {
        const previousId = nativeImported.lastRequestId()
        const { observation, outcome } = lateStart(nativeImported, fixture, 100)
        expect(fixture.calls.length).toBe(1)
        fixture.observedToken = 'OTHER'
        const response = Response.json(nativeResult(), {
          headers: { 'X-Request-Id': 'OTHER_OBS' },
        })
        const parser = vi.spyOn(response, 'json')
        try {
          fixture.answer.resolve(response)
          lateAbort(await outcome)
          expect(nativeImported.lastRequestId()).toBe(previousId)
          expect(parser.mock.calls.length).toBe(0)
          lateClosed(fixture)
          fixture.observedToken = NATIVE_ACCESS
          lateNoReopen(nativeImported, fixture, observation)
        } finally {
          parser.mockRestore()
        }
      })
      await withNativeFixture(nativeImported, async (fixture) => {
        const { observation, outcome } = lateStart(nativeImported, fixture, 100)
        const response = Response.json(nativeResult(), {
          headers: { 'X-Request-Id': 'BEFORE_REVOKE' },
        })
        const parser = vi.spyOn(response, 'json').mockImplementation(() => {
          fixture.parsing.resolve(undefined)
          return fixture.parse.promise
        })
        try {
          fixture.answer.resolve(response)
          const reached = await Promise.race([
            fixture.parsing.promise.then(() => 'parsing'),
            outcome.then(() => 'early'),
          ])
          expect(reached, 'LATE_REQUIRED_PARSER_PHASE').toBe('parsing')
          expect(nativeImported.lastRequestId()).toBe('BEFORE_REVOKE')
          expect(fixture.parse.settled).toBe(false)
          observation.revoke()
          observation.revoke()
          expect(fixture.controller.signal.aborted).toBe(false)
          expect(fixture.calls[0]!.init.body).toBe(JSON.stringify(NATIVE_BODY))
          expect(fixture.calls[0]!.headers['Authorization']).toBe('Bearer ' + NATIVE_ACCESS)
          expect(fixture.listeners.size).toBe(1)
          fixture.parse.resolve(nativeResult())
          lateAbort(await outcome)
          expect(nativeImported.lastRequestId()).toBe('BEFORE_REVOKE')
          lateClosed(fixture)
          sample = 0
          lateNoReopen(nativeImported, fixture, observation)
        } finally {
          parser.mockRestore()
        }
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('L07 refuses eight finite factory, opaque-handle and export inputs with restorations', async () => {
    lateSourceScope(nativeClientSource)
    await lateSuccess(nativeImported)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10)
    try {
      for (const bound of [NaN, Infinity, -1, 0, 10, Number.MAX_SAFE_INTEGER + 1]) {
        let failed = false
        let observed: unknown
        try {
          nativeImported.createOwnerClaimObservation(bound)
        } catch (error) {
          failed = true
          observed = error
        }
        expect(failed).toBe(true)
        expect(observed).toBeInstanceOf(RangeError)
        expect((observed as RangeError).message).toBe('Owner-claim observation deadline refused.')
        await withNativeFixture(nativeImported, async (fixture) => {
          const { outcome } = lateStart(nativeImported, fixture, 20)
          fixture.answer.resolve(Response.json(nativeResult()))
          expect(await outcome).toEqual({ ok: true, value: nativeResult() })
          lateClosed(fixture)
        })
      }
      await withNativeFixture(nativeImported, (fixture) => {
        let reads = 0
        const foreign = Object.defineProperty({}, 'revoke', {
          get: () => {
            reads++
            throw Error('LATE_FOREIGN_PROPERTY')
          },
        })
        const refused: unknown = Reflect.apply(nativeImported.dispatchOwnerClaim, undefined, [
          fixture.source,
          foreign,
        ])
        expect(refused).toEqual({ kind: 'not-started', reason: 'invalid-input' })
        expect(reads).toBe(0)
        expect(fixture.borrows).toBe(0)
        expect(fixture.releases).toBe(0)
        expect(fixture.calls.length).toBe(0)
      })
      await withNativeFixture(nativeImported, async (fixture) => {
        const { outcome } = lateStart(nativeImported, fixture, 20)
        fixture.answer.resolve(Response.json(nativeResult()))
        expect(await outcome).toEqual({ ok: true, value: nativeResult() })
        lateClosed(fixture)
      })
      const unexported = nativeReplace(
        nativeClientSource,
        'createOwnerClaimObservation',
        /\bexport\s+function\s+createOwnerClaimObservation\b/,
        'function createOwnerClaimObservation'
      )
      expect(() => lateSourceScope(unexported)).toThrowError(/^LATE_SOURCE_SCOPE$/)
      let failed = false
      let observed: unknown
      try {
        nativeLoad(unexported)
      } catch (error) {
        failed = true
        observed = error
      }
      expect(failed).toBe(true)
      expect(observed).toBeInstanceOf(Error)
      expect((observed as Error).message).toBe('A_LOADER_EXPORT')
      lateSourceScope(nativeClientSource)
      const restored = nativeLoad(nativeClientSource)
      await withNativeFixture(restored, async (fixture) => {
        const { outcome } = lateStart(restored, fixture, 20)
        fixture.answer.resolve(Response.json(nativeResult()))
        expect(await outcome).toEqual({ ok: true, value: nativeResult() })
        lateClosed(fixture)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('L08 closes regressed and nonfinite clocks and preserves late getter failure identity', async () => {
    for (const mode of ['regression', 'nonfinite', 'undefined', 'cleanup'] as const) {
      let sample = 10
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => sample)
      try {
        await withNativeFixture(nativeImported, async (fixture) => {
          const previousId = nativeImported.lastRequestId()
          const { observation, outcome } = lateStart(nativeImported, fixture, 100)
          expect(fixture.calls.length, 'LATE_ACTUAL_NATIVE').toBe(1)
          expect(fixture.answer.settled).toBe(false)
          nativeLoanGone(fixture)
          const primary = Error('LATE_GETTER')
          const removal = Error('LATE_REMOVE')
          if (mode === 'regression') sample = 9
          if (mode === 'nonfinite') sample = NaN
          if (mode === 'undefined' || mode === 'cleanup') {
            fixture.getterEffect = () => {
              throw mode === 'undefined' ? undefined : primary
            }
          }
          if (mode === 'cleanup') fixture.removeFailure = { value: removal }
          const response = Response.json(nativeResult(), {
            headers: { 'X-Request-Id': 'FAILED_OBS' },
          })
          const headers = vi.spyOn(response.headers, 'get')
          const parser = vi.spyOn(response, 'json')
          try {
            fixture.answer.resolve(response)
            const settled = await outcome
            if (mode === 'undefined') expect(nativeFailure(settled)).toBeUndefined()
            else if (mode === 'cleanup') {
              const error = nativeFailure(settled)
              expect(error).toBeInstanceOf(AggregateError)
              expect((error as AggregateError).errors).toEqual([primary, removal])
              expect((error as AggregateError).errors[0]).toBe(primary)
              expect((error as AggregateError).errors[1]).toBe(removal)
            } else lateAbort(settled)
            expect(nativeImported.lastRequestId()).toBe(previousId)
            expect(headers.mock.calls.length).toBe(0)
            expect(parser.mock.calls.length).toBe(0)
            lateClosed(fixture)
            if (mode === 'regression' || mode === 'nonfinite') {
              sample = 10
              lateNoReopen(nativeImported, fixture, observation)
            }
          } finally {
            parser.mockRestore()
            headers.mockRestore()
          }
        })
      } finally {
        clock.mockRestore()
      }
    }
  })

  it('L09 refuses cleanup reentrancy and preserves independent failure precedence', async () => {
    for (const mode of ['expiry', 'revoke', 'token'] as const) {
      await lateCleanupProbe(nativeImported, 'current')
      await lateCleanupProbe(nativeImported, mode)
      await lateCleanupProbe(nativeImported, 'current')
    }
    for (const mode of ['getter-undefined', 'cleanup-success', 'cleanup-parse'] as const)
      await latePublicationFailureProbe(nativeImported, mode)
  })

  it('M06 kills only omitted pre-observation admission and freshly restores', async () => {
    await lateFault(6)
  })

  it('M07 kills only omitted settlement admission and freshly restores', async () => {
    await lateFault(7)
    for (const mode of ['expiry', 'revoke', 'token'] as const) await lateCleanupFault(mode)
  })
})
