import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { http, HttpResponse } from 'msw/http'
import * as compiler from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiProblem, coreApi, setTokenProvider } from '../../api/client'
import type { components } from '../../api/schema'
import type { AuthAdapter, AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { authAdapter } from '../../auth/oidc'
import { problem } from '../../mocks/problem'
import { server } from '../../mocks/server'
import * as orderContext from '../order/freshOwner'
import * as claimImported from './freshOwner'

type Me = components['schemas']['Me']
type SessionReader = Pick<AuthAdapter, 'getSnapshot' | 'getAccessToken' | 'subscribe'>
type ClaimApi = Pick<typeof claimImported, 'createFreshClaimOwnerReader' | 'loadFreshClaimOwner'>
type ClaimRead = ReturnType<ClaimApi['createFreshClaimOwnerReader']>
type ExpectedOwner = Parameters<ClaimRead>[0]
type OwnerResult = Awaited<ReturnType<ClaimRead>>
type Outcome = { ok: true; value: OwnerResult } | { ok: false; error: unknown }
type Control = 'uuid' | 'role'

const BASE = 'https://core.claim-reader.test/api/v1'
const ORG = '00000000-0000-4000-8000-000000000081'
const OTHER_ORG = '00000000-0000-4000-8000-000000000082'
const MEMBERSHIP = '00000000-0000-4000-8000-000000000083'
const IDENTITY = '00000000-0000-4000-8000-000000000084'
const ISSUER = 'https://identity.example.test/realms/claim-reader'
const SUBJECT = 'claim-reader-subject'
const SLUG = 'claim-reader'
const ACCESS = 'NO_LOG'
const UNAVAILABLE = 'https://kodera.io/problems/service-unavailable'
const SOURCE = readFileSync(join(import.meta.dirname, 'freshOwner.ts'), 'utf8')
const UUID_GUARD = 'if (fresh.owner.organisationId !== expected.organisationId) return undefined'
const ROLE_GUARD = "if (fresh.membership.role !== 'org_owner') return undefined"

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

function latch() {
  let complete!: () => void
  let settled = false
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    get settled() {
      return settled
    },
    resolve() {
      if (settled) throw Error('C8_DOUBLE_SETTLEMENT')
      settled = true
      complete()
    },
  }
}

function generatedMe(): Me {
  return {
    id: '00000000-0000-4000-8000-000000000085',
    email: 'owner@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: IDENTITY,
        issuer: ISSUER,
        realm: SLUG,
        subject: SUBJECT,
        email: 'owner@example.test',
      },
    ],
    organisations: [
      {
        organisation: { id: ORG, slug: SLUG, name: 'Synthetic organisation' },
        membership_id: MEMBERSHIP,
        identity_id: IDENTITY,
        state: 'active',
        role: 'org_owner',
      },
    ],
  }
}

function expectedResult() {
  return {
    issuer: ISSUER,
    subject: SUBJECT,
    organisationId: ORG,
    membershipId: MEMBERSHIP,
    identityId: IDENTITY,
    generation: 4,
  }
}

interface ReaderFixture {
  adapter: SessionReader
  expected: {
    organisationId: string
    organisationSlug: string
    issuer: string
    subject: string
    generation: number
  }
  me: Me
  controller: AbortController
  reached: ReturnType<typeof latch>
  release: ReturnType<typeof latch>
  finished: ReturnType<typeof latch>
  listeners: Set<() => void>
  abortListeners: Set<EventListenerOrEventListenerObject>
  requests: { method: string; url: string; bearer: string | null; key: string | null }[]
  signals: AbortSignal[]
  failures: unknown[]
  outcomes: Promise<Outcome>[]
  response: () => Response
  activeReads: number
  notify(): void
  replaceGeneration(): void
  replaceToken(): void
  start(expected?: ExpectedOwner): Promise<Outcome>
  startProduction(expected?: ExpectedOwner): Promise<Outcome>
}

async function withReaderFixture<Value>(
  api: ClaimApi,
  action: (fixture: ReaderFixture) => Promise<Value>
): Promise<Value> {
  const controller = new AbortController()
  const reached = latch()
  const release = latch()
  const finished = latch()
  const me = generatedMe()
  let token = ACCESS
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    generation: 4,
    credentialGeneration: 1,
    user: {
      realm: SLUG,
      identity: { issuer: ISSUER, subject: SUBJECT },
    },
  }
  const listeners = new Set<() => void>()
  const abortListeners = new Set<EventListenerOrEventListenerObject>()
  const unexpected: string[] = []
  const adapter: SessionReader = {
    getSnapshot: () => snapshot,
    getAccessToken: () => token,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener)) unexpected.push('unowned-auth-removal')
      }
    },
  }
  const observe = (pending: Promise<OwnerResult>): Promise<Outcome> => {
    const outcome = pending.then(
      (value): Outcome => ({ ok: true, value }),
      (error: unknown): Outcome => ({ ok: false, error })
    )
    fixture.outcomes.push(outcome)
    return outcome
  }
  const read = api.createFreshClaimOwnerReader(
    adapter,
    orderContext.createFreshOrderContextReader(adapter, async (signal) => {
      fixture.signals.push(signal)
      fixture.activeReads++
      try {
        const { data } = await coreApi().GET('/me', { signal })
        return data
      } catch (error) {
        fixture.failures.push(error)
        throw error
      } finally {
        fixture.activeReads--
      }
    })
  )
  const fixture: ReaderFixture = {
    adapter,
    expected: {
      organisationId: ORG,
      organisationSlug: SLUG,
      issuer: ISSUER,
      subject: SUBJECT,
      generation: 4,
    },
    me,
    controller,
    reached,
    release,
    finished,
    listeners,
    abortListeners,
    requests: [],
    signals: [],
    failures: [],
    outcomes: [],
    response: () => HttpResponse.json(me),
    activeReads: 0,
    notify: () => {
      for (const listener of [...listeners]) listener()
    },
    replaceGeneration: () => {
      snapshot = { ...snapshot, generation: 5 }
      fixture.notify()
    },
    replaceToken: () => {
      token = 'NO_LOG_2'
      fixture.notify()
    },
    start: (expected = fixture.expected) => observe(read(expected, controller.signal)),
    startProduction: (expected = fixture.expected) =>
      observe(api.loadFreshClaimOwner(expected, controller.signal)),
  }
  const audit = ({ request }: { request: Request }) => {
    if (request.method !== 'GET' || request.url !== BASE + '/me')
      unexpected.push('forbidden-request')
  }
  const auditUnhandled = () => unexpected.push('unhandled-request')
  server.events.on('request:start', audit)
  server.events.on('request:unhandled', auditUnhandled)
  server.use(
    http.get(BASE + '/me', async ({ request }) => {
      fixture.requests.push({
        method: request.method,
        url: request.url,
        bearer: request.headers.get('Authorization'),
        key: request.headers.get('Idempotency-Key'),
      })
      if (fixture.requests.length !== 1) throw Error('C8_EXTRA_GET')
      reached.resolve()
      try {
        await release.promise
        return fixture.response()
      } finally {
        finished.resolve()
      }
    })
  )
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(adapter.getAccessToken)
  const snapshotSpy = vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(adapter.getSnapshot)
  const tokenSpy = vi
    .spyOn(authAdapter, 'getAccessToken')
    .mockImplementation(adapter.getAccessToken)
  const subscribeSpy = vi.spyOn(authAdapter, 'subscribe').mockImplementation(adapter.subscribe)
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  const addSpy = vi
    .spyOn(controller.signal, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'abort' || listener === null) unexpected.push('unexpected-abort-listener')
      else abortListeners.add(listener)
      add(type, listener, options)
    })
  const removeSpy = vi
    .spyOn(controller.signal, 'removeEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'abort' || listener === null || !abortListeners.delete(listener))
        unexpected.push('unowned-abort-removal')
      remove(type, listener, options)
    })
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {
    unexpected.push('window-open')
    return null
  })
  const pushSpy = vi.spyOn(history, 'pushState').mockImplementation(() => {
    unexpected.push('history-push')
  })
  const replaceSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {
    unexpected.push('history-replace')
  })
  let primaryFailed = false
  let primary: unknown
  let value!: Value
  try {
    value = await action(fixture)
  } catch (error) {
    primaryFailed = true
    primary = error
  }
  const cleanup: unknown[] = []
  const finalize = async (operation: () => unknown | Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      cleanup.push(error)
    }
  }
  await finalize(() => {
    if (!release.settled) release.resolve()
  })
  await finalize(() => Promise.all(fixture.outcomes))
  await finalize(async () => {
    if (reached.settled) await finished.promise
  })
  await finalize(() => {
    expect(fixture.activeReads, 'C8_PENDING_READS').toBe(0)
    expect(listeners.size, 'C8_OWNED_AUTH_LISTENERS').toBe(0)
    expect(abortListeners.size, 'C8_OWNED_ABORT_LISTENERS').toBe(0)
    expect(unexpected, 'C8_FORBIDDEN_EFFECTS').toEqual([])
  })
  await finalize(() => server.events.removeListener('request:start', audit))
  await finalize(() => server.events.removeListener('request:unhandled', auditUnhandled))
  await finalize(() => server.resetHandlers())
  await finalize(() => setTokenProvider(() => undefined))
  for (const spy of [
    snapshotSpy,
    tokenSpy,
    subscribeSpy,
    addSpy,
    removeSpy,
    openSpy,
    pushSpy,
    replaceSpy,
  ])
    await finalize(() => spy.mockRestore())
  await finalize(() => vi.unstubAllEnvs())
  if (cleanup.length !== 0)
    throw new AggregateError(primaryFailed ? [primary, ...cleanup] : cleanup, 'C8_FIXTURE_CLEANUP')
  if (primaryFailed) throw primary
  return value
}

function successful(outcome: Outcome): OwnerResult {
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

async function complete(fixture: ReaderFixture): Promise<OwnerResult> {
  const outcome = fixture.start()
  fixture.release.resolve()
  return successful(await outcome)
}

async function reachedGet(reached: Promise<void>, outcome: Promise<Outcome>): Promise<void> {
  const first = await Promise.race([
    reached.then(() => 'reached' as const),
    outcome.then(() => 'completed' as const),
  ])
  if (first === 'completed') throw Error('C8_COMPLETED_BEFORE_GET')
}

function currentGet(fixture: ReaderFixture): void {
  expect(fixture.requests, 'C8_ACTUAL_GET').toEqual([
    { method: 'GET', url: BASE + '/me', bearer: 'Bearer ' + ACCESS, key: null },
  ])
  expect(fixture.signals).toHaveLength(1)
  expect(fixture.signals[0]!.aborted).toBe(false)
  expect(fixture.adapter.getSnapshot().status).toBe('ready')
  expect(fixture.adapter.getSnapshot().generation).toBe(4)
  expect(fixture.adapter.getSnapshot().user?.identity).toEqual({ issuer: ISSUER, subject: SUBJECT })
  expect(fixture.adapter.getAccessToken()).toBe(ACCESS)
  expect(fixture.me.identities).toHaveLength(1)
  expect(fixture.me.identities[0]).toEqual({
    id: IDENTITY,
    issuer: ISSUER,
    realm: SLUG,
    subject: SUBJECT,
    email: 'owner@example.test',
  })
  expect(fixture.me.organisations).toHaveLength(1)
  expect(fixture.me.organisations[0]!.membership_id).toBe(MEMBERSHIP)
  expect(fixture.me.organisations[0]!.state).toBe('active')
  expect(fixture.me.organisations[0]!.identity_id).toBe(IDENTITY)
  expect(fixture.listeners.size).toBe(0)
  expect(fixture.abortListeners.size).toBe(0)
}

function checkSource(source: string): void {
  if (Buffer.byteLength(source) > 8192) throw Error('C8_SOURCE_SIZE')
  for (const anchor of [UUID_GUARD, ROLE_GUARD]) {
    if (source.split(anchor).length !== 2) throw Error('C8_SOURCE_ANCHOR')
  }
  const parsed = compiler.createSourceFile(
    'freshOwner.ts',
    source,
    compiler.ScriptTarget.ES2022,
    true
  )
  const declarations = parsed.statements
    .filter(compiler.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        compiler.isIdentifier(declaration.name) && declaration.name.text === 'loadFreshClaimOwner'
    )
  if (declarations.length !== 1) throw Error('C8_PRODUCTION_BINDING')
  const initializer = declarations[0]!.initializer
  if (
    initializer === undefined ||
    !compiler.isCallExpression(initializer) ||
    !compiler.isIdentifier(initializer.expression) ||
    initializer.expression.text !== 'createFreshClaimOwnerReader' ||
    initializer.arguments.length !== 2
  )
    throw Error('C8_PRODUCTION_BINDING')
  const [adapterArgument, readerArgument] = initializer.arguments
  if (
    adapterArgument === undefined ||
    readerArgument === undefined ||
    !compiler.isIdentifier(adapterArgument) ||
    adapterArgument.text !== 'authAdapter' ||
    !compiler.isIdentifier(readerArgument) ||
    readerArgument.text !== 'loadFreshOrderContext'
  )
    throw Error('C8_PRODUCTION_BINDING')
}

function loadClaim(control?: Control, inputSource: string = SOURCE): ClaimApi {
  checkSource(inputSource)
  const anchor = control === 'uuid' ? UUID_GUARD : ROLE_GUARD
  const source = control === undefined ? inputSource : inputSource.replace(anchor, '')
  const compiled = compiler.transpileModule(source, {
    fileName: 'freshOwner.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: compiler.ScriptTarget.ES2022,
      module: compiler.ModuleKind.CommonJS,
    },
  })
  if (compiled.diagnostics?.some((entry) => entry.category === compiler.DiagnosticCategory.Error))
    throw Error('C8_SOURCE_SYNTAX')
  if (Buffer.byteLength(compiled.outputText) > 16384) throw Error('C8_SOURCE_OUTPUT')
  const loaded = { exports: {} as Record<string, unknown> }
  runInNewContext(
    compiled.outputText,
    {
      exports: loaded.exports,
      module: loaded,
      require: (name: string) => {
        if (name === '../../auth/oidc') return { authAdapter }
        if (name === '../order/freshOwner')
          return {
            loadFreshOrderContext: orderContext.loadFreshOrderContext,
            OrderOwnershipUnavailable: orderContext.OrderOwnershipUnavailable,
          }
        throw Error('C8_SOURCE_IMPORT')
      },
      Error,
      AggregateError,
      DOMException,
      AbortSignal,
      AbortController,
      Promise,
      console: {
        log: () => {
          throw Error('C8_SOURCE_EFFECT')
        },
        error: () => {
          throw Error('C8_SOURCE_EFFECT')
        },
      },
      setTimeout: () => {
        throw Error('C8_SOURCE_EFFECT')
      },
      setInterval: () => {
        throw Error('C8_SOURCE_EFFECT')
      },
    },
    { timeout: 1000, filename: 'claim-owner-control.cjs' }
  )
  if (
    typeof loaded.exports['createFreshClaimOwnerReader'] !== 'function' ||
    typeof loaded.exports['loadFreshClaimOwner'] !== 'function'
  )
    throw Error('C8_SOURCE_EXPORT')
  return loaded.exports as ClaimApi
}

async function authorityProbe(api: ClaimApi, control: Control): Promise<void> {
  await withReaderFixture(api, async (fixture) => {
    if (control === 'uuid') fixture.expected.organisationId = OTHER_ORG
    else fixture.me.organisations[0]!.role = 'org_member'
    const owner = await complete(fixture)
    currentGet(fixture)
    expect(fixture.me.organisations[0]!.organisation).toEqual({
      id: ORG,
      slug: SLUG,
      name: 'Synthetic organisation',
    })
    expect(fixture.me.organisations[0]!.role).toBe(control === 'role' ? 'org_member' : 'org_owner')
    expect(owner, control === 'uuid' ? 'C8_EXPECTED_UUID' : 'C8_ACTIVE_OWNER_ROLE').toBeUndefined()
  })
}

describe('unused fresh claim-owner authority', () => {
  it('C8 current owner uses the fixed production binding and a copied expected context', async () => {
    checkSource(SOURCE)
    await withReaderFixture(claimImported, async (fixture) => {
      const outcome = fixture.startProduction()
      await reachedGet(fixture.reached.promise, outcome)
      Object.assign(fixture.expected, {
        organisationId: OTHER_ORG,
        organisationSlug: 'other',
        issuer: 'https://other.example.test',
        subject: 'other',
        generation: 5,
      })
      fixture.release.resolve()
      const owner = successful(await outcome)
      expect(fixture.requests).toEqual([
        { method: 'GET', url: BASE + '/me', bearer: 'Bearer ' + ACCESS, key: null },
      ])
      expect(owner).toEqual(expectedResult())
      expect(Object.isFrozen(owner)).toBe(true)
      expect(Object.keys(owner!)).toEqual(Object.keys(expectedResult()))
    })
  })

  it('C8 same slug with wrong expected UUID is not owner evidence', async () => {
    await authorityProbe(claimImported, 'uuid')
  })

  it('C8 same UUID with wrong slug has no selected owner', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.expected.organisationSlug = 'other'
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(1)
    })
  })

  it('C8 active member without owner role is not owner evidence', async () => {
    await authorityProbe(claimImported, 'role')
  })

  it('C8 inactive owner is unresolved', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.me.organisations[0]!.state = 'removed'
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(1)
    })
  })

  it('C8 duplicate selected organisation membership is unresolved', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.me.organisations.push({ ...fixture.me.organisations[0]! })
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(1)
    })
  })

  it('C8 absent fresh data is unresolved', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.response = () => new HttpResponse(null, { status: 204 })
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(1)
    })
  })

  it('C8 still-current request failure retains the exact actual ApiProblem', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.response = () => problem(UNAVAILABLE, { retryAfterS: 1 })
      const outcome = fixture.start()
      fixture.release.resolve()
      const observed = await outcome
      currentGet(fixture)
      expect(fixture.failures).toHaveLength(1)
      const original = fixture.failures[0]
      expect(original).toBeInstanceOf(ApiProblem)
      expect(original).toMatchObject({ type: UNAVAILABLE, status: 503 })
      expect(observed.ok).toBe(false)
      if (observed.ok) throw Error('C8_EXPECTED_REQUEST_FAILURE')
      expect(observed.error).toBe(original)
    })
  })

  it('C8 generation replacement aborts the reached request and rejects late authority', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      const outcome = fixture.start()
      await reachedGet(fixture.reached.promise, outcome)
      expect(fixture.requests).toHaveLength(1)
      fixture.replaceGeneration()
      expect(fixture.signals[0]!.aborted).toBe(true)
      fixture.release.resolve()
      expect(successful(await outcome)).toBeUndefined()
    })
  })

  it('C8 token replacement and actual notification abort the reached request', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      const outcome = fixture.start()
      await reachedGet(fixture.reached.promise, outcome)
      expect(fixture.requests).toHaveLength(1)
      fixture.replaceToken()
      expect(fixture.signals[0]!.aborted).toBe(true)
      fixture.release.resolve()
      expect(successful(await outcome)).toBeUndefined()
    })
  })

  it('C8 wrong expected issuer refuses before requesting Core', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.expected.issuer = 'https://other.example.test'
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(0)
    })
  })

  it('C8 wrong expected subject refuses before requesting Core', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      fixture.expected.subject = 'other'
      expect(await complete(fixture)).toBeUndefined()
      expect(fixture.requests).toHaveLength(0)
    })
  })

  it('C8 caller abort ends the reached request and refuses late authority', async () => {
    await withReaderFixture(claimImported, async (fixture) => {
      const outcome = fixture.start()
      await reachedGet(fixture.reached.promise, outcome)
      expect(fixture.requests).toHaveLength(1)
      fixture.controller.abort()
      expect(fixture.signals[0]!.aborted).toBe(true)
      fixture.release.resolve()
      expect(successful(await outcome)).toBeUndefined()
    })
  })

  it('C8 fixture and loader guards refuse eight exact inputs and freshly restore', async () => {
    await authorityProbe(loadClaim(), 'uuid')
    const sourceBytes = Buffer.byteLength(SOURCE)
    expect(sourceBytes).toBeLessThanOrEqual(8192)
    expect(SOURCE.split(UUID_GUARD)).toHaveLength(2)
    const binding = /createFreshClaimOwnerReader\(\s*authAdapter\s*,\s*loadFreshOrderContext\s*\)/g
    const exported = /\bexport\s+const\s+loadFreshClaimOwner\b/g
    expect([...SOURCE.matchAll(binding)]).toHaveLength(1)
    expect([...SOURCE.matchAll(exported)]).toHaveLength(1)
    const enumSuffix =
      '\nenum C8BoundedOutputPressureEvidence { ' +
      Array.from({ length: 256 }, (_unused, index) => 'E' + index).join(',') +
      ' }\n'
    expect(Buffer.byteLength(enumSuffix)).toBe(1212)
    const syntax = SOURCE + '\nconst c8Broken = (\n'
    const pressure = SOURCE + enumSuffix
    const extraImport = "import 'node:fs'\n" + SOURCE
    const missingExport = SOURCE.replace(exported, 'const loadFreshClaimOwner')
    const wrongBinding = SOURCE.replace(
      binding,
      'createFreshClaimOwnerReader(authAdapter, undefined)'
    )
    for (const input of [syntax, pressure, extraImport, missingExport, wrongBinding])
      expect(Buffer.byteLength(input)).toBeLessThanOrEqual(8192)
    const oversized = SOURCE + ' '.repeat(8193 - sourceBytes)
    expect(Buffer.byteLength(oversized)).toBe(8193)
    const inputs: readonly [string, () => unknown][] = [
      ['C8_SOURCE_SIZE', () => loadClaim(undefined, oversized)],
      ['C8_SOURCE_ANCHOR', () => loadClaim(undefined, SOURCE.replace(UUID_GUARD, ''))],
      ['C8_PRODUCTION_BINDING', () => loadClaim(undefined, wrongBinding)],
      ['C8_SOURCE_SYNTAX', () => loadClaim(undefined, syntax)],
      ['C8_SOURCE_OUTPUT', () => loadClaim(undefined, pressure)],
      ['C8_SOURCE_IMPORT', () => loadClaim(undefined, extraImport)],
      ['C8_SOURCE_EXPORT', () => loadClaim(undefined, missingExport)],
      [
        'C8_COMPLETED_BEFORE_GET',
        () =>
          withReaderFixture(claimImported, async (fixture) => {
            const outcome = Promise.resolve<Outcome>({ ok: false, error: undefined })
            let failed = false
            let observed: unknown
            try {
              await reachedGet(fixture.reached.promise, outcome)
            } catch (error) {
              failed = true
              observed = error
            }
            expect(fixture.reached.settled).toBe(false)
            expect(fixture.requests).toHaveLength(0)
            expect(failed).toBe(true)
            throw observed
          }),
      ],
    ]
    expect(inputs).toHaveLength(8)
    for (const [marker, run] of inputs) {
      let failed = false
      let observed: unknown
      try {
        await run()
      } catch (error) {
        failed = true
        observed = error
      }
      expect(failed, 'C8_HEALTH_MUST_REFUSE').toBe(true)
      expect(observed).toBeInstanceOf(Error)
      expect(observed).not.toBeInstanceOf(AggregateError)
      expect((observed as Error).message).toBe(marker)
      await authorityProbe(loadClaim(), 'uuid')
    }
  })

  it.each(['uuid', 'role'] as const)(
    'C8 isolated %s source guard reaches its exact refusal and restores fresh pristines',
    async (control) => {
      await authorityProbe(claimImported, control)
      await authorityProbe(loadClaim(), control)
      let failed = false
      let observed: unknown
      try {
        await authorityProbe(loadClaim(control), control)
      } catch (error) {
        failed = true
        observed = error
      }
      expect(failed, 'C8_CONTROL_MUST_REFUSE').toBe(true)
      expect(observed).toBeInstanceOf(Error)
      expect(observed).not.toBeInstanceOf(AggregateError)
      const assertion = observed as Error & { actual?: unknown; expected?: unknown }
      expect(assertion.message).toContain(
        control === 'uuid' ? 'C8_EXPECTED_UUID' : 'C8_ACTIVE_OWNER_ROLE'
      )
      expect(Object.prototype.hasOwnProperty.call(assertion, 'actual')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(assertion, 'expected')).toBe(true)
      expect(assertion.expected).toBeUndefined()
      expect(assertion.actual).toEqual(expectedResult())
      expect(Object.isFrozen(assertion.actual)).toBe(true)
      await authorityProbe(loadClaim(), control)
      await authorityProbe(claimImported, control)
    }
  )
})
