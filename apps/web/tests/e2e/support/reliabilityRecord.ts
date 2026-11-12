import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import type { Browser, Page, Request, Response, TestInfo, test } from '@playwright/test'

export const reliabilityCases = [
  {
    id: 'C1',
    project: 'chromium',
    file: '01-order.spec.ts',
    title: 'order/wizard: prepares a held draft with the keyboard alone',
  },
  {
    id: 'C2',
    project: 'chromium',
    file: '02-status.spec.ts',
    title: 'status/overview: describes a calls outage by what the user cannot do',
  },
  {
    id: 'C3',
    project: 'chromium',
    file: '02-status.spec.ts',
    title: 'status/overview: distinguishes a stale heartbeat from an outage',
  },
  {
    id: 'C4',
    project: 'chromium',
    file: 'recovered-screens.spec.ts',
    title: 'combined screens preserve navigation from Home through Status and invoice detail',
  },
  {
    id: 'C5',
    project: 'chromium',
    file: 'recovered-screens.spec.ts',
    title:
      'combined billing reader sees Home and invoices without management or purchase authority',
  },
  {
    id: 'C6',
    project: 'chromium-dark',
    file: 'module-rail.spec.ts',
    title: 'shell/rail: two named navigation landmarks, the skip link still first',
  },
] as const

type Identity = { caseId: string; project: string; retry: number; worker: number }
const phases = [
  'setup',
  'entry',
  'authentication',
  'destination',
  'primary',
  'interaction',
  'home',
  'applications',
  'billing',
  'invoice',
  'restoration',
  'axe',
  'end',
] as const
type Phase = (typeof phases)[number]
const categories = [
  'entry-document',
  'authorize-document',
  'callback-document',
  'theme-script',
  'bootstrap-script',
  'main-script',
  'application-script',
  'mock-runtime-script',
  'unknown-local-script',
  'worker-script',
  'auth-discovery',
  'auth-token',
  'me',
  'tenant-list',
  'tenant-status',
  'status-components',
  'status-incidents',
  'other-local',
  'external-or-opaque',
] as const
const resources = ['document', 'script', 'stylesheet', 'font', 'fetch', 'xhr', 'other'] as const
const statuses = [
  'informational',
  'success',
  'redirect',
  'client-error',
  'server-error',
  'other',
] as const
const reasons = [
  'none',
  'events',
  'pending',
  'bytes',
  'observer',
  'cleanup',
  'guard',
  'attachment',
] as const
type Reason = (typeof reasons)[number]
type PrimaryStatus = NonNullable<TestInfo['status']>
type Observation = { order: number; at: number; phase: Phase }
type InlineResponse = Observation & { status: string }
type BaseEvent = Observation & { seq: number }
type EventInput =
  | { kind: 'phase' | 'end' | 'page-error' | 'browser-disconnected' }
  | {
      kind: 'request'
      request: number
      method: string
      resource: string
      category: string
      response?: InlineResponse
    }
  | { kind: 'finished' | 'failed'; request: number }
  | { kind: 'unobserved-boundary'; boundary: 'response' | 'finished' | 'failed' }
  | { kind: 'frame-navigation'; frame: number; category: string }
type RecordEvent = BaseEvent & EventInput
/**
 * How many requests of one kind a record counts without a row each: the bound on
 * `excludedRequests` and on `deferredChunks` alike.
 */
const COUNTED_REQUEST_LIMIT = 256

export interface ReliabilityRecord extends Identity {
  version: 3
  representation: 'response-inline'
  coverage: 'allowlisted-phase-only'
  assetMapping: 'pattern-only'
  excludedRequests: number
  /**
   * Requests for the files the console fetches on demand: a lazy route (`route-`), the layout
   * they hang below (`console-`), a workspace library (`vendor-`), a message catalogue (`i18n-`).
   *
   * They are counted, not given rows. A row is what the 256-event cap is spent on, and the cap is
   * there for what a flow does that a person or Core would notice: documents, the bootstrap and
   * the application, the calls to Core and to the identity provider, and any script nobody has a
   * name for. How many files a page's code happens to be cut into is not that: it changes with
   * every route added, and spending rows on it took the largest case to within a few rows of its
   * cap for a reason that had nothing to do with the flow. The count is still bounded, by the
   * same number, so a page that fetched chunks without end is caught as it was.
   */
  deferredChunks: number
  status: PrimaryStatus
  disposition: 'complete' | 'incomplete'
  reason: Reason
  events: RecordEvent[]
  pending: number[]
}
type Recorder = {
  mark: (phase: Phase) => void
  finish: (status: PrimaryStatus) => ReliabilityRecord
}

function identityValid(value: Identity): boolean {
  return (
    reliabilityCases.some(
      (entry) => entry.id === value.caseId && entry.project === value.project
    ) &&
    Number.isSafeInteger(value.retry) &&
    value.retry >= 0 &&
    value.retry <= 2 &&
    Number.isSafeInteger(value.worker) &&
    value.worker >= 0
  )
}

export function selectReliabilityCase(input: {
  file: string
  title: string
  project: string
  retry: number
  worker: number
}): Identity | undefined {
  const selected = reliabilityCases.find(
    (entry) =>
      entry.file === basename(input.file) &&
      entry.title === input.title &&
      entry.project === input.project
  )
  if (!selected) return undefined
  const identity = {
    caseId: selected.id,
    project: selected.project,
    retry: input.retry,
    worker: input.worker,
  }
  if (!identityValid(identity)) throw new Error('E2E_RECORD_IDENTITY')
  return identity
}

export function claimReliabilityIdentity(identity: Identity, seen: Set<string>): void {
  const key = `${identity.caseId}:${identity.project}:${identity.retry}`
  if (!identityValid(identity) || seen.has(key) || seen.size >= 18)
    throw new Error('E2E_RECORD_IDENTITY')
  seen.add(key)
}

function object(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!
  )
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}
function member(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}
function ordinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 256
}

export function reliabilityByteBudget(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 65536
}

function observationValid(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.order) &&
    (value.order as number) >= 0 &&
    (value.order as number) < 512 &&
    Number.isSafeInteger(value.at) &&
    (value.at as number) >= 0 &&
    member(value.phase, phases)
  )
}

export function reliabilityRecordReason(value: unknown): 'schema' | 'order' | 'limit' | undefined {
  if (
    !object(value) ||
    !keys(value, [
      'version',
      'representation',
      'coverage',
      'assetMapping',
      'excludedRequests',
      'deferredChunks',
      'caseId',
      'project',
      'retry',
      'worker',
      'status',
      'disposition',
      'reason',
      'events',
      'pending',
    ])
  )
    return 'schema'
  if (
    value.version !== 3 ||
    value.representation !== 'response-inline' ||
    value.coverage !== 'allowlisted-phase-only' ||
    value.assetMapping !== 'pattern-only' ||
    !Number.isSafeInteger(value.excludedRequests) ||
    (value.excludedRequests as number) < 0 ||
    !Number.isSafeInteger(value.deferredChunks) ||
    (value.deferredChunks as number) < 0 ||
    !identityValid(value as unknown as Identity) ||
    !member(value.status, ['passed', 'failed', 'timedOut', 'skipped', 'interrupted']) ||
    !member(value.reason, reasons) ||
    !member(value.disposition, ['complete', 'incomplete'])
  )
    return 'schema'
  if ((value.reason === 'none') !== (value.disposition === 'complete')) return 'schema'
  if (!Array.isArray(value.events) || !Array.isArray(value.pending)) return 'schema'
  if (
    value.events.length > 256 ||
    value.pending.length > 64 ||
    (value.excludedRequests as number) > COUNTED_REQUEST_LIMIT ||
    (value.deferredChunks as number) > COUNTED_REQUEST_LIMIT
  )
    return 'limit'
  const observations: { order: number; at: number; kind: string; request?: number }[] = []
  let previousOrder = -1
  for (const [index, event] of value.events.entries()) {
    if (!object(event) || !member(event.phase, phases)) return 'schema'
    if (!observationValid(event) || event.seq !== index || (event.order as number) <= previousOrder)
      return 'order'
    previousOrder = event.order as number
    const base = ['seq', 'order', 'at', 'phase', 'kind']
    if (member(event.kind, ['phase', 'end', 'page-error', 'browser-disconnected'])) {
      if (!keys(event, base)) return 'schema'
    } else if (event.kind === 'request') {
      if (
        !keys(event, [
          ...base,
          'request',
          'method',
          'resource',
          'category',
          ...('response' in event ? ['response'] : []),
        ]) ||
        !member(event.method, ['GET', 'POST', 'OTHER']) ||
        !member(event.resource, resources) ||
        !member(event.category, categories)
      )
        return 'schema'
      if (!ordinal(event.request)) return 'order'
      if ('response' in event) {
        const response = event.response
        if (
          !object(response) ||
          !keys(response, ['order', 'at', 'phase', 'status']) ||
          !member(response.phase, phases) ||
          !member(response.status, statuses)
        )
          return 'schema'
        if (!observationValid(response)) return 'order'
        observations.push({
          order: response.order as number,
          at: response.at as number,
          kind: 'response',
          request: event.request,
        })
      }
    } else if (member(event.kind, ['finished', 'failed'])) {
      if (!keys(event, [...base, 'request'])) return 'schema'
      if (!ordinal(event.request)) return 'order'
    } else if (event.kind === 'unobserved-boundary') {
      if (
        !keys(event, [...base, 'boundary']) ||
        !member(event.boundary, ['response', 'finished', 'failed'])
      )
        return 'schema'
    } else if (event.kind === 'frame-navigation') {
      if (
        !keys(event, [...base, 'frame', 'category']) ||
        !ordinal(event.frame) ||
        !member(event.category, categories)
      )
        return 'schema'
    } else return 'schema'
    observations.push({
      order: event.order as number,
      at: event.at as number,
      kind: event.kind as string,
      ...(ordinal(event.request) ? { request: event.request } : {}),
    })
  }
  const pending = new Set<number>()
  const responded = new Set<number>()
  let started = 0
  let time = 0
  let ended = false
  for (const [index, observation] of observations
    .sort((left, right) => left.order - right.order)
    .entries()) {
    if (observation.order !== index || observation.at < time || ended) return 'order'
    time = observation.at
    if (observation.kind === 'request') {
      if (observation.request !== ++started) return 'order'
      pending.add(started)
      if (pending.size > 64) return 'limit'
    } else if (observation.kind === 'response') {
      if (!pending.has(observation.request!) || responded.has(observation.request!)) return 'order'
      responded.add(observation.request!)
    } else if (observation.kind === 'finished' || observation.kind === 'failed') {
      if (!pending.delete(observation.request!)) return 'order'
    } else if (observation.kind === 'end') ended = true
  }
  if (value.disposition === 'complete' && !ended) return 'order'
  if (
    value.pending.some((entry) => !ordinal(entry)) ||
    new Set(value.pending).size !== value.pending.length ||
    [...pending].join(',') !== value.pending.join(',')
  )
    return 'order'
  return reliabilityByteBudget(Buffer.byteLength(JSON.stringify(value))) ? undefined : 'limit'
}

export function reliabilityGuardControls(): string[] {
  const pristine: ReliabilityRecord = {
    version: 3,
    representation: 'response-inline',
    coverage: 'allowlisted-phase-only',
    assetMapping: 'pattern-only',
    excludedRequests: 0,
    deferredChunks: 0,
    caseId: 'C1',
    project: 'chromium',
    retry: 0,
    worker: 0,
    status: 'passed',
    disposition: 'complete',
    reason: 'none',
    events: [
      {
        seq: 0,
        order: 0,
        at: 0,
        phase: 'entry',
        kind: 'request',
        request: 1,
        method: 'GET',
        resource: 'document',
        category: 'entry-document',
        response: { order: 1, at: 1, phase: 'entry', status: 'success' },
      },
      { seq: 1, order: 2, at: 2, phase: 'entry', kind: 'finished', request: 1 },
      { seq: 2, order: 3, at: 3, phase: 'end', kind: 'end' },
    ],
    pending: [],
  }
  const original = JSON.stringify(pristine)
  const mutations = [
    { value: { ...pristine, rawURL: 'NO_LOG' }, reason: 'schema' },
    {
      value: {
        ...pristine,
        events: pristine.events.map((event) =>
          event.kind === 'finished' ? { ...event, request: 99 } : event
        ),
      },
      reason: 'order',
    },
    {
      value: {
        ...pristine,
        events: [pristine.events[0], { ...pristine.events[2], seq: 1 }],
      },
      reason: 'order',
    },
    {
      value: {
        ...pristine,
        events: pristine.events.map((event) =>
          event.kind === 'request' ? { ...event, response: { ...event.response, order: 0 } } : event
        ),
      },
      reason: 'order',
    },
    { value: { ...pristine, events: Array(257).fill(pristine.events[0]) }, reason: 'limit' },
    { value: { ...pristine, deferredChunks: COUNTED_REQUEST_LIMIT + 1 }, reason: 'limit' },
  ]
  const observed: string[] = []
  for (const mutation of mutations) {
    const reason = reliabilityRecordReason(mutation.value)
    if (
      reason === undefined ||
      reason !== mutation.reason ||
      reliabilityRecordReason(pristine) !== undefined ||
      JSON.stringify(pristine) !== original
    )
      throw new Error('E2E_RECORD_SELF_CHECK')
    observed.push(reason)
  }
  if (
    !reliabilityByteBudget(65536) ||
    reliabilityByteBudget(65537) ||
    !reliabilityByteBudget(65536)
  )
    throw new Error('E2E_RECORD_BYTE_SELF_CHECK')
  observed.push('bytes')
  return observed
}

/**
 * The files `vite.config.ts` names for what the console fetches on demand. A name, not a guess:
 * a script that matches none of these and none of the patterns in `category` stays an
 * `unknown-local-script`, with a row of its own.
 */
const DEFERRED_CHUNK = /^\/assets\/(?:route|console|vendor|i18n)-[^/]*\.js$/
/** Never a row's category: a deferred chunk has no row (`ReliabilityRecord.deferredChunks`). */
const DEFERRED_CHUNK_CATEGORY = 'deferred-chunk'

function category(raw: string): string {
  try {
    const value = new URL(raw)
    if (value.origin !== 'http://localhost:4173') return 'external-or-opaque'
    const path = value.pathname
    if (path === '/__mock-idp/authorize') return 'authorize-document'
    if (path === '/auth/callback') return 'callback-document'
    if (path === '/theme.js') return 'theme-script'
    if (/^\/assets\/index-.*\.js$/.test(path)) return 'bootstrap-script'
    if (/^\/assets\/main-.*\.js$/.test(path)) return 'main-script'
    if (/^\/assets\/app-.*\.js$/.test(path)) return 'application-script'
    if (DEFERRED_CHUNK.test(path)) return DEFERRED_CHUNK_CATEGORY
    if (/^\/assets\/browser-.*\.js$/.test(path)) return 'mock-runtime-script'
    if (path === '/mockServiceWorker.js') return 'worker-script'
    if (/^\/auth\/realms\/[^/]+\/\.well-known\/openid-configuration$/.test(path))
      return 'auth-discovery'
    if (/^\/auth\/realms\/[^/]+\/protocol\/openid-connect\/token$/.test(path)) return 'auth-token'
    if (path === '/api/v1/me') return 'me'
    if (/^\/api\/v1\/organisations\/[^/]+\/tenants$/.test(path)) return 'tenant-list'
    if (/^\/api\/v1\/tenants\/[^/]+\/status$/.test(path)) return 'tenant-status'
    if (path === '/api/v1/status/components') return 'status-components'
    if (path === '/api/v1/status/incidents') return 'status-incidents'
    if (/^\/[^/]+\/(home|status|order)$/.test(path)) return 'entry-document'
    if (path.endsWith('.js')) return 'unknown-local-script'
    return 'other-local'
  } catch {
    return 'external-or-opaque'
  }
}

export function createReliabilityRecord(
  identity: Identity,
  page: Pick<Page, 'on' | 'off'>,
  browser: Pick<Browser, 'on' | 'off'>,
  now: () => number = () => performance.now()
): Recorder {
  if (!identityValid(identity)) throw new Error('E2E_RECORD_IDENTITY')
  reliabilityGuardControls()
  const owner = Object.freeze({
    caseId: identity.caseId,
    project: identity.project,
    retry: identity.retry,
    worker: identity.worker,
  })
  const origin = now()
  let phase: Phase = 'setup'
  let reason: Reason = 'none'
  let closed = false
  let requestCount = 0
  let excludedRequests = 0
  let deferredChunks = 0
  let frameCount = 0
  let order = 0
  let lastAt = 0
  let requestIds = new WeakMap<object, number>()
  let excluded = new WeakSet<object>()
  let frameIds = new WeakMap<object, number>()
  const pending = new Set<number>()
  const requestRows = new Map<number, number>()
  const events: RecordEvent[] = []
  const detach: (() => void)[] = []
  let result: ReliabilityRecord | undefined
  const disconnect = () => {
    closed = true
    for (const remove of detach.splice(0)) {
      try {
        remove()
      } catch {
        if (reason === 'none') reason = 'cleanup'
      }
    }
    requestIds = new WeakMap()
    excluded = new WeakSet()
    frameIds = new WeakMap()
    requestRows.clear()
  }
  const stop = (failure: Reason): false => {
    if (reason === 'none') reason = failure
    disconnect()
    return false
  }
  const stamp = (): Observation | undefined => {
    if (closed) return undefined
    const at = Math.round(now() - origin)
    if (!Number.isSafeInteger(at) || at < lastAt || order >= 512) {
      stop('observer')
      return undefined
    }
    return { order, at, phase }
  }
  const admit = (candidate: RecordEvent[], nextPending: Set<number>): boolean => {
    if (!reliabilityByteBudget(Buffer.byteLength(JSON.stringify(candidate)) + 5536))
      return stop('bytes')
    if (
      reliabilityRecordReason({
        ...owner,
        version: 3,
        representation: 'response-inline',
        coverage: 'allowlisted-phase-only',
        assetMapping: 'pattern-only',
        excludedRequests,
        deferredChunks,
        status: 'passed',
        disposition: 'incomplete',
        reason: 'observer',
        events: candidate,
        pending: [...nextPending],
      }) !== undefined
    )
      return stop('observer')
    return true
  }
  const emit = (input: EventInput, nextPending = pending): boolean => {
    const observation = stamp()
    if (!observation) return false
    if (events.length >= 256 || (input.kind !== 'end' && events.length >= 255))
      return stop('events')
    const event = { ...input, seq: events.length, ...observation } as RecordEvent
    if (!admit([...events, event], nextPending)) return false
    events.push(event)
    order += 1
    lastAt = observation.at
    return true
  }
  const observe = (operation: () => void) => {
    if (closed) return
    try {
      operation()
    } catch {
      stop('observer')
    }
  }
  const onRequest = (request: Request) =>
    observe(() => {
      const selected = category(request.url())
      if (selected === 'other-local' || selected === 'external-or-opaque') {
        if (excludedRequests >= COUNTED_REQUEST_LIMIT) return stop('events')
        excludedRequests += 1
        excluded.add(request)
        return
      }
      if (selected === DEFERRED_CHUNK_CATEGORY) {
        // Counted in a bucket of its own, with the bound the excluded bucket has: no row, and
        // still not without limit.
        if (deferredChunks >= COUNTED_REQUEST_LIMIT) return stop('events')
        deferredChunks += 1
        excluded.add(request)
        return
      }
      if (pending.size >= 64) return stop('pending')
      const id = requestCount + 1
      const method = request.method()
      const resource = request.resourceType()
      if (
        !emit(
          {
            kind: 'request',
            request: id,
            method: ['GET', 'POST'].includes(method) ? method : 'OTHER',
            resource: resources.includes(resource as (typeof resources)[number])
              ? resource
              : 'other',
            category: selected,
          },
          new Set([...pending, id])
        )
      )
        return
      requestCount = id
      requestIds.set(request, id)
      requestRows.set(id, events.length - 1)
      pending.add(id)
    })
  const boundary = (request: Request, kind: 'response' | 'finished' | 'failed', status?: number) =>
    observe(() => {
      if (excluded.has(request)) return
      const id = requestIds.get(request)
      if (id === undefined) {
        const selected = category(request.url())
        if (
          selected === 'other-local' ||
          selected === 'external-or-opaque' ||
          selected === DEFERRED_CHUNK_CATEGORY
        )
          return
        return emit({ kind: 'unobserved-boundary', boundary: kind })
      }
      if (kind === 'response') {
        const index = requestRows.get(id)
        const start = index === undefined ? undefined : events[index]
        if (!pending.has(id) || start?.kind !== 'request' || start.response) return stop('observer')
        const observation = stamp()
        if (!observation) return
        const bucket =
          status !== undefined && Number.isInteger(status) && status >= 100 && status < 600
            ? statuses[Math.floor(status / 100) - 1]!
            : 'other'
        const changed = { ...start, response: { ...observation, status: bucket } }
        const candidate = [...events]
        candidate[index!] = changed
        if (!admit(candidate, pending)) return
        events[index!] = changed
        order += 1
        lastAt = observation.at
      } else {
        if (!pending.has(id)) return stop('observer')
        const nextPending = new Set(pending)
        nextPending.delete(id)
        if (!emit({ kind, request: id }, nextPending)) return
        pending.delete(id)
      }
    })
  const onResponse = (response: Response) =>
    observe(() => boundary(response.request(), 'response', response.status()))
  const onFinished = (request: Request) => boundary(request, 'finished')
  const onFailed = (request: Request) => boundary(request, 'failed')
  const onFrame = (frame: { url: () => string }) =>
    observe(() => {
      const existing = frameIds.get(frame)
      const id = existing ?? frameCount + 1
      if (!emit({ kind: 'frame-navigation', frame: id, category: category(frame.url()) })) return
      if (existing === undefined) {
        frameCount = id
        frameIds.set(frame, id)
      }
    })
  const onError = () => observe(() => emit({ kind: 'page-error' }))
  const onDisconnected = () => observe(() => emit({ kind: 'browser-disconnected' }))
  try {
    detach.push(() => page.off('request', onRequest))
    page.on('request', onRequest)
    detach.push(() => page.off('response', onResponse))
    page.on('response', onResponse)
    detach.push(() => page.off('requestfinished', onFinished))
    page.on('requestfinished', onFinished)
    detach.push(() => page.off('requestfailed', onFailed))
    page.on('requestfailed', onFailed)
    detach.push(() => page.off('framenavigated', onFrame))
    page.on('framenavigated', onFrame)
    detach.push(() => page.off('pageerror', onError))
    page.on('pageerror', onError)
    detach.push(() => browser.off('disconnected', onDisconnected))
    browser.on('disconnected', onDisconnected)
  } catch {
    stop('observer')
  }
  return {
    mark(next) {
      if (!closed) {
        if (!member(next, phases)) return stop('observer')
        phase = next
        emit({ kind: 'phase' })
      }
    },
    finish(status) {
      if (result) return result
      const validStatus = member(status, ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'])
      if (!validStatus) stop('observer')
      phase = 'end'
      emit({ kind: 'end' })
      disconnect()
      result = {
        version: 3,
        representation: 'response-inline',
        coverage: 'allowlisted-phase-only',
        assetMapping: 'pattern-only',
        excludedRequests,
        deferredChunks,
        ...owner,
        status: validStatus ? status : 'interrupted',
        disposition: reason === 'none' ? 'complete' : 'incomplete',
        reason,
        events: events.map((event) =>
          event.kind === 'request' && event.response
            ? { ...event, response: { ...event.response } }
            : { ...event }
        ),
        pending: [...pending],
      }
      if (reliabilityRecordReason(result) !== undefined)
        result = { ...result, disposition: 'incomplete', reason: 'guard', events: [], pending: [] }
      events.length = 0
      pending.clear()
      return result
    },
  }
}

export function createReliabilityReceipt(value: unknown): {
  body: Buffer
  parts: string[]
  end: { ok: string; failed: string }
  reason: Reason
} {
  try {
    if (reliabilityRecordReason(value) !== undefined) throw new Error()
    const serialized = JSON.stringify(value)
    const body = Buffer.from(serialized)
    const decoded: unknown = JSON.parse(body.toString('utf8'))
    if (
      !/^[\x20-\x7e]+$/.test(serialized) ||
      !reliabilityByteBudget(body.length) ||
      reliabilityRecordReason(decoded) !== undefined ||
      JSON.stringify(decoded) !== serialized
    )
      throw new Error()
    const record = decoded as ReliabilityRecord
    const count = Math.ceil(body.length / 4096)
    if (count < 1 || count > 16) throw new Error()
    const digest = createHash('sha256').update(body).digest('hex')
    const identityFields = `case=${record.caseId} project=${record.project} retry=${record.retry} worker=${record.worker}`
    const parts: string[] = []
    for (let index = 0; index < count; index += 1) {
      const header = `E2E_RELIABILITY_V3_PART ${identityFields} part=${index + 1}/${count} bytes=${body.length} sha256=${digest} data=`
      const line = header + body.subarray(index * 4096, (index + 1) * 4096).toString('ascii')
      if (
        Buffer.byteLength(header) + 1 > 256 ||
        Buffer.byteLength(line) + 1 > 4352 ||
        !/^[\x20-\x7e]+$/.test(line)
      )
        throw new Error()
      parts.push(line)
    }
    const footer = `E2E_RELIABILITY_V3_END ${identityFields} parts=${count} bytes=${body.length} sha256=${digest} attachment=`
    const end = { ok: `${footer}ok`, failed: `${footer}failed` }
    if (
      Object.values(end).some(
        (line) => Buffer.byteLength(line) + 1 > 256 || !/^[\x20-\x7e]+$/.test(line)
      )
    )
      throw new Error()
    if (
      parts.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0) +
        Buffer.byteLength(end.failed) +
        1 >
      69888
    )
      throw new Error()
    return { body, parts, end, reason: record.reason }
  } catch {
    throw new Error('E2E_RECORD_PUBLICATION')
  }
}

export async function finalizeReliabilityRecord(
  recorder: Recorder,
  status: PrimaryStatus,
  primary: unknown,
  attach: (body: Buffer) => Promise<void>,
  report: (reason: Reason | 'publication') => void = () => {},
  write: (line: string) => void | Promise<void> = (line) => console.log(line)
): Promise<void> {
  const result = recorder.finish(status)
  const reports: (Reason | 'publication')[] = []
  let packet: ReturnType<typeof createReliabilityReceipt> | undefined
  try {
    packet = createReliabilityReceipt(result)
  } catch {
    reports.push('publication')
  }
  if (packet) {
    if (packet.reason !== 'none') reports.push(packet.reason)
    let publicationFailed = false
    try {
      for (const line of packet.parts) await write(line)
    } catch {
      publicationFailed = true
    }
    let attachmentFailed = false
    try {
      await attach(packet.body)
    } catch {
      attachmentFailed = true
      reports.push('attachment')
    }
    if (!publicationFailed) {
      try {
        await write(attachmentFailed ? packet.end.failed : packet.end.ok)
      } catch {
        publicationFailed = true
      }
    }
    if (publicationFailed) reports.push('publication')
  }
  for (const reason of reports) {
    try {
      report(reason)
    } catch {
      continue
    }
  }
  if (reports.length > 0 && primary === undefined && status === 'passed')
    throw new Error('E2E_DIAGNOSTIC_INCOMPLETE')
}

const active = new WeakMap<object, Recorder>()
const seen = new Set<string>()
export function beginReliability(
  page: Pick<Page, 'on' | 'off'>,
  browser: Pick<Browser, 'on' | 'off'>,
  input: Parameters<typeof selectReliabilityCase>[0]
): void {
  const identity = selectReliabilityCase(input)
  if (!identity) return
  claimReliabilityIdentity(identity, seen)
  active.set(page, createReliabilityRecord(identity, page, browser))
}
export function markReliability(page: object, phase: Phase): void {
  active.get(page)?.mark(phase)
}
export function registerReliability(testType: typeof test): void {
  testType.beforeEach(({ page, browser }, info) => {
    beginReliability(page, browser, {
      file: info.file,
      title: info.title,
      project: info.project.name,
      retry: info.retry,
      worker: info.workerIndex,
    })
  })
  testType.afterEach(async ({ page }, info) => {
    const recorder = active.get(page)
    if (!recorder) return
    active.delete(page)
    await finalizeReliabilityRecord(
      recorder,
      info.status ?? 'interrupted',
      info.errors[0],
      (body) => info.attach('e2e-reliability', { body, contentType: 'application/json' }),
      (reason) => console.error(`E2E_DIAGNOSTIC_INCOMPLETE:${reason}`)
    )
  })
}
