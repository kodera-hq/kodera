// Every scenario overlay answers inside the pinned contract.
//
// Overlays are the one hand-written layer of the mocks (docs/dev/TESTING.md §2), which
// makes them the layer that drifts: bumping the pin regenerates the base handlers, and
// nothing regenerates an overlay. An overlay still answering an enum member the contract
// dropped, or a slug longer than the pattern now allows, keeps every screen and every
// end-to-end spec green against a response the Core API can no longer send.
//
// Each handler is run once, directly (`RequestHandler.run`), with no server, on a request
// for the route it declares, and its answer is judged by `contract-conformance.ts`: the
// route, the status, the media type and the body. Response headers are not judged. A
// handler that answers differently on a later call is judged on its first answer.

import type { HttpHandler } from 'msw'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXAMPLES } from '@/mocks/generated/examples'
import { problem } from '@/mocks/problem'
import { Contract, handlerRoute, runHandler } from './contract-conformance'

interface OverlayModule {
  readonly handlers?: unknown
}

const modules = import.meta.glob<OverlayModule>('../../../src/mocks/overlays/*.ts', {
  eager: true,
})

/** A route that exists to test the overlay mechanism itself, not to stand in for the Core API. */
const MECHANISM_FIXTURE_PATHS: readonly string[] = ['/__scenario-composition-fixture']

/** The ways a scenario leaves the contract on purpose, each recognised by its violation. */
const SIGNATURE = {
  /** A 2xx body the schema refuses: the scenario proves the screen does not trust it. */
  'malformed-body': /^status 2\d\d \/\S* must /,
  /** A `503` from whatever stands in front of the API, which the contract does not describe. */
  unavailable: /^status 503 is not declared /,
  /** The connection failing: `Response.error()` has no status of its own. */
  'network-failure': /^status 0 is not declared /,
  /** One handler standing in for every route at once, so it names none of them. */
  'catch-all': /^not a Core API route$/,
  /** An exact identity-provider handler used by browser acceptance, outside the Core API. */
  'identity-provider': /^not a Core API route$/,
} as const satisfies Record<string, RegExp>

type DeliberateKind = keyof typeof SIGNATURE

interface Exemption {
  readonly overlay: string
  /** The operation the handler answers, or MSW's own header for a catch-all that names none. */
  readonly handler: string
  readonly kind: DeliberateKind
}

/**
 * One entry per deliberately off-contract handler. An exemption covers that handler alone,
 * and only for its own kind of defect: every other handler in the same overlay is judged
 * like any other, and the exempted one fails on a violation of a different kind. An entry
 * whose handler answers inside the contract again, or no longer exists, fails until it is
 * deleted — an exemption nobody needs is one waiting to cover something else.
 */
const DELIBERATE: readonly Exemption[] = [
  {
    overlay: 'home.discovery-malformed',
    handler: 'getOrganisationStatusSummary',
    kind: 'malformed-body',
  },
  { overlay: 'home.fallback-malformed', handler: 'listTenants', kind: 'malformed-body' },
  { overlay: 'home.status-malformed', handler: 'getTenantStatus', kind: 'malformed-body' },
  { overlay: 'status.summary-malformed', handler: 'getTenantStatus', kind: 'malformed-body' },
  { overlay: 'status.tenant-malformed', handler: 'listTenants', kind: 'malformed-body' },
  // 03-people.md §7: creation succeeds with `qr_svg` absent, which the contract marks
  // required — the screen must still give a usable code (acceptance test 12).
  {
    overlay: 'people.enrolment-qr-failed',
    handler: 'createEnrolmentToken',
    kind: 'malformed-body',
  },
  { overlay: 'home.cards-unavailable', handler: 'listSubscriptions', kind: 'unavailable' },
  { overlay: 'home.cards-unavailable', handler: 'listInvoices', kind: 'unavailable' },
  { overlay: 'home.cards-unavailable', handler: 'getHelpContext', kind: 'unavailable' },
  {
    overlay: 'home.discovery-unavailable',
    handler: 'getOrganisationStatusSummary',
    kind: 'unavailable',
  },
  { overlay: 'home.fallback-unavailable', handler: 'listTenants', kind: 'unavailable' },
  { overlay: 'home.invitations-error', handler: 'listInvitations', kind: 'unavailable' },
  { overlay: 'status.components-error', handler: 'listStatusComponents', kind: 'unavailable' },
  { overlay: 'status.subscription-error', handler: 'listSubscriptions', kind: 'unavailable' },
  { overlay: 'status.tenant-error', handler: 'listTenants', kind: 'unavailable' },
  { overlay: 'order.submission-conflict', handler: 'placeOrder', kind: 'network-failure' },
  {
    overlay: 'oidc.current-user-fence',
    handler: 'POST */auth/realms/:realm/protocol/openid-connect/token',
    kind: 'identity-provider',
  },
  { overlay: 'shell.offline', handler: '/.+/ */api/v1/*', kind: 'catch-all' },
  { overlay: 'shell.session-expired', handler: '/.+/ */api/v1/*', kind: 'catch-all' },
]

// What the suite measured when these were set. Each overlay is already refused on its own
// when it exports no handler or a handler declines its request; these catch the rest — a
// glob that stopped matching files, or a request builder every handler declined.
const OVERLAY_COUNT = 90
const ANSWERED_COUNT = 178

const contract = new Contract()

interface Judgement {
  readonly answered: number
  readonly fixtures: readonly string[]
  /** Every failure, each naming the overlay and the operation (or route) it is about. */
  readonly problems: readonly string[]
}

interface HandlerJudgement {
  readonly subject: string
  readonly outcome: 'fixture' | 'unrouted' | 'declined' | 'answered'
  readonly violations: readonly string[]
}

async function judgeHandler(handler: HttpHandler): Promise<HandlerJudgement> {
  const declared = handlerRoute(handler)
  if (declared === undefined) {
    return {
      subject: handler.info.header,
      outcome: 'unrouted',
      violations: ['not a Core API route'],
    }
  }
  if (MECHANISM_FIXTURE_PATHS.includes(declared.path)) {
    return { subject: declared.path, outcome: 'fixture', violations: [] }
  }
  const route = contract.route(declared.method, declared.path)
  if (route === undefined) {
    return {
      subject: handler.info.header,
      outcome: 'unrouted',
      violations: ['the pinned contract has no such route'],
    }
  }
  const response = await runHandler(handler, route.method, contract.url(route, declared.path))
  if (response === undefined) {
    return { subject: route.operationId, outcome: 'declined', violations: [] }
  }
  return {
    subject: route.operationId,
    outcome: 'answered',
    violations: await contract.violations(route, response),
  }
}

async function judgeOverlay(name: string, module: OverlayModule): Promise<Judgement> {
  const { handlers } = module
  if (!Array.isArray(handlers) || handlers.length === 0) {
    return {
      answered: 0,
      fixtures: [],
      problems: [
        `${name}: exports no \`handlers\` array with a handler in it, so nothing is judged`,
      ],
    }
  }
  const exemptions = DELIBERATE.filter((exemption) => exemption.overlay === name)
  const used = new Set<Exemption>()
  const problems: string[] = []
  const fixtures: string[] = []
  let answered = 0

  for (const handler of handlers as HttpHandler[]) {
    const { subject, outcome, violations } = await judgeHandler(handler)
    const at = `${name} › ${subject}`
    if (outcome === 'fixture') {
      fixtures.push(subject)
      continue
    }
    if (outcome === 'declined') {
      problems.push(`${at}: answered nothing to the request it was sent, so nothing was judged`)
      continue
    }
    if (outcome === 'answered') answered += 1

    const exemption = exemptions.find((candidate) => candidate.handler === subject)
    if (exemption === undefined) {
      problems.push(...violations.map((violation) => `${at}: ${violation}`))
      continue
    }
    used.add(exemption)
    const signature = SIGNATURE[exemption.kind]
    problems.push(
      ...violations
        .filter((violation) => !signature.test(violation))
        .map((violation) => `${at}: ${violation}`)
    )
    if (!violations.some((violation) => signature.test(violation))) {
      problems.push(
        `${at}: exempted as deliberately ${exemption.kind}, and answers nothing of the kind`
      )
    }
  }

  for (const exemption of exemptions) {
    if (!used.has(exemption)) {
      problems.push(
        `${name} › ${exemption.handler}: exempted as deliberately ${exemption.kind}, and no handler answers it`
      )
    }
  }
  return { answered, fixtures, problems }
}

const overlays = Object.entries(modules)
  .filter(([path]) => !path.endsWith('/index-glob.ts'))
  .map(
    ([path, module]) => [path.replace(/^.*\/overlays\//, '').replace(/\.ts$/, ''), module] as const
  )

function overlayModule(name: string): OverlayModule {
  const found = overlays.find(([candidate]) => candidate === name)
  if (found === undefined) throw new Error(`no overlay named ${name}`)
  return found[1]
}

// The demo overlay resolves the identity provider's URL from configuration when it answers.
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.test/api/v1')
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://keycloak.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('scenario overlays', () => {
  const judgements = new Map<string, Judgement>()

  it.each(overlays)('%s answers inside the pinned contract', async (name, module) => {
    const judgement = await judgeOverlay(name, module)
    judgements.set(name, judgement)
    expect(judgement.problems).toEqual([])
  })

  it('were all found and actually exercised', () => {
    expect(judgements.size).toBe(overlays.length)
    expect(overlays.length).toBeGreaterThanOrEqual(OVERLAY_COUNT)
    const answered = [...judgements.values()].reduce((sum, j) => sum + j.answered, 0)
    expect(answered).toBeGreaterThanOrEqual(ANSWERED_COUNT)
    // An allowlisted fixture path nothing declares any more is an exemption waiting to
    // cover a real route.
    const fixtures = new Set([...judgements.values()].flatMap((j) => j.fixtures))
    expect([...fixtures].sort()).toEqual([...MECHANISM_FIXTURE_PATHS].sort())
    // An exemption for an overlay that was renamed or deleted is never checked above.
    const names = new Set(overlays.map(([name]) => name))
    expect(DELIBERATE.filter((exemption) => !names.has(exemption.overlay))).toEqual([])
  })
})

describe('the gate refuses to pass without judging', () => {
  it('refuses an overlay whose handlers export was renamed', async () => {
    const { problems } = await judgeOverlay('home.default', { handlerList: [] } as OverlayModule)
    expect(problems).toEqual([
      'home.default: exports no `handlers` array with a handler in it, so nothing is judged',
    ])
  })

  it('refuses a handler that declines the request it is sent', async () => {
    const onlyWithCursor = http.get(
      '*/api/v1/organisations/:organisation_id/invoices',
      ({ request }) =>
        new URL(request.url).searchParams.has('cursor')
          ? HttpResponse.json({ data: 'not a page' })
          : undefined
    )
    const { problems } = await judgeOverlay('invoices.overdue', { handlers: [onlyWithCursor] })
    expect(problems).toEqual([
      'invoices.overdue › listInvoices: answered nothing to the request it was sent, so nothing was judged',
    ])
  })

  it('judges a handler an exemption does not name, inside an exempted overlay', async () => {
    const real = overlayModule('home.cards-unavailable').handlers as HttpHandler[]
    const wrongDunning = http.get('*/api/v1/organisations/:organisation_id/dunning', () =>
      HttpResponse.json({ state: 'not-a-dunning-state' })
    )
    const { problems } = await judgeOverlay('home.cards-unavailable', {
      handlers: [...real, wrongDunning],
    })
    expect(problems.length).toBeGreaterThan(0)
    expect(
      problems.filter((p) => !p.startsWith('home.cards-unavailable › getDunning: status 200 /'))
    ).toEqual([])
  })

  it('holds an exemption to its own kind of defect', async () => {
    const malformedInvoices = http.get('*/api/v1/organisations/:organisation_id/invoices', () =>
      HttpResponse.json({ data: 'not a page' })
    )
    const { problems } = await judgeOverlay('home.cards-unavailable', {
      handlers: [malformedInvoices],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^home\.cards-unavailable › listInvoices: status 200 \//),
        'home.cards-unavailable › listInvoices: exempted as deliberately unavailable, and answers nothing of the kind',
        'home.cards-unavailable › listSubscriptions: exempted as deliberately unavailable, and no handler answers it',
        'home.cards-unavailable › getHelpContext: exempted as deliberately unavailable, and no handler answers it',
      ])
    )
  })
})

describe('the conformance check', () => {
  const invitationsRoute = '*/api/v1/organisations/:organisation_id/invitations'
  const organisationRoute = '*/api/v1/organisations/:organisation_id'
  const judge = (handlers: HttpHandler[]) => judgeOverlay('synthetic', { handlers })

  it('accepts every response the contract itself exemplifies', async () => {
    // The control: a check that refused everything would pass every refusal below.
    const handlers = Object.values(EXAMPLES).map((example) =>
      http[example.method](`*/api/v1${example.path.replace(/\{([^{}]+)\}/g, ':$1')}`, () =>
        example.body === null
          ? new HttpResponse(null, { status: example.status })
          : 'Content-Type' in example.headers &&
              example.headers['Content-Type'] === 'text/plain' &&
              typeof example.body === 'string'
            ? HttpResponse.text(example.body, { status: example.status })
            : HttpResponse.json(example.body, { status: example.status })
      )
    )
    const judgement = await judge(handlers)
    expect(judgement.problems).toEqual([])
    expect(judgement.answered).toBe(contract.operationCount)
  })

  it('refuses a document using a format it cannot validate', () => {
    const document = [
      'openapi: 3.1.0',
      'info: { title: t, version: 1.0.0 }',
      'paths: {}',
      'components:',
      '  schemas:',
      '    Host: { type: string, format: hostname }',
    ].join('\n')
    expect(() => new Contract(document)).toThrow(
      'The contract uses format hostname, which this check does not validate.'
    )
  })

  it('refuses an invitation role the contract no longer admits', async () => {
    const body = structuredClone(EXAMPLES.listInvitations.body) as {
      data: Record<string, unknown>[]
    }
    body.data[0] = { ...body.data[0], role: 'org_owner' }
    const { problems } = await judge([http.get(invitationsRoute, () => HttpResponse.json(body))])
    expect(problems).toEqual([
      'synthetic › listInvitations: status 200 /data/0/role must be equal to one of the allowed values ["org_admin","org_billing","org_member"]',
    ])
  })

  it('refuses an organisation slug longer than the pattern allows', async () => {
    const body = { ...(EXAMPLES.getOrganisation.body as object), slug: 'a'.repeat(21) }
    const { problems } = await judge([http.get(organisationRoute, () => HttpResponse.json(body))])
    expect(problems).toEqual([
      expect.stringMatching(/^synthetic › getOrganisation: status 200 \/slug must match pattern /),
    ])
  })

  it('refuses a required field left out', async () => {
    const { slug: _slug, ...body } = EXAMPLES.getOrganisation.body as Record<string, unknown>
    const { problems } = await judge([http.get(organisationRoute, () => HttpResponse.json(body))])
    expect(problems).toEqual([
      "synthetic › getOrganisation: status 200 / must have required property 'slug'",
    ])
  })

  it('refuses a status the operation does not declare', async () => {
    const { problems } = await judge([
      http.get('*/api/v1/me', () => problem('https://kodera.io/problems/not-found')),
    ])
    expect(problems).toEqual([
      expect.stringMatching(/^synthetic › getMe: status 404 is not declared \(declared: 200, /),
    ])
  })

  it('refuses a problem type the registry does not contain', async () => {
    const valid = (await problem('https://kodera.io/problems/forbidden').json()) as object
    const { problems } = await judge([
      http.get(invitationsRoute, () =>
        HttpResponse.json(
          { ...valid, type: 'https://kodera.io/problems/invented' },
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } }
        )
      ),
    ])
    expect(problems).toEqual([
      expect.stringMatching(
        /^synthetic › listInvitations: status 403 \/type must be equal to one of the allowed values /
      ),
    ])
  })

  it('refuses a problem sent as plain JSON', async () => {
    const valid = (await problem('https://kodera.io/problems/forbidden').json()) as object
    const { problems } = await judge([
      http.get(invitationsRoute, () => HttpResponse.json(valid, { status: 403 })),
    ])
    expect(problems).toEqual([
      'synthetic › listInvitations: status 403 is application/json; the contract declares application/problem+json',
    ])
  })

  it('refuses a route the contract does not have', async () => {
    const { problems } = await judge([
      http.get('*/api/v1/organisations/:organisation_id/members', () => HttpResponse.json({})),
    ])
    expect(problems).toEqual([
      'synthetic › GET */api/v1/organisations/:organisation_id/members: the pinned contract has no such route',
    ])
  })
})

describe('the canonical instant-claim demo refusal', () => {
  const path = '*/api/v1/workspaces/instant-claim'
  const judge = (handler: HttpHandler) =>
    judgeOverlay('demo.groupe-vercelli', { handlers: [handler] })
  it('executes and admits only the exact local-preview refusal', async () => {
    const resolver = vi.fn(() => HttpResponse.json({ code: 'local-preview-only' }, { status: 503 }))
    const result = await judge(http.post(path, resolver))
    expect(resolver).toHaveBeenCalledOnce()
    expect(result.problems).toEqual([])
    expect(result.answered).toBe(1)
  })
  it.each([200, 201, 403])('refuses a JSON preview refusal with status %s', async (status) => {
    const result = await judge(
      http.post(path, () => HttpResponse.json({ code: 'local-preview-only' }, { status }))
    )
    expect(result.problems.length).toBeGreaterThan(0)
  })
  it('refuses a fabricated allocation or additional response field', async () => {
    const result = await judge(
      http.post(path, () =>
        HttpResponse.json({ code: 'local-preview-only', workspaceId: 'invented' }, { status: 503 })
      )
    )
    expect(result.problems.length).toBeGreaterThan(0)
  })
  it('refuses a handler that never answers', async () => {
    const result = await judge(http.post(path, () => undefined))
    expect(result.problems).toEqual([expect.stringContaining('answered nothing')])
  })
  it('judges any overlay against the canonical route and refuses undeclared methods and paths', async () => {
    const answer = () => HttpResponse.json({ code: 'local-preview-only' }, { status: 503 })
    expect(
      (await judgeOverlay('synthetic', { handlers: [http.post(path, answer)] })).problems
    ).toEqual([])
    for (const result of [
      await judge(http.get(path, answer)),
      await judge(http.post('*/api/v1/workspaces/unknown-claim', answer)),
    ])
      expect(result.problems).toEqual([
        expect.stringContaining('the pinned contract has no such route'),
      ])
  })
})
