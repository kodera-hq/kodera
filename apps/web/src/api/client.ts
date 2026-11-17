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
import type { AuthLifetime } from '../auth/AuthProvider'
import type { AuthSessionSnapshot } from '../auth/AuthAdapter'

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
    const expectedAccessToken = { value: cell.expectedAccessToken }
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
      if (!admitOwnerClaimPublication(observation, expectedAccessToken.value, reject)) return
    } finally {
      expectedAccessToken.value = undefined
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
      throw new AggregateError([error, failure], 'Owner-claim setup cleanup failed.', {
        cause: failure,
      })
    }
    throw error
  }
}

import { parseDevicePrincipal } from '../features/confidential/device-principal'
import type { DevicePrincipal } from '../features/confidential/device-principal'

// Application-private ADR-0014 transport. Only the fixed worker factory imports
// the binder; its structural argument types are not authentication capabilities.
const deviceNow = performance.now.bind(performance)
const deviceWall = Date.now.bind(Date)
const deviceEncoder = new TextEncoder()
const DEVICE_RETRY_MS = 86_100_000 // 23h55m scheduling metadata, never server receipt authority.
const DEVICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEVICE_HEX = /^[0-9a-f]{64}$/
const DEVICE_NIL = '00000000-0000-0000-0000-000000000000'
const deviceTyped = Object.getPrototypeOf(Uint8Array.prototype) as object
const deviceBuffer = Object.getOwnPropertyDescriptor(deviceTyped, 'buffer')!.get!
const deviceLength = Object.getOwnPropertyDescriptor(deviceTyped, 'byteLength')!.get!
const deviceOffset = Object.getOwnPropertyDescriptor(deviceTyped, 'byteOffset')!.get!
const deviceResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get

type DeviceLease = Readonly<{ isCurrent: () => boolean }>
type DeviceCapture = (rpcId: number) => DeviceLease | undefined
type DeviceCode =
  'invalid-input' | 'invalid-config' | 'ineligible' | 'network' | 'invalid-response' | 'capacity'
class DeviceDispatchFailure extends Error {
  constructor(readonly code: DeviceCode) {
    super('Confidential device dispatch refused.')
    this.name = 'DeviceDispatchFailure'
  }
}
function deviceFail(code: DeviceCode = 'invalid-input'): never {
  throw new DeviceDispatchFailure(code)
}
function deviceNeed(condition: unknown, code: DeviceCode = 'invalid-input'): asserts condition {
  if (!condition) deviceFail(code)
}
function deviceId(value: unknown): asserts value is string {
  deviceNeed(
    typeof value === 'string' &&
      value.length === 36 &&
      DEVICE_UUID.test(value) &&
      value !== DEVICE_NIL
  )
}
function deviceInteger(value: unknown, positive = true): asserts value is number {
  deviceNeed(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
  )
}
function deviceFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  deviceNeed(
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  )
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  deviceNeed(
    actual.length === keys.length &&
      actual.every((key) => typeof key === 'string' && keys.includes(key))
  )
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    deviceNeed(descriptor && descriptor.enumerable && 'value' in descriptor)
    result[key] = descriptor.value
  }
  return result
}
function deviceBytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  deviceNeed(value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
  const buffer: unknown = Reflect.apply(deviceBuffer, value, [])
  const length: number = Reflect.apply(deviceLength, value, [])
  const offset: number = Reflect.apply(deviceOffset, value, [])
  deviceNeed(
    buffer instanceof ArrayBuffer &&
      (!deviceResizable || Reflect.apply(deviceResizable, buffer, []) === false) &&
      length > 0 &&
      length <= maximum
  )
  const copy = new Uint8Array(length)
  copy.set(new Uint8Array(buffer, offset, length))
  return copy
}
function deviceBaseCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 32 || code === 127 || code === 92 || code === 37) return false
  }
  return true
}
function deviceAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 127) return false
  }
  return true
}
function deviceBaseUrl(): string {
  let configured: string
  try {
    configured = coreApiUrl()
  } catch {
    deviceFail('invalid-config')
  }
  deviceNeed(configured.length <= 2048 && deviceBaseCharacters(configured), 'invalid-config')
  const raw = /^(https?):\/\/[^/?#]+(\/[^?#]*)$/.exec(configured)
  deviceNeed(raw, 'invalid-config')
  const path = raw[2]!.replace(/\/$/, '')
  const segments = path.split('/').slice(1)
  deviceNeed(
    segments.length >= 2 &&
      segments.at(-2) === 'api' &&
      segments.at(-1) === 'v1' &&
      segments.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9._~-]+$/.test(part)),
    'invalid-config'
  )
  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    deviceFail('invalid-config')
  }
  deviceNeed(
    !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname.replace(/\/$/, '') === path,
    'invalid-config'
  )
  deviceNeed(
    parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)),
    'invalid-config'
  )
  return parsed.origin + path
}

interface DeviceAuth {
  generation: number
  credentialGeneration: number
  realm: string
  issuer: string
  subject: string
  stamp: object
}
interface DeviceDescriptor {
  version: 2
  actorOperation: number
  recordId: string
  operation: 'register' | 'publish-package'
  operationId: string
  ownerId: string
  organisationId: string
  membershipId: string
  devicePublicKey: string
  nativeGeneration: number
  hostGeneration: number
  bodySha256: string
  recordSha256: string
}
interface DeviceBinding {
  active: boolean
  brokenClock: boolean
  base: string
  slug: string
  nonce: string
  worker: Worker
  port: MessagePort
  lifetime: AuthLifetime
  auth: DeviceAuth
  token: string | undefined
  capture: DeviceCapture
  lastClock: number
  principal?: DevicePrincipal
  cells: Map<string, DeviceCell>
  unsubscribe?: () => void
  listener?: (event: MessageEvent<unknown>) => void
}
interface DeviceCell {
  binding: DeviceBinding
  id: string
  rpcId: number
  lease: DeviceLease
  mode: 'initialize' | 'attempt'
  finished: boolean
  consumed: boolean
  observing: boolean
  observedAt?: number
  descriptor?: DeviceDescriptor
  body?: Uint8Array<ArrayBuffer>
  principal?: DevicePrincipal
  initializationMode?: 'create' | 'restore'
  native?: DeviceNativeCell
  response?: Response
  reader?: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
}
interface DeviceNativeCell {
  owner: DeviceCell
  url: string
  init: RequestInit
  controller: AbortController
  startedAt: number
  deadline: number
  post: boolean
  used: boolean
}
const deviceBindings = new WeakMap<MessagePort, DeviceBinding>()
const deviceNativeCells = new WeakSet<DeviceNativeCell>()

function deviceAuth(lifetime: AuthLifetime): DeviceAuth {
  try {
    const snapshot: AuthSessionSnapshot = lifetime.getSnapshot()
    deviceNeed(
      snapshot.status === 'ready' && snapshot.user?.identity && lifetime.hasUsableCredential(),
      'ineligible'
    )
    deviceInteger(snapshot.generation, false)
    deviceInteger(snapshot.credentialGeneration, false)
    const { issuer, subject } = snapshot.user.identity
    deviceNeed(
      typeof issuer === 'string' &&
        issuer.length > 0 &&
        issuer.length <= 2048 &&
        deviceEncoder.encode(issuer).length <= 2048 &&
        typeof subject === 'string' &&
        subject.length > 0 &&
        subject.length <= 255 &&
        deviceAscii(subject) &&
        typeof snapshot.user.realm === 'string' &&
        snapshot.user.realm.length > 0 &&
        snapshot.user.realm.length <= 64 &&
        deviceEncoder.encode(snapshot.user.realm).length <= 64,
      'ineligible'
    )
    const stamp = lifetime.getRetirementStamp()
    deviceNeed(stamp !== null && typeof stamp === 'object', 'ineligible')
    return {
      generation: snapshot.generation,
      credentialGeneration: snapshot.credentialGeneration,
      realm: snapshot.user.realm,
      issuer,
      subject,
      stamp,
    }
  } catch (error) {
    if (error instanceof DeviceDispatchFailure) throw error
    deviceFail('ineligible')
  }
}
function deviceClock(binding: DeviceBinding): number | undefined {
  let sample: number
  try {
    sample = deviceNow()
  } catch {
    binding.brokenClock = true
    return undefined
  }
  if (
    binding.brokenClock ||
    !Number.isFinite(sample) ||
    sample < 0 ||
    sample > Number.MAX_SAFE_INTEGER ||
    sample < binding.lastClock
  ) {
    binding.brokenClock = true
    return undefined
  }
  binding.lastClock = sample
  return sample
}
function deviceCurrent(binding: DeviceBinding, lease?: DeviceLease): boolean {
  if (!binding.active) return false
  try {
    const current = deviceAuth(binding.lifetime)
    const token = tokenProvider()
    const same =
      current.generation === binding.auth.generation &&
      current.credentialGeneration === binding.auth.credentialGeneration &&
      current.realm === binding.auth.realm &&
      current.issuer === binding.auth.issuer &&
      current.subject === binding.auth.subject &&
      current.stamp === binding.auth.stamp &&
      token !== undefined &&
      token.length > 0 &&
      token === binding.token
    if (!same || !binding.active) return false
    const live = lease === undefined || lease.isCurrent() === true
    return binding.active && live
  } catch {
    return false
  }
}
function deviceDropCell(cell: DeviceCell): void {
  if (cell.finished) return
  cell.finished = true
  cell.binding.cells.delete(cell.id)
  const timer = cell.timer,
    reader = cell.reader,
    controller = cell.controller,
    response = cell.response,
    native = cell.native
  delete cell.timer
  delete cell.reader
  delete cell.controller
  delete cell.body
  delete cell.descriptor
  delete cell.principal
  delete cell.response
  delete cell.native
  delete cell.initializationMode
  if (native) {
    delete native.init.headers
    delete native.init.body
    native.init = {}
  }
  if (timer !== undefined) clearTimeout(timer)
  try {
    void reader?.cancel().catch(() => {})
  } catch {
    /* Late reader cleanup cannot revive a cell. */
  }
  if (!reader) {
    try {
      void response?.body?.cancel().catch(() => {})
    } catch {
      /* Unread refused response is not retained. */
    }
  }
  try {
    reader?.releaseLock()
  } catch {
    /* A pending native read may still settle after abort. */
  }
  try {
    controller?.abort()
  } catch {
    /* No untrusted error text or retired output escapes. */
  }
}
function closeDeviceBinding(binding: DeviceBinding): void {
  if (!binding.active) return
  binding.active = false
  binding.token = undefined
  for (const cell of [...binding.cells.values()]) deviceDropCell(cell)
  const listener = binding.listener,
    unsubscribe = binding.unsubscribe
  delete binding.listener
  delete binding.unsubscribe
  delete binding.principal
  if (listener) binding.port.removeEventListener('message', listener)
  try {
    unsubscribe?.()
  } catch {
    /* Closed remains final under reentrancy. */
  }
  binding.port.close()
}
function devicePost(
  binding: DeviceBinding,
  lease: DeviceLease,
  rpcId: number,
  fields: Record<string, unknown>,
  deadline?: number
): boolean {
  const failure =
    fields.kind === 'refused' ||
    (fields.kind === 'attempt-outcome' &&
      fields.outcome !== null &&
      typeof fields.outcome === 'object' &&
      'kind' in fields.outcome &&
      fields.outcome.kind === 'unknown')
  if (!deviceCurrent(binding, lease)) return false
  // Currentness and cleanup may synchronously call application code. Sample
  // last, against the original network/observation deadline, without renewal.
  const now = failure ? undefined : deviceClock(binding)
  if (!failure && (now === undefined || (deadline !== undefined && now > deadline))) return false
  if (!binding.active) return false
  binding.port.postMessage({ version: 1, nonce: binding.nonce, rpcId, ...fields })
  return true
}
function deviceComplete(cell: DeviceCell, fields: Record<string, unknown>): void {
  if (cell.finished) return
  const { binding, lease, rpcId } = cell
  const id = cell.id
  const deadline = cell.native?.deadline ?? (cell.observedAt === undefined ? undefined : cell.observedAt + 5000)
  const consumed = cell.mode === 'attempt' && cell.consumed
  deviceDropCell(cell)
  if (!devicePost(binding, lease, rpcId, { cellId: id, ...fields }, deadline)) {
    devicePost(binding, lease, rpcId, consumed
      ? { cellId: id, kind: 'attempt-outcome', outcome: { kind: 'unknown' } }
      : { cellId: id, kind: 'refused', code: 'ineligible' })
  }
}
function deviceRefuse(cell: DeviceCell, code: DeviceCode): void {
  deviceComplete(
    cell,
    cell.mode === 'attempt' && cell.consumed
      ? { kind: 'attempt-outcome', outcome: { kind: 'unknown' } }
      : { kind: 'refused', code }
  )
}
function deviceTimer(cell: DeviceCell, milliseconds: number): void {
  if (cell.timer !== undefined) clearTimeout(cell.timer)
  cell.timer = setTimeout(() => deviceRefuse(cell, 'network'), milliseconds)
}
function deviceDescriptor(text: unknown): DeviceDescriptor {
  deviceNeed(
    typeof text === 'string' && text.length > 0 && text.length <= 2048 && !/[^\x20-\x7e]/.test(text)
  )
  const parsed: unknown = JSON.parse(text)
  const value = deviceFields(parsed, [
    'version',
    'actorOperation',
    'recordId',
    'operation',
    'operationId',
    'ownerId',
    'organisationId',
    'membershipId',
    'devicePublicKey',
    'nativeGeneration',
    'hostGeneration',
    'bodySha256',
    'recordSha256',
  ])
  deviceNeed(
    JSON.stringify(parsed) === text &&
      value.version === 2 &&
      (value.operation === 'register' || value.operation === 'publish-package')
  )
  for (const key of ['recordId', 'operationId', 'ownerId', 'organisationId', 'membershipId'])
    deviceId(value[key])
  for (const key of ['actorOperation', 'nativeGeneration', 'hostGeneration'])
    deviceInteger(value[key])
  deviceNeed(Number(value.hostGeneration) >= Number(value.nativeGeneration))
  for (const key of ['devicePublicKey', 'bodySha256', 'recordSha256'])
    deviceNeed(typeof value[key] === 'string' && DEVICE_HEX.test(value[key]))
  const actorOperation = value.actorOperation,
    nativeGeneration = value.nativeGeneration,
    hostGeneration = value.hostGeneration
  deviceInteger(actorOperation)
  deviceInteger(nativeGeneration)
  deviceInteger(hostGeneration)
  const recordId = value.recordId,
    operationId = value.operationId,
    ownerId = value.ownerId,
    organisationId = value.organisationId,
    membershipId = value.membershipId
  deviceId(recordId)
  deviceId(operationId)
  deviceId(ownerId)
  deviceId(organisationId)
  deviceId(membershipId)
  const devicePublicKey = value.devicePublicKey,
    bodySha256 = value.bodySha256,
    recordSha256 = value.recordSha256
  deviceNeed(
    typeof devicePublicKey === 'string' &&
      typeof bodySha256 === 'string' &&
      typeof recordSha256 === 'string'
  )
  return {
    version: 2,
    actorOperation,
    nativeGeneration,
    hostGeneration,
    recordId,
    operationId,
    ownerId,
    organisationId,
    membershipId,
    operation: value.operation,
    devicePublicKey,
    bodySha256,
    recordSha256,
  }
}
async function deviceHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
function sameDeviceBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function deviceNewCell(
  binding: DeviceBinding,
  rpcId: number,
  mode: 'initialize' | 'attempt',
  lease: DeviceLease | undefined
): DeviceCell {
  deviceNeed(binding.cells.size === 0, 'capacity')
  deviceNeed(
    binding.active &&
      lease &&
      typeof lease.isCurrent === 'function' &&
      deviceCurrent(binding, lease),
    'ineligible'
  )
  const cell: DeviceCell = {
    binding,
    id: crypto.randomUUID(),
    rpcId,
    lease,
    mode,
    finished: false,
    consumed: false,
    observing: true,
  }
  binding.cells.set(cell.id, cell)
  return cell
}
function deviceNative(cell: DeviceCell, post: boolean): DeviceNativeCell {
  const { binding } = cell
  deviceNeed(!cell.finished && deviceCurrent(binding, cell.lease), 'ineligible')
  const start = deviceClock(binding)
  deviceNeed(start !== undefined, 'ineligible')
  const controller = new AbortController()
  cell.controller = controller
  const headers: Record<string, string> = { Authorization: 'Bearer ' + binding.token }
  let url = binding.base + '/me'
  const init: RequestInit = {
    method: post ? 'POST' : 'GET',
    headers,
    signal: controller.signal,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  }
  if (post) {
    const descriptor = cell.descriptor,
      principal = binding.principal
    deviceNeed(descriptor && principal && cell.body)
    const suffix = descriptor.operation === 'register' ? 'devices' : 'key-packages'
    url = binding.base + '/organisations/' + principal.organisationId + '/confidential/' + suffix
    headers['Content-Type'] = 'application/json'
    headers['Idempotency-Key'] = descriptor.operationId
    init.body = new Uint8Array(cell.body)
  }
  const value: DeviceNativeCell = {
    owner: cell,
    url,
    init,
    controller,
    startedAt: start,
    deadline: start + (post ? 30000 : 10000),
    post,
    used: false,
  }
  cell.native = value
  deviceNativeCells.add(value)
  deviceTimer(cell, post ? 30000 : 10000)
  return value
}

function invokeConfidentialDeviceNative(cell: DeviceNativeCell): Promise<Response> | undefined {
  if (!deviceNativeCells.has(cell) || cell.used || cell.owner.finished) return undefined
  const owner = cell.owner,
    binding = owner.binding
  if (!deviceCurrent(binding, owner.lease)) return undefined
  // The actual provider lookup is final; reentrant retirement cannot be masked
  // by a predicate that returns true. No user callback follows these checks.
  let token: string | undefined
  try {
    token = tokenProvider()
  } catch {
    return undefined
  }
  if (!binding.active || owner.finished || token === undefined || token !== binding.token)
    return undefined
  // Sample after every reentrant callback. No callback or await may follow
  // this final deadline/age check before the private consume and fetch call.
  const now = deviceClock(binding)
  if (
    now === undefined ||
    now > cell.deadline ||
    (cell.post &&
      (owner.consumed ||
        owner.observing ||
        owner.observedAt === undefined ||
        now - owner.observedAt > 5000))
  )
    return undefined
  cell.used = true
  deviceNativeCells.delete(cell)
  if (cell.post) owner.consumed = true
  try {
    return fetch(cell.url, cell.init)
  } catch {
    return Promise.reject(new NetworkError(undefined))
  }
}

function deviceHeader(response: Response, name: string, maximum: number): string {
  const value = response.headers.get(name)
  deviceNeed(
    value !== null && value.length > 0 && value.length <= maximum && !/[^\x20-\x7e]/.test(value),
    'invalid-response'
  )
  return value
}
async function deviceRead(
  native: DeviceNativeCell,
  response: Response
): Promise<{
  body: Uint8Array<ArrayBuffer>
  contentType: string
  requestId: string
  replayed: string | null
}> {
  const cell = native.owner,
    binding = cell.binding
  deviceNeed(!cell.finished && deviceCurrent(binding, cell.lease), 'ineligible')
  deviceNeed(response.url === native.url && !response.redirected, 'invalid-response')
  const type = deviceHeader(response, 'Content-Type', 128).toLowerCase()
  deviceNeed(
    /^(?:application\/json|application\/problem\+json)(?:;\s*charset=utf-8)?$/.test(type),
    'invalid-response'
  )
  const contentType = type.split(';', 1)[0]!.trim()
  deviceNeed(
    contentType ===
      (response.status >= 200 && response.status < 300
        ? 'application/json'
        : 'application/problem+json'),
    'invalid-response'
  )
  const requestId = deviceHeader(response, 'X-Request-Id', 64)
  deviceNeed(/^[A-Za-z0-9_-]{8,64}$/.test(requestId), 'invalid-response')
  const replayed = response.headers.get('Idempotency-Replayed')
  deviceNeed(replayed === null || replayed === 'true', 'invalid-response')
  if (!native.post && response.status === 200) {
    const etag = deviceHeader(response, 'ETag', 256)
    deviceNeed(/^"[\x21\x23-\x7e]+"$/.test(etag), 'invalid-response')
  }
  const limit = !native.post && response.status === 200 ? 262144 : 16384
  deviceNeed(response.body, 'invalid-response')
  const reader = response.body.getReader()
  cell.reader = reader
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  try {
    for (;;) {
      deviceNeed(!cell.finished && deviceCurrent(binding, cell.lease), 'ineligible')
      const now = deviceClock(binding)
      deviceNeed(now !== undefined && now <= native.deadline, 'ineligible')
      const chunk = await reader.read()
      deviceNeed(!cell.finished && deviceCurrent(binding, cell.lease), 'ineligible')
      const after = deviceClock(binding)
      deviceNeed(after !== undefined && after <= native.deadline, 'ineligible')
      if (chunk.done) break
      const copy = deviceBytes(chunk.value, limit - length)
      length += copy.length
      chunks.push(copy)
    }
    deviceNeed(length > 0, 'invalid-response')
    const body = new Uint8Array(length)
    let at = 0
    for (const chunk of chunks) {
      body.set(chunk, at)
      at += chunk.length
    }
    new TextDecoder('utf-8', { fatal: true }).decode(body)
    return { body, contentType, requestId, replayed }
  } finally {
    delete cell.reader
    try {
      reader.releaseLock()
    } catch {
      /* Refusal path cancels its private controller below. */
    }
  }
}
async function deviceObserve(cell: DeviceCell): Promise<void> {
  const native = deviceNative(cell, false)
  const promise = invokeConfidentialDeviceNative(native)
  deviceNeed(promise, 'ineligible')
  const response = await promise
  if (cell.finished || !deviceCurrent(cell.binding, cell.lease)) {
    try {
      void response.body?.cancel().catch(() => {})
    } catch {
      /* Late response is never retained. */
    }
    deviceFail('ineligible')
  }
  cell.response = response
  const result = await deviceRead(native, response)
  deviceNeed(response.status === 200, 'ineligible')
  const principal = parseDevicePrincipal(
    new TextDecoder('utf-8', { fatal: true }).decode(result.body),
    {
      issuer: cell.binding.auth.issuer,
      subject: cell.binding.auth.subject,
      organisationSlug: cell.binding.slug,
    },
    cell.binding.principal
  )
  const descriptor = cell.descriptor
  if (descriptor)
    deviceNeed(
      principal.ownerId === descriptor.ownerId &&
        principal.organisationId === descriptor.organisationId &&
        principal.membershipId === descriptor.membershipId,
      'ineligible'
    )
  deviceNeed(!cell.finished && deviceCurrent(cell.binding, cell.lease), 'ineligible')
  const observedAt = deviceClock(cell.binding)
  deviceNeed(observedAt !== undefined && observedAt <= native.deadline, 'ineligible')
  cell.principal = principal
  cell.observedAt = observedAt
  cell.observing = false
  // Drop GET outbound roots before keeping the one-use principal observation.
  delete native.init.headers
  delete native.init.body
  native.init = {}
  delete cell.native
  delete cell.controller
  delete cell.response
  deviceTimer(cell, 5000)
  if (cell.mode === 'initialize') {
    deviceNeed(devicePost(cell.binding, cell.lease, cell.rpcId, {
      kind: 'initialization-prepared',
      cellId: cell.id,
      principal,
      mode: cell.initializationMode,
    }, native.deadline), 'ineligible')
  } else {
    deviceNeed(descriptor)
    const wall = deviceWall()
    deviceInteger(wall, false)
    deviceNeed(wall <= Number.MAX_SAFE_INTEGER - DEVICE_RETRY_MS, 'ineligible')
    deviceNeed(devicePost(cell.binding, cell.lease, cell.rpcId, {
      kind: 'attempt-prepared',
      cellId: cell.id,
      info: {
        version: 2,
        actorOperation: descriptor.actorOperation,
        operationId: descriptor.operationId,
        bodySha256: descriptor.bodySha256,
        observedWallMs: wall,
        retryBeforeMs: wall + DEVICE_RETRY_MS,
      },
    }, native.deadline), 'ineligible')
  }
}
async function deviceSend(cell: DeviceCell): Promise<void> {
  const native = deviceNative(cell, true)
  const promise = invokeConfidentialDeviceNative(native)
  deviceNeed(promise, 'ineligible')
  const response = await promise
  if (cell.finished || !deviceCurrent(cell.binding, cell.lease)) {
    try {
      void response.body?.cancel().catch(() => {})
    } catch {
      /* Late response is never retained. */
    }
    deviceFail('ineligible')
  }
  cell.response = response
  const result = await deviceRead(native, response)
  const descriptor = cell.descriptor
  deviceNeed(descriptor)
  deviceComplete(cell, {
    kind: 'attempt-outcome',
    outcome: {
      kind: 'response',
      actorOperation: descriptor.actorOperation,
      operationId: descriptor.operationId,
      bodySha256: descriptor.bodySha256,
      status: response.status,
      contentType: result.contentType,
      requestId: result.requestId,
      replayed: result.replayed,
      body: result.body,
    },
  })
}
function deviceBareRefusal(binding: DeviceBinding, rpcId: number, code: DeviceCode): void {
  try {
    const lease = binding.capture(rpcId)
    if (lease) devicePost(binding, lease, rpcId, { kind: 'refused', code })
  } catch {
    /* No result for a retired operation. */
  }
}
async function deviceFrame(binding: DeviceBinding, input: unknown): Promise<void> {
  let rpcId = 0,
    cell: DeviceCell | undefined
  let captured: DeviceLease | undefined,
    captureTried = false
  try {
    deviceNeed(input !== null && typeof input === 'object')
    const initial = Object.getOwnPropertyDescriptors(input)
    const nonce = initial.nonce,
      kind = initial.kind,
      rpc = initial.rpcId
    deviceNeed(
      nonce &&
        'value' in nonce &&
        nonce.value === binding.nonce &&
        kind &&
        'value' in kind &&
        typeof kind.value === 'string'
    )
    deviceNeed(rpc && 'value' in rpc)
    deviceInteger(rpc.value)
    rpcId = rpc.value
    const base = ['version', 'nonce', 'rpcId', 'kind']
    const extra =
      kind.value === 'initialize-prepare'
        ? ['mode']
        : kind.value === 'initialize-consume'
          ? ['cellId']
          : kind.value === 'attempt-prepare'
            ? ['descriptor', 'body']
            : kind.value === 'attempt-send'
              ? ['cellId', 'descriptor', 'body']
              : kind.value === 'retire-rpc'
                ? []
                : null
    deviceNeed(extra)
    const frame = deviceFields(input, [...base, ...extra])
    deviceNeed(frame.version === 1 && binding.active)
    if (kind.value === 'retire-rpc') {
      for (const current of [...binding.cells.values()])
        if (current.rpcId === rpcId) deviceDropCell(current)
      return
    }
    if (kind.value === 'initialize-prepare') {
      deviceNeed(
        (frame.mode === 'create' || frame.mode === 'restore') && binding.principal === undefined
      )
      captureTried = true
      captured = binding.capture(rpcId)
      cell = deviceNewCell(binding, rpcId, 'initialize', captured)
      cell.initializationMode = frame.mode
      await deviceObserve(cell)
      return
    }
    if (kind.value === 'attempt-prepare') {
      deviceNeed(binding.principal, 'ineligible')
      const descriptor = deviceDescriptor(frame.descriptor),
        body = deviceBytes(frame.body, 32768)
      captureTried = true
      captured = binding.capture(rpcId)
      cell = deviceNewCell(binding, rpcId, 'attempt', captured)
      cell.descriptor = descriptor
      cell.body = body
      const hashing = deviceHash(body)
      deviceNeed(!cell.finished && deviceCurrent(binding, cell.lease), 'ineligible')
      const hash = await hashing
      deviceNeed(
        !cell.finished && deviceCurrent(binding, cell.lease) && hash === descriptor.bodySha256,
        'invalid-input'
      )
      await deviceObserve(cell)
      return
    }
    deviceId(frame.cellId)
    cell = binding.cells.get(frame.cellId)
    deviceNeed(
      cell && cell.rpcId === rpcId && !cell.finished && !cell.consumed && !cell.observing,
      'ineligible'
    )
    if (kind.value === 'initialize-consume') {
      deviceNeed(cell.mode === 'initialize' && cell.principal && cell.observedAt !== undefined)
      deviceNeed(deviceCurrent(binding, cell.lease), 'ineligible')
      const now = deviceClock(binding)
      deviceNeed(now !== undefined && now - cell.observedAt <= 5000, 'ineligible')
      const remainingMs = 5000 - (now - cell.observedAt),
        principal = cell.principal
      cell.consumed = true
      binding.principal = principal
      deviceComplete(cell, {
        kind: 'initialization-consumed',
        remainingMs,
        mode: cell.initializationMode,
      })
      return
    }
    deviceNeed(cell.mode === 'attempt' && cell.descriptor && cell.body)
    const next = deviceDescriptor(frame.descriptor),
      prior = cell.descriptor,
      body = deviceBytes(frame.body, 32768)
    deviceNeed(
      sameDeviceBytes(body, cell.body) &&
        Object.keys(prior).every((key) => {
          if (key === 'recordSha256') return true
          if (key === 'hostGeneration')
            return (
              next.hostGeneration === prior.hostGeneration ||
              next.hostGeneration === prior.hostGeneration + 1
            )
          return next[key as keyof DeviceDescriptor] === prior[key as keyof DeviceDescriptor]
        })
    )
    deviceNeed(
      next.hostGeneration !== prior.hostGeneration || next.recordSha256 === prior.recordSha256
    )
    cell.descriptor = next
    await deviceSend(cell)
  } catch (error) {
    const code = error instanceof DeviceDispatchFailure ? error.code : 'invalid-response'
    if (cell) {
      if (!cell.finished) deviceRefuse(cell, code)
    } else if (rpcId > 0 && binding.active) {
      if (captured) devicePost(binding, captured, rpcId, { kind: 'refused', code })
      else if (!captureTried) deviceBareRefusal(binding, rpcId, code)
    }
  }
}

/** Internal fixed-factory binding only; never expose these parameters as facade options. */
export function bindConfidentialDeviceDispatch(
  lifetime: AuthLifetime,
  organisationSlug: string,
  worker: Worker,
  privatePort: MessagePort,
  expectedNonce: string,
  captureOperation: DeviceCapture
): Readonly<{ close(): void }> {
  deviceNeed(
    typeof expectedNonce === 'string' &&
      /^[0-9a-f]{32}$/.test(expectedNonce) &&
      typeof captureOperation === 'function'
  )
  deviceNeed(
    typeof organisationSlug === 'string' &&
      /^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$/.test(organisationSlug)
  )
  deviceNeed(
    worker instanceof Worker &&
      privatePort instanceof MessagePort &&
      !deviceBindings.has(privatePort)
  )
  const auth = deviceAuth(lifetime),
    base = deviceBaseUrl()
  let token: string | undefined, sample: number
  try {
    token = tokenProvider()
    sample = deviceNow()
  } catch {
    deviceFail('ineligible')
  }
  deviceNeed(
    typeof token === 'string' &&
      token.length > 0 &&
      token.length <= 16384 &&
      /^[\x21-\x7e]+$/.test(token),
    'ineligible'
  )
  deviceNeed(
    Number.isFinite(sample) && sample >= 0 && sample <= Number.MAX_SAFE_INTEGER,
    'ineligible'
  )
  const binding: DeviceBinding = {
    active: true,
    brokenClock: false,
    base,
    slug: organisationSlug,
    nonce: expectedNonce,
    worker,
    port: privatePort,
    lifetime,
    auth,
    token,
    capture: captureOperation,
    lastClock: sample,
    cells: new Map(),
  }
  const close = () => closeDeviceBinding(binding)
  try {
    deviceBindings.set(privatePort, binding)
    binding.unsubscribe = lifetime.subscribe(() => {
      if (!deviceCurrent(binding)) close()
    })
    deviceNeed(deviceCurrent(binding), 'ineligible')
    binding.listener = (event) => {
      void deviceFrame(binding, event.data)
    }
    privatePort.addEventListener('message', binding.listener)
    privatePort.start()
    return Object.freeze({ close })
  } catch (error) {
    close()
    throw error instanceof DeviceDispatchFailure ? error : new DeviceDispatchFailure('ineligible')
  }
}
