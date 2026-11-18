import type { BrowserContext, Request, Route } from '@playwright/test'
import { exactOrigin, guard, object } from './shared'

export const POSTHOG_EU_ENDPOINT = 'https://eu.i.posthog.com/i/v0/e/'
const AREAS = [
  'home',
  'workspace',
  'docs',
  'people',
  'status',
  'security',
  'domain',
  'federation',
  'invoices',
  'order',
  'login',
  'other',
] as const
const OPERATIONS = ['chat_send', 'docs_load', 'docs_save', 'file_upload', 'file_download'] as const
type Rule = readonly string[] | 'number' | 'boolean' | 'stack'
/** Independent mirror of privacy.ts's private RULES. The unit suite checks source conformance. */
export const EVENT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
  navigation_completed: { area: AREAS, duration_ms: 'number' },
  web_vital: { metric: ['LCP', 'CLS', 'interaction_latency'], value: 'number' },
  resource_latency: { operation: [...OPERATIONS, 'docs_request'], duration_ms: 'number' },
  operation_completed: { operation: OPERATIONS, duration_ms: 'number', success: 'boolean' },
  onboarding_completed: { mode: ['cloud', 'local'] },
  channel_opened: { kind: ['chat', 'voice'] },
  workspace_surface_changed: { surface: ['chat', 'docs', 'files'], duration_ms: 'number' },
  channel_joined: { kind: ['chat', 'docs', 'voice'] },
  client_error: {
    source: ['error', 'rejection', 'boundary'],
    kind: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'unknown'],
    area: AREAS,
    component: ['RouteError', 'unknown'],
    stack: 'stack',
  },
  status_banner_shown: { kind: ['offline', 'incident', 'dunning', 'capacity', 'maintenance'] },
  organisation_switched: { membership_count: 'number' },
  session_expiry_dialog_shown: { outcome: ['extended', 'signed-out', 'ignored'] },
  help_opened: { area: AREAS },
  login_discovery_submitted: { kind: ['email', 'domain'] },
  home_viewed: {
    tenant_state: ['active', 'pending', 'suspended', 'none'],
    cards_rendered: 'number',
  },
}
export type ConsentPhase = 'before-consent' | 'consented' | 'revoked'
export interface CaptureRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

export function validateCapturePayload(body: unknown, expectedKey: string): string {
  guard(object(body), 'R5_BODY_OBJECT')
  guard(
    Object.keys(body).sort().join('|') === 'api_key|distinct_id|event|properties',
    'R5_ENVELOPE_KEYS'
  )
  guard(expectedKey.trim() && body.api_key === expectedKey, 'R5_CAPTURE_KEY')
  guard(typeof body.event === 'string' && Object.hasOwn(EVENT_SCHEMAS, body.event), 'R5_EVENT_NAME')
  guard(
    typeof body.distinct_id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.distinct_id
      ),
    'R5_RANDOM_UUID'
  )
  const properties = body.properties
  guard(object(properties), 'R5_PROPERTIES_OBJECT')
  guard(properties.$geoip_disable === true, 'R5_GEOIP_DISABLED')
  guard(properties.$process_person_profile === false, 'R5_NO_PERSON_PROFILE')
  const schema = EVENT_SCHEMAS[body.event]!
  for (const [key, value] of Object.entries(properties)) {
    if (key === '$geoip_disable' || key === '$process_person_profile') continue
    guard(Object.hasOwn(schema, key), 'R5_UNKNOWN_PROPERTY')
    const rule = schema[key]
    if (rule === 'number')
      guard(
        typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 3_600_000 &&
          Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
        'R5_BOUNDED_NUMBER'
      )
    else if (rule === 'boolean') guard(typeof value === 'boolean', 'R5_BOOLEAN')
    else if (rule === 'stack')
      guard(
        typeof value === 'string' &&
          value.length > 0 &&
          value.split('\n').length <= 8 &&
          value.split('\n').every((frame) => /^bundle:\d{1,8}:\d{1,8}$/.test(frame)),
        'R5_STACK_GRAMMAR'
      )
    else
      guard(
        Array.isArray(rule) && typeof value === 'string' && rule.includes(value),
        'R5_CLOSED_ENUM'
      )
  }
  return body.distinct_id
}

export function validateCaptureRequest(
  request: CaptureRequest,
  phase: ConsentPhase,
  appOrigin: string,
  expectedKey: string
): void {
  guard(phase === 'consented', 'R5_NO_REQUEST_WITHOUT_CONSENT')
  guard(request.url === POSTHOG_EU_ENDPOINT, 'R5_ENDPOINT')
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  guard(
    !headers.cookie && !headers.authorization && !headers.referer,
    'R5_NO_CREDENTIALS_OR_REFERRER'
  )
  guard(headers.origin === exactOrigin(appOrigin), 'R5_APP_ORIGIN')
  if (request.method === 'OPTIONS') {
    guard(headers['access-control-request-method'] === 'POST', 'R5_PREFLIGHT_METHOD')
    guard(
      headers['access-control-request-headers']?.toLowerCase() === 'content-type',
      'R5_PREFLIGHT_HEADERS'
    )
    return
  }
  guard(request.method === 'POST', 'R5_METHOD')
  guard(headers['content-type']?.split(';')[0] === 'application/json', 'R5_CONTENT_TYPE')
  validateCapturePayload(request.body, expectedKey)
}

export class ConsentLedger {
  phase: ConsentPhase = 'before-consent'
  readonly attempts: { phase: ConsentPhase; method: string }[] = []
  readonly failures: string[] = []
  constructor(
    readonly appOrigin: string,
    private readonly key: string
  ) {
    exactOrigin(appOrigin)
  }
  observe(request: CaptureRequest): void {
    this.attempts.push({ phase: this.phase, method: request.method })
    this.validate(request, this.phase)
  }
  validate(request: CaptureRequest, phase: ConsentPhase): void {
    try {
      validateCaptureRequest(request, phase, this.appOrigin, this.key)
    } catch (error) {
      this.failures.push(
        error instanceof Error && /^R5_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'R5_INTERCEPTOR_ERROR'
      )
    }
  }
  assertClean(): void {
    guard(!this.failures.length, this.failures[0] ?? 'R5_FAILURE')
  }
  postCount(): number {
    return this.attempts.filter((attempt) => attempt.method === 'POST').length
  }
}

/** Local interception proves attempted dispatch, not remote collection or erasure. */
export async function installPosthogInterceptor(
  context: BrowserContext,
  ledger: ConsentLedger,
  allowedServiceOrigins: readonly string[]
) {
  allowedServiceOrigins.forEach(exactOrigin)
  const diagnostic = (url: URL) => /posthog/i.test(url.hostname)
  const held = new Map<Request, { wait: Promise<void>; release: () => void }>()
  const heldRequests = new Set<Request>()
  const phases = new WeakMap<Request, ConsentPhase>()
  const inFlight = new Set<Promise<void>>()
  let holding = false
  let closing = false
  const captured = new WeakSet<Request>()
  const inspect = (request: Request) => {
    const url = new URL(request.url())
    if (!diagnostic(url)) {
      if (!allowedServiceOrigins.includes(url.origin)) ledger.failures.push('R5_UNADMITTED_ORIGIN')
      return
    }
    if (captured.has(request)) return
    captured.add(request)
    phases.set(request, ledger.phase)
    if (holding && request.method() === 'POST' && ledger.phase === 'consented') {
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      held.set(request, { wait, release })
      heldRequests.add(request)
    }
    let body: unknown
    try {
      body = request.method() === 'POST' ? request.postDataJSON() : undefined
    } catch {
      ledger.failures.push('R5_BODY_OBJECT')
    }
    ledger.observe({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body,
    })
  }
  const handleRoute = async (route: Route) => {
    const request = route.request()
    inspect(request)
    if (!diagnostic(new URL(request.url()))) return route.abort('blockedbyclient')
    const heldPost = held.get(request)
    let body: unknown
    try {
      body = request.method() === 'POST' ? request.postDataJSON() : undefined
    } catch {
      ledger.failures.push('R5_BODY_OBJECT')
    }
    ledger.validate(
      { url: request.url(), method: request.method(), headers: await request.allHeaders(), body },
      phases.get(request) ?? ledger.phase
    )
    if (ledger.failures.length) return route.abort('blockedbyclient')
    if (heldPost) await heldPost.wait
    if (closing || ledger.phase !== 'consented') return route.abort('aborted')
    await route.fulfill({
      status: route.request().method() === 'OPTIONS' ? 204 : 200,
      headers: {
        'Access-Control-Allow-Origin': ledger.appOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
      },
      body: route.request().method() === 'OPTIONS' ? '' : '{"status":1}',
    })
  }
  const routeHandler = (route: Route): Promise<void> => {
    const task = handleRoute(route).catch(() => {
      if (!closing) ledger.failures.push('R5_INTERCEPTOR_ERROR')
    })
    inFlight.add(task)
    void task.finally(() => inFlight.delete(task))
    return task
  }
  context.on('request', inspect)
  const matcher = (url: URL) => diagnostic(url) || !allowedServiceOrigins.includes(url.origin)
  const releaseHeldPosts = () => {
    holding = false
    for (const { release } of held.values()) release()
    held.clear()
  }
  const completed = (request: Request) => heldRequests.delete(request)
  const close = () => {
    closing = true
    releaseHeldPosts()
  }
  context.on('requestfinished', completed).on('requestfailed', completed).on('close', close)
  await context.route(matcher, routeHandler)
  return {
    holdPosts() {
      holding = true
    },
    heldCount: () => held.size,
    isHeldRequest: (request: Request) => heldRequests.has(request),
    releaseHeldPosts,
    async dispose() {
      close()
      await context.unroute(matcher, routeHandler)
      while (inFlight.size) await Promise.all([...inFlight])
      context
        .off('request', inspect)
        .off('requestfinished', completed)
        .off('requestfailed', completed)
        .off('close', close)
      heldRequests.clear()
    },
  }
}

export interface DispatchFact {
  allowedAtDispatch: boolean
  aborted: boolean
  privacyOptions: boolean
}
export async function revokeConsent(
  ledger: ConsentLedger,
  revoke: () => Promise<unknown>
): Promise<void> {
  ledger.phase = 'revoked'
  await revoke()
}

export function assertNativeCancellation(
  facts: readonly DispatchFact[],
  firstHeld: number,
  heldCount: number
): void {
  guard(
    Number.isInteger(firstHeld) &&
      firstHeld >= 0 &&
      firstHeld < facts.length &&
      Number.isInteger(heldCount) &&
      heldCount > 0 &&
      facts.length > 0 &&
      facts.every((fact) => fact.allowedAtDispatch && fact.privacyOptions) &&
      facts.some((fact) => fact.aborted) &&
      facts.slice(firstHeld).length >= heldCount &&
      facts.slice(firstHeld).every((fact) => fact.aborted),
    'R5_IMMEDIATE_NATIVE_ABORT'
  )
}

/** This browser-local probe closes the driver/UI scheduling gap and witnesses native cancellation. */
export async function installConsentDispatchProbe(context: BrowserContext, consentKey: string) {
  await context.addInitScript(
    ({ consentKey }) => {
      const facts: DispatchFact[] = []
      Object.defineProperty(window, '__wave2DispatchFacts', { value: facts })
      // eslint-disable-next-line no-restricted-properties -- Test-only transparent transport observer.
      const nativeFetch = window.fetch
      // eslint-disable-next-line no-restricted-properties -- Test-only transparent transport observer.
      window.fetch = function (...args: Parameters<typeof fetch>) {
        const [input, init] = args
        const request = input instanceof Request ? input : undefined
        const url = new URL(request?.url ?? String(input), location.href)
        if (/posthog/i.test(url.hostname)) {
          let allowed = false
          try {
            allowed = localStorage.getItem(consentKey) === 'yes'
          } catch {
            /* Denied storage fails closed. */
          }
          const signal = init?.signal === undefined ? request?.signal : init.signal
          const fact = {
            allowedAtDispatch: allowed,
            aborted: signal?.aborted ?? false,
            privacyOptions:
              init?.credentials === 'omit' &&
              init?.referrerPolicy === 'no-referrer' &&
              init?.redirect === 'error',
          }
          facts.push(fact)
          signal?.addEventListener(
            'abort',
            () => {
              fact.aborted = true
            },
            { once: true }
          )
        }
        return nativeFetch.apply(this, args)
      }
    },
    { consentKey }
  )
}
