import type { BrowserContext, Request } from '@playwright/test'
import { exactOrigin, guard } from './shared'

export type RateEvent = 'matrix-login' | 'core-token' | 'local-join' | 'core-write'
type Counts = Record<RateEvent, number>
type State = Awaited<ReturnType<BrowserContext['storageState']>>

// One worker shares an egress address across every test and every budget instance.
let addressLogins = 0

/** Unit tests only; production harness cleanup must never replenish the shared address. */
export function resetRateAddressForTests(): void {
  addressLogins = 0
}

/** No refill assumptions: the run must start with fresh, independently admitted accounts. */
export class RateBudget {
  private readonly actors = new Map<string, Counts>()
  private readonly states = new Map<string, State>()
  private readonly reuses = new Map<string, number>()
  private readonly pages = new Map<string, object>()
  private readonly pageReuses = new Map<string, number>()
  readonly failures: string[] = []
  register(alias: string): void {
    guard(/^[A-Z][A-Z0-9_-]{0,31}$/.test(alias) && !this.actors.has(alias), 'R3_ACTOR')
    this.actors.set(alias, { 'matrix-login': 0, 'core-token': 0, 'local-join': 0, 'core-write': 0 })
  }
  reserve(alias: string, event: RateEvent, amount = 1): void {
    const counts = this.actors.get(alias)
    guard(counts && Number.isInteger(amount) && amount > 0, 'R3_RESERVATION')
    const limit = { 'matrix-login': 4, 'core-token': 4, 'local-join': 9, 'core-write': 20 }[event]
    guard(typeof limit === 'number', 'R3_EVENT')
    const marker = event === 'local-join' ? 'R3_JOIN_CEILING' : 'R3_LOGIN_CEILING'
    if (
      counts[event] + amount > limit ||
      (event === 'matrix-login' && addressLogins + amount >= 20)
    ) {
      this.failures.push(event === 'core-write' ? 'R3_WRITE_CEILING' : marker)
      throw new Error(this.failures.at(-1))
    }
    counts[event] += amount
    if (event === 'matrix-login') addressLogins += amount
  }
  observeAttempt(alias: string, event: RateEvent): void {
    try {
      this.reserve(alias, event)
    } catch {
      // Reservations stop a planned send; automatic SDK attempts have already happened and count.
      const counts = this.actors.get(alias)
      if (counts) counts[event] += 1
      if (event === 'matrix-login') addressLogins += 1
    }
  }
  rememberState(alias: string, state: State): void {
    guard(this.actors.has(alias) && !this.states.has(alias), 'R3_STATE_OWNER')
    guard(!state.origins.some((origin) => 'indexedDB' in origin), 'R3_VAULT_EXPORT')
    this.states.set(alias, structuredClone(state))
  }
  retainPage(alias: string, page: object): void {
    guard(this.actors.has(alias) && !this.pages.has(alias), 'R3_PAGE_OWNER')
    this.pages.set(alias, page)
  }
  reusePage(alias: string, page: object): void {
    guard(this.pages.get(alias) === page, 'R3_PAGE_REPLACED')
    this.pageReuses.set(alias, (this.pageReuses.get(alias) ?? 0) + 1)
  }
  reuseState(alias: string): State {
    const state = this.states.get(alias)
    guard(state, 'R3_STATE_MISSING')
    this.reuses.set(alias, (this.reuses.get(alias) ?? 0) + 1)
    return structuredClone(state)
  }
  assertExact(alias: string, expected: Partial<Counts>): void {
    const actual = this.actors.get(alias)
    guard(
      actual &&
        Object.entries(expected).every(([key, value]) => actual[key as RateEvent] === value),
      'R3_EXACT_ALLOCATION'
    )
    this.assertClean()
  }
  assertClean(): void {
    guard(!this.failures.length, this.failures[0] ?? 'R3_FAILURE')
  }
  receipt() {
    return [...this.actors].map(([actor, counts]) => ({
      actor,
      ...counts,
      storageStateReuses: this.reuses.get(actor) ?? 0,
      livePageReuses: this.pageReuses.get(actor) ?? 0,
    }))
  }
  clear(): void {
    this.states.clear()
    this.pages.clear()
  }
}

export function classifyRateRequest(
  urlValue: string,
  method: string,
  origins: {
    homeserver: string
    auth: string
    api: string
  }
): RateEvent | undefined {
  Object.values(origins).forEach(exactOrigin)
  const url = new URL(urlValue)
  if (method === 'POST' && url.origin === origins.homeserver) {
    if (/^\/_matrix\/client\/(?:v3|r0)\/login$/.test(url.pathname)) return 'matrix-login'
    if (
      /^\/_matrix\/client\/(?:v3|r0)\/(?:join\/[^/]+|rooms\/[^/]+\/join|createRoom)$/.test(
        url.pathname
      ) ||
      /^\/_synapse\/admin\/v1\/join\/[^/]+$/.test(url.pathname)
    )
      return 'local-join'
  }
  if (
    method === 'POST' &&
    url.origin === origins.auth &&
    /^\/.*realms\/[^/]+\/protocol\/openid-connect\/token$/.test(url.pathname)
  )
    return 'core-token'
  if (
    method === 'POST' &&
    url.origin === origins.api &&
    /^\/api\/v1\/(?:owner-claims\/actions\/consume|invitations\/accept|workspace-invites\/redeem)$/.test(
      url.pathname
    )
  )
    return 'local-join'
  if (
    url.origin === origins.api &&
    /^\/api\//.test(url.pathname) &&
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
  )
    return 'core-write'
  return undefined
}

/** Observed SDK attempts invalidate the run immediately; deliberate setup calls reserve before send. */
export function trackRateRequests(
  context: BrowserContext,
  alias: string,
  budget: RateBudget,
  origins: Parameters<typeof classifyRateRequest>[2]
) {
  const listener = (request: Request) => {
    const event = classifyRateRequest(request.url(), request.method(), origins)
    if (event) budget.observeAttempt(alias, event)
  }
  context.on('request', listener)
  return () => context.off('request', listener)
}
