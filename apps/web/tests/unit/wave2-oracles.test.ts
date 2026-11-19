import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { check as checkFormatting } from 'prettier'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import scrubArtifacts from '../wave2/teardown'
import { MatrixSyncLifecycle } from '../wave2/sync-lifecycle'
import { installMatrixNavigationBarrier } from '../wave2/navigation'
import { documentText } from '../wave2/documents'
import { finishCleanup } from '../wave2/cleanup'
import { findMailLink, mailLinkPattern } from '../wave2/mailpit'
import { enterOrganisation } from '../wave2/login'
import { enterWorkspace } from '../wave2/workspace'
import { Actor, parentDomain, readWave2Input } from '../wave2/world'
import type { Wave2Input } from '../wave2/world'
import { selectInterfaceLanguage } from '../wave2/language'
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
  Request,
  Route,
} from '@playwright/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkLedger, recordNetwork } from '../wave2/oracles/r1-network'
import type { NetworkObservation, NetworkTemplate } from '../wave2/oracles/r1-network'
import {
  RateBudget,
  classifyRateRequest,
  trackRateRequests,
  resetRateAddressForTests,
} from '../wave2/oracles/r3-rate-budget'
import {
  assertTargetGate,
  openTargetGate,
  redactNetworkReceipt,
  validateReceipt,
  safeString,
} from '../wave2/oracles/r4-sanitizer'
import {
  ConsentLedger,
  EVENT_SCHEMAS,
  installConsentDispatchProbe,
  installPosthogInterceptor,
  POSTHOG_EU_ENDPOINT,
  validateCapturePayload,
  validateCaptureRequest,
  revokeConsent,
  assertNativeCancellation,
} from '../wave2/oracles/r5-posthog-eu'
import type { CaptureRequest } from '../wave2/oracles/r5-posthog-eu'
import {
  assertA11yResult,
  assertFontScan,
  assertLayout,
  assertLocalFont,
  assertRenderedFont,
  assertScreenshotOptions,
  assertTheme,
  assertTokenValues,
  layoutFaultsInDocument,
  snapshotKey,
  verifyTokenBinding,
  viewportScreenshot,
  WCAG_TAGS,
  scanFontsInDocument,
  installFontProbesInDocument,
  removeFontProbesInDocument,
  resetDocumentFocus,
  tabOrderForViewport,
} from '../wave2/oracles/r6-visual-a11y'
import type { VisualCell } from '../wave2/oracles/r6-visual-a11y'
import { exactOrigin, pathMatches } from '../wave2/oracles/shared'
import { assertSurfaceManifest, fixturePath, LANDING_DIALOGS, SURFACES } from '../wave2/surfaces'

const webPath = (...parts: string[]) => resolve(import.meta.dirname, '../..', ...parts)

const WEB = 'https://web.example.test'
const API = 'https://api.example.test'
const AUTH = 'https://auth.example.test'
const HS = 'https://matrix.example.test'
const template: NetworkTemplate = {
  origin: API,
  method: 'GET',
  pathPattern: '/api/v1/me',
  expectedStatus: 200,
}
const observation: NetworkObservation = {
  url: `${API}/api/v1/me`,
  method: 'GET',
  status: 200,
  contentType: 'application/json; charset=utf-8',
  bodyPrefix: '{"ok":true}',
  body: { ok: true },
}
const network = (t: NetworkTemplate[] = [template]) => new NetworkLedger(t, [WEB, API, AUTH, HS])
afterEach(() => {
  resetRateAddressForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('actor homeserver isolation', () => {
  const outsider = 'https://outsider.example.test'
  const room = '!private:matrix.example.test'
  const joinPath = `/_matrix/client/v3/join/${encodeURIComponent(room)}`
  let ordinal = 0
  const inputFor = (homeserverOrigin?: string): Wave2Input => {
    const actor = (alias: string) => ({
      account: {
        username: `synthetic-${alias}-${++ordinal}`,
        email: `${alias}@wave2.test`,
        password: 'synthetic-password',
        totpBase32: 'SYNTHETIC',
      },
      organisation: alias === 'C' ? 'other' : 'shared',
      organisationId: alias === 'C' ? 'other-id' : 'shared-id',
      realm: alias === 'C' ? 'other' : 'shared',
      role: alias === 'A' ? ('org_owner' as const) : ('org_member' as const),
      seedJoins: 0,
      network: [],
      ...(alias === 'C' && homeserverOrigin !== undefined ? { homeserverOrigin } : {}),
    })
    return {
      revision: 'a'.repeat(40),
      realm: 'shared',
      homeserverOrigin: HS,
      actors: { A: actor('A'), B: actor('B'), C: actor('C') },
    } as unknown as Wave2Input
  }
  const readFixture = async (input: Wave2Input) => {
    const dir = await mkdtemp(webPath('tests/wave2/runtime/origin-unit-'))
    const path = resolve(dir, 'input.json')
    try {
      await writeFile(path, JSON.stringify(input))
      vi.stubEnv('KODERA_WAVE2_PERSONA2_INPUT', path)
      return readWave2Input('PERSONA2')
    } finally {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  }
  it.each([undefined, HS, outsider, 'http://127.0.0.1:8008'])(
    'validates the optional actor origin %s',
    async (origin) => {
      await mkdir(webPath('tests/wave2/runtime'), { recursive: true })
      expect((await readFixture(inputFor(origin))).actors.C.homeserverOrigin).toBe(origin)
    }
  )
  it.each([
    ['https://outsider.example.test/path', 'TARGET_ORIGIN'],
    ['https://outsider.example.test/', 'TARGET_ORIGIN'],
    ['https://outsider.example.test?query=1', 'TARGET_ORIGIN'],
    ['https://user:secret@outsider.example.test', 'TARGET_ORIGIN'],
    ['http://outsider.example.test', 'TARGET_TLS'],
    ['', 'TARGET_ORIGIN'],
    [null, 'TARGET_ORIGIN'],
    [42, 'TARGET_ORIGIN'],
  ])('refuses noncanonical actor origin %s', async (origin, marker) => {
    const input = inputFor()
    Object.assign(input.actors.C, { homeserverOrigin: origin })
    await expect(readFixture(input)).rejects.toThrow(marker as string)
  })
  const setup = async (
    origin: string | undefined,
    replies = [{ status: 403, body: { errcode: 'M_FORBIDDEN' } }],
    capture = true
  ) => {
    const input = inputFor(origin)
    input.actors.C.network = [
      {
        origin: origin ?? HS,
        method: 'POST',
        pathPattern: joinPath,
        expectedStatus: origin && origin !== HS ? 502 : 403,
        max: 1,
        query: origin && origin !== HS ? { server_name: new URL(HS).host } : {},
        requiredBodyKeys: ['errcode'],
      },
      ...(origin && origin !== HS
        ? [{ origin: HS, method: 'POST', pathPattern: joinPath, expectedStatus: 401, max: 1 }]
        : []),
    ]
    const emitter = new EventEmitter()
    const post = vi.fn(async (url: string) => {
      const reply = replies[post.mock.calls.length - 1]!
      return {
        url: () => url,
        status: () => reply.status,
        headers: () => ({ 'content-type': 'application/json' }),
        json: async () => reply.body,
      }
    })
    const context = Object.assign(emitter, {
      newPage: async () => ({}),
      pages: () => [],
      exposeBinding: async () => {},
      addInitScript: async () => {},
      close: vi.fn(),
      request: { post },
      route: async () => {},
      unroute: async () => {},
    }) as unknown as BrowserContext
    const browser = { newContext: async () => context } as unknown as Browser
    const budget = new RateBudget()
    const actor = await Actor.create(browser, 'C', input, budget)
    const request = (
      host: string,
      authority: string,
      method = 'GET',
      path = '/_matrix/client/v3/sync'
    ) =>
      emitter.emit('request', {
        url: () => `${host}${path}`,
        method: () => method,
        resourceType: () => 'fetch',
        headers: () => ({ authorization: authority }),
      })
    if (capture) request(origin ?? HS, 'Bearer synthetic-own-authority')
    return { actor, budget, post, emitter, request }
  }
  it.each([undefined, HS])('retains the single-homeserver 403 refusal for %s', async (origin) => {
    const { actor, budget, post, emitter } = await setup(origin)
    try {
      expect(actor.homeserverOrigin).toBe(HS)
      expect(actor.ledger.allowedOrigins.filter((value) => value === HS)).toHaveLength(1)
      await actor.denyForeignJoin(HS, room)
      expect(post).toHaveBeenCalledExactlyOnceWith(`${HS}${joinPath}`, {
        headers: { authorization: 'Bearer synthetic-own-authority' },
        data: {},
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      budget.assertExact('C', { 'local-join': 1 })
      await actor.assertClean()
    } finally {
      await actor.close()
      expect(emitter.eventNames()).toEqual([])
    }
  })
  it('proves closed federation locally and foreign token rejection with the same own authority', async () => {
    const { actor, budget, post, request } = await setup(outsider, [
      { status: 502, body: { errcode: 'M_UNKNOWN' } },
      { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN' } },
    ])
    try {
      request(HS, 'Bearer foreign-authority')
      await actor.denyForeignJoin(HS, room)
      expect(actor.homeserverOrigin).toBe(outsider)
      expect(new Set(actor.ledger.allowedOrigins).size).toBe(actor.ledger.allowedOrigins.length)
      expect(post.mock.calls.map(([url]) => url)).toEqual([
        `${outsider}${joinPath}?server_name=matrix.example.test`,
        `${HS}${joinPath}`,
      ])
      for (const call of post.mock.calls)
        expect(call).toEqual([
          expect.any(String),
          {
            headers: { authorization: 'Bearer synthetic-own-authority' },
            data: {},
            maxRedirects: 0,
            failOnStatusCode: false,
          },
        ])
      budget.assertExact('C', { 'local-join': 1 })
      expect(actor.ledger.receipt().map((row) => row.count)).toEqual([1, 1])
      await actor.assertClean()
      request(HS, 'Bearer foreign-authority', 'POST', '/_matrix/client/v3/login')
      budget.assertExact('C', { 'matrix-login': 0 })
      request(outsider, 'Bearer synthetic-own-authority', 'POST', '/_matrix/client/v3/login')
      budget.assertExact('C', { 'matrix-login': 1 })
    } finally {
      await actor.close()
    }
  })
  it.each([
    [undefined, 200, 'M_FORBIDDEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [undefined, 403, 'M_UNKNOWN_TOKEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [outsider, 200, 'M_UNKNOWN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [outsider, 403, 'M_FORBIDDEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [outsider, 502, 'M_FORBIDDEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [outsider, 401, 'M_UNKNOWN_TOKEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
    [outsider, 403, 'M_UNKNOWN_TOKEN', 'WAVE2_MATRIX_FOREIGN_JOIN'],
  ])(
    'refuses the wrong local boundary response %s/%s/%s',
    async (origin, status, errcode, marker) => {
      const { actor, budget, post } = await setup(origin, [{ status, body: { errcode } }])
      try {
        await expect(actor.denyForeignJoin(HS, room)).rejects.toThrow(marker)
        expect(post).toHaveBeenCalledTimes(1)
        expect(actor.ledger.receipt()[0]!.count).toBe(1)
        budget.assertExact('C', { 'local-join': 1 })
      } finally {
        await actor.close()
      }
    }
  )
  it.each([
    [403, 'M_FORBIDDEN'],
    [200, 'M_UNKNOWN_TOKEN'],
    [401, 'M_FORBIDDEN'],
  ])('refuses the wrong foreign boundary response %s/%s', async (status, errcode) => {
    const { actor, post, budget } = await setup(outsider, [
      { status: 502, body: { errcode: 'M_UNKNOWN' } },
      { status, body: { errcode } },
    ])
    try {
      await expect(actor.denyForeignJoin(HS, room)).rejects.toThrow('WAVE2_MATRIX_FOREIGN_TOKEN')
      expect(post).toHaveBeenCalledTimes(2)
      expect(actor.ledger.receipt().map((row) => row.count)).toEqual([1, 1])
      budget.assertExact('C', { 'local-join': 1 })
    } finally {
      await actor.close()
    }
  })
  it.each([
    ['https://a.wave2.localhost', 'wave2.localhost'],
    ['https://a.kodera.test', 'kodera.test'],
    ['https://a.staging.kodera.io', 'staging.kodera.io'],
    ['https://localhost:8008', ''],
    ['https://127.0.0.1:8008', ''],
    ['https://[::1]:8008', ''],
    ['https://kodera.test', ''],
  ])('extracts the tenant parent for %s', (origin, parent) => {
    expect(parentDomain(origin)).toBe(parent)
  })
  it.each(['https://matrix.other.test', 'https://localhost:8008', 'https://example.test'])(
    'refuses a foreign domain before transmitting authority to %s',
    async (target) => {
      const { actor, post, budget } = await setup(outsider)
      try {
        await expect(actor.denyForeignJoin(target, room)).rejects.toThrow(
          'WAVE2_FOREIGN_DOMAIN_BOUNDARY'
        )
        expect(post).not.toHaveBeenCalled()
        budget.assertExact('C', { 'local-join': 0 })
      } finally {
        await actor.close()
      }
    }
  )
  it.each([
    'https://capture.example.test/path',
    'https://capture.example.test/',
    'http://capture.example.test',
  ])('validates extra instrumentation origin %s before opening a page', async (origin) => {
    const close = vi.fn(async () => {})
    const newPage = vi.fn()
    const browser = { newContext: async () => ({ close, newPage }) } as unknown as Browser
    await expect(
      Actor.create(browser, 'C', inputFor(), new RateBudget(), {
        extraOrigins: [origin],
      })
    ).rejects.toThrow(/TARGET_/)
    expect(newPage).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
  it('requires current own-homeserver authority before sending either request', async () => {
    const { actor, post, budget, request } = await setup(outsider, [], false)
    try {
      request(HS, 'Bearer foreign-authority')
      await expect(actor.denyForeignJoin(HS, room)).rejects.toThrow(
        'WAVE2_MATRIX_AUTHORITY_REQUIRED'
      )
      expect(post).not.toHaveBeenCalled()
      budget.assertExact('C', { 'local-join': 0 })
    } finally {
      await actor.close()
    }
  })
})

describe('Matrix navigation response barrier', () => {
  it('finishes an in-flight Core body before continuing the full-page SSO navigation', async () => {
    const emitter = new EventEmitter()
    let matcher!: (url: URL) => boolean
    let navigate!: (route: { continue(): Promise<void> }) => Promise<void>
    const context = Object.assign(emitter, {
      route: async (match: typeof matcher, callback: typeof navigate) => {
        matcher = match
        navigate = callback
      },
    }) as unknown as BrowserContext
    await installMatrixNavigationBarrier(context, API, HS)
    expect(matcher(new URL(HS + '/_matrix/client/v3/login/sso/redirect?redirectUrl=owned'))).toBe(
      true
    )
    expect(matcher(new URL(WEB + '/_matrix/client/v3/login/sso/redirect'))).toBe(false)
    const request = { url: () => API + '/api/v1/me' }
    emitter.emit('request', request)
    let finishBody!: () => void
    const body = new Promise<void>((resolve) => {
      finishBody = resolve
    })
    const continued = vi.fn(async () => {})
    const navigation = navigate({ continue: continued })
    emitter.emit('response', { request: () => request, body: () => body })
    await Promise.resolve()
    expect(continued).not.toHaveBeenCalled()
    finishBody()
    await navigation
    expect(continued).toHaveBeenCalledOnce()
  })
  it('refuses a failed body read rather than exempting it', async () => {
    const emitter = new EventEmitter()
    let navigate!: (route: { continue(): Promise<void> }) => Promise<void>
    const context = Object.assign(emitter, {
      route: async (_match: unknown, callback: typeof navigate) => {
        navigate = callback
      },
    }) as unknown as BrowserContext
    await installMatrixNavigationBarrier(context, API, HS)
    const request = { url: () => API + '/api/v1/me' }
    emitter.emit('request', request)
    emitter.emit('response', {
      request: () => request,
      body: async () => {
        throw new Error('body refused')
      },
    })
    const continued = vi.fn(async () => {})
    await expect(navigate({ continue: continued })).rejects.toThrow('WAVE2_CORE_RESPONSE_BARRIER')
    expect(continued).not.toHaveBeenCalled()
  })
})

describe('responsive Matrix sync lifecycle', () => {
  const setup = async () => {
    const emitter = new EventEmitter()
    let nativeAbort!: (source: unknown, url: unknown) => void
    const context = Object.assign(emitter, {
      exposeBinding: async (_name: string, callback: typeof nativeAbort) => {
        nativeAbort = callback
      },
      addInitScript: async () => {},
    }) as unknown as BrowserContext
    const sync = new MatrixSyncLifecycle(HS)
    await sync.install(context)
    const request = (
      origin = HS,
      method = 'GET',
      failure = 'net::ERR_ABORTED',
      path = '/_matrix/client/v3/sync'
    ) =>
      ({
        url: () => origin + path,
        method: () => method,
        failure: () => ({ errorText: failure }),
      }) as unknown as Request
    return { emitter, sync, request, nativeAbort }
  }
  it('admits only the old native-aborted poll during a resize with a successful replacement', async () => {
    const { emitter, sync, request, nativeAbort } = await setup()
    const old = request()
    emitter.emit('request', old)
    expect(sync.allowedRequestFailure(old)).toBe(false)
    await sync.resize(async () => {
      expect(sync.allowedRequestFailure(old)).toBe(false)
      nativeAbort({}, old.url())
      expect(sync.allowedRequestFailure(old)).toBe(true)
      emitter.emit('requestfailed', old)
      const replacement = request()
      emitter.emit('request', replacement)
      expect(sync.allowedRequestFailure(replacement)).toBe(false)
      emitter.emit('response', { request: () => replacement, status: () => 200 })
    })
    expect(sync.allowedRequestFailure(old)).toBe(false)
  })
  it.each([
    [API, 'GET', 'net::ERR_ABORTED', '/_matrix/client/v3/sync'],
    [HS, 'POST', 'net::ERR_ABORTED', '/_matrix/client/v3/sync'],
    [HS, 'GET', 'net::ERR_FAILED', '/_matrix/client/v3/sync'],
    [HS, 'GET', 'net::ERR_CONNECTION_RESET', '/_matrix/client/v3/sync'],
    [HS, 'GET', 'net::ERR_ABORTED', '/_matrix/client/v3/messages'],
  ])('refuses unrelated failures %s/%s/%s/%s', async (origin, method, failure, path) => {
    const { emitter, sync, request, nativeAbort } = await setup()
    const failed = request(origin, method, failure, path)
    emitter.emit('request', failed)
    await sync.resize(async () => {
      nativeAbort({}, failed.url())
      expect(sync.allowedRequestFailure(failed)).toBe(false)
    })
  })
  it('does not reuse native abort evidence after the resize ends', async () => {
    const { emitter, sync, request, nativeAbort } = await setup()
    const old = request()
    emitter.emit('request', old)
    await sync.resize(async () => {
      nativeAbort({}, old.url())
    })
    await sync.resize(async () => {
      expect(sync.allowedRequestFailure(old)).toBe(false)
    })
  })
})

describe('collaborative document text', () => {
  it('joins text split by a peer caret without mutating the live editor', () => {
    const editor = document.createElement('div')
    editor.innerHTML =
      '<p>wave2-pe<span data-collab-caret="peer" aria-hidden="true">Peer name</span>er</p>'
    expect(documentText(editor)).toBe('wave2-peer')
    expect(editor.querySelector('[data-collab-caret]')).not.toBeNull()
    expect(editor.textContent).toContain('Peer name')
  })
  it('keeps ordinary document content and refuses a missing marker', () => {
    const editor = document.createElement('div')
    editor.innerHTML = '<p>First <strong>document</strong> marker</p><p>Second marker</p>'
    expect(documentText(editor)).toBe('First document markerSecond marker')
    expect(documentText(editor)).not.toContain('missing marker')
  })
})

describe('R1 exact network evidence', () => {
  it('requires the exact origin, method, anchored path and status', () => {
    const ledger = network()
    ledger.observe(observation)
    ledger.assertClean()
    expect(ledger.receipt()).toEqual([{ ...template, count: 1 }])
    expect(pathMatches('/api/v1/rooms/{room_id}', '/api/v1/rooms/%21synthetic%3Atest')).toBe(true)
    for (const path of ['/api/v1/rooms/x/extra', '/prefix/api/v1/rooms/x', '/api/v1/rooms/'])
      expect(pathMatches('/api/v1/rooms/{room_id}', path)).toBe(false)
  })
  it.each([
    { url: `${API}.attacker.test/api/v1/me` },
    { method: 'POST' },
    { url: `${API}/api/v1/me/extra` },
    { status: 201 },
    { status: 503 },
    { contentType: 'text/html' },
    { bodyPrefix: '<!DOCTYPE html><html>' },
    { jsonValid: false },
  ])('refuses mutated response %j', (mutation) => {
    const ledger = network()
    ledger.observe({ ...observation, ...mutation })
    expect(() => ledger.assertClean()).toThrow(/^R1_/)
  })
  it('refuses silence, excess counts, wrong query and incomplete bodies', () => {
    expect(() => network().assertClean()).toThrow('R1_MISSING_RESPONSE')
    const ledger = network([
      { ...template, max: 1, query: { exact: 'yes' }, requiredBodyKeys: ['ok'] },
    ])
    ledger.observe({ ...observation, url: `${observation.url}?exact=yes` })
    ledger.assertClean()
    ledger.observe({ ...observation, url: `${observation.url}?exact=no&extra=yes`, body: {} })
    expect(ledger.failures).toEqual(
      expect.arrayContaining(['R1_QUERY', 'R1_BODY_SHAPE', 'R1_MAX_COUNT'])
    )
  })
  it('admits only separately named expected failure statuses', () => {
    const ledger = network([{ ...template, expectedStatus: 503 }])
    ledger.observe({ ...observation, status: 503 })
    ledger.assertClean()
    const unexpectedAsset = network([])
    unexpectedAsset.observe({ ...observation, url: `${WEB}/asset.js`, status: 502 })
    expect(() => unexpectedAsset.assertClean()).toThrow('R1_UNEXPECTED_5XX')
  })
  it('supports problem JSON, exact refusal endpoints and optional zero reads', () => {
    const ledger = network([
      { ...template, expectedStatus: 404 },
      { ...template, pathPattern: '/api/v1/forbidden', min: 0, max: 0 },
    ])
    ledger.observe({ ...observation, status: 404, contentType: 'application/problem+json' })
    ledger.assertClean()
    ledger.observe({ ...observation, url: `${API}/api/v1/forbidden` })
    expect(() => ledger.assertClean()).toThrow('R1_MAX_COUNT')
  })
  it('validates template configuration and secure canonical origins', () => {
    expect(() => network([{ ...template, method: 'get' }])).toThrow('R1_METHOD_TEMPLATE')
    expect(() => pathMatches('/api/*', '/api/a')).toThrow('R1_PATH_TEMPLATE')
    expect(() => exactOrigin('https://web.example.test/path')).toThrow('TARGET_ORIGIN')
    expect(() => exactOrigin('http://web.example.test')).toThrow('TARGET_TLS')
    expect(exactOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173')
  })
  it('records context responses, popup console errors and CSP violations; drains and detaches', async () => {
    const emitter = new EventEmitter()
    const context = Object.assign(emitter, {
      newPage: vi.fn(),
      pages: () => [],
      exposeBinding: async (name: string, callback: () => void) => {
        vi.stubGlobal(name, async () => callback())
      },
      addInitScript: async (install: (name: string) => void, name: string) => install(name),
    }) as unknown as BrowserContext
    const ledger = network()
    const recorder = await recordNetwork(context, ledger)
    emitter.emit('response', {
      url: () => observation.url,
      status: () => 200,
      request: () => ({ method: () => 'GET' }),
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => '{"ok":true}',
    })
    await recorder.assertClean()
    emitter.emit('console', { type: () => 'error' })
    emitter.emit('weberror', {})
    emitter.emit('requestfailed', {})
    document.dispatchEvent(new Event('securitypolicyviolation'))
    expect(ledger.failures).toEqual([
      'R1_CONSOLE_ERROR',
      'R1_PAGE_ERROR',
      'R1_REQUEST_FAILED',
      'R1_CSP_VIOLATION',
    ])
    await expect(recorder.assertClean()).rejects.toThrow('R1_CONSOLE_ERROR')
    await recorder.dispose()
    expect(emitter.eventNames()).toEqual([])
  })
})

describe('R3 per-run budgets and reuse', () => {
  const setup = () => {
    const budget = new RateBudget()
    budget.register('A')
    return budget
  }
  it('meters claim consumption separately from the later Matrix join and refuses an extra attempt', () => {
    const budget = setup()
    const context = new EventEmitter()
    const detach = trackRateRequests(context as unknown as BrowserContext, 'A', budget, {
      auth: AUTH,
      api: API,
      homeserver: HS,
    })
    const attempt = (url: string) =>
      context.emit('request', { url: () => url, method: () => 'POST' })
    attempt(`${API}/api/v1/owner-claims/actions/consume`)
    expect(() => budget.assertExact('A', { 'local-join': 2 })).toThrow('R3_EXACT_ALLOCATION')
    attempt(`${HS}/_matrix/client/v3/join/%21synthetic`)
    budget.assertExact('A', { 'local-join': 2 })
    attempt(`${HS}/_matrix/client/v3/join/%21synthetic`)
    expect(() => budget.assertExact('A', { 'local-join': 2 })).toThrow('R3_EXACT_ALLOCATION')
    detach()
    expect(context.eventNames()).toEqual([])
  })
  it('admits strictly fewer than five logins and ten local joins, including denied/seed attempts', () => {
    const budget = setup()
    budget.reserve('A', 'matrix-login', 4)
    budget.reserve('A', 'local-join', 9)
    budget.assertExact('A', { 'matrix-login': 4, 'local-join': 9 })
    expect(() => budget.reserve('A', 'matrix-login')).toThrow('R3_LOGIN_CEILING')
    expect(() => budget.reserve('A', 'local-join')).toThrow('R3_JOIN_CEILING')
    expect(() => budget.assertClean()).toThrow('R3_LOGIN_CEILING')
  })
  it('refuses shared-address exhaustion, unknown actors, changed exact allocations and write storms', () => {
    const budget = setup()
    for (const actor of ['B', 'C', 'D', 'E']) budget.register(actor)
    for (const actor of ['A', 'B', 'C', 'D']) budget.reserve(actor, 'matrix-login', 4)
    budget.reserve('E', 'matrix-login', 3)
    expect(() => budget.reserve('E', 'matrix-login')).toThrow('R3_LOGIN_CEILING')
    expect(() => setup().reserve('C', 'local-join')).toThrow('R3_RESERVATION')
    expect(() => setup().reserve('A', 'local-join', -1)).toThrow('R3_RESERVATION')
    expect(() => setup().assertExact('A', { 'matrix-login': 1 })).toThrow('R3_EXACT_ALLOCATION')
    const writes = setup()
    writes.reserve('A', 'core-write', 20)
    expect(() => writes.reserve('A', 'core-write')).toThrow('R3_WRITE_CEILING')
  })
  it('owns in-memory snapshots by actor, refuses vault export, tracks retained pages independently', () => {
    const budget = setup()
    const page = {}
    budget.retainPage('A', page)
    budget.reusePage('A', page)
    expect(() => budget.reusePage('A', {})).toThrow('R3_PAGE_REPLACED')
    budget.rememberState('A', { cookies: [], origins: [] })
    const restored = budget.reuseState('A')
    restored.origins.push({ origin: WEB, localStorage: [] })
    expect(budget.reuseState('A').origins).toEqual([])
    expect(budget.receipt()[0]).toMatchObject({ storageStateReuses: 2, livePageReuses: 1 })
    expect(() => budget.reuseState('B')).toThrow('R3_STATE_MISSING')
    const vaultState = { cookies: [], origins: [{ origin: WEB, localStorage: [], indexedDB: [] }] }
    expect(() => setup().rememberState('A', vaultState)).toThrow('R3_VAULT_EXPORT')
    budget.clear()
    expect(() => budget.reuseState('A')).toThrow('R3_STATE_MISSING')
  })
  it.each([
    '/_matrix/client/v3/join/encoded-room',
    '/_matrix/client/v3/rooms/encoded-room/join',
    '/_synapse/admin/v1/join/encoded-room',
    '/_matrix/client/v3/createRoom',
  ])('counts join form %s', (path) => {
    expect(
      classifyRateRequest(`${HS}${path}`, 'POST', { homeserver: HS, auth: AUTH, api: API })
    ).toBe('local-join')
  })
  it('meters SDK requests on the correct origin and latches automatic excess', () => {
    const origins = { homeserver: HS, auth: AUTH, api: API }
    expect(
      classifyRateRequest(`${AUTH}/realms/test/protocol/openid-connect/token`, 'POST', origins)
    ).toBe('core-token')
    expect(classifyRateRequest(`${API}/api/v1/write`, 'PATCH', origins)).toBe('core-write')
    expect(classifyRateRequest(`${API}/api/v1/me`, 'GET', origins)).toBeUndefined()
    expect(classifyRateRequest(`${WEB}/_matrix/client/v3/login`, 'POST', origins)).toBeUndefined()
    const emitter = new EventEmitter()
    const budget = setup()
    const detach = trackRateRequests(emitter as unknown as BrowserContext, 'A', budget, origins)
    for (let i = 0; i < 5; i++)
      emitter.emit('request', { url: () => `${HS}/_matrix/client/v3/login`, method: () => 'POST' })
    expect(() => budget.assertClean()).toThrow('R3_LOGIN_CEILING')
    expect(budget.receipt()[0]?.['matrix-login']).toBe(5)
    detach()
    expect(emitter.listenerCount('request')).toBe(0)
  })
})

describe('R4 opening gate and receipt confidentiality', () => {
  const target = {
    webOrigin: WEB,
    apiOrigin: API,
    authOrigin: AUTH,
    realm: 'synthetic',
    webRevision: 'a'.repeat(40),
  }
  const actual = {
    release: { web_revision: target.webRevision },
    realm: target.realm,
    apiOrigin: API,
    issuer: `${AUTH}/realms/synthetic`,
  }
  it('admits only the pinned revision, realm, API origin and issuer', () => {
    assertTargetGate(target, actual)
    for (const mutation of [
      { release: {} },
      { realm: 'other' },
      { apiOrigin: WEB },
      { issuer: `${AUTH}.attacker.test/realms/synthetic` },
    ])
      expect(() => assertTargetGate(target, { ...actual, ...mutation })).toThrow(/^R4_/)
    expect(() => assertTargetGate({ ...target, webRevision: '' }, actual)).toThrow(
      'R4_REVISION_REQUIRED'
    )
  })
  it('opens the real release/OIDC/API probes and refuses redirects, HTML and unavailable APIs', async () => {
    const request = (mutation: { status?: number; contentType?: string } = {}) =>
      ({
        get: async (url: string) => ({
          url: () => url,
          status: () => mutation.status ?? (url.endsWith('/api/v1/me') ? 401 : 200),
          headers: () => ({ 'content-type': mutation.contentType ?? 'application/json' }),
          json: async () =>
            url.endsWith('/release.json') ? actual.release : { issuer: actual.issuer },
        }),
      }) as unknown as APIRequestContext
    expect(await openTargetGate(request(), target)).toEqual({
      web_revision: target.webRevision,
      realm: target.realm,
      apiOrigin: API,
    })
    await expect(openTargetGate(request({ status: 302 }), target)).rejects.toThrow(
      'R4_OPENING_STATUS'
    )
    await expect(openTargetGate(request({ contentType: 'text/html' }), target)).rejects.toThrow(
      'R4_OPENING_JSON'
    )
  })
  it.each([
    'Bearer synthetic',
    'eyJhbGciOiJub25lIn0.payload.signature',
    '/claim/synthetic#claim',
    '/join%23invite',
    'https://storage.example.test/a?X-Amz-Signature=synthetic',
    'phc_synthetic',
    '%2542earer%2520synthetic',
    '%2570hc_synthetic',
  ])('refuses secret sentinel without reflecting it: %s', (sentinel) => {
    expect(() => validateReceipt({ nested: [sentinel] })).toThrow(/^R4_/)
    try {
      validateReceipt({ nested: [sentinel] })
    } catch (error) {
      expect(String(error)).not.toContain(sentinel)
    }
  })
  it('redacts by projecting the admitted fields, then validates plain JSON recursively', () => {
    const input = {
      surface: 'S30',
      actor: 'A',
      origin: API,
      method: 'GET',
      pathPattern: '/api/v1/documents/{document_id}',
      expectedStatus: 200,
      actualStatus: 200,
      authorization: 'Bearer synthetic',
      body: { title: 'synthetic title' },
    }
    const receipt = redactNetworkReceipt(input)
    expect(Object.keys(receipt)).not.toContain('authorization')
    expect(JSON.stringify(receipt)).not.toContain('synthetic')
    validateReceipt({ receipt, results: [true, false, 1, null] })
    for (const bad of [
      NaN,
      undefined,
      new Date(0),
      { toJSON: () => ({}) },
      Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'hidden' }),
    ])
      expect(() => validateReceipt(bad)).toThrow(/^R4_/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => validateReceipt(cycle)).toThrow('R4_JSON_CYCLE')
    expect(() => validateReceipt({ phc_key: 'hidden' })).toThrow('R4_SECRET_RECEIPT')
  })
})

const captureKey = ['phc', 'synthetic'].join('_')
const payload = () => ({
  api_key: captureKey,
  event: 'navigation_completed',
  distinct_id: '00000000-0000-4000-8000-000000000001',
  properties: {
    area: 'workspace',
    duration_ms: 12.125,
    $geoip_disable: true,
    $process_person_profile: false,
  },
})
const captureRequest = () => ({
  url: POSTHOG_EU_ENDPOINT,
  method: 'POST',
  headers: { origin: WEB, 'content-type': 'application/json' },
  body: payload(),
})

describe('R5 independent PostHog EU consent oracle', () => {
  it('matches the private source schema without using the production sanitizer as its oracle', () => {
    const source = readFileSync(webPath('src/analytics/telemetry/privacy.ts'), 'utf8')
    const bindings: Record<string, unknown> = {}
    // Accept only the current declarative literal grammar. New executable schema syntax refuses
    // rather than being evaluated or silently omitted. No production function decides admission.
    const literal = (expression: string): unknown =>
      JSON.parse(
        expression
          .replace(/\.\.\.(AREAS|OPERATIONS)/g, (_match, name: string) =>
            JSON.stringify(bindings[name]).slice(1, -1)
          )
          .replace(/\b(AREAS|OPERATIONS)\b/g, (name) => JSON.stringify(bindings[name]))
          .replace(/([{,]\s*)([a-z_]+)\s*:/g, '$1"$2":')
          .replace(/'/g, '"')
          .replace(/,\s*([}\]])/g, '$1')
      ) as unknown
    for (const name of ['AREAS', 'OPERATIONS']) {
      const expression = source.match(
        new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]) as const`)
      )?.[1]
      expect(expression).toBeDefined()
      bindings[name] = literal(expression!)
    }
    const rules = source.match(/const RULES:[^=]+=\s*(\{[\s\S]*?\n\})/)?.[1]
    expect(rules).toBeDefined()
    bindings.RULES = literal(rules!)
    const mirror = structuredClone(EVENT_SCHEMAS)
    const clientError = { ...mirror.client_error }
    delete clientError.stack
    expect({ ...mirror, client_error: clientError }).toEqual(bindings.RULES)
  })
  it('admits one exact opted-in POST and a narrow CORS preflight', () => {
    validateCaptureRequest(captureRequest(), 'consented', WEB, captureKey)
    validateCaptureRequest(
      {
        url: POSTHOG_EU_ENDPOINT,
        method: 'OPTIONS',
        headers: {
          origin: WEB,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
      'consented',
      WEB,
      captureKey
    )
    expect(validateCapturePayload(payload(), captureKey)).toBe(payload().distinct_id)
  })
  it.each(['before-consent', 'revoked'] as const)(
    'records and refuses every attempt during %s',
    (phase) => {
      const ledger = new ConsentLedger(WEB, captureKey)
      ledger.phase = phase
      ledger.observe(captureRequest())
      expect(ledger.attempts).toHaveLength(1)
      expect(() => ledger.assertClean()).toThrow('R5_NO_REQUEST_WITHOUT_CONSENT')
    }
  )
  it.each([
    'room_id',
    'document_title',
    'email',
    '$current_url',
    '$set',
    '$identify',
    'unexpected',
  ])('refuses property %s', (key) => {
    expect(() =>
      validateCapturePayload(
        { ...payload(), properties: { ...payload().properties, [key]: 'synthetic@example.test' } },
        captureKey
      )
    ).toThrow('R5_UNKNOWN_PROPERTY')
  })
  it.each([NaN, Infinity, -1, 3_600_001, 0.00001, '12'])(
    'refuses invalid numeric value %s',
    (value) => {
      expect(() =>
        validateCapturePayload(
          { ...payload(), properties: { ...payload().properties, duration_ms: value } },
          captureKey
        )
      ).toThrow('R5_BOUNDED_NUMBER')
    }
  )
  it('refuses malformed envelopes, identities, events, fixed privacy flags and enums', () => {
    for (const body of [
      null,
      [],
      { ...payload(), extra: true },
      { ...payload(), api_key: 'wrong' },
      { ...payload(), distinct_id: 'stable-person' },
      { ...payload(), event: '$identify' },
      { ...payload(), properties: null },
      { ...payload(), properties: { $geoip_disable: false, $process_person_profile: false } },
      { ...payload(), properties: { $geoip_disable: true } },
      { ...payload(), properties: { ...payload().properties, area: 'private-room' } },
    ])
      expect(() => validateCapturePayload(body, captureKey)).toThrow(/^R5_/)
  })
  it('validates every schema rule, optional properties, booleans and stack grammar', () => {
    for (const [event, schema] of Object.entries(EVENT_SCHEMAS)) {
      const properties: Record<string, unknown> = {
        $geoip_disable: true,
        $process_person_profile: false,
      }
      for (const [key, rule] of Object.entries(schema))
        properties[key] =
          rule === 'number'
            ? 1
            : rule === 'boolean'
              ? true
              : rule === 'stack'
                ? 'bundle:123:45'
                : rule[0]
      validateCapturePayload({ ...payload(), event, properties }, captureKey)
    }
    for (const stack of [
      'raw message',
      'https://web.example.test/assets/a.js:1:2',
      Array(9).fill('bundle:1:1').join('\n'),
    ])
      expect(() =>
        validateCapturePayload(
          {
            ...payload(),
            event: 'client_error',
            properties: {
              $geoip_disable: true,
              $process_person_profile: false,
              stack,
            },
          },
          captureKey
        )
      ).toThrow('R5_STACK_GRAMMAR')
    expect(() =>
      validateCapturePayload(
        {
          ...payload(),
          event: 'operation_completed',
          properties: {
            $geoip_disable: true,
            $process_person_profile: false,
            success: 'yes',
          },
        },
        captureKey
      )
    ).toThrow('R5_BOOLEAN')
  })
  it.each([
    { url: 'https://us.i.posthog.com/i/v0/e/' },
    { url: 'https://eu.i.posthog.com.attacker.test/i/v0/e/' },
    { url: `${POSTHOG_EU_ENDPOINT}?extra=yes` },
    { method: 'GET' },
    { headers: { origin: WEB, 'content-type': 'application/json', authorization: 'synthetic' } },
    { headers: { origin: API, 'content-type': 'application/json' } },
    { headers: { origin: WEB, 'content-type': 'text/plain' } },
  ])('refuses mutated transport %j', (mutation) => {
    expect(() =>
      validateCaptureRequest(
        { ...captureRequest(), ...mutation } as CaptureRequest,
        'consented',
        WEB,
        captureKey
      )
    ).toThrow(/^R5_/)
  })
  it('intercepts at context scope, counts aborted attempts and refuses a collector on another domain', async () => {
    const emitter = new EventEmitter()
    let handler: ((route: Route) => Promise<unknown>) | undefined
    const context = Object.assign(emitter, {
      route: async (_matcher: unknown, callback: typeof handler) => {
        handler = callback
      },
      unroute: vi.fn(),
    }) as unknown as BrowserContext
    const ledger = new ConsentLedger(WEB, captureKey)
    const interceptor = await installPosthogInterceptor(context, ledger, [WEB, API])
    const raw = captureRequest()
    const request = {
      url: () => raw.url,
      method: () => raw.method,
      headers: () => raw.headers,
      allHeaders: async () => raw.headers,
      postDataJSON: () => raw.body,
    } as unknown as Request
    const abort = vi.fn()
    const fulfill = vi.fn()
    emitter.emit('request', request)
    await handler!({ request: () => request, abort, fulfill } as unknown as Route)
    expect(abort).toHaveBeenCalledWith('blockedbyclient')
    expect(ledger.attempts).toHaveLength(1)
    emitter.emit('request', { url: () => 'https://unadmitted.example.test/collect' })
    expect(ledger.failures).toContain('R5_UNADMITTED_ORIGIN')
    await interceptor.dispose()
    expect(emitter.listenerCount('request')).toBe(0)
  })
  it('fulfills only valid opted-in requests and releases every held route on cleanup', async () => {
    const emitter = new EventEmitter()
    let handler: ((route: Route) => Promise<unknown>) | undefined
    const context = Object.assign(emitter, {
      route: async (_matcher: unknown, callback: typeof handler) => {
        handler = callback
      },
      unroute: vi.fn(),
    }) as unknown as BrowserContext
    const ledger = new ConsentLedger(WEB, captureKey)
    ledger.phase = 'consented'
    const interceptor = await installPosthogInterceptor(context, ledger, [WEB])
    const raw = captureRequest()
    const request = {
      url: () => raw.url,
      method: () => raw.method,
      headers: () => raw.headers,
      allHeaders: async () => raw.headers,
      postDataJSON: () => raw.body,
    } as unknown as Request
    const fulfill = vi.fn(),
      abort = vi.fn()
    await handler!({ request: () => request, fulfill, abort } as unknown as Route)
    ledger.assertClean()
    expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }))
    interceptor.holdPosts()
    const heldRequest = { ...request } as unknown as Request
    // A new attempt is independently counted even when its payload is identical.
    const task = handler!({ request: () => heldRequest, fulfill, abort } as unknown as Route)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(interceptor.heldCount()).toBe(1)
    expect(interceptor.isHeldRequest(heldRequest)).toBe(true)
    ledger.phase = 'revoked'
    await interceptor.dispose()
    await task
    expect(abort).toHaveBeenCalledWith('aborted')
    expect(ledger.postCount()).toBe(2)
    ledger.assertClean()
  })
  it('checks complete headers even when the short Playwright header view hides credentials', async () => {
    let handler: ((route: Route) => Promise<unknown>) | undefined
    const context = Object.assign(new EventEmitter(), {
      route: async (_matcher: unknown, callback: typeof handler) => {
        handler = callback
      },
      unroute: vi.fn(),
    }) as unknown as BrowserContext
    const ledger = new ConsentLedger(WEB, captureKey)
    ledger.phase = 'consented'
    const interceptor = await installPosthogInterceptor(context, ledger, [WEB])
    const raw = captureRequest()
    const request = {
      url: () => raw.url,
      method: () => raw.method,
      headers: () => raw.headers,
      allHeaders: async () => ({ ...raw.headers, cookie: 'synthetic' }),
      postDataJSON: () => raw.body,
    } as unknown as Request
    const abort = vi.fn()
    await handler!({ request: () => request, abort, fulfill: vi.fn() } as unknown as Route)
    expect(() => ledger.assertClean()).toThrow('R5_NO_CREDENTIALS_OR_REFERRER')
    expect(abort).toHaveBeenCalledWith('blockedbyclient')
    await interceptor.dispose()
  })
  it('observes native dispatch consent and immediate AbortSignal cancellation', async () => {
    const nativeFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', nativeFetch)
    const key = 'synthetic-consent'
    const context = {
      addInitScript: async (
        callback: (input: { consentKey: string }) => void,
        input: { consentKey: string }
      ) => callback(input),
    } as unknown as BrowserContext
    await installConsentDispatchProbe(context, key)
    const controller = new AbortController()
    localStorage.setItem(key, 'yes')
    await window.fetch(POSTHOG_EU_ENDPOINT, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    })
    controller.abort()
    const facts = (window as unknown as { __wave2DispatchFacts: unknown[] }).__wave2DispatchFacts
    expect(facts).toEqual([{ allowedAtDispatch: true, aborted: true, privacyOptions: true }])
    localStorage.removeItem(key)
  })
})

describe('R6 browser helpers and WCAG guard mutations', () => {
  const cell: VisualCell = {
    origin: 'web',
    surface: 'S08',
    state: 'ready',
    theme: 'dark',
    language: 'fr',
    width: 375,
    height: 900,
  }
  const scan = {
    scanned: 21,
    missing: [],
    sans: 'Plus Jakarta Sans',
    mono: 'IBM Plex Mono',
    negativeFacePresent: false,
  }
  const metrics = (element: Element, width: number, scrollWidth: number, right = width) => {
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: width },
      scrollWidth: { configurable: true, value: scrollWidth },
    })
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width,
      height: 20,
      top: 0,
      left: 0,
      right,
      bottom: 20,
      toJSON: () => ({}),
    })
  }
  it('binds snapshot keys to the complete cell and refuses omitted themes or wrong browser schemes', () => {
    expect(snapshotKey(cell)).toBe('web-S08-ready-dark-fr-375x900.png')
    assertTheme({ theme: 'dark', dark: true, scheme: 'dark' }, cell)
    expect(() => assertTheme({ theme: 'ciel-nuit', dark: true, scheme: 'dark' }, cell)).toThrow(
      'R6_THEME_NOT_SET'
    )
    expect(() => assertTheme({ theme: 'dark', dark: false, scheme: 'light' }, cell)).toThrow(
      'R6_COLOR_SCHEME'
    )
    assertTheme({ theme: null, dark: true, scheme: 'dark' }, { ...cell, origin: 'auth' })
    expect(() => snapshotKey({ ...cell, state: '../unsafe' })).toThrow('R6_CELL')
  })
  it('requires one custom rendered face; catches a single-glyph fallback and synthetic weights', () => {
    assertFontScan(scan)
    assertRenderedFont(
      [{ familyName: 'Plus Jakarta Sans SemiBold', isCustomFont: true }],
      'Plus Jakarta Sans'
    )
    for (const fonts of [
      [],
      [{ familyName: 'Other', isCustomFont: true }],
      [{ familyName: 'Plus Jakarta Sans', isCustomFont: false }],
      [
        { familyName: 'Plus Jakarta Sans', isCustomFont: true },
        { familyName: 'Fallback', isCustomFont: false },
      ],
    ])
      expect(() => assertRenderedFont(fonts, 'Plus Jakarta Sans')).toThrow('R6_FONT_FAMILY_RENAMED')
    for (const mutation of [
      { scanned: 0 },
      { negativeFacePresent: true },
      { missing: ['Plus Jakarta Sans 600 normal'] },
      { missing: ['IBM Plex Mono 600 normal'] },
      { sans: 'Fallback' },
      { mono: 'Fallback' },
    ])
      expect(() => assertFontScan({ ...scan, ...mutation })).toThrow(/^R6_/)
    assertFontScan({ ...scan, mono: 'missing' }, false)
    expect(() => assertLocalFont('https://cdn.example.test/font.woff2', WEB)).toThrow(
      'R6_THIRD_PARTY_FONT'
    )
    assertLocalFont(`${WEB}/font.woff2`, WEB)
  })
  it('refuses unresolved/deleted theme rows and full-page/lossy baselines before touching the browser', async () => {
    assertTokenValues({ '--c-ink': 'rgb(1, 2, 3)' }, 1)
    expect(() => assertTokenValues({}, 119)).toThrow('R6_TOKEN_COUNT')
    expect(() => assertTokenValues({ '--c-ink': '' }, 1)).toThrow('R6_TOKEN_UNRESOLVED')
    expect(() => assertTokenValues({ '--c-ink': 'var(--missing)' }, 1)).toThrow(
      'R6_TOKEN_UNRESOLVED'
    )
    assertScreenshotOptions({ fullPage: false })
    expect(() => assertScreenshotOptions({ fullPage: true })).toThrow('R6_FULLPAGE_BASELINE')
    expect(() => assertScreenshotOptions({ type: 'jpeg' })).toThrow('R6_LOSSY_BASELINE')
    await expect(viewportScreenshot({} as Page, cell, { fullPage: true })).rejects.toThrow(
      'R6_FULLPAGE_BASELINE'
    )
  })
  it('takes a stable viewport PNG only after the font and layout barriers complete', async () => {
    const screenshot = vi.fn().mockResolvedValue(new Uint8Array([1]))
    const evaluate = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce([])
    const page = {
      viewportSize: () => ({ width: cell.width, height: cell.height }),
      evaluate,
      screenshot,
    } as unknown as Page
    await viewportScreenshot(page, cell)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(screenshot).toHaveBeenCalledWith({
      fullPage: false,
      animations: 'disabled',
      type: 'png',
    })
    expect(evaluate.mock.invocationCallOrder[1]).toBeLessThan(
      screenshot.mock.invocationCallOrder[0]!
    )
    const badPage = {
      ...page,
      evaluate: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(['R6_OVERFLOW:DIV']),
    } as unknown as Page
    await expect(viewportScreenshot(badPage, cell)).rejects.toThrow('R6_OVERFLOW')
    expect(screenshot).toHaveBeenCalledTimes(1)
  })
  it('binds the rendered pair and per-theme inverse anchor after enforcing all declared tokens', async () => {
    const values = Object.fromEntries(
      Array.from({ length: 119 }, (_, i) => [`--token-${i}`, 'rgb(1, 2, 3)'])
    )
    const page = (binding: boolean, anchor: boolean) =>
      ({ evaluate: async () => ({ values, binding, anchor }) }) as unknown as Page
    await verifyTokenBinding(page(true, true), cell, 'main')
    await expect(verifyTokenBinding(page(false, true), cell, 'main')).rejects.toThrow(
      'R6_TOKEN_BINDING'
    )
    await expect(verifyTokenBinding(page(true, false), cell, 'main')).rejects.toThrow(
      'R6_TOKEN_ANCHOR'
    )
  })
  it('detects sideways page/control overflow and non-ellipsized clipping, preserving explicit exemptions', () => {
    metrics(document.documentElement, 375, 375)
    const child = document.createElement('div')
    document.body.append(child)
    metrics(child, 100, 200)
    child.style.overflowX = 'hidden'
    expect(layoutFaultsInDocument()).toContain('R6_CLIPPING:DIV')
    child.style.textOverflow = 'ellipsis'
    assertLayout(layoutFaultsInDocument())
    child.style.overflowX = 'auto'
    expect(() => assertLayout(layoutFaultsInDocument())).toThrow('R6_OVERFLOW')
    child.className = 'sr-only'
    assertLayout(layoutFaultsInDocument())
    child.className = ''
    child.style.overflowX = 'visible'
    metrics(child, 500, 500, 500)
    expect(layoutFaultsInDocument()).toContain('R6_OVERFLOW:DIV')
    child.remove()
    metrics(document.documentElement, 375, 500)
    expect(layoutFaultsInDocument()).toContain('R6_OVERFLOW:document')
  })
  it('exempts internal form-value scrolling and table regions, but not page overflow', () => {
    metrics(document.documentElement, 375, 375)
    const input = document.createElement('input')
    input.style.overflowX = 'hidden'
    document.body.append(input)
    metrics(input, 100, 200)
    const table = document.createElement('section')
    table.setAttribute('role', 'region')
    table.style.overflowX = 'auto'
    table.innerHTML = '<table><tbody><tr><td>synthetic</td></tr></tbody></table>'
    document.body.append(table)
    metrics(table, 100, 200)
    assertLayout(layoutFaultsInDocument())
  })
  it('requires the complete WCAG 2.2 tagset and rejects clean-but-empty or violating scans', () => {
    assertA11yResult({ passes: Array(11).fill({}), violations: [] })
    expect(() => assertA11yResult({ passes: [], violations: [] })).toThrow('A11Y_VACUOUS_SCAN')
    expect(() => assertA11yResult({ passes: Array(11).fill({}), violations: [{}] })).toThrow(
      'A11Y_VIOLATIONS'
    )
    expect(() =>
      assertA11yResult(
        { passes: Array(11).fill({}), violations: [] },
        WCAG_TAGS.filter((tag) => tag !== 'wcag22aa')
      )
    ).toThrow('A11Y_TAGSET')
  })
})

describe('surface registry and executable harness policy', () => {
  it('covers S01–S32, L01–L22, A01–A13 and three landing dialogs without claiming runtime passes', () => {
    assertSurfaceManifest()
    expect(SURFACES).toHaveLength(67)
    expect(LANDING_DIALOGS).toHaveLength(3)
    expect(() => assertSurfaceManifest(SURFACES.slice(1))).toThrow('SURFACES_COMPLETENESS')
    expect(() => assertSurfaceManifest([...SURFACES.slice(1), SURFACES[1]!])).toThrow(
      'SURFACES_COMPLETENESS'
    )
    expect(() =>
      assertSurfaceManifest(
        SURFACES.map((row) => (row.id === 'L01' ? { ...row, origin: 'web' } : row))
      )
    ).toThrow('SURFACES_ORIGIN')
    expect(fixturePath('/rooms/{room_id}', { room_id: '!synthetic:test/segment' })).toBe(
      '/rooms/!synthetic%3Atest%2Fsegment'
    )
    expect(() => fixturePath('/rooms/{room_id}', {})).toThrow('SURFACES_FIXTURE_REQUIRED')
  })
  it('contains no fixed-delay waits in the config or any Wave 2 module', () => {
    const files: string[] = []
    const walk = (path: string) => {
      for (const file of readdirSync(path, { withFileTypes: true })) {
        const full = resolve(path, file.name)
        if (file.isDirectory()) walk(full)
        else if (/\.ts$/.test(file.name)) files.push(full)
      }
    }
    walk(webPath('tests/wave2'))
    files.push(webPath('playwright.wave2.config.ts'))
    const checked = new Set<string>()
    while (files.length) {
      const file = files.pop()!
      if (checked.has(file)) continue
      checked.add(file)
      const source = readFileSync(file, 'utf8')
      expect(timingViolations(source), file).toEqual([])
      for (const helper of relativeImports(source)) {
        const base = resolve(dirname(file), helper)
        const path = [base, `${base}.ts`, resolve(base, 'index.ts')].find(
          (candidate) => candidate.endsWith('.ts') && existsSync(candidate)
        )
        expect(path, 'relative helper must resolve').toBeDefined()
        expect(path!.startsWith(`${webPath()}/`)).toBe(true)
        files.push(path!)
      }
    }
    expect(checked.has(webPath('tests/wave2/mailpit.ts'))).toBe(true)
    expect(checked.has(webPath('tests/wave2/keycloak.ts'))).toBe(true)
    const config = readFileSync(webPath('playwright.wave2.config.ts'), 'utf8')
    for (const origin of ['WEB', 'LANDING', 'AUTH', 'API'])
      expect(config).toContain(`KODERA_WAVE2_${origin}_ORIGIN`)
    expect(config).toMatch(/workers:\s*1/)
    expect(config).toMatch(/retries:\s*0/)
    expect(config).not.toContain('webServer:')
    expect(readFileSync(webPath('tests/wave2/vitest.config.ts'), 'utf8')).toContain('envDir: false')
  })
})

function timingViolations(source: string): string[] {
  const faults: string[] = []
  const root = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      ['waitForTimeout', 'setTimeout'].includes(node.text)
    )
      faults.push('R2_FIXED_DELAY')
    if (ts.isStringLiteral(node) && /^(?:node:)?timers(?:\/promises)?$/.test(node.text))
      faults.push('R2_TIMER_IMPORT')
    ts.forEachChild(node, visit)
  }
  visit(root)
  return faults
}

function relativeImports(source: string): string[] {
  const imports: string[] = []
  const root = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ? node.arguments[0]
          : undefined
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.'))
      imports.push(specifier.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return imports
}

describe('adversarial regression coverage', () => {
  it.each([false, true])(
    'switches language through real controls with a settings panel: %s',
    async (panel) => {
      const actions: string[] = []
      const page = {
        locator: (selector: string) => ({
          click: async () => {
            actions.push(selector)
          },
        }),
      } as unknown as Page
      await selectInterfaceLanguage(page, {
        button: '#language',
        option: '#english',
        ...(panel ? { section: '#appearance', close: '#close' } : {}),
      })
      expect(actions).toEqual(
        panel ? ['#language', '#appearance', '#english', '#close'] : ['#language', '#english']
      )
    }
  )

  it.each(['home', 'workspace', 'workspace/previous'])(
    'enters a channel through the retained workspace from %s',
    async (start) => {
      let path = `/synthetic-org/${start}`
      const actions: string[] = []
      const page = {
        url: () => `${WEB}${path}`,
        locator: (selector: string) => ({
          first() {
            return this
          },
          click: async () => {
            const target = /^a\[href="([^"]+)"\]$/.exec(selector)![1]!
            actions.push(target)
            path = target
          },
          waitFor: async () => {
            actions.push(`ready:${path}`)
          },
        }),
      } as unknown as Page
      await enterWorkspace(page, 'synthetic-org', '#ready', '/synthetic-org/workspace/channel')
      expect(actions).toEqual([
        ...(start === 'home' ? ['/synthetic-org/workspace'] : []),
        `ready:/synthetic-org/${start === 'home' ? 'workspace' : start}`,
        '/synthetic-org/workspace/channel',
        'ready:/synthetic-org/workspace/channel',
      ])
      actions.length = 0
      await enterWorkspace(page, 'synthetic-org', '#ready', path)
      expect(actions).toEqual([`ready:${path}`])
    }
  )

  it.each(['tenant', 'email-slug', 'email-provider'] as const)(
    'enters the actual %s discovery form without waiting for an absent email field',
    async (entry) => {
      let state: 'email' | 'slug' | 'provider' = entry === 'tenant' ? 'slug' : 'email'
      const fills: string[] = []
      type DiscoveryLocator = {
        isVisible: () => Promise<boolean>
        fill: (value: string) => Promise<void>
        or: (other: DiscoveryLocator) => {
          first: () => { waitFor: () => Promise<void> }
        }
      }
      const locator = (field: 'email' | 'slug' | 'provider'): DiscoveryLocator => ({
        isVisible: async () => state === field,
        fill: async (value: string) => {
          expect(state).toBe(field)
          fills.push(value)
        },
        or(other: DiscoveryLocator) {
          return {
            first: () => ({
              waitFor: async () =>
                expect((await this.isVisible()) || (await other.isVisible())).toBe(true),
            }),
          }
        },
      })
      const page = {
        getByLabel: (label: string) => locator(label === 'Adresse e-mail' ? 'email' : 'slug'),
        locator: () => locator('provider'),
        getByRole: () => ({
          click: async () => {
            state = state === 'email' && entry === 'email-slug' ? 'slug' : 'provider'
          },
        }),
      } as unknown as Page
      await enterOrganisation(page, 'synthetic@example.test', 'synthetic-org')
      expect(state).toBe('provider')
      expect(fills).toEqual(
        entry === 'tenant'
          ? ['synthetic-org']
          : entry === 'email-slug'
            ? ['synthetic@example.test', 'synthetic-org']
            : ['synthetic@example.test']
      )
    }
  )

  it.each([
    [WEB, '/assets/app.js', 404],
    [HS, '/_matrix/client/v3/sync', 401],
    [HS, '/_kodera/rooms/token', 403],
    [AUTH, '/realms/synthetic/login', 429],
  ])('R1 requires an explicit error rule at %s%s', (origin, path, status) => {
    const denied = network([])
    denied.observe({ ...observation, url: `${origin}${path}`, status })
    expect(() => denied.assertClean()).toThrow('R1_UNEXPECTED_4XX')
    const allowed = network([{ origin, method: 'GET', pathPattern: path, expectedStatus: status }])
    allowed.observe({ ...observation, url: `${origin}${path}`, status })
    allowed.assertClean()
  })

  it('R1 observes existing pages, new pages, crashes and worker errors and removes listeners', async () => {
    const worker = new EventEmitter()
    const page = Object.assign(new EventEmitter(), {
      workers: () => [worker],
      evaluate: async () => {},
    })
    const context = Object.assign(new EventEmitter(), {
      newPage: vi.fn(),
      pages: () => [page],
      exposeBinding: async () => {},
      addInitScript: async () => {},
    })
    const ledger = network([])
    const recorder = await recordNetwork(context as unknown as BrowserContext, ledger)
    await recorder.assertClean()
    page.emit('crash')
    worker.emit('error', new Error('synthetic'))
    const popupWorker = new EventEmitter()
    const popup = Object.assign(new EventEmitter(), { workers: () => [] })
    context.emit('page', popup)
    popup.emit('worker', popupWorker)
    popupWorker.emit('error', new Error('synthetic'))
    expect(ledger.failures).toEqual(['R1_PAGE_CRASH', 'R1_WORKER_ERROR', 'R1_WORKER_ERROR'])
    await recorder.dispose()
    for (const emitter of [context, page, worker, popup, popupWorker])
      expect(emitter.eventNames()).toEqual([])
  })

  it('R1 tolerates a rejected frame teardown CSP report', async () => {
    const context = Object.assign(new EventEmitter(), {
      newPage: vi.fn(),
      pages: () => [],
      exposeBinding: async (name: string) => {
        vi.stubGlobal(name, vi.fn().mockRejectedValue(new Error('closed')))
      },
      addInitScript: async (install: (name: string) => void, name: string) => install(name),
    })
    const ledger = network([])
    const recorder = await recordNetwork(context as unknown as BrowserContext, ledger)
    document.dispatchEvent(new Event('securitypolicyviolation'))
    await Promise.resolve()
    await recorder.assertClean()
    await recorder.dispose()
  })

  it('R1 preserves primary failures while cleanup runs and surfaces cleanup-only failures', async () => {
    const close = vi.fn().mockRejectedValue(new Error('cleanup'))
    const other = vi.fn().mockResolvedValue(undefined)
    const primary = new Error('primary')
    const run = async () => {
      try {
        throw primary
      } finally {
        await finishCleanup(false, [close, other], 'WAVE2_CLEANUP')
      }
    }
    await expect(run()).rejects.toBe(primary)
    expect(other).toHaveBeenCalledOnce()
    await expect(finishCleanup(true, [close, other], 'WAVE2_CLEANUP')).rejects.toThrow(
      'WAVE2_CLEANUP'
    )
    await expect(finishCleanup(true, [other], 'WAVE2_CLEANUP')).resolves.toBeUndefined()
    await expect(
      finishCleanup(
        false,
        [
          () => {
            throw new Error('sync')
          },
        ],
        'WAVE2_CLEANUP'
      )
    ).resolves.toBeUndefined()
  })

  it.each([
    'await page.waitForTimeout(100)',
    'await new Promise(resolve => setTimeout(resolve, 100))',
    "import { setTimeout as delay } from 'node:timers/promises'; await delay(100)",
    "const timers = await import('timers/promises'); await timers.setTimeout(100)",
    'await window.setTimeout(callback, 100)',
  ])('R2 refuses fixed-delay source mutations', (source) => {
    expect(timingViolations(source).length).toBeGreaterThan(0)
  })
  it('R2 admits polling and discovers transitive static and dynamic helpers', () => {
    expect(timingViolations('await expect.poll(() => ready).toBe(true)')).toEqual([])
    expect(
      relativeImports("import './one'; export * from '../two'; const helper = import('./three')")
    ).toEqual(['./one', '../two', './three'])
  })

  it('R2 matches only the literal mail target and stops at whitespace', () => {
    const pattern = mailLinkPattern(`${WEB}/claim/one`)
    expect(`message ${WEB}/claim/one#synthetic remaining`.match(pattern)?.[0]).toBe(
      `${WEB}/claim/one#synthetic`
    )
    expect('https://webXexampleXtest/claim/one#synthetic'.match(pattern)).toBeNull()
  })

  it('R2 scans Mailpit deterministically without reflecting recipients, URLs or transport failures', async () => {
    const to = 'synthetic@example.test'
    const link = `${WEB}/claim/one#synthetic`
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        status: () => 200,
        json: async () => ({
          messages: [
            { ID: 'other', To: [{ Address: 'other@example.test' }] },
            { ID: 'one/two', To: [{ Address: to }] },
          ],
        }),
      })
      .mockResolvedValueOnce({ status: () => 200, json: async () => ({ Text: link }) })
    expect(
      await findMailLink({ get } as unknown as APIRequestContext, API, to, /https:\/\/[^\s]+/)
    ).toBe(link)
    expect(get).toHaveBeenLastCalledWith(`${API}/api/v1/message/one%2Ftwo`, { maxRedirects: 0 })
    const empty = {
      get: async () => ({ status: () => 200, json: async () => ({ messages: [] }) }),
    } as unknown as APIRequestContext
    expect(await findMailLink(empty, API, to, /claim/)).toBeUndefined()
    for (const response of [
      new Error(`${to} ${link}`),
      { status: () => 502 },
      { status: () => 200, json: async () => ({}) },
    ]) {
      const request = {
        get: async () => {
          if (response instanceof Error) throw response
          return response
        },
      } as unknown as APIRequestContext
      await expect(findMailLink(request, API, to, /claim/)).rejects.toThrow(/^WAVE2_MAIL_SCAN$/)
    }
  })

  it('R2 searches by recipient and paginates beyond fifty messages with exact ownership checks', async () => {
    const to = 'synthetic+wave@example.test'
    const link = `${WEB}/claim/one#synthetic`
    const get = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/message/')) {
        expect(url).toBe(`${API}/api/v1/message/owned`)
        return { status: () => 200, json: async () => ({ HTML: link }) }
      }
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/api/v1/search')
      expect(parsed.searchParams.get('query')).toBe(`to:${to}`)
      expect(parsed.searchParams.get('limit')).toBe('50')
      const start = Number(parsed.searchParams.get('start'))
      expect([0, 50]).toContain(start)
      return {
        status: () => 200,
        json: async () => ({
          messages:
            start === 0
              ? Array.from({ length: 50 }, (_, i) => ({
                  ID: String(i),
                  To: [{ Address: 'other@example.test' }],
                }))
              : [{ ID: 'owned', To: [{ Address: to.toUpperCase() }] }],
        }),
      }
    })
    expect(
      await findMailLink(
        { get } as unknown as APIRequestContext,
        API,
        to,
        mailLinkPattern(`${WEB}/claim/one`)
      )
    ).toBe(link)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('R2 bounds a nonterminating Mailpit listing and sanitizes later-page failures', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ ID: String(i), To: [] }))
    const get = vi.fn().mockResolvedValue({ status: () => 200, json: async () => ({ messages }) })
    await expect(
      findMailLink({ get } as unknown as APIRequestContext, API, 'synthetic@example.test', /claim/)
    ).rejects.toThrow(/^WAVE2_MAIL_SCAN$/)
    expect(get).toHaveBeenCalledTimes(100)
    get
      .mockReset()
      .mockResolvedValueOnce({ status: () => 200, json: async () => ({ messages }) })
      .mockRejectedValueOnce(new Error('private transport detail'))
    await expect(
      findMailLink({ get } as unknown as APIRequestContext, API, 'synthetic@example.test', /claim/)
    ).rejects.toThrow(/^WAVE2_MAIL_SCAN$/)
  })

  it('R3 retains the shared-address ceiling across budgets and cleanup, with independent account counts', () => {
    for (let i = 0; i < 4; i++) {
      const budget = new RateBudget()
      budget.register('A')
      budget.reserve('A', 'matrix-login', 4)
      budget.assertExact('A', { 'matrix-login': 4 })
      budget.clear()
    }
    const last = new RateBudget()
    last.register('B')
    last.reserve('B', 'matrix-login', 3)
    last.assertExact('B', { 'matrix-login': 3 })
    expect(() => last.reserve('B', 'matrix-login')).toThrow('R3_LOGIN_CEILING')
    resetRateAddressForTests()
    const fresh = new RateBudget()
    fresh.register('A')
    fresh.reserve('A', 'matrix-login', 4)
    fresh.assertClean()
  })
  it.each([
    '/api/v1/owner-claims/actions/consume',
    '/api/v1/invitations/accept',
    '/api/v1/workspace-invites/redeem',
  ])('R3 meters Core local join %s', (path) => {
    const origins = { homeserver: HS, auth: AUTH, api: API }
    expect(classifyRateRequest(`${API}${path}`, 'POST', origins)).toBe('local-join')
    expect(classifyRateRequest(`${API}${path}`, 'GET', origins)).toBeUndefined()
    expect(classifyRateRequest(`${WEB}${path}`, 'POST', origins)).toBeUndefined()
    expect(classifyRateRequest(`${API}${path}/extra`, 'POST', origins)).toBe('core-write')
  })

  it('R4 checks every decode depth, plus separators and the decode ceiling', () => {
    for (const value of [
      'phc_secret',
      'Bearer secret',
      'Bearer+secret',
      'syt_synthetic',
      'mda_synthetic',
      '/callback?code=opaque',
      '/callback?loginToken=opaque',
    ]) {
      let encoded = value
      for (let depth = 0; depth <= 5; depth++) {
        expect(() => safeString(encoded)).toThrow(/^R4_/)
        encoded = encoded.replace(
          /[%pBs m/?=&+]/g,
          (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`
        )
      }
    }
    for (const value of ['%25252570hc_secret', '%25252542earer%25252520secret'])
      expect(() => safeString(value)).toThrow('R4_SECRET_RECEIPT')
    expect(() => safeString('%2525252541')).toThrow('R4_ENCODED_RECEIPT')
    expect(() => safeString('%broken')).toThrow('R4_ENCODED_RECEIPT')
    for (const value of ['ready', '/callback?mode=synthetic', 'hello+world', '%25252541'])
      safeString(value)
  })
  it.each([
    'code',
    'loginToken',
    'access_token',
    'refresh_token',
    'id_token',
    'code_verifier',
    'token',
    'secret',
    'X-Amz-Credential',
    'X-Amz-Security-Token',
    'X-Amz-Signature',
    'AWSAccessKeyId',
    'Signature',
  ])('R4 rejects sensitive query parameter %s', (key) => {
    for (const separator of ['?', '&'])
      expect(() => safeString(`/callback${separator}${key}=opaque`)).toThrow('R4_SECRET_RECEIPT')
    safeString(`/callback?mode=${key}`)
  })
  it.each([
    'api_key',
    'code',
    'code_verifier',
    'token',
    'access_token',
    'refresh_token',
    'id_token',
    'loginToken',
    'secret',
    'password',
    'totpBase32',
    'authorization',
    'cookie',
    'set-cookie',
    'signature',
  ])('R4 rejects sensitive object key %s', (key) => {
    expect(() => validateReceipt({ nested: { [key]: 'opaque' } })).toThrow('R4_SECRET_RECEIPT')
    expect(() =>
      validateReceipt({
        [key.replace(/^./, (char) => `%${char.charCodeAt(0).toString(16)}`)]: 'opaque',
      })
    ).toThrow('R4_SECRET_RECEIPT')
    validateReceipt({ nested: { [`${key}_count`]: 1 } })
  })
  it('R4 rejects runtime fixture secrets in arrays and sets, verbatim and repeatedly encoded', () => {
    const secret = 'fixture/opaque+value'
    for (const secrets of [[secret], new Set([secret])]) {
      let encoded = secret
      for (let i = 0; i <= 4; i++) {
        expect(() => validateReceipt({ result: `prefix${encoded}suffix` }, secrets)).toThrow(/^R4_/)
        encoded = encodeURIComponent(encoded)
      }
      validateReceipt({ result: 'public-summary' }, secrets)
    }
  })
  it('R4 rejects a runtime form secret after the final permitted decode', () => {
    let value = 'fixture+opaque'
    for (let pass = 0; pass < 4; pass++) value = encodeURIComponent(value)
    expect(() => validateReceipt({ result: value }, ['fixture opaque'])).toThrow(
      'R4_SECRET_RECEIPT'
    )
    validateReceipt({ result: value }, ['different fixture'])
  })

  it('R4 scrubs stale output at startup and teardown and is idempotent', async () => {
    const config = readFileSync(webPath('playwright.wave2.config.ts'), 'utf8')
    for (const hook of ['globalSetup', 'globalTeardown'])
      expect(config).toContain(`${hook}: './tests/wave2/teardown.ts'`)
    const output = webPath('test-results/wave2')
    for (const _phase of ['startup', 'teardown']) {
      await mkdir(output, { recursive: true })
      await writeFile(resolve(output, 'stale.txt'), 'synthetic')
      expect(existsSync(output)).toBe(true)
      await scrubArtifacts()
      expect(existsSync(output)).toBe(false)
    }
    await expect(scrubArtifacts()).resolves.toBeUndefined()
  })

  it('R5 marks revocation before the UI action and refuses a farewell request', async () => {
    const ledger = new ConsentLedger(WEB, captureKey)
    ledger.phase = 'consented'
    ledger.observe(captureRequest())
    ledger.assertClean()
    await revokeConsent(ledger, async () => {
      expect(ledger.phase).toBe('revoked')
      ledger.observe(captureRequest())
    })
    expect(ledger.attempts.at(-1)?.phase).toBe('revoked')
    expect(() => ledger.assertClean()).toThrow('R5_NO_REQUEST_WITHOUT_CONSENT')
  })
  it('R5 requires every held native request to abort, including concurrent vital events', () => {
    const fact = { allowedAtDispatch: true, privacyOptions: true, aborted: true }
    assertNativeCancellation([fact, fact, fact], 1, 2)
    for (const facts of [
      [],
      [fact],
      [fact, { ...fact, aborted: false }],
      [fact, { ...fact, allowedAtDispatch: false }],
      [fact, { ...fact, privacyOptions: false }],
    ])
      expect(() => assertNativeCancellation(facts, 0, 2)).toThrow('R5_IMMEDIATE_NATIVE_ABORT')
  })

  it('R6 resets focus and preserves the original body tabindex', () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    expect(document.activeElement).toBe(button)
    resetDocumentFocus()
    expect(document.activeElement).toBe(document.body)
    expect(document.body.hasAttribute('tabindex')).toBe(false)
    document.body.setAttribute('tabindex', '0')
    button.focus()
    resetDocumentFocus()
    expect(document.activeElement).toBe(document.body)
    expect(document.body.getAttribute('tabindex')).toBe('0')
    document.body.removeAttribute('tabindex')
  })
  it('R6 selects responsive keyboard orders and rejects an absent viewport allocation', () => {
    const orders = { 375: ['#mobile'], 768: ['#tablet'], 1440: ['#desktop'] }
    for (const width of VIEWPORTS) expect(tabOrderForViewport(orders, width)).toEqual(orders[width])
    expect(tabOrderForViewport(['#fallback'], 375)).toEqual(['#fallback'])
    expect(() => tabOrderForViewport({ ...orders, 375: [] }, 375)).toThrow('A11Y_VACUOUS_ORDER')
  })
  it('R6 checks vertical text clipping independently of horizontal ellipsis and preserves visible text', () => {
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 375 },
      scrollWidth: { configurable: true, value: 375 },
    })
    const child = document.createElement('p')
    child.textContent = 'synthetic'
    document.body.append(child)
    vi.spyOn(child, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
      right: 100,
      left: 0,
    } as DOMRect)
    Object.defineProperties(child, {
      clientHeight: { configurable: true, value: 20 },
      scrollHeight: { configurable: true, value: 40 },
    })
    child.style.textOverflow = 'ellipsis'
    for (const overflow of ['hidden', 'clip']) {
      child.style.overflowY = overflow
      expect(layoutFaultsInDocument()).toContain('R6_VERTICAL_CLIPPING:P')
    }
    child.style.overflowY = 'visible'
    assertLayout(layoutFaultsInDocument())
    child.style.overflowY = 'hidden'
    child.textContent = ''
    assertLayout(layoutFaultsInDocument())
    child.textContent = 'synthetic'
    Object.defineProperty(child, 'scrollHeight', { value: 21 })
    assertLayout(layoutFaultsInDocument())
  })
})
const VIEWPORTS = [375, 768, 1440] as const

describe('concurrent transport and font regressions', () => {
  it.each(['release', 'revoke', 'close'] as const)(
    'R5 holds every POST until %s and tracks every cancellation',
    async (mode) => {
      let handler: ((route: Route) => Promise<void>) | undefined
      let matcher: ((url: URL) => boolean) | undefined
      const emitter = new EventEmitter()
      const context = Object.assign(emitter, {
        route: async (match: typeof matcher, callback: typeof handler) => {
          matcher = match
          handler = callback
        },
        unroute: vi.fn(),
      }) as unknown as BrowserContext
      const ledger = new ConsentLedger(WEB, captureKey)
      ledger.phase = 'consented'
      const interceptor = await installPosthogInterceptor(context, ledger, [WEB, API, AUTH, HS])
      expect(matcher!(new URL(`${WEB}/assets/app.js`))).toBe(false)
      expect(matcher!(new URL('https://unexpected.example.test/collect'))).toBe(true)
      interceptor.holdPosts()
      const raw = captureRequest()
      const requests: Request[] = []
      const aborts: ReturnType<typeof vi.fn>[] = []
      const fulfills: ReturnType<typeof vi.fn>[] = []
      const tasks: Promise<void>[] = []
      const send = () => {
        const request = {
          url: () => raw.url,
          method: () => 'POST',
          headers: () => raw.headers,
          allHeaders: async () => raw.headers,
          postDataJSON: () => raw.body,
        } as unknown as Request
        const abort = vi.fn(async () => {
          expect(interceptor.isHeldRequest(request)).toBe(true)
          emitter.emit('requestfailed', request)
        })
        const fulfill = vi.fn(async () => {
          emitter.emit('requestfinished', request)
        })
        requests.push(request)
        aborts.push(abort)
        fulfills.push(fulfill)
        emitter.emit('request', request)
        tasks.push(handler!({ request: () => request, abort, fulfill } as unknown as Route))
      }
      send()
      send()
      await vi.waitFor(() => expect(interceptor.heldCount()).toBe(2))
      send()
      await vi.waitFor(() => expect(interceptor.heldCount()).toBe(3))
      for (const request of requests) expect(interceptor.isHeldRequest(request)).toBe(true)
      for (const fulfill of fulfills) expect(fulfill).not.toHaveBeenCalled()
      expect(interceptor.isHeldRequest({} as Request)).toBe(false)
      if (mode === 'revoke') ledger.phase = 'revoked'
      if (mode === 'close') emitter.emit('close')
      else interceptor.releaseHeldPosts()
      await Promise.all(tasks)
      expect(interceptor.heldCount()).toBe(0)
      for (const request of requests) expect(interceptor.isHeldRequest(request)).toBe(false)
      if (mode === 'release') {
        for (const fulfill of fulfills) expect(fulfill).toHaveBeenCalledOnce()
        for (const abort of aborts) expect(abort).not.toHaveBeenCalled()
        send()
        await tasks.at(-1)
        expect(fulfills.at(-1)).toHaveBeenCalledOnce()
      } else {
        for (const abort of aborts) expect(abort).toHaveBeenCalledWith('aborted')
        for (const fulfill of fulfills) expect(fulfill).not.toHaveBeenCalled()
      }
      ledger.assertClean()
      await interceptor.dispose()
      expect(emitter.eventNames()).toEqual([])
    }
  )

  it('R5 blocks an unrelated third-party collector and admits configured first-party egress', async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    const emitter = new EventEmitter()
    const context = Object.assign(emitter, {
      route: async (_match: unknown, callback: typeof handler) => {
        handler = callback
      },
      unroute: vi.fn(),
    }) as unknown as BrowserContext
    const ledger = new ConsentLedger(WEB, captureKey)
    const interceptor = await installPosthogInterceptor(context, ledger, [WEB, API, AUTH, HS])
    emitter.emit('request', { url: () => `${API}/api/v1/me` })
    ledger.assertClean()
    const abort = vi.fn()
    await handler!({
      request: () => ({ url: () => 'https://unexpected.example.test/collect' }),
      abort,
    } as unknown as Route)
    expect(abort).toHaveBeenCalledWith('blockedbyclient')
    expect(() => ledger.assertClean()).toThrow('R5_UNADMITTED_ORIGIN')
    await interceptor.dispose()
  })

  it('R6 scans normal and bold loaded font weights and rejects malformed descriptors', () => {
    const original = Object.getOwnPropertyDescriptor(document, 'fonts')
    const faces = [
      ...['normal', '500', '600', 'bold', '800'].map((weight) => ({
        family: 'Plus Jakarta Sans',
        weight,
        style: 'normal',
        status: 'loaded',
      })),
      ...['normal', '500'].map((weight) => ({
        family: 'IBM Plex Mono',
        weight,
        style: 'normal',
        status: 'loaded',
      })),
    ]
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { forEach: (visit: (face: unknown) => void) => faces.forEach(visit) },
    })
    vi.stubGlobal('getComputedStyle', (_element: Element, pseudo?: string) => ({
      content: pseudo ? 'none' : '',
      fontFamily: 'Plus Jakarta Sans',
      fontWeight: 'normal',
      fontStyle: 'normal',
      getPropertyValue: () => 'IBM Plex Mono',
    }))
    for (let i = 0; i < 21; i++) {
      const paragraph = document.createElement('p')
      paragraph.textContent = 'synthetic'
      paragraph.checkVisibility = () => true
      document.body.append(paragraph)
    }
    try {
      assertFontScan(scanFontsInDocument('landing'))
      faces[0]!.weight = 'invalid'
      expect(scanFontsInDocument('landing').missing).toContain('Plus Jakarta Sans 400 normal')
      expect(() => assertFontScan(scanFontsInDocument('landing'))).toThrow('R6_FONT_ASSET_MISSING')
      faces[0]!.weight = 'normal'
      faces[3]!.weight = 'invalid'
      expect(scanFontsInDocument('landing').missing).toContain('Plus Jakarta Sans 700 normal')
      faces[3]!.weight = '700 800'
      assertFontScan(scanFontsInDocument('landing'))
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original)
      else Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('R6 adopts token-bound probe rules without a utility class or style attribute and removes them', () => {
    const original = Object.getOwnPropertyDescriptor(document, 'adoptedStyleSheets')
    class Sheet {
      cssRules: { cssText: string }[] = []
      replaceSync(text: string) {
        this.cssRules = [{ cssText: text }]
      }
    }
    vi.stubGlobal('CSSStyleSheet', Sheet)
    const existing = new Sheet()
    existing.replaceSync('body { display: block }')
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      writable: true,
      value: [existing],
    })
    try {
      installFontProbesInDocument(true)
      const mono = document.querySelector('[data-wave2-glyph-probe="mono"]')!
      expect(mono).not.toBeNull()
      expect(mono.hasAttribute('style')).toBe(false)
      expect(mono.hasAttribute('class')).toBe(false)
      expect(document.adoptedStyleSheets[1]?.cssRules[0]?.cssText).toContain(
        'font-family: var(--font-mono)'
      )
      removeFontProbesInDocument()
      expect(document.adoptedStyleSheets).toEqual([existing])
      expect(document.querySelector('[data-wave2-glyph-probe]')).toBeNull()
      installFontProbesInDocument(false)
      expect(document.querySelector('[data-wave2-glyph-probe="mono"]')).toBeNull()
      expect(document.querySelector('[data-wave2-glyph-probe="sans"]')).not.toBeNull()
      removeFontProbesInDocument()
    } finally {
      if (original) Object.defineProperty(document, 'adoptedStyleSheets', original)
      else Reflect.deleteProperty(document, 'adoptedStyleSheets')
    }
  })

  it('R6 captures both web and landing cells before keyboard probes and rejects reversed order', () => {
    const captureFirst = (source: string) => {
      const root = ts.createSourceFile('cell.ts', source, ts.ScriptTarget.Latest, true)
      const calls: string[] = []
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['viewportScreenshot', 'verifySkipLink', 'verifyTabOrder'].includes(node.expression.text)
        )
          calls.push(node.expression.text)
        ts.forEachChild(node, visit)
      }
      visit(root)
      return calls[0] === 'viewportScreenshot' && calls.includes('verifySkipLink')
    }
    const source = readFileSync(webPath('tests/wave2/persona4-visual-a11y-r5.spec.ts'), 'utf8')
    const cells = source.split("test('Persona 4:").slice(1)
    expect(cells).toHaveLength(2)
    for (const cell of cells) expect(captureFirst(`test('Persona 4:${cell}`)).toBe(true)
    expect(
      captureFirst('await viewportScreenshot(page, cell); await verifySkipLink(page, id)')
    ).toBe(true)
    expect(
      captureFirst('await verifySkipLink(page, id); await viewportScreenshot(page, cell)')
    ).toBe(false)
    expect(
      captureFirst(
        'await verifyTabOrder(page, order); await viewportScreenshot(page, cell); await verifySkipLink(page, id)'
      )
    ).toBe(false)
  })
})

describe('P2 location-independent tooling and formatting', () => {
  it('resolves the web root from this module and pins the isolated runner root', () => {
    expect(existsSync(webPath('playwright.wave2.config.ts'))).toBe(true)
    const config = readFileSync(webPath('tests/wave2/vitest.config.ts'), 'utf8')
    expect(config).toContain("root: resolve(import.meta.dirname, '../..')")
    expect(config).not.toMatch(/process\.cwd\(/)
  })
  it('admits formatted code, rejects style mutations and checks every Wave 2 TypeScript file', async () => {
    const config = JSON.parse(readFileSync(webPath('.prettierrc'), 'utf8'))
    const options = {
      parser: 'typescript',
      singleQuote: config.singleQuote,
      semi: config.semi,
      printWidth: config.printWidth,
      trailingComma: config.trailingComma,
    }
    expect(options).toMatchObject({
      singleQuote: true,
      semi: false,
      printWidth: 100,
      trailingComma: 'es5',
    })
    expect(await checkFormatting("const result = 'ready'\n", options)).toBe(true)
    expect(await checkFormatting('const result="ready";\n', options)).toBe(false)
    const files = [
      webPath('playwright.wave2.config.ts'),
      resolve(import.meta.dirname, 'wave2-oracles.test.ts'),
    ]
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = resolve(path, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(webPath('tests/wave2'))
    for (const file of files)
      expect(await checkFormatting(readFileSync(file, 'utf8'), options), file).toBe(true)
  })
})

describe('dispatch boundary races', () => {
  it('R5 holds a dispatched request even while complete headers are pending at revocation', async () => {
    let handler: ((route: Route) => Promise<void>) | undefined
    const emitter = new EventEmitter()
    const context = Object.assign(emitter, {
      route: async (_match: unknown, callback: typeof handler) => {
        handler = callback
      },
      unroute: vi.fn(),
    }) as unknown as BrowserContext
    const ledger = new ConsentLedger(WEB, captureKey)
    ledger.phase = 'consented'
    const interceptor = await installPosthogInterceptor(context, ledger, [WEB])
    let resolveHeaders!: (headers: Record<string, string>) => void
    const headers = new Promise<Record<string, string>>((resolve) => {
      resolveHeaders = resolve
    })
    const raw = captureRequest()
    const request = {
      url: () => raw.url,
      method: () => 'POST',
      headers: () => raw.headers,
      allHeaders: () => headers,
      postDataJSON: () => raw.body,
    } as unknown as Request
    interceptor.holdPosts()
    emitter.emit('request', request)
    expect(interceptor.isHeldRequest(request)).toBe(true)
    expect(interceptor.heldCount()).toBe(1)
    const abort = vi.fn()
    const fulfill = vi.fn()
    const task = handler!({ request: () => request, abort, fulfill } as unknown as Route)
    await revokeConsent(ledger, async () => {})
    interceptor.releaseHeldPosts()
    resolveHeaders(raw.headers)
    await task
    expect(abort).toHaveBeenCalledWith('aborted')
    expect(fulfill).not.toHaveBeenCalled()
    ledger.assertClean()
    await interceptor.dispose()
  })

  it('R1 requires an exact 200 landing response as well as clean subresources', () => {
    const origin = 'https://landing.example.test'
    const rule = { origin, method: 'GET', pathPattern: '/', expectedStatus: 200 }
    const good = new NetworkLedger([rule], [origin])
    good.observe({ ...observation, url: `${origin}/`, status: 200, contentType: 'text/html' })
    good.assertClean()
    const redirect = new NetworkLedger([rule], [origin])
    redirect.observe({ ...observation, url: `${origin}/`, status: 302, contentType: 'text/html' })
    expect(() => redirect.assertClean()).toThrow('R1_EXACT_STATUS')
    good.observe({ ...observation, url: `${origin}/assets/app.js`, status: 404 })
    expect(() => good.assertClean()).toThrow('R1_UNEXPECTED_4XX')
  })
})
