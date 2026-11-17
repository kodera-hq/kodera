// @vitest-environment node
// Controlled transport/port oracles; not real Core, native-worker or PG acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type * as ApiClient from '@/api/client'
import type { AuthLifetime } from '@/auth/AuthProvider'
import type { AuthSessionSnapshot } from '@/auth/AuthAdapter'
import fixtures from './fixtures/confidential-device-http.responses.json'

const context = fixtures.acceptedContext
const NONCE = '0123456789abcdef0123456789abcdef'
const BASE = 'https://core.dispatch.test/api/v1'
const recordId = '01970000-0000-7000-8000-000000000021'
const operationId = '01970000-0000-7000-8000-000000000022'
const bytes = () => new TextEncoder().encode('{"synthetic":"exact public signed-byte placeholder"}')
const hex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TEST_OBJECT')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('TEST_STRING')
  return value
}
class UnitWorker extends EventTarget implements Worker {
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null
  postMessage(): void {
    throw new Error('PRIVATE_PORT_ONLY')
  }
  terminate(): void {
    /* Controlled identity object; no real worker was started. */
  }
}

type Call = {
  url: string
  method: string
  headers: Headers
  body: Uint8Array | undefined
  init: RequestInit
}
let api: typeof ApiClient
let clock: number
let token: string | undefined
let session: AuthSessionSnapshot
let stamp: object
let rpcLive: boolean
let closeDuringCurrent: boolean
let closeObserved: boolean
let advanceCurrent: boolean
let currentChecks: number
let currentAdvanced: boolean
let responseClockAdvance: number | undefined
let callbacks: Set<() => void>
let calls: Call[]
let outputs: unknown[]
let channels: MessageChannel[]
let bindings: { close(): void }[]
let scopeResponse: unknown
let responseOverride: ((call: Call) => Response | Promise<Response>) | undefined
let lifetime: AuthLifetime
let captures: number

function response(
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  status = 200,
  headers: Record<string, string> = {}
) {
  const value = new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'c-synthetic-dispatch-123',
      ...(status === 200 ? { ETag: '"opaque-strong-fixture-validator"' } : {}),
      ...headers,
    },
  })
  Object.defineProperty(value, 'url', { value: url })
  return value
}

beforeEach(async () => {
  clock = 100
  token = 'synthetic-short-lived-bearer'
  stamp = {}
  rpcLive = true
  closeDuringCurrent = false
  closeObserved = false
  advanceCurrent = false
  currentChecks = 0
  currentAdvanced = false
  responseClockAdvance = undefined
  captures = 0
  callbacks = new Set()
  calls = []
  outputs = []
  channels = []
  bindings = []
  responseOverride = undefined
  scopeResponse = structuredClone(fixtures.responses.me.body)
  session = {
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'spec-org', identity: { issuer: context.issuer, subject: context.subject } },
  }
  lifetime = {
    getSnapshot: () => session,
    hasUsableCredential: () => Boolean(token),
    getRetirementStamp: () => stamp,
    subscribe: (listener) => {
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
      }
    },
  }
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('Worker', UnitWorker)
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  vi.resetModules()
  api = await import('@/api/client')
  api.setTokenProvider(() => token)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body,
      init,
    }
    calls.push(call)
    if (responseOverride) return responseOverride(call)
    return response(
      url,
      call.method === 'GET' ? JSON.stringify(scopeResponse) : '{ "deviceId": "synthetic-wire" }',
      call.method === 'GET' ? 200 : 201
    )
  })
})
afterEach(() => {
  for (const binding of bindings) binding.close()
  for (const channel of channels) {
    channel.port1.close()
    channel.port2.close()
  }
  api.setTokenProvider(() => undefined)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function harness() {
  const channel = new MessageChannel()
  channels.push(channel)
  const worker = new UnitWorker()
  const binding: { close(): void } = api.bindConfidentialDeviceDispatch(
    lifetime,
    context.organisationSlug,
    worker,
    channel.port1,
    NONCE,
    () => {
      captures += 1
      const capturedStamp = stamp
      return {
        isCurrent: () => {
          if (responseClockAdvance !== undefined) {
            clock += responseClockAdvance
            responseClockAdvance = undefined
          }
          if (closeDuringCurrent) {
            closeObserved = true
            binding.close()
          }
          if (advanceCurrent && ++currentChecks === 2) {
            clock += 6000
            currentAdvanced = true
          }
          return rpcLive && capturedStamp === stamp
        },
      }
    }
  )
  bindings.push(binding)
  const waiting: ((value: unknown) => void)[] = []
  channel.port2.addEventListener('message', (event: MessageEvent<unknown>) => {
    outputs.push(event.data)
    waiting.shift()?.(event.data)
  })
  channel.port2.start()
  const post = (kind: string, extra: Record<string, unknown> = {}) =>
    channel.port2.postMessage({ version: 1, nonce: NONCE, rpcId: 1, kind, ...extra })
  const request = (kind: string, extra: Record<string, unknown> = {}) => {
    const received = new Promise<unknown>((resolve) => {
      waiting.push(resolve)
    })
    post(kind, extra)
    return received.then(object)
  }
  return { channel, binding, post, request }
}
async function initialize(h: ReturnType<typeof harness>) {
  const prepared = await h.request('initialize-prepare', { mode: 'create' })
  expect(prepared.kind).toBe('initialization-prepared')
  expect(prepared.principal).toEqual(context)
  const consumed = await h.request('initialize-consume', { cellId: string(prepared.cellId) })
  expect(consumed.kind).toBe('initialization-consumed')
  expect(consumed.remainingMs).toBeGreaterThan(0)
  return prepared
}
async function descriptor(operation: 'register' | 'publish-package' = 'register', body = bytes()) {
  const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)))
  return {
    version: 2,
    actorOperation: 3,
    recordId,
    operation,
    operationId,
    ownerId: context.ownerId,
    organisationId: context.organisationId,
    membershipId: context.membershipId,
    devicePublicKey: '0'.repeat(64),
    nativeGeneration: 1,
    hostGeneration: 2,
    bodySha256: hash,
    recordSha256: '1'.repeat(64),
  }
}
async function prepare(
  h: ReturnType<typeof harness>,
  operation: 'register' | 'publish-package' = 'register'
) {
  const body = bytes(),
    value = await descriptor(operation, body)
  const result = await h.request('attempt-prepare', { descriptor: JSON.stringify(value), body })
  expect(result.kind).toBe('attempt-prepared')
  const info = object(result.info)
  expect(info.operationId).toBe(operationId)
  expect(Number(info.retryBeforeMs) - Number(info.observedWallMs)).toBe(86_100_000)
  return { cellId: string(result.cellId), body, descriptor: value }
}

describe('fixed private confidential-device dispatch', () => {
  it('calibrates the actual native gate against exact final-clock guard omission', async () => {
    // An isolated source-helper oracle, not a replacement for the real client
    // transport cases below or native/Core provenance. No network is performed.
    const source = await readFile(
      fileURLToPath(new URL('../../../src/api/client.ts', import.meta.url)),
      'utf8'
    )
    const tree = ts.createSourceFile(
      'client.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const functions = tree.statements
      .filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === 'invokeConfidentialDeviceNative')
    expect(functions).toHaveLength(1)
    const node = functions[0]!
    if (!node.body) throw new Error('TEST_NATIVE_GATE_BODY')
    const guards = node.body.statements
      .filter(ts.isIfStatement)
      .filter((statement) => statement.expression.getText(tree).includes('now > cell.deadline'))
    expect(guards).toHaveLength(1)
    const original = node.getText(tree),
      guard = guards[0]!.getText(tree)
    expect(original.split(guard)).toHaveLength(2)
    const mutant = original.replace(guard, '')
    expect(mutant).not.toBe(original)
    async function evaluate(text: string, stale: boolean) {
      let sampled = 100
      const owner = {
        finished: false,
        consumed: false,
        observing: false,
        observedAt: 100,
        binding: { active: true, token: 'synthetic-gate-token' },
        lease: {},
      }
      const cell = {
        owner,
        post: true,
        used: false,
        deadline: 30100,
        url: BASE + '/organisations/' + context.organisationId + '/confidential/devices',
        init: { method: 'POST' },
      }
      const nativeCells = new WeakSet([cell])
      const native = vi.fn(() => Promise.resolve(new Response('{}')))
      const transformed = ts.transpileModule(text, {
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      })
      expect(transformed.diagnostics).toEqual([])
      const loaded: unknown = new Function(
        'deviceNativeCells',
        'deviceCurrent',
        'deviceClock',
        'tokenProvider',
        'NetworkError',
        'fetch',
        transformed.outputText + '\nreturn invokeConfidentialDeviceNative'
      )(
        nativeCells,
        () => {
          sampled = stale ? 6101 : 100
          return true
        },
        () => sampled,
        () => 'synthetic-gate-token',
        api.NetworkError,
        native
      )
      if (typeof loaded !== 'function') throw new Error('TEST_NATIVE_GATE_FUNCTION')
      const invoke = loaded as (value: typeof cell) => Promise<Response> | undefined
      const result = invoke(cell)
      if (result) await result
      return { result, native, consumed: owner.consumed }
    }
    const healthy = await evaluate(original, false)
    expect(healthy.native).toHaveBeenCalledOnce()
    expect(healthy.consumed).toBe(true)
    const refused = await evaluate(original, true)
    expect(refused.result).toBeUndefined()
    expect(refused.native).not.toHaveBeenCalled()
    expect(refused.consumed).toBe(false)
    const unguarded = await evaluate(mutant, true)
    expect(unguarded.native).toHaveBeenCalledOnce()
    expect(unguarded.consumed).toBe(true)
    expect(unguarded.native.mock.calls[0]).toEqual([
      BASE + '/organisations/' + context.organisationId + '/confidential/devices',
      { method: 'POST' },
    ])
  })
  it('uses the factory nonce instead of adopting the first received nonce', async () => {
    const h = harness()
    h.post('initialize-prepare', { mode: 'create', nonce: 'f'.repeat(32) })
    await initialize(h)
    expect(calls).toHaveLength(1)
    expect(captures).toBe(1)
  })
  it.each(['register', 'publish-package'] as const)(
    'freshly observes and sends exact %s bytes/key only once',
    async (operation) => {
      const h = harness()
      await initialize(h)
      const ready = await prepare(h, operation)
      const armed = { ...ready.descriptor, hostGeneration: 3, recordSha256: '2'.repeat(64) }
      const outcome = await h.request('attempt-send', {
        cellId: ready.cellId,
        descriptor: JSON.stringify(armed),
        body: ready.body,
      })
      expect(outcome.kind).toBe('attempt-outcome')
      expect(object(outcome.outcome).kind).toBe('response')
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', BASE + '/me'],
        ['GET', BASE + '/me'],
        [
          'POST',
          BASE +
            '/organisations/' +
            context.organisationId +
            '/confidential/' +
            (operation === 'register' ? 'devices' : 'key-packages'),
        ],
      ])
      const sent = calls[2]!
      expect(sent.headers.get('Authorization') === 'Bearer ' + token).toBe(true)
      expect(sent.headers.get('Idempotency-Key')).toBe(operationId)
      expect(sent.headers.get('Content-Type')).toBe('application/json')
      expect(sent.body).toEqual(ready.body)
      expect(sent.init.redirect).toBe('error')
      expect(sent.init.credentials).toBe('omit')
      expect(sent.init.cache).toBe('no-store')
      expect(
        calls
          .slice(0, 2)
          .every((c) => !c.headers.has('If-None-Match') && !c.headers.has('Idempotency-Key'))
      ).toBe(true)
      expect(captures).toBe(2)
      const count = calls.length
      const duplicate = await h.request('attempt-send', {
        cellId: ready.cellId,
        descriptor: JSON.stringify(armed),
        body: ready.body,
      })
      expect(duplicate.kind).toBe('refused')
      expect(calls).toHaveLength(count)
    }
  )
  it('preserves exact raw response bytes and opaque caller request IDs privately', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    const rawBody = ' { "deviceId" : "wire-order-and-spaces" }\n'
    responseOverride = (c) => response(c.url, rawBody, 201)
    const result = await h.request('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    const wire = object(result.outcome)
    expect(wire.requestId).toBe('c-synthetic-dispatch-123')
    expect(wire.body).toEqual(new TextEncoder().encode(rawBody))
    expect(wire.actorOperation).toBe(3)
    expect(wire.operationId).toBe(operationId)
    expect(Object.keys(h.binding)).toEqual(['close'])
  })
  it('uses structured-cloned IDs instead of object identity and refuses another endpoint', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    const another = harness()
    const crossed = await another.request('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    expect(crossed.kind).toBe('refused')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    const cloned = structuredClone({
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    const result = await h.request('attempt-send', cloned)
    expect(object(result.outcome).kind).toBe('response')
  })
  it('cannot accept a fabricated 201 or caller-selected transport through its private union', async () => {
    const h = harness()
    await initialize(h)
    const forged = await h.request('accept201', { response: { status: 201, deviceId: 'forged' } })
    expect(forged.kind).toBe('refused')
    const bad = await h.request('attempt-prepare', {
      descriptor: '{}',
      body: bytes(),
      url: 'https://outside.invalid',
      method: 'POST',
    })
    expect(bad.kind).toBe('refused')
    expect(calls).toHaveLength(1)
  })
  it('independently hashes bytes before observing principal or accepting a body replacement', async () => {
    const h = harness()
    await initialize(h)
    const body = bytes(),
      value = await descriptor()
    body[0] = body[0]! ^ 1
    const bad = await h.request('attempt-prepare', { descriptor: JSON.stringify(value), body })
    expect(bad.kind).toBe('refused')
    expect(calls).toHaveLength(1)
    const ready = await prepare(h)
    ready.body[0] = ready.body[0]! ^ 1
    const swapped = await h.request('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    expect(swapped.kind).toBe('refused')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
  it.each(['owner', 'membership', 'identity', 'staff'] as const)(
    '%s drift refuses current principal without rescoping',
    async (kind) => {
      const h = harness()
      await initialize(h)
      const bad = structuredClone(fixtures.responses.me.body)
      if (kind === 'owner') bad.id = recordId
      if (kind === 'membership') bad.organisations[0]!.membership_id = recordId
      if (kind === 'identity')
        Object.defineProperty(bad.organisations[0]!, 'identity_id', { value: undefined })
      if (kind === 'staff') bad.staff = true
      scopeResponse = bad
      const ready = await h.request('attempt-prepare', {
        descriptor: JSON.stringify(await descriptor()),
        body: bytes(),
      })
      expect(ready.kind).toBe('refused')
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    }
  )
  it('does not reuse initial observation for POST and expires a cell before invocation', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    clock += 5001
    const result = await h.request('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    expect(result.kind).toBe('refused')
    expect(calls).toHaveLength(2)
  })
  it('does not reapply the five-second preparation age after a valid invocation starts', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    let complete: ((r: Response) => void) | undefined
    responseOverride = () =>
      new Promise<Response>((resolve) => {
        complete = resolve
      })
    const pending = h.request('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    clock += 7000
    if (!complete) throw new Error('TEST_NATIVE_NOT_STARTED')
    complete(response(calls[2]!.url, '{}', 201))
    expect(object((await pending).outcome).kind).toBe('response')
  })
  it.each(['current', 'provider'] as const)(
    'checks final invocation age after %s callbacks',
    async (kind) => {
      const h = harness()
      await initialize(h)
      const ready = await prepare(h)
      let advanced = false,
        lookups = 0
      if (kind === 'current') advanceCurrent = true
      else
        api.setTokenProvider(() => {
          if (++lookups === 3) {
            clock += 6000
            advanced = true
          }
          return token
        })
      const result = await h.request('attempt-send', {
        cellId: ready.cellId,
        descriptor: JSON.stringify(ready.descriptor),
        body: ready.body,
      })
      expect(kind === 'current' ? currentAdvanced : advanced).toBe(true)
      expect(result.kind).toBe('refused')
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    }
  )
  it.each(['GET', 'POST'] as const)('refuses a %s body deadline crossed by the final currentness callback', async (method) => {
    const h = harness()
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined
    if (method === 'POST') { await initialize(h); prepared = await prepare(h) }
    responseOverride = (call) => {
      const value = response(call.url, method === 'GET' ? JSON.stringify(scopeResponse) : '{}', method === 'POST' ? 201 : 200)
      const body = value.body!
      const reader = body.getReader()
      const read = reader.read.bind(reader)
      vi.spyOn(body, 'getReader').mockReturnValue(reader)
      vi.spyOn(reader, 'read').mockImplementation(async () => {
        const result = await read()
        if (result.done) responseClockAdvance = method === 'POST' ? 40000 : 11000
        return result
      })
      return value
    }
    const result = prepared ? await h.request('attempt-send', {
      cellId: prepared.cellId, descriptor: JSON.stringify(prepared.descriptor), body: prepared.body,
    }) : await h.request('initialize-prepare', { mode: 'create' })
    if (method === 'POST') expect(object(result.outcome).kind).toBe('unknown')
    else expect(result.kind).toBe('refused')
  })
  it('preserves unknown when the final publication predicate crosses the POST deadline', async () => {
    const h = harness(); await initialize(h); const prepared = await prepare(h)
    let reads = 0
    responseOverride = (call) => {
      const value = response(call.url, '{}', 201)
      Object.defineProperty(value, 'status', { get() {
        // Two metadata checks precede body completion. Arm only when the
        // actual success outcome is built immediately before publication.
        if (++reads === 3) responseClockAdvance = 40000
        return 201
      } })
      return value
    }
    const result = await h.request('attempt-send', { cellId: prepared.cellId,
      descriptor: JSON.stringify(prepared.descriptor), body: prepared.body })
    expect(reads).toBe(3)
    expect(object(result.outcome).kind).toBe('unknown')
  })
  it('checks the GET native deadline after the final provider callback', async () => {
    const h = harness()
    let lookups = 0,
      advanced = false
    api.setTokenProvider(() => {
      if (++lookups === 4) {
        clock += 11000
        advanced = true
      }
      return token
    })
    const result = await h.request('initialize-prepare', { mode: 'create' })
    expect(advanced).toBe(true)
    expect(result.kind).toBe('refused')
    expect(calls).toHaveLength(0)
  })
  it('samples initial consumption age after its captured current predicate', async () => {
    const h = harness()
    const prepared = await h.request('initialize-prepare', { mode: 'create' })
    expect(prepared.kind).toBe('initialization-prepared')
    advanceCurrent = true
    currentChecks = 1
    const result = await h.request('initialize-consume', { cellId: string(prepared.cellId) })
    expect(currentAdvanced).toBe(true)
    expect(result.kind).toBe('refused')
    const unpublished = await h.request('attempt-prepare', {
      descriptor: JSON.stringify(await descriptor()),
      body: bytes(),
    })
    expect(unpublished.kind).toBe('refused')
    expect(calls).toHaveLength(1)
  })
  it.each(['backward', 'nonfinite'] as const)(
    'refuses %s monotonic preparation age',
    async (kind) => {
      const h = harness()
      await initialize(h)
      const ready = await prepare(h)
      clock = kind === 'backward' ? clock - 1 : NaN
      const result = await h.request('attempt-send', {
        cellId: ready.cellId,
        descriptor: JSON.stringify(ready.descriptor),
        body: ready.body,
      })
      expect(result.kind).toBe('refused')
      expect(calls).toHaveLength(2)
    }
  )
  it('rejects a reentrant close before native invocation even when current returns true', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    closeDuringCurrent = true
    h.post('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    await vi.waitFor(() => expect(closeObserved).toBe(true))
    expect(calls).toHaveLength(2)
  })
  it('retirement with same identity but renewed credential suppresses a late result', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    let complete: ((r: Response) => void) | undefined
    responseOverride = () =>
      new Promise<Response>((resolve) => {
        complete = resolve
      })
    h.post('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    const prior = outputs.length
    session = { ...session, credentialGeneration: 2 }
    token = 'synthetic-renewed-bearer'
    for (const callback of callbacks) callback()
    if (!complete) throw new Error('TEST_NATIVE_NOT_STARTED')
    complete(response(calls[2]!.url, '{}', 201))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(outputs).toHaveLength(prior)
    expect(calls[2]!.init.signal?.aborted).toBe(true)
  })
  it.each(['GET', 'POST'] as const)(
    'cancels a deferred %s response body that arrives after retirement',
    async (method) => {
      const h = harness()
      const ready = method === 'POST' ? (await initialize(h), await prepare(h)) : undefined
      let complete: ((response: Response) => void) | undefined
      responseOverride = () =>
        new Promise<Response>((resolve) => {
          complete = resolve
        })
      if (ready)
        h.post('attempt-send', {
          cellId: ready.cellId,
          descriptor: JSON.stringify(ready.descriptor),
          body: ready.body,
        })
      else h.post('initialize-prepare', { mode: 'create' })
      await vi.waitFor(() => expect(calls).toHaveLength(method === 'POST' ? 3 : 1))
      const prior = outputs.length
      session = { ...session, credentialGeneration: 2 }
      for (const callback of callbacks) callback()
      const cancelled = vi.fn()
      const late = new Response(new ReadableStream({ cancel: cancelled }))
      if (!complete) throw new Error('TEST_NATIVE_NOT_STARTED')
      complete(late)
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
      expect(outputs).toHaveLength(prior)
      expect(calls.at(-1)!.init.signal?.aborted).toBe(true)
    }
  )
  it.each([
    'missing-etag',
    'weak-etag',
    'missing-id',
    'unsafe-id',
    'media',
    'media-charset',
    'large',
    'utf8',
  ] as const)('%s Me cannot create an initialization cell', async (kind) => {
    const h = harness()
    responseOverride = (c) => {
      const result = response(
        c.url,
        kind === 'large'
          ? ' '.repeat(262145)
          : kind === 'utf8'
            ? Uint8Array.of(255)
            : JSON.stringify(scopeResponse)
      )
      if (kind === 'missing-etag') result.headers.delete('ETag')
      if (kind === 'weak-etag') result.headers.set('ETag', 'W/"weak"')
      if (kind === 'missing-id') result.headers.delete('X-Request-Id')
      if (kind === 'unsafe-id') result.headers.set('X-Request-Id', 'short')
      if (kind === 'media') result.headers.set('Content-Type', 'text/html')
      if (kind === 'media-charset')
        result.headers.set('Content-Type', 'application/json; charset=iso-8859-1')
      return result
    }
    const result = await h.request('initialize-prepare', { mode: 'restore' })
    expect(result.kind).toBe('refused')
    expect(calls).toHaveLength(1)
  })
  it.each(['large', 'utf8', 'redirect', 'network'] as const)(
    '%s POST remains unknown with no automatic retry',
    async (kind) => {
      const h = harness()
      await initialize(h)
      const ready = await prepare(h)
      responseOverride = (c) => {
        if (kind === 'network') return Promise.reject(new TypeError('synthetic transport failure'))
        return response(
          kind === 'redirect' ? 'https://outside.invalid/' : c.url,
          kind === 'large' ? ' '.repeat(16385) : kind === 'utf8' ? Uint8Array.of(255) : '{}',
          201
        )
      }
      const result = await h.request('attempt-send', {
        cellId: ready.cellId,
        descriptor: JSON.stringify(ready.descriptor),
        body: ready.body,
      })
      expect(object(result.outcome).kind).toBe('unknown')
      expect(calls).toHaveLength(3)
    }
  )
  it('retirement during an actual stream read cancels it without publishing', async () => {
    const h = harness()
    await initialize(h)
    const ready = await prepare(h)
    let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(value) {
        controller = value
      },
      cancel: cancelled,
    })
    responseOverride = (c) => {
      const result = new Response(stream, {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'c-synthetic-stream-123' },
      })
      Object.defineProperty(result, 'url', { value: c.url })
      return result
    }
    h.post('attempt-send', {
      cellId: ready.cellId,
      descriptor: JSON.stringify(ready.descriptor),
      body: ready.body,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    const prior = outputs.length
    rpcLive = false
    controller.enqueue(new TextEncoder().encode('{}'))
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
    expect(outputs).toHaveLength(prior)
    expect(calls[2]!.init.signal?.aborted).toBe(true)
  })
  it.each([
    'https://core.example/api/v1',
    'https://core.example/reverse-proxy/api/v1/',
    'http://localhost:8000/api/v1',
    'http://127.0.0.1:8000/api/v1',
    'http://[::1]:8000/api/v1',
  ])('accepts configured fixed base %s', async (base) => {
    vi.stubEnv('VITE_CORE_API_URL', base)
    const h = harness()
    await initialize(h)
    expect(calls[0]!.url).toBe(base.replace(/\/$/, '') + '/me')
  })
  it.each([
    'http://localhost.evil/api/v1',
    'http://127.0.0.2/api/v1',
    'http://192.168.1.2/api/v1',
    'https://user:pass@core.example/api/v1',
    'https://core.example/api/v1?x=1',
    'https://core.example/api/v1#x',
    'https://core.example/a/../api/v1',
    'https://core.example/a//api/v1',
    'https://core.example/%61pi/v1',
    'https://core.example/other',
    'https://core.example\\api/v1',
  ])('refuses unsafe configured base %s before network', (base) => {
    vi.stubEnv('VITE_CORE_API_URL', base)
    expect(() => harness()).toThrow('Confidential device dispatch refused.')
    expect(calls).toEqual([])
  })
  it('defines extracted frame fields without invoking Object.prototype setters', async () => {
    let intercepted = false
    Object.defineProperty(Object.prototype, 'mode', {
      configurable: true,
      set() {
        intercepted = true
        throw new Error('POLLUTED_DISPATCH_SETTER')
      },
    })
    try {
      const h = harness()
      await initialize(h)
      expect(intercepted).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'mode')
    }
  })
})
