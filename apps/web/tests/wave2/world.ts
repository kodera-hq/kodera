import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { APIResponse, Browser, BrowserContext, Page, Request } from '@playwright/test'
import { throughKeycloak } from './keycloak'
import { enterOrganisation } from './login'
import { enterWorkspace } from './workspace'
import { finishCleanup } from './cleanup'
import type { Account } from './keycloak'
import { NetworkLedger, recordNetwork } from './oracles/r1-network'
import type { NetworkTemplate } from './oracles/r1-network'
import { RateBudget, classifyRateRequest, trackRateRequests } from './oracles/r3-rate-budget'
import { openTargetGate, validateReceipt } from './oracles/r4-sanitizer'
import { exactOrigin, guard, object } from './oracles/shared'
import { assertLocalFont } from './oracles/r6-visual-a11y'
import { fixturePath } from './surfaces'

export interface ActorInput {
  account: Account
  organisation: string
  organisationId: string
  realm: string
  role: 'org_owner' | 'org_member'
  seedJoins: number
  /** Exact permitted background responses, including separately named refusal cases. */
  network: NetworkTemplate[]
}
export interface Wave2Input {
  revision: string
  realm: string
  livekitOrigin?: string
  homeserverOrigin: string
  actors: { A: ActorInput; B: ActorInput; C: ActorInput }
  mailpitOrigin: string
  workspaceReady: string
  channelPath: string
  composer: string
  documentId: string
  documentTitle: string
  docsButton: string
  editor: string
  telemetry: {
    captureKey: string
    personId: string
    workspaceId: string
    settingsButton: string
    privacyButton: string
  }
  visual: {
    webPath: string
    sansSelector: string
    monoSelector: string
    tokenSelector: string
    languageButton: string
    languageSection?: string
    languageClose?: string
    languageOptions: { fr: string; en: string }
    tabOrder: readonly string[] | Record<375 | 768 | 1440, readonly string[]>
    landingSansSelector: string
    landingMonoSelector: string
    landingTokenSelector: string
    clockEpochMs: number
  }
}

/** Only an explicitly named JSON fixture under this web workspace may be opened. No dotenv loader. */
export function readWave2Input(profile: 'PERSONA1' | 'PERSONA2' | 'PERSONA4' | 'R5'): Wave2Input {
  const rawPath = env[`KODERA_WAVE2_${profile}_INPUT`] ?? env['KODERA_WAVE2_INPUT']
  guard(
    rawPath &&
      rawPath.endsWith('.json') &&
      !rawPath.split(/[\\/]/).some((part) => part.startsWith('.env')),
    'WAVE2_INPUT_REQUIRED'
  )
  const webRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
  const path = realpathSync(resolve(rawPath))
  const inside = relative(webRoot, path)
  guard(
    inside &&
      !inside.startsWith('..') &&
      !isAbsolute(inside) &&
      path.endsWith('.json') &&
      !inside.split(/[\\/]/).some((part) => part.startsWith('.env')),
    'WAVE2_INPUT_BOUNDARY'
  )
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'))
  guard(
    object(input) &&
      object(input.actors) &&
      typeof input.revision === 'string' &&
      /^[a-f0-9]{40}$/.test(input.revision) &&
      typeof input.realm === 'string',
    'WAVE2_INPUT_SHAPE'
  )
  for (const alias of ['A', 'B', 'C']) {
    const actor = input.actors[alias]
    guard(
      object(actor) &&
        object(actor.account) &&
        typeof actor.organisation === 'string' &&
        typeof actor.organisationId === 'string' &&
        Array.isArray(actor.network) &&
        typeof actor.realm === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(actor.realm) &&
        Number.isInteger(actor.seedJoins) &&
        Number(actor.seedJoins) >= 0,
      'WAVE2_ACTOR_SHAPE'
    )
    for (const field of ['email', 'username', 'password', 'totpBase32'])
      guard(
        typeof actor.account[field] === 'string' && actor.account[field] !== '',
        'WAVE2_ACCOUNT_REQUIRED'
      )
    guard(/@[^@]+\.test$/.test(String(actor.account.email)), 'WAVE2_SYNTHETIC_IDENTITY')
  }
  const result = input as unknown as Wave2Input
  guard(
    result.actors.A.role === 'org_owner' &&
      result.actors.B.role === 'org_member' &&
      result.actors.C.role === 'org_member' &&
      result.actors.A.organisationId === result.actors.B.organisationId &&
      result.actors.C.organisationId !== result.actors.A.organisationId &&
      result.realm === result.actors.A.realm &&
      result.actors.A.realm === result.actors.B.realm &&
      result.actors.C.realm !== result.actors.A.realm,
    'WAVE2_ROLE_FIXTURE'
  )
  return result
}

const claimedIdentities = new Set<string>()

export function targets() {
  const result = {
    web: env['KODERA_WAVE2_WEB_ORIGIN'] ?? 'https://web.example.test',
    landing: env['KODERA_WAVE2_LANDING_ORIGIN'] ?? 'https://landing.example.test',
    auth: env['KODERA_WAVE2_AUTH_ORIGIN'] ?? 'https://auth.example.test',
    api: env['KODERA_WAVE2_API_ORIGIN'] ?? 'https://api.example.test',
  }
  Object.values(result).forEach(exactOrigin)
  return result
}

export class Actor {
  private bearer: string | undefined
  private matrixBearer: string | undefined
  private readonly authorityListener: (request: Request) => void
  private readonly detachRates: () => unknown
  private constructor(
    readonly alias: 'A' | 'B' | 'C',
    readonly input: ActorInput,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly budget: RateBudget,
    readonly ledger: NetworkLedger,
    private readonly recorder: Awaited<ReturnType<typeof recordNetwork>>,
    private readonly origins: ReturnType<typeof targets>,
    private readonly homeserver: string
  ) {
    this.authorityListener = (request) => {
      if (request.resourceType() === 'font') {
        try {
          assertLocalFont(request.url(), new URL(request.frame().url()).origin)
        } catch {
          ledger.fail('R6_THIRD_PARTY_FONT')
        }
      }
      if (new URL(request.url()).origin === origins.api) {
        const authority = request.headers().authorization
        if (authority?.startsWith('Bearer ')) this.bearer = authority
      }
      if (new URL(request.url()).origin === homeserver) {
        const authority = request.headers().authorization
        if (authority?.startsWith('Bearer ')) this.matrixBearer = authority
      }
    }
    context.on('request', this.authorityListener)
    this.detachRates = trackRateRequests(context, alias, budget, {
      auth: origins.auth,
      api: origins.api,
      homeserver,
    })
  }
  static async create(
    browser: Browser,
    alias: 'A' | 'B' | 'C',
    input: Wave2Input,
    budget: RateBudget,
    instrumentation: {
      beforePage?: (context: BrowserContext) => Promise<void>
      extraOrigins?: string[]
      allowedRequestFailure?: (request: Request) => boolean
    } = {}
  ) {
    const origins = targets()
    const actorInput = input.actors[alias]
    const identity = JSON.stringify([actorInput.realm, actorInput.account.username])
    guard(!claimedIdentities.has(identity), 'WAVE2_REUSED_IDENTITY')
    claimedIdentities.add(identity)
    const context = await browser.newContext({
      baseURL: origins.web,
      locale: 'fr-FR',
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 900 },
    })
    try {
      budget.register(alias)
      if (actorInput.seedJoins) budget.reserve(alias, 'local-join', actorInput.seedJoins)
      const allowed = [
        ...Object.values(origins),
        exactOrigin(input.homeserverOrigin),
        ...(input.livekitOrigin ? [exactOrigin(input.livekitOrigin)] : []),
        ...(instrumentation.extraOrigins ?? []),
      ]
      const ledger = new NetworkLedger(actorInput.network, allowed)
      const recorder = await recordNetwork(context, ledger, instrumentation.allowedRequestFailure)
      if (instrumentation.beforePage) await instrumentation.beforePage(context)
      const page = await context.newPage()
      budget.retainPage(alias, page)
      return new Actor(
        alias,
        actorInput,
        context,
        page,
        budget,
        ledger,
        recorder,
        origins,
        input.homeserverOrigin
      )
    } catch (error) {
      await context.close().catch(() => {})
      throw error
    }
  }
  async signIn() {
    const me = this.page.waitForResponse(
      (response) =>
        response.url() === `${this.origins.api}/api/v1/me` && response.request().method() === 'GET'
    )
    const discovered = this.page.waitForResponse(async (response) => {
      if (
        response.url() !== `${this.origins.api}/api/v1/auth/discover` ||
        response.request().method() !== 'POST' ||
        response.status() !== 200
      )
        return false
      const body: unknown = await response.json()
      return object(body) && typeof body.realm === 'string'
    })
    await this.page.goto(`/login?org=${encodeURIComponent(this.input.organisation)}&mode=tenant`)
    await enterOrganisation(this.page, this.input.account.email, this.input.organisation)
    const discovery: unknown = await (await discovered).json()
    guard(
      object(discovery) &&
        discovery.realm === this.input.realm &&
        discovery.issuer === `${this.origins.auth}/realms/${this.input.realm}`,
      'R4_REALM'
    )
    await throughKeycloak(this.page, this.input.account)
    const response = await me
    guard(response.status() === 200, 'WAVE2_ME_STATUS')
    this.assertMembership(await response.json())
    this.budget.rememberState(this.alias, await this.context.storageState())
  }
  assertMembership(me: unknown) {
    guard(object(me) && Array.isArray(me.organisations), 'WAVE2_ME_SHAPE')
    guard(
      me.organisations.some(
        (membership: unknown) =>
          object(membership) &&
          membership.role === this.input.role &&
          membership.state === 'active' &&
          object(membership.organisation) &&
          membership.organisation.slug === this.input.organisation &&
          membership.organisation.id === this.input.organisationId
      ),
      'WAVE2_MEMBERSHIP'
    )
    if (this.alias === 'C')
      guard(
        me.organisations.every(
          (membership: unknown) =>
            object(membership) &&
            object(membership.organisation) &&
            membership.organisation.id === this.input.organisationId
        ),
        'WAVE2_OUTSIDER_ISOLATION'
      )
  }
  async workspace(selector: string, channelPath?: string) {
    this.budget.reusePage(this.alias, this.page)
    await enterWorkspace(this.page, this.input.organisation, selector, channelPath)
    await expect(this.page.locator(selector)).toBeVisible()
  }
  async core(
    pathPattern: string,
    values: Record<string, string>,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
    expectedStatus = 200
  ): Promise<APIResponse> {
    guard(this.bearer, 'WAVE2_CURRENT_AUTHORITY_REQUIRED')
    guard(
      !Object.keys(headers).some((name) =>
        ['authorization', 'cookie', 'host', 'origin'].includes(name.toLowerCase())
      ),
      'WAVE2_AUTHORITY_OVERRIDE'
    )
    const pathname = fixturePath(pathPattern, values)
    guard(pathname.startsWith('/api/v1/'), 'WAVE2_CORE_PATH')
    const event = classifyRateRequest(`${this.origins.api}${pathname}`, method, {
      homeserver: this.homeserver,
      auth: this.origins.auth,
      api: this.origins.api,
    })
    if (event) this.budget.reserve(this.alias, event)
    const response = await this.context.request.fetch(`${this.origins.api}${pathname}`, {
      method,
      headers: { authorization: this.bearer, ...headers },
      data,
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    let body: unknown
    let jsonValid = true
    const text = await response.text()
    try {
      body = JSON.parse(text)
    } catch {
      jsonValid = false
    }
    // Request-context traffic is not emitted by browser-context event listeners: meter it explicitly.
    this.ledger.observe({
      url: response.url(),
      method,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      bodyPrefix: text.slice(0, 128),
      body,
      jsonValid,
    })
    guard(response.status() === expectedStatus, 'WAVE2_PROTOCOL_STATUS')
    return response
  }
  async assertClean() {
    await this.recorder.assertClean()
    this.budget.assertClean()
  }
  async denyForeignJoin(homeserver: string, roomId: string) {
    guard(this.matrixBearer, 'WAVE2_MATRIX_AUTHORITY_REQUIRED')
    this.budget.reserve(this.alias, 'local-join')
    const response = await this.context.request.post(
      `${exactOrigin(homeserver)}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {
        headers: { authorization: this.matrixBearer },
        data: {},
        maxRedirects: 0,
        failOnStatusCode: false,
      }
    )
    const body: unknown = await response.json()
    this.ledger.observe({
      url: response.url(),
      method: 'POST',
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      body,
    })
    guard(
      response.status() === 403 && object(body) && body.errcode === 'M_FORBIDDEN',
      'WAVE2_MATRIX_FOREIGN_JOIN'
    )
  }
  async close() {
    this.bearer = undefined
    this.matrixBearer = undefined
    this.detachRates()
    this.context.off('request', this.authorityListener)
    await finishCleanup(
      true,
      [() => this.recorder.dispose(), () => this.context.close()],
      'WAVE2_CLEANUP'
    )
  }
}

export async function gateWorld(browser: Browser, input: Wave2Input) {
  const origin = targets()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  let succeeded = false
  try {
    const result = await openTargetGate(context.request, {
      webOrigin: origin.web,
      apiOrigin: origin.api,
      authOrigin: origin.auth,
      realm: input.realm,
      webRevision: input.revision,
    })
    succeeded = true
    return result
  } finally {
    await finishCleanup(succeeded, [() => context.close()], 'WAVE2_CLEANUP')
  }
}

export async function withActors(
  browser: Browser,
  input: Wave2Input,
  aliases: ('A' | 'B' | 'C')[],
  run: (actors: Partial<Record<'A' | 'B' | 'C', Actor>>, budget: RateBudget) => Promise<void>
) {
  await gateWorld(browser, input)
  const budget = new RateBudget()
  const actors: Partial<Record<'A' | 'B' | 'C', Actor>> = {}
  let succeeded = false
  try {
    for (const alias of aliases) actors[alias] = await Actor.create(browser, alias, input, budget)
    await run(actors, budget)
    for (const actor of Object.values(actors)) await actor.assertClean()
    validateReceipt(
      { rateBudget: budget.receipt(), result: 'protocol-assertions-complete' },
      Object.values(input.actors).flatMap((actor) => [
        actor.account.password,
        actor.account.totpBase32,
      ])
    )
    succeeded = true
  } finally {
    await finishCleanup(
      succeeded,
      Object.values(actors).map((actor) => () => actor.close()),
      'WAVE2_CLEANUP'
    )
    budget.clear()
  }
}
