// Placing the order where the first-owner journey is built in (`VITE_FIRST_OWNER_JOURNEY`):
// what the request carries, which retries keep the key, and what each refusal tells the person.
// The held behaviour, the default, is `AgreementsStep.test.tsx`.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { EXAMPLES } from '@/mocks/generated/examples'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { emptyDraft } from './draft'
import type { OrderDraft } from './draft'

const BASE = 'https://core.test/api/v1'
const ORDERS = `${BASE}/organisations/org-1/orders`
const problemType = (suffix: string) => `https://kodera.io/problems/${suffix}`

const CONTACTS: OrderDraft['contacts'] = {
  legalName: 'ACME Construction',
  slug: 'acme',
  registrationNumber: '830485108',
  vatNumber: '',
  addressLine1: '12 rue des Lilas',
  postalCode: '75011',
  city: 'Paris',
  country: 'FR',
  billingReference: '',
  adminEmail: 'marie.dupont@acme.fr',
  billingEmail: 'compta@acme.fr',
  securityEmail: 'dpo@acme.fr',
}

interface Sent {
  key: string | null
  body: {
    legal_acceptances: { code: string; version: string; locale: string }[]
    dpa_acceptance: { dpa_id: string; accepted: boolean }
    plan_code?: string | null
  }
}
let sent: Sent[] = []
let answers: (() => Response)[] = []
let documentReads = 0
let dpaGenerations = 0
let liveOrders: object[] = []
let ordersFail = false
let ordersHaveMore = false

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  vi.stubEnv('VITE_FIRST_OWNER_JOURNEY', '1')
  vi.resetModules()
  sent = []
  answers = []
  documentReads = 0
  dpaGenerations = 0
  liveOrders = []
  ordersFail = false
  ordersHaveMore = false
  // Listed first so they observe before the catalogue overlay answers; returning nothing passes on.
  server.use(
    http.get(`${BASE}/organisations/:organisation_id/orders`, () =>
      ordersFail
        ? refusal('internal-error', 500)()
        : HttpResponse.json({
            data: liveOrders,
            next_cursor: ordersHaveMore ? 'next' : null,
            has_more: ordersHaveMore,
          })
    ),
    http.get(`${BASE}/legal-documents`, () => {
      documentReads += 1
      return undefined
    }),
    http.post(`${BASE}/organisations/:organisation_id/dpa`, () => {
      dpaGenerations += 1
      // Each generation is a distinct DPA, as after a template change.
      const dpa = { ...(EXAMPLES.generateDpa.body as object), id: `dpa-${dpaGenerations}` }
      return HttpResponse.json(dpa, { status: 201 })
    }),
    http.post(ORDERS, async ({ request }) => {
      sent.push({
        key: request.headers.get('Idempotency-Key'),
        body: (await request.json()) as Sent['body'],
      })
      const answer = answers.shift()
      return answer ? answer() : HttpResponse.json(EXAMPLES.placeOrder.body, { status: 201 })
    }),
    ...catalogueHandlers
  )
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const refusal =
  (suffix: string, status: number, errors: object[] = []) =>
  () =>
    HttpResponse.json(
      { type: problemType(suffix), title: 'Synthetic', status, errors },
      { status, headers: { 'Content-Type': 'application/problem+json' } }
    )

async function renderStep(draftId?: string) {
  // Imported after the flag is set: the hold is decided when the module loads.
  const { AgreementsStep } = await import('./AgreementsStep')
  const onSubmitted = vi.fn()
  function Harness() {
    return (
      <AgreementsStep
        draft={{
          ...emptyDraft(),
          ...(draftId === undefined ? {} : { draftId }),
          packCode: 'visio-docs',
          capacityTierCode: 'M',
          contacts: CONTACTS,
        }}
        organisationId="org-1"
        signatoryName="Marie Dupont"
        signatoryEmail="marie.dupont@acme.fr"
        onSubmitted={onSubmitted}
        onBack={vi.fn()}
      />
    )
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: /ACME Construction/ }))
  const submit = async () =>
    user.click(screen.getByRole('button', { name: 'Signer et recevoir la facture' }))
  return { client, onSubmitted, submit, user }
}

describe('placing the order', () => {
  it('sends the DPA acceptance and the exact versions shown, then reports the order', async () => {
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(onSubmitted).toHaveBeenCalledWith(
      (EXAMPLES.placeOrder.body as { order: { id: string } }).order.id
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.key).toMatch(/^[!-~]{16,255}$/)
    expect(sent[0]!.body.dpa_acceptance).toMatchObject({ accepted: true })
    // The plan the card and the summary showed, from the catalogue's price row for this pack,
    // tier and period: not left for Core to pick.
    expect(sent[0]!.body.plan_code).toBe('business')
    expect(sent[0]!.body.legal_acceptances).toEqual([
      { code: 'cgv', locale: 'fr', version: '2.1' },
      { code: 'sla', locale: 'fr', version: '1.2' },
      { code: 'aup', locale: 'fr', version: '1.0' },
    ])
  })

  it('names the plan of the exact row the order is priced at', async () => {
    const row = (pack: string, period: string, plan: string, n: number) => ({
      id: `00000000-0000-4000-8000-00000000009${n}`,
      plan_code: plan,
      plan_version: 1,
      pack_code: pack,
      capacity_tier_code: 'M',
      billing_period: period,
      amount_excl_vat: { amount_minor: 483_600, currency: 'EUR' },
      valid_from: '2026-01-01T00:00:00Z',
    })
    server.use(
      http.get(`${BASE}/catalog/prices`, ({ request }) => {
        const url = new URL(request.url)
        const rows = [
          row('visio', 'yearly', 'not-this-pack', 1),
          row('visio-docs', 'monthly', 'not-this-period', 2),
          row('visio-docs', 'yearly', 'business-docs-yearly', 3),
        ].filter(
          (candidate) =>
            candidate.pack_code === url.searchParams.get('pack_code') &&
            candidate.billing_period === url.searchParams.get('billing_period')
        )
        return HttpResponse.json({ data: rows, next_cursor: null, has_more: false })
      })
    )
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent[0]!.body.plan_code).toBe('business-docs-yearly')
  })

  it('places no order without the price row it would be placed at', async () => {
    server.use(
      http.get(`${BASE}/catalog/prices`, () =>
        HttpResponse.json({ data: [], next_cursor: null, has_more: false })
      )
    )
    const { onSubmitted, submit } = await renderStep()
    await submit()
    expect(await screen.findAllByText(/Le service est momentanément indisponible/)).not.toEqual([])
    expect(sent).toEqual([])
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('retries an unknown outcome with exactly the request it sent, under the same key', async () => {
    answers.push(refusal('internal-error', 500))
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Une opération n'a pas abouti/)
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  it('keeps the key while the same request is still running', async () => {
    answers.push(refusal('idempotency-key-in-flight', 409))
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Une opération n'a pas abouti/)
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent[1]).toEqual(sent[0])
  })

  it('asks for acceptance again when a version is no longer in force, then sends a new request', async () => {
    answers.push(
      refusal('validation-error', 422, [
        { pointer: '/legal_acceptances', code: 'cgv_not_in_force' },
      ])
    )
    const { onSubmitted, submit, user } = await renderStep()
    const readsBefore = documentReads
    await submit()
    await screen.findByText(/Une nouvelle version d'un document a été publiée/)
    await vi.waitFor(() => expect(documentReads).toBeGreaterThan(readsBefore))
    const checkbox = screen.getByRole('checkbox', { name: /ACME Construction/ })
    expect(checkbox).not.toBeChecked()
    await submit()
    expect(sent).toHaveLength(1)
    await user.click(checkbox)
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent[1]!.key).not.toBe(sent[0]!.key)
  })

  it('says another order is awaiting payment, and places no other, on order-in-progress', async () => {
    answers.push(() => {
      // Another tab or owner ordered first: the organisation's order list now shows it.
      liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'awaiting_payment' }]
      return refusal('order-in-progress', 409)()
    })
    const { onSubmitted, submit } = await renderStep('order-in-progress')
    await submit()
    expect(
      await screen.findByText(
        'Une commande existe déjà pour cette organisation. Contactez-nous à support@kodera.io.'
      )
    ).toBeVisible()
    // Nothing was placed, so nothing is held: the refused key is dropped, and the page stops
    // only because it read the order in flight. Once that order is settled, a new one may go.
    const { orderSubmission } = await import('./submission')
    expect(orderSubmission('order-in-progress')).toMatchObject({ key: undefined, body: undefined })
    expect(orderSubmission('order-in-progress').unresolved).not.toBe(true)
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    )
    await submit()
    expect(sent).toHaveLength(1)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('generates the DPA again when the one accepted is refused, and asks for acceptance again', async () => {
    answers.push(
      refusal('validation-error', 422, [
        { pointer: '/dpa_acceptance/dpa_id', code: 'dpa_not_in_force' },
      ])
    )
    const { onSubmitted, submit, user } = await renderStep()
    expect(dpaGenerations).toBe(1)
    await submit()
    await screen.findByText(/Le contrat de sous-traitance a été mis à jour/)
    await vi.waitFor(() => expect(dpaGenerations).toBe(2))
    const checkbox = screen.getByRole('checkbox', { name: /ACME Construction/ })
    await vi.waitFor(() => expect(checkbox).not.toBeChecked())
    await user.click(checkbox)
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent[0]!.body.dpa_acceptance.dpa_id).toBe('dpa-1')
    expect(sent[1]!.body.dpa_acceptance.dpa_id).toBe('dpa-2')
  })

  it.each([
    ['the key was used for another request', refusal('idempotency-key-reuse', 409)],
    [
      'the DPA is already accepted',
      refusal('validation-error', 422, [
        { pointer: '/dpa_acceptance/dpa_id', code: 'dpa_already_accepted' },
      ]),
    ],
  ])('sends nothing more when %s: an order may already exist', async (_, answer) => {
    answers.push(answer)
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Une commande pourrait déjà avoir été envoyée/)
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    await submit()
    expect(sent).toHaveLength(1)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('places no order when the organisation already has one, and says so plainly', async () => {
    liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'awaiting_payment' }]
    const { onSubmitted, submit } = await renderStep()
    await screen.findByText(
      'Une commande existe déjà pour cette organisation. Contactez-nous à support@kodera.io.'
    )
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    await submit()
    expect(sent).toEqual([])
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('does not count a cancelled order', async () => {
    liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'cancelled' }]
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent).toHaveLength(1)
  })

  it('sends nothing while it cannot tell whether an order exists', async () => {
    ordersFail = true
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/indisponible|momentanément/i)
    expect(sent).toEqual([])
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('still retries the exact request once its own order shows up', async () => {
    answers.push(refusal('internal-error', 500))
    const { client, onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Une opération n'a pas abouti/)
    // The first attempt committed after all: the organisation now has that order.
    liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'placed' }]
    await client.refetchQueries({ queryKey: ['order', 'live-order'] })
    await submit()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(sent[1]).toEqual(sent[0])
  })

  it('stops when the slug is taken and the organisation now has an order', async () => {
    answers.push(() => {
      liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'placed' }]
      return refusal('slug-taken', 409)()
    })
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Une commande pourrait déjà avoir été envoyée/)
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    expect(sent).toHaveLength(1)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('lets the person choose another slug when someone else took it', async () => {
    answers.push(refusal('slug-taken', 409))
    const { onSubmitted, submit } = await renderStep()
    await submit()
    await screen.findByText(/Cette adresse vient d'être prise/)
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeEnabled()
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('places no order, and claims none, when the first page of orders does not settle it', async () => {
    liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'cancelled' }]
    ordersHaveMore = true
    const { onSubmitted, submit } = await renderStep()
    await screen.findByText(/Une commande pourrait déjà avoir été envoyée/)
    expect(screen.queryByText(/Une commande existe déjà/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    await submit()
    expect(sent).toEqual([])
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('reads the orders again just before ordering, as another tab may have ordered', async () => {
    const { onSubmitted, submit } = await renderStep()
    // Mounted with no order; another tab places one before this one submits.
    liveOrders = [{ ...(EXAMPLES.getOrder.body as object), state: 'placed' }]
    await submit()
    await screen.findByText(/Une commande existe déjà pour cette organisation/)
    expect(sent).toEqual([])
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('keeps the acceptance a pending retry carries, ticked and locked', async () => {
    answers.push(refusal('internal-error', 500))
    const { submit } = await renderStep()
    await submit()
    await screen.findByText(/Une opération n'a pas abouti/)
    const checkbox = screen.getByRole('checkbox', { name: /ACME Construction/ })
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeDisabled()
  })
})
