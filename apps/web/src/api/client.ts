// The Core API client. The console has exactly one backend (ADR-0003), and this is
// the only module that speaks to it: ESLint bans the global `fetch` everywhere else,
// so a call to a second origin is a lint error rather than a review catch.
//
// What the client adds to the generated types:
//
// - the bearer token, from an in-memory provider that nothing here stores;
// - an `Idempotency-Key` on every POST, which the contract requires;
// - `X-Request-Id` capture, so a support ticket can quote the failing request;
// - a non-2xx response raised as `ApiProblem`, and an unreachable network as
//   `NetworkError`, so a caller never has to remember to check a result object.

import createClient from 'openapi-fetch'
import type { Middleware } from 'openapi-fetch'
import { coreApiUrl } from '../config'
import { PROBLEM_TYPES, type ProblemType } from './generated/problems'
import type { operations, paths } from './schema'

export interface ProblemFieldError {
  readonly pointer: string
  readonly code: string
  readonly detail?: string
}

/**
 * An RFC 9457 problem document from the Core API.
 *
 * Callers switch on `type` and map it to a message-catalogue key. They never render
 * `title` or `detail`: both are English staff-facing prose that the contract is free
 * to reword, and neither is a sentence a customer should read (docs/dev/I18N.md).
 */
export class ApiProblem extends Error {
  /**
   * The problem type, when it is one of the 23 the contract registers.
   *
   * `null` means the server answered a non-2xx that is not a registered problem —
   * an edge returning HTML, a proxy timing out. Nothing here maps that to a type the
   * registry does not contain: the console would render a message for a condition
   * the API never reported. Treat `null` as "unknown failure, quote the request id".
   */
  readonly type: ProblemType | null
  readonly status: number
  /** Staff-facing prose. Never rendered to a customer. */
  readonly title: string
  /** Staff-facing prose. Never rendered to a customer; kept for logs and support. */
  readonly detail: string | undefined
  readonly requestId: string | undefined
  readonly errors: readonly ProblemFieldError[]
  readonly allowedStates: readonly string[]
  readonly retryAfterS: number | undefined
  /**
   * The tag to re-read against, on `precondition-failed` (412): the `If-Match` sent did
   * not match the resource's current `ETag`, and this is what it is now. `undefined` on
   * every other type, including `precondition-required` (428), which carries no data of
   * its own — a `PATCH` sent no `If-Match` at all, so there is nothing to compare.
   */
  readonly currentEtag: string | undefined
  /**
   * Free names to offer instead, on `slug-taken` (409): up to three tenant slugs Core found
   * free when it refused. Empty on every other type.
   */
  readonly suggestions: readonly string[]

  constructor(fields: {
    type: ProblemType | null
    status: number
    title: string
    detail?: string | undefined
    requestId?: string | undefined
    errors?: readonly ProblemFieldError[] | undefined
    allowedStates?: readonly string[] | undefined
    retryAfterS?: number | undefined
    currentEtag?: string | undefined
    suggestions?: readonly string[] | undefined
  }) {
    super(`${fields.status} ${fields.type ?? 'unregistered problem'}`)
    this.name = 'ApiProblem'
    this.type = fields.type
    this.status = fields.status
    this.title = fields.title
    this.detail = fields.detail
    this.requestId = fields.requestId
    this.errors = fields.errors ?? []
    this.allowedStates = fields.allowedStates ?? []
    this.retryAfterS = fields.retryAfterS
    this.currentEtag = fields.currentEtag
    this.suggestions = fields.suggestions ?? []
  }
}

/**
 * The Core API could not be reached at all: DNS, TLS, an offline browser, a request
 * the page aborted. Deliberately not an `ApiProblem`: the problem registry is closed,
 * and a locally invented `type` would be a member no message catalogue and no upstream
 * document knows about.
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('The Core API could not be reached.', { cause })
    this.name = 'NetworkError'
  }
}

const isProblemType = (value: unknown): value is ProblemType =>
  typeof value === 'string' && (PROBLEM_TYPES as readonly string[]).includes(value)

async function problemFrom(response: Response): Promise<ApiProblem> {
  const requestId = response.headers.get('X-Request-Id') ?? undefined
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.clone().json()
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    // Not JSON. `type` stays null and the status carries the whole message.
  }
  const type = isProblemType(body['type']) ? body['type'] : null
  return new ApiProblem({
    type,
    status: response.status,
    title: typeof body['title'] === 'string' ? body['title'] : response.statusText,
    detail: typeof body['detail'] === 'string' ? body['detail'] : undefined,
    requestId: typeof body['request_id'] === 'string' ? body['request_id'] : requestId,
    errors: Array.isArray(body['errors']) ? (body['errors'] as ProblemFieldError[]) : undefined,
    allowedStates: Array.isArray(body['allowed_states'])
      ? (body['allowed_states'] as string[])
      : undefined,
    retryAfterS: typeof body['retry_after_s'] === 'number' ? body['retry_after_s'] : undefined,
    currentEtag: typeof body['current_etag'] === 'string' ? body['current_etag'] : undefined,
    suggestions: Array.isArray(body['suggestions'])
      ? body['suggestions'].filter((value): value is string => typeof value === 'string')
      : undefined,
  })
}

/**
 * Where the access token comes from. Set once by the auth adapter (ADR-0007); the
 * token is short-lived and lives in memory only — nothing here writes it to
 * `localStorage`, to a log, or to an error report.
 */
export type TokenProvider = () => string | undefined

let tokenProvider: TokenProvider = () => undefined

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider
}

let lastId: string | undefined

/** The `X-Request-Id` of the most recent response. What a customer quotes to support. */
export function lastRequestId(): string | undefined {
  return lastId
}

const middleware: Middleware = {
  onRequest({ request }) {
    const token = tokenProvider()
    if (token !== undefined) request.headers.set('Authorization', `Bearer ${token}`)
    // The contract requires a key on every POST, and a retried order that creates a
    // second one is exactly what it prevents. A caller that supplies its own — a
    // deliberate retry of the same intent — keeps it.
    if (request.method === 'POST' && !request.headers.has('Idempotency-Key')) {
      request.headers.set('Idempotency-Key', crypto.randomUUID())
    }
    return request
  },
  async onResponse({ response }) {
    lastId = response.headers.get('X-Request-Id') ?? undefined
    if (!response.ok) throw await problemFrom(response)
    return undefined
  },
  onError({ error }) {
    // Returning an Error replaces what openapi-fetch is about to throw.
    return new NetworkError(error)
  },
}

export type CoreClient = ReturnType<typeof createClient<paths>>

const clients = new Map<string, CoreClient>()

/**
 * The typed Core API client.
 *
 * Built on first use rather than at import time, so a missing `VITE_` variable fails
 * on the first request with the variable's name in the message instead of taking down
 * whatever module happened to import this one. Memoised per base URL.
 */
export function coreApi(): CoreClient {
  const baseUrl = coreApiUrl()
  const existing = clients.get(baseUrl)
  if (existing !== undefined) return existing
  const client = createClient<paths>({ baseUrl })
  client.use(middleware)
  clients.set(baseUrl, client)
  return client
}

type OwnerClaimConsume = operations['consumeOwnerClaim']
type OwnerClaimBody = OwnerClaimConsume['requestBody']['content']['application/json']
type OwnerClaimKey = OwnerClaimConsume['parameters']['header']['Idempotency-Key']
type OwnerClaimResult = OwnerClaimConsume['responses'][200]['content']['application/json']

export interface OwnerClaimBorrow {
  idempotencyKey: OwnerClaimKey | undefined
  body: OwnerClaimBody | undefined
  expectedAccessToken: string | undefined
  signal: AbortSignal | undefined
}

export interface OwnerClaimDispatchSource {
  isCurrent(): boolean
  borrow(): OwnerClaimBorrow | undefined
  releaseBorrow(borrow: OwnerClaimBorrow): void
}

type OwnerClaimRefusal = 'ineligible' | 'invalid-input' | 'invalid-config'
type OwnerClaimStarted = {
  readonly kind: 'started'
  readonly result: Promise<OwnerClaimResult>
  retire(): void
}
export type OwnerClaimDispatch =
  { readonly kind: 'not-started'; readonly reason: OwnerClaimRefusal } | OwnerClaimStarted

interface OwnerClaimCell {
  retired: boolean
  settled: boolean
  url: string
  init: {
    method: 'POST'
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
  expectedAccessToken?: string
  observation?: OwnerClaimObservationState
  source?: OwnerClaimDispatchSource
  borrow?: OwnerClaimBorrow
  controller?: AbortController
  external?: AbortSignal
  listener?: () => void
  response?: Response
  result: Promise<OwnerClaimResult>
  resolve?: (value: OwnerClaimResult) => void
  reject?: (error: unknown) => void
}

export interface OwnerClaimObservation {
  revoke(): void
}

type OwnerClaimObservationState = {
  active: boolean
  validBefore: number
  lastSample: number
}

const ownerClaimObservations = new WeakMap<object, OwnerClaimObservationState>()

export function createOwnerClaimObservation(validBefore: number): OwnerClaimObservation {
  const sample = performance.now()
  if (
    !Number.isFinite(validBefore) ||
    validBefore < 0 ||
    validBefore > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(sample) ||
    sample < 0 ||
    sample > Number.MAX_SAFE_INTEGER ||
    validBefore <= sample
  )
    throw new RangeError('Owner-claim observation deadline refused.')
  const state = { active: true, validBefore, lastSample: sample }
  const observation = Object.freeze({
    revoke: () => {
      state.active = false
    },
  })
  ownerClaimObservations.set(observation, state)
  return observation
}

function refuseOwnerClaimObservation(cell: OwnerClaimCell, primary: unknown): void {
  if (cell.retired || cell.settled) return
  const reject = cell.reject
  cell.settled = true
  let failed = false
  let cleanup: unknown
  try {
    retireOwnerClaimCell(cell)
  } catch (error) {
    failed = true
    cleanup = error
  }
  reject?.(
    failed
      ? new AggregateError([primary, cleanup], 'Owner-claim observation cleanup failed.')
      : primary
  )
}

type OwnerClaimObservationDecision = { ok: true } | { ok: false; error: unknown }

function decideOwnerClaimObservation(
  observation: OwnerClaimObservationState,
  expectedAccessToken: string | undefined
): OwnerClaimObservationDecision {
  try {
    const observedToken = tokenProvider()
    const sample = performance.now()
    if (
      !observation.active ||
      !Number.isFinite(sample) ||
      sample < 0 ||
      sample > Number.MAX_SAFE_INTEGER ||
      sample < observation.lastSample ||
      sample >= observation.validBefore ||
      observedToken === undefined ||
      observedToken.length === 0 ||
      expectedAccessToken !== observedToken
    ) {
      observation.active = false
      return { ok: false, error: new DOMException('Owner-claim dispatch retired.', 'AbortError') }
    }
    observation.lastSample = sample
    return { ok: true }
  } catch (error) {
    observation.active = false
    return { ok: false, error }
  }
}

function admitOwnerClaimObservation(cell: OwnerClaimCell): boolean {
  const observation = cell.observation
  if (observation === undefined) return true
  const decision = decideOwnerClaimObservation(observation, cell.expectedAccessToken)
  if (cell.retired || cell.settled || cell.observation !== observation) {
    observation.active = false
    return false
  }
  if (!decision.ok) {
    refuseOwnerClaimObservation(cell, decision.error)
    return false
  }
  return true
}

function admitOwnerClaimPublication(
  observation: OwnerClaimObservationState,
  expectedAccessToken: string | undefined,
  reject: ((error: unknown) => void) | undefined
): boolean {
  const decision = decideOwnerClaimObservation(observation, expectedAccessToken)
  if (decision.ok) return true
  reject?.(decision.error)
  return false
}

function observeOwnerClaimRejection(): undefined {
  return undefined
}

function createOwnerClaimCell(source: OwnerClaimDispatchSource): OwnerClaimCell {
  const settlement: {
    resolve?: (value: OwnerClaimResult) => void
    reject?: (error: unknown) => void
  } = {}
  const result = new Promise<OwnerClaimResult>((resolve, reject) => {
    settlement.resolve = resolve
    settlement.reject = reject
  })
  void result.catch(observeOwnerClaimRejection)
  return {
    retired: false,
    settled: false,
    url: '',
    init: { method: 'POST', headers: {} },
    source,
    result,
    resolve: settlement.resolve!,
    reject: settlement.reject!,
  }
}

function materializeOwnerClaimBody(value: unknown): OwnerClaimBody | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return undefined
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'token' && key !== 'display_name') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      return undefined
  }
  const token = Object.getOwnPropertyDescriptor(value, 'token')
  const name = Object.getOwnPropertyDescriptor(value, 'display_name')
  if (token === undefined || !('value' in token) || typeof token.value !== 'string')
    return undefined
  if (name !== undefined && typeof name.value !== 'string' && name.value !== null) return undefined
  return name === undefined
    ? { token: token.value }
    : { token: token.value, display_name: name.value }
}

function ownerClaimUrl(): string | undefined {
  const configured = coreApiUrl()
  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    return undefined
  }
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return undefined
  return parsed.origin + parsed.pathname.replace(/\/$/, '') + '/owner-claims/actions/consume'
}

function retireOwnerClaimCell(cell: OwnerClaimCell): void {
  if (cell.retired) return
  cell.retired = true
  const controller = cell.controller
  const external = cell.external
  const listener = cell.listener
  const reject = cell.reject
  const pending = !cell.settled
  cell.settled = true
  delete cell.init.body
  delete cell.init.headers['Authorization']
  delete cell.init.headers['Idempotency-Key']
  delete cell.init.signal
  delete cell.expectedAccessToken
  delete cell.observation
  delete cell.source
  delete cell.borrow
  delete cell.controller
  delete cell.external
  delete cell.listener
  delete cell.response
  delete cell.resolve
  delete cell.reject
  cell.url = ''
  const failures: unknown[] = []
  try {
    if (external !== undefined && listener !== undefined)
      external.removeEventListener('abort', listener)
  } catch (error) {
    failures.push(error)
  }
  try {
    controller?.abort()
  } catch (error) {
    failures.push(error)
  }
  if (pending) reject?.(new DOMException('Owner-claim dispatch retired.', 'AbortError'))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Owner-claim retirement failed.')
}

function ownerClaimAbortListener(cell: OwnerClaimCell): () => void {
  return () => retireOwnerClaimCell(cell)
}

function settleOwnerClaimCell(
  cell: OwnerClaimCell,
  outcome: { ok: true; value: OwnerClaimResult } | { ok: false; error: unknown }
): void {
  if (cell.retired || cell.settled) return
  const observation = cell.observation
  if (observation !== undefined) {
    const resolve = cell.resolve
    const reject = cell.reject
    let expectedAccessToken = cell.expectedAccessToken
    cell.settled = true
    try {
      try {
        retireOwnerClaimCell(cell)
      } catch (error) {
        observation.active = false
        reject?.(
          new AggregateError(
            outcome.ok ? [error] : [outcome.error, error],
            'Owner-claim settlement cleanup failed.'
          )
        )
        return
      }
      if (!admitOwnerClaimPublication(observation, expectedAccessToken, reject)) return
    } finally {
      expectedAccessToken = undefined
    }
    if (outcome.ok) resolve?.(outcome.value)
    else reject?.(outcome.error)
    return
  }
  const resolve = cell.resolve
  const reject = cell.reject
  cell.settled = true
  try {
    retireOwnerClaimCell(cell)
  } catch (error) {
    reject?.(
      new AggregateError(
        outcome.ok ? [error] : [outcome.error, error],
        'Owner-claim settlement cleanup failed.'
      )
    )
    return
  }
  if (outcome.ok) resolve?.(outcome.value)
  else reject?.(outcome.error)
}

function ownerClaimParseFailure(error: unknown): Error {
  return error instanceof SyntaxError
    ? new SyntaxError('The Core API returned invalid JSON.')
    : new NetworkError(undefined)
}

function observeOwnerClaimResponse(cell: OwnerClaimCell, response: Response): void {
  if (cell.retired) return
  if (!admitOwnerClaimObservation(cell)) return
  cell.response = response
  lastId = response.headers.get('X-Request-Id') ?? undefined
  if (response.status === 200) {
    let parsed: Promise<unknown>
    try {
      parsed = response.json()
    } catch (error) {
      settleOwnerClaimCell(cell, { ok: false, error: ownerClaimParseFailure(error) })
      return
    }
    void parsed.then(
      (value) => settleOwnerClaimCell(cell, { ok: true, value: value as OwnerClaimResult }),
      (error: unknown) =>
        settleOwnerClaimCell(cell, { ok: false, error: ownerClaimParseFailure(error) })
    )
  } else {
    void problemFrom(response).then(
      (error) => settleOwnerClaimCell(cell, { ok: false, error }),
      () => settleOwnerClaimCell(cell, { ok: false, error: new NetworkError(undefined) })
    )
  }
}

function createOwnerClaimWork(cell: OwnerClaimCell, native: Promise<Response>): OwnerClaimStarted {
  void native.then(
    (response) => observeOwnerClaimResponse(cell, response),
    () => settleOwnerClaimCell(cell, { ok: false, error: new NetworkError(undefined) })
  )
  return { kind: 'started', result: cell.result, retire: () => retireOwnerClaimCell(cell) }
}

function invokeOwnerClaimNative(
  isCurrent: () => boolean,
  cell: OwnerClaimCell,
  observedToken: string | undefined
): Promise<Response> | undefined {
  if (!isCurrent() || cell.retired || cell.expectedAccessToken !== observedToken) return undefined
  try {
    return fetch(cell.url, cell.init)
  } catch {
    return Promise.reject(new NetworkError(undefined))
  }
}

export function dispatchOwnerClaim(
  source: OwnerClaimDispatchSource,
  observation?: OwnerClaimObservation
): OwnerClaimDispatch {
  let observationState: OwnerClaimObservationState | undefined
  if (observation !== undefined) {
    if (observation === null || typeof observation !== 'object')
      return { kind: 'not-started', reason: 'invalid-input' }
    observationState = ownerClaimObservations.get(observation)
    if (observationState === undefined) return { kind: 'not-started', reason: 'invalid-input' }
    if (!observationState.active) return { kind: 'not-started', reason: 'ineligible' }
  }
  if (!source.isCurrent()) return { kind: 'not-started', reason: 'ineligible' }
  const cell = createOwnerClaimCell(source)
  if (observationState !== undefined) cell.observation = observationState
  let borrow: OwnerClaimBorrow | undefined
  let refusal: OwnerClaimRefusal | undefined
  let primaryFailed = false
  let primary: unknown
  const cleanup: unknown[] = []
  try {
    borrow = source.borrow()
    if (borrow === undefined) refusal = 'ineligible'
    else {
      cell.borrow = borrow
      const body = materializeOwnerClaimBody(borrow.body)
      if (
        body === undefined ||
        typeof borrow.idempotencyKey !== 'string' ||
        borrow.idempotencyKey.length < 16 ||
        borrow.idempotencyKey.length > 255 ||
        /[^\x21-\x7e]/.test(borrow.idempotencyKey)
      )
        refusal = 'invalid-input'
      else if (
        typeof borrow.expectedAccessToken !== 'string' ||
        !borrow.expectedAccessToken ||
        !(borrow.signal instanceof AbortSignal) ||
        borrow.signal.aborted
      )
        refusal = 'ineligible'
      else {
        const url = ownerClaimUrl()
        if (url === undefined) refusal = 'invalid-config'
        else {
          cell.url = url
          cell.expectedAccessToken = borrow.expectedAccessToken
          cell.controller = new AbortController()
          cell.init = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': borrow.idempotencyKey,
              Authorization: 'Bearer ' + borrow.expectedAccessToken,
            },
            body: JSON.stringify(body),
            signal: cell.controller.signal,
          }
          cell.external = borrow.signal
          cell.listener = ownerClaimAbortListener(cell)
          cell.external.addEventListener('abort', cell.listener, { once: true })
          if (cell.external.aborted) retireOwnerClaimCell(cell)
        }
      }
    }
  } catch (error) {
    primaryFailed = true
    primary = error
  } finally {
    if (borrow !== undefined) {
      try {
        source.releaseBorrow(borrow)
      } catch (error) {
        if (primaryFailed) cleanup.push(error)
        else {
          primaryFailed = true
          primary = error
        }
      }
    }
    delete cell.borrow
    delete cell.source
  }
  if (primaryFailed) {
    try {
      retireOwnerClaimCell(cell)
    } catch (error) {
      cleanup.push(error)
    }
    if (cleanup.length !== 0)
      throw new AggregateError([primary, ...cleanup], 'Owner-claim setup cleanup failed.')
    throw primary
  }
  if (refusal !== undefined) {
    retireOwnerClaimCell(cell)
    return { kind: 'not-started', reason: refusal }
  }
  try {
    const observedToken = tokenProvider()
    if (observedToken === undefined || observedToken.length === 0) {
      retireOwnerClaimCell(cell)
      return { kind: 'not-started', reason: 'ineligible' }
    }
    const native = invokeOwnerClaimNative(source.isCurrent.bind(source), cell, observedToken)
    if (native === undefined) {
      retireOwnerClaimCell(cell)
      return { kind: 'not-started', reason: 'ineligible' }
    }
    return createOwnerClaimWork(cell, native)
  } catch (error) {
    try {
      retireOwnerClaimCell(cell)
    } catch (failure) {
      throw new AggregateError([error, failure], 'Owner-claim setup cleanup failed.')
    }
    throw error
  }
}
