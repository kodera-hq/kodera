import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { handlers as unavailableHandlers } from '@/mocks/overlays/order.catalogue-unavailable'
import { handlers as emptyHandlers } from '@/mocks/overlays/order.catalogue-empty'
import { handlers as todayHandlers } from '@/mocks/overlays/order.catalogue-today'
import { emptyDraft } from './draft'
import { PlanStep } from './PlanStep'
import type { OrderDraft } from './draft'
import type { OrderRole } from './PlanStep'

const BASE = 'https://core.test/api/v1'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  server.use(...catalogueHandlers)
})
afterEach(() => {
  server.events.removeAllListeners()
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

/** A real, stateful stand-in for `useOrderDraft`: `update` patches the draft
 * and the component re-renders with it, the same as the real hook does — a
 * static draft plus a spy would never show the screen reacting to its own
 * `update` calls, which is exactly what several of these tests assert on. */
function Harness({
  initial,
  role = 'org_owner',
  onUpdate,
  onRequestQuote = vi.fn(),
}: {
  initial: Partial<OrderDraft>
  role?: OrderRole
  onUpdate?: (patch: Partial<OrderDraft>) => void
  onRequestQuote?: () => void
}) {
  const [draft, setDraft] = useState<OrderDraft>({ ...emptyDraft(), ...initial })
  return (
    <PlanStep
      draft={draft}
      update={(patch) => {
        onUpdate?.(patch)
        setDraft((current) => ({ ...current, ...patch }))
      }}
      role={role}
      organisationId="org-1"
      onContinue={vi.fn()}
      onRequestQuote={onRequestQuote}
    />
  )
}

function renderPlanStep(initial: Partial<OrderDraft> = {}, role: OrderRole = 'org_owner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onUpdate = vi.fn()
  const onRequestQuote = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} role={role} onUpdate={onUpdate} onRequestQuote={onRequestQuote} />
    </QueryClientProvider>
  )
  return { update: onUpdate, requestQuote: onRequestQuote }
}

describe('PlanStep', () => {
  it.each([
    ['failed catalogue', unavailableHandlers],
    ['empty catalogue', emptyHandlers],
  ])('keeps a visible plan heading for the owner with a %s', async (state, handlers) => {
    server.use(...handlers)
    renderPlanStep()
    const message =
      state === 'failed catalogue'
        ? /Le service est momentanément indisponible/
        : /Les formules sont momentanément indisponibles/
    await screen.findByText(message)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Choisissez votre formule' })
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Continuer' })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    if (state === 'failed catalogue') {
      expect(screen.getByRole('alert')).toHaveTextContent(/support@kodera.io/)
      expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
    } else {
      expect(screen.getByText(message)).toHaveTextContent(/support@kodera.io/)
      expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull()
    }
  })

  it('renders one card per capacity tier from the catalogue', async () => {
    renderPlanStep()
    expect(await screen.findByRole('radio', { name: /Team/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Business Plus/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Business,/ })).toBeInTheDocument()
  })

  it('names each plan as a radio choice without introducing nested headings', async () => {
    renderPlanStep()
    await screen.findByRole('radio', { name: /Team/ })
    const choices = ['Team', 'Business', 'Business Plus']
    for (const name of choices) {
      const choice = screen.getByRole('radio', { name: new RegExp(`^${name},`) })
      expect(within(choice).getByText(name)).toBeVisible()
      expect(choice.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    }
  })

  // The tiers are named « Capacité S » to « Capacité L »: the sentence names the plan.
  it('recommends a tier from the headcount and pre-selects it', async () => {
    const { update } = renderPlanStep()
    await screen.findByRole('radio', { name: /Team/ })

    const headcountField = screen.getByLabelText('Combien de personnes dans votre organisation ?')
    await userEvent.type(headcountField, '120')
    await userEvent.tab()

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ headcount: 120 }))
    })
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ capacityTierCode: 'M' }))
    })

    expect(await screen.findByText(/Nous vous recommandons Business\./)).toBeInTheDocument()
  })

  it('shows a member a read-only message naming the owner instead of the form', async () => {
    renderPlanStep({}, 'member')

    expect(await screen.findByText(/Seul le propriétaire peut passer commande/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('Combien de personnes dans votre organisation ?')
    ).not.toBeInTheDocument()
  })

  it('moves the selection between cards with the arrow keys', async () => {
    const { update } = renderPlanStep({ capacityTierCode: 'S' })
    const first = await screen.findByRole('radio', { name: /Team/ })
    first.focus()

    // Radix moves the roving focus on a macrotask and only selects the
    // option it lands on if the arrow key is still physically down when
    // that runs (see src/ui/RadioGroup/RadioGroup.test.tsx) — so the key is
    // held until the move completes, then released.
    await userEvent.keyboard('{ArrowRight>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Business,/ })).toHaveFocus())
    await userEvent.keyboard('{/ArrowRight}')

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ capacityTierCode: 'M' }))
    })
  })
})

describe('the recommended card', () => {
  it('carries the recommended badge as visible text, not colour alone', async () => {
    renderPlanStep({ headcount: 120, capacityTierCode: 'M' })
    const card = await screen.findByRole('radio', { name: /^Business,/ })
    expect(within(card).getByText(/Recommandé/)).toBeInTheDocument()
  })

  it('draws one accent ink edge on the chosen card, even when it is also recommended', async () => {
    renderPlanStep({ headcount: 120, capacityTierCode: 'M' })
    const chosen = (await screen.findByRole('radio', { name: /^Business,/ })).firstElementChild
    expect(chosen).toHaveClass('border-2', 'border-c-accent-ink')
    expect(chosen).not.toHaveClass('border-c-action')
    const other = screen.getByRole('radio', { name: /^Team,/ }).firstElementChild
    expect(other).toHaveClass('border', 'border-c-border')
    expect(other).not.toHaveClass('border-c-accent-ink')
  })

  // The badge used to print the tier's capacity as a headcount: "Recommandé ·
  // 50 personnes" on the card chosen for 120 people.
  it("names the buyer's own headcount on the badge, not the tier's capacity", async () => {
    renderPlanStep({ headcount: 120, capacityTierCode: 'M' })
    const card = await screen.findByRole('radio', { name: /^Business,/ })
    expect(within(card).getByText('Recommandé · 120 personnes')).toBeInTheDocument()
  })

  // OL-03: 340 people is a peak of 102, over the largest tier's 100. The step
  // used to recommend that tier anyway ("prévue pour 167 personnes et plus")
  // while the link under the cards said "Plus de 330 personnes ? Parlons-en.".
  it('recommends a quote, and no card, when no tier covers the peak', async () => {
    const { requestQuote } = renderPlanStep({ headcount: 700 })

    const largest = await screen.findByRole('radio', { name: /^Enterprise,/ })
    expect(within(largest).getByText('Conçu pour 251 à 666 personnes')).toBeInTheDocument()
    expect(screen.queryByText(/Recommandé ·/)).not.toBeInTheDocument()
    expect(screen.queryByText(/personnes et plus/)).not.toBeInTheDocument()

    // Two elements carry role="status": the sr-only live region, filled after
    // the 600 ms debounce, and the visible InlineAlert. Both are waited for
    // and both are asserted, as the test this replaces did.
    const quote =
      "Aucune formule en ligne n'est prévue pour 700 personnes : nous dimensionnons votre espace avec vous, sur devis."
    await waitFor(
      () => {
        const statuses = screen.getAllByRole('status')
        expect(statuses.filter((node) => node.textContent === quote)).toHaveLength(2)
      },
      { timeout: 2000 }
    )
    for (const node of screen.getAllByRole('status')) {
      expect(node).not.toHaveTextContent(/Nous vous recommandons/)
    }

    await userEvent.click(screen.getByRole('button', { name: 'Demander un devis' }))
    expect(requestQuote).toHaveBeenCalledTimes(1)
  })

  // Ruling C: the cutoff the link names is the one the plans stop at, from
  // the catalogue — 666 for a 200-participant largest tier, never a figure of
  // its own.
  it('names the catalogue-derived cutoff in the quote link', async () => {
    renderPlanStep()
    await screen.findByRole('radio', { name: /^Enterprise,/ })
    expect(
      screen.getByRole('link', { name: 'Plus de 666 personnes ? Parlons-en.' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/660/)).not.toBeInTheDocument()
  })
})

describe('cards named and described by the catalogue plan (01-order.md §4.1)', () => {
  const BUSINESS_TEXT =
    'Pour une organisation de taille moyenne, avec plusieurs équipes. Assistance par e-mail les jours ouvrés ; Docs en option dès sa mise à disposition.'

  it('titles each card by the plan its price row names, not by the tier « Capacité M »', async () => {
    renderPlanStep()
    const business = await screen.findByRole('radio', { name: /^Business,/ })
    expect(within(business).getByText('Business')).toBeVisible()
    expect(within(business).getByText('Continuer avec Business')).toBeInTheDocument()
    expect(screen.queryByText('Capacité M')).toBeNull()
  })

  it('gives the radio the plan’s description, which assistive technology reads', async () => {
    renderPlanStep()
    const business = await screen.findByRole('radio', { name: /^Business,/ })
    expect(business).toHaveAccessibleDescription(BUSINESS_TEXT)
    expect(within(business).getByText(BUSINESS_TEXT)).toBeVisible()
  })

  it.each([
    ['null', null],
    ['empty', ''],
  ] as const)(
    'draws no description, and points at none, when the plan’s is %s',
    async (_, text) => {
      server.use(
        http.get(`${BASE}/catalog/plans`, () =>
          HttpResponse.json({
            data: [
              {
                code: 'business',
                version: 1,
                name: 'Business',
                description: text,
                state: 'published',
                packs: ['visio'],
              },
            ],
            next_cursor: null,
            has_more: false,
          })
        )
      )
      renderPlanStep()
      const business = await screen.findByRole('radio', { name: /^Business,/ })
      expect(business).not.toHaveAttribute('aria-describedby')
      // Nor an empty description paragraph.
      const empty = [...business.querySelectorAll('p')].filter((p) => p.textContent?.trim() === '')
      expect(empty).toEqual([])
    }
  )

  it('names the plan at the version its price row names, not another listed version', async () => {
    const business = (version: number, name: string) => ({
      code: 'business',
      version,
      name,
      description: null,
      state: 'published',
      packs: ['visio'],
    })
    server.use(
      http.get(`${BASE}/catalog/plans`, () =>
        HttpResponse.json({
          // The catalogue's price rows name version 1.
          data: [business(2, 'Business 2027'), business(1, 'Business')],
          next_cursor: null,
          has_more: false,
        })
      )
    )
    renderPlanStep()
    expect(await screen.findByRole('radio', { name: /^Business,/ })).toBeInTheDocument()
    expect(screen.queryByText('Business 2027')).toBeNull()
  })

  it('names the plan of the row the card shows, for the period chosen', async () => {
    const plan = (version: number, name: string) => ({
      code: 'business',
      version,
      name,
      description: null,
      state: 'published',
      packs: ['visio'],
    })
    server.use(
      http.get(`${BASE}/catalog/plans`, () =>
        HttpResponse.json({
          data: [plan(1, 'Business'), plan(2, 'Business mensuel')],
          next_cursor: null,
          has_more: false,
        })
      ),
      // The monthly rows are sold under version 2, the yearly ones under version 1.
      http.get(`${BASE}/catalog/prices`, ({ request }) => {
        const url = new URL(request.url)
        const period = url.searchParams.get('billing_period') === 'monthly' ? 'monthly' : 'yearly'
        return HttpResponse.json({
          data: [
            {
              id: `00000000-0000-4000-8000-00000000000${period === 'monthly' ? 2 : 1}`,
              plan_code: 'business',
              plan_version: period === 'monthly' ? 2 : 1,
              pack_code: url.searchParams.get('pack_code'),
              capacity_tier_code: 'M',
              billing_period: period,
              amount_excl_vat: {
                amount_minor: period === 'monthly' ? 34_900 : 31_400 * 12,
                currency: 'EUR',
              },
              valid_from: '2026-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        })
      })
    )
    renderPlanStep({ billingPeriod: 'yearly' })
    expect(await screen.findByRole('radio', { name: /^Business, 314/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Mensuel, sans engagement' }))
    expect(await screen.findByRole('radio', { name: /^Business mensuel, 349/ })).toBeInTheDocument()
  })

  it('reads the tier’s own name when no listed plan matches the price row', async () => {
    server.use(
      http.get(`${BASE}/catalog/plans`, () =>
        HttpResponse.json({ data: [], next_cursor: null, has_more: false })
      )
    )
    renderPlanStep()
    expect(await screen.findByRole('radio', { name: /^Capacité M,/ })).toBeInTheDocument()
  })

  it('draws no card before its price row is read, so no title starts as « Capacité M »', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.get(`${BASE}/catalog/prices`, async () => {
        await gate
        return undefined
      })
    )
    const read = new Set<string>()
    server.events.on('response:mocked', ({ request }) => {
      read.add(new URL(request.url).pathname.split('/').pop() ?? '')
    })
    renderPlanStep({ headcount: 120, capacityTierCode: 'M' })
    // Packs, tiers and plans are in; the prices are held.
    await waitFor(() => expect([...read].sort()).toEqual(['capacity-tiers', 'packs', 'plans']))
    // Past the announcement's 600 ms debounce: nothing may be announced under a tier's name.
    await delay(800)
    expect(screen.queryAllByRole('radio', { name: /participants simultanés/ })).toEqual([])
    expect(screen.queryByText(/Capacité/)).toBeNull()
    // Only the cards wait: the fields around them stay usable.
    expect(screen.getByRole('checkbox', { name: 'Docs — documents collaboratifs' })).toBeEnabled()
    release()
    expect(await screen.findByRole('radio', { name: /^Business,/ })).toBeInTheDocument()
    expect(screen.queryByText(/Capacité/)).toBeNull()
    server.events.removeAllListeners()
  })

  it('keeps every card under its plan’s name when Docs is ticked', async () => {
    const docsReads: string[] = []
    server.events.on('response:mocked', ({ request }) => {
      const url = new URL(request.url)
      if (
        url.pathname.endsWith('/catalog/prices') &&
        url.searchParams.get('pack_code') === 'visio-docs'
      ) {
        docsReads.push(url.searchParams.get('billing_period') ?? '')
      }
    })
    renderPlanStep()
    await screen.findByRole('radio', { name: /^Business,/ })
    // The Docs pack's prices were read ahead, before anyone ticked it.
    await waitFor(() => expect(docsReads.sort()).toEqual(['monthly', 'yearly']))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Docs — documents collaboratifs' }))
    expect(screen.getByRole('radio', { name: /^Business, 403\s€/ })).toBeInTheDocument()
    expect(screen.queryByText(/Capacité/)).toBeNull()
    server.events.removeAllListeners()
  })

  it('shows the amount through PlanPrice: the sans face with tabular figures, not mono', async () => {
    renderPlanStep({ billingPeriod: 'yearly' })
    const team = await screen.findByRole('radio', { name: /^Team,/ })
    const amount = await within(team).findByText('161 €')
    expect(amount.className).toMatch(/\btabular-nums\b/)
    expect(amount.className).not.toMatch(/\bfont-mono\b/)
  })

  // Core's yearly price is the annual total (1 932 € here). A card never puts it beside
  // « /mois »: it shows the monthly equivalent, says it is billed annually, and gives the total.
  it('shows a yearly price as its monthly equivalent, billed annually, with the annual total', async () => {
    renderPlanStep({ billingPeriod: 'yearly' })
    const team = await screen.findByRole('radio', {
      name: /^Team, 161\s€ par mois, facturé annuellement,/,
    })
    expect(within(team).getByText('161 €')).toBeVisible()
    expect(within(team).getByText('/mois HT, facturé annuellement')).toBeVisible()
    expect(within(team).getByText('soit 1 932 € HT par an')).toBeVisible()
    expect(within(team).queryByText(/^1 932 €$/)).toBeNull()
  })

  it('shows a monthly price as it is, with no annual line', async () => {
    renderPlanStep({ billingPeriod: 'monthly' })
    const team = await screen.findByRole('radio', {
      name: /^Team, 179\s€ par mois sans engagement,/,
    })
    expect(within(team).getByText('179 €')).toBeVisible()
    expect(within(team).getByText('/mois HT')).toBeVisible()
    expect(within(team).queryByText(/par an/)).toBeNull()
  })

  it('reads the plans as a catalogue collection: a failed read is the catalogue’s failure', async () => {
    server.use(
      http.get(`${BASE}/catalog/plans`, () =>
        HttpResponse.json(
          { type: 'https://kodera.io/problems/internal-error', title: 'x', status: 500 },
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } }
        )
      )
    )
    renderPlanStep()
    expect(await screen.findByText(/Le service est momentanément indisponible/)).toBeVisible()
    expect(screen.queryByRole('radio')).toBeNull()
  })
})

describe('the offer as Core sells it: four tiers, Docs included, Enterprise yearly only', () => {
  const DOCS = 'Docs — documents collaboratifs'

  it('draws all four tiers, two by two then four across, never three and an orphan', async () => {
    renderPlanStep()
    const cards = await screen.findAllByRole('radio', { name: /participants simultanés\.$/ })
    expect(cards.map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual([
      'Team',
      'Business',
      'Business Plus',
      'Enterprise',
    ])
    const grid = cards[0]!.parentElement!
    expect(grid.className).toMatch(/\[@container\(min-width:30rem\)\]:grid-cols-2/)
    expect(grid.className).toMatch(/\[@container\(min-width:45rem\)\]:grid-cols-4/)
    expect(grid.className).not.toMatch(/grid-cols-3/)
  })

  it('offers no paid Docs option on a plan that includes Docs, and orders it with Docs', async () => {
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    await userEvent.click(await screen.findByRole('radio', { name: /^Business Plus,/ }))
    expect(screen.queryByRole('checkbox', { name: DOCS })).toBeNull()
    expect(
      screen.getByText('Docs est inclus dans la formule Business Plus : rien à ajouter.')
    ).toBeVisible()
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'L', packCode: 'visio-docs' })
    )
  })

  it('treats a tier sold only with Docs as including it, as Business Plus once Docs ships', async () => {
    const row = (pack: string, tier: string, minor: number, plan: string) => ({
      id: `00000000-0000-4000-8000-${pack.length}${tier.length}${minor}`.slice(0, 36),
      plan_code: plan,
      plan_version: 1,
      pack_code: pack,
      capacity_tier_code: tier,
      billing_period: 'yearly',
      amount_excl_vat: { amount_minor: minor, currency: 'EUR' },
      valid_from: '2026-01-01T00:00:00Z',
    })
    server.use(
      http.get(`${BASE}/catalog/prices`, ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('billing_period') !== 'yearly') {
          return HttpResponse.json({ data: [], next_cursor: null, has_more: false })
        }
        // The Visio-only Business Plus rows are closed: L is sold with Docs only.
        const data =
          url.searchParams.get('pack_code') === 'visio'
            ? [row('visio', 'S', 193_200, 'team'), row('visio', 'M', 376_800, 'business')]
            : [
                row('visio-docs', 'S', 300_000, 'team'),
                row('visio-docs', 'M', 483_600, 'business'),
                row('visio-docs', 'L', 853_200, 'business-plus'),
              ]
        return HttpResponse.json({ data, next_cursor: null, has_more: false })
      })
    )
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    // Without Docs ticked, the card is still priced, from the Docs pack.
    const plus = await screen.findByRole('radio', { name: /^Business Plus, 711\s€/ })
    await userEvent.click(plus)
    expect(screen.queryByRole('checkbox', { name: DOCS })).toBeNull()
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'L', packCode: 'visio-docs' })
    )
  })

  it('leaves Docs unticked on leaving a plan that included it: nobody pays for Docs unticked', async () => {
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    await userEvent.click(await screen.findByRole('radio', { name: /^Business Plus,/ }))
    await userEvent.click(screen.getByRole('radio', { name: /^Team,/ }))
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'S', packCode: 'visio' })
    )
    expect(screen.getByRole('checkbox', { name: DOCS })).not.toBeChecked()
  })

  it('keeps a Docs option the person ticked when they move between plans that charge for it', async () => {
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    await userEvent.click(await screen.findByRole('radio', { name: /^Team,/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: DOCS }))
    await userEvent.click(screen.getByRole('radio', { name: /^Business, 403\s€/ }))
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'M', packCode: 'visio-docs' })
    )
    expect(screen.getByRole('checkbox', { name: DOCS })).toBeChecked()
  })

  it('bills Enterprise annually: choosing it under monthly billing moves to yearly and says why', async () => {
    const { update } = renderPlanStep({ billingPeriod: 'monthly' })
    // Under monthly billing, the yearly-only card still shows its price, billed annually.
    const enterprise = await screen.findByRole('radio', {
      name: /^Enterprise, 1\s341\s€ par mois, facturé annuellement,/,
    })
    expect(within(enterprise).getByText('soit 16 092 € HT par an')).toBeVisible()
    await userEvent.click(enterprise)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'XL', billingPeriod: 'yearly' })
    )
    expect(screen.getByRole('radio', { name: 'Mensuel, sans engagement' })).toBeDisabled()
    expect(
      screen.getByText('La formule Enterprise est facturée annuellement uniquement.')
    ).toBeVisible()
  })

  it('labels the empty summary by the period set, before any tier is chosen', async () => {
    renderPlanStep({ billingPeriod: 'yearly' })
    const heading = await screen.findByRole('heading', { name: 'Votre commande' })
    const summary = heading.parentElement!.parentElement!
    expect(await within(summary).findByText('Facturé annuellement')).toBeVisible()
    expect(within(summary).queryByText('Total mensuel')).toBeNull()
  })

  it('totals the step’s summary as billed: the annual total, said to be billed annually', async () => {
    renderPlanStep({ billingPeriod: 'yearly', capacityTierCode: 'S' })
    const heading = await screen.findByRole('heading', { name: 'Votre commande' })
    const summary = heading.parentElement!.parentElement!
    expect(await within(summary).findByText('Facturé annuellement')).toBeVisible()
    expect(within(summary).getAllByText('1 932 €').length).toBeGreaterThan(0)
    expect(within(summary).queryByText('Total mensuel')).toBeNull()
  })
})

describe('nothing is concluded from prices that are missing, late or failed', () => {
  const DOCS = 'Docs — documents collaboratifs'

  it('shows the catalogue failure when a price read fails, never « Docs est inclus »', async () => {
    server.use(
      http.get(`${BASE}/catalog/prices`, ({ request }) =>
        new URL(request.url).searchParams.get('pack_code') === 'visio'
          ? HttpResponse.json(
              { type: 'https://kodera.io/problems/internal-error', title: 'x', status: 500 },
              { status: 500, headers: { 'Content-Type': 'application/problem+json' } }
            )
          : undefined
      )
    )
    renderPlanStep({ billingPeriod: 'yearly' })
    expect(await screen.findByText(/Le service est momentanément indisponible/)).toBeVisible()
    expect(screen.queryByText(/Docs est inclus/)).toBeNull()
    expect(screen.queryAllByRole('radio', { name: /participants simultanés/ })).toEqual([])
  })

  it('keeps the base pack for a tier chosen while the base prices were still loading', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.get(`${BASE}/catalog/prices`, async ({ request }) => {
        // The Docs pack answers first; the base pack is held.
        if (new URL(request.url).searchParams.get('pack_code') === 'visio') await gate
        return undefined
      })
    )
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    const headcount = await screen.findByLabelText('Combien de personnes dans votre organisation ?')
    await userEvent.type(headcount, '50')
    await userEvent.tab()
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ capacityTierCode: 'S' }))
    )
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ packCode: 'visio-docs' }))
    release()
    expect(await screen.findByRole('checkbox', { name: DOCS })).not.toBeChecked()
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ packCode: 'visio-docs' }))
  })

  it('draws no card while the Docs pack’s prices are still out', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.get(`${BASE}/catalog/prices`, async ({ request }) => {
        if (new URL(request.url).searchParams.get('pack_code') === 'visio-docs') await gate
        return undefined
      })
    )
    renderPlanStep({ billingPeriod: 'yearly' })
    await screen.findByRole('checkbox', { name: DOCS })
    await delay(300)
    expect(screen.queryAllByRole('radio', { name: /participants simultanés/ })).toEqual([])
    release()
    expect(await screen.findByRole('radio', { name: /^Enterprise,/ })).toBeInTheDocument()
  })

  it('moves a restored Enterprise draft on monthly billing to yearly, and to the Docs pack', async () => {
    const { update } = renderPlanStep({
      billingPeriod: 'monthly',
      capacityTierCode: 'XL',
      packCode: 'visio',
    })
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ billingPeriod: 'yearly', packCode: 'visio-docs' })
      )
    )
    expect(await screen.findByRole('radio', { name: 'Mensuel, sans engagement' })).toBeDisabled()
  })

  it('rounds a monthly equivalent down to the cent, never up', async () => {
    server.use(
      http.get(`${BASE}/catalog/prices`, ({ request }) => {
        const url = new URL(request.url)
        const period = url.searchParams.get('billing_period')
        const data =
          period === 'yearly'
            ? [
                {
                  id: '00000000-0000-4000-8000-000000000071',
                  plan_code: 'team',
                  plan_version: 1,
                  pack_code: url.searchParams.get('pack_code'),
                  capacity_tier_code: 'S',
                  billing_period: 'yearly',
                  // 1 000,07 € a year: 83,3391… € a month, shown as 83,33 €, not 83,34 €.
                  amount_excl_vat: { amount_minor: 100_007, currency: 'EUR' },
                  valid_from: '2026-01-01T00:00:00Z',
                },
              ]
            : []
        return HttpResponse.json({ data, next_cursor: null, has_more: false })
      })
    )
    renderPlanStep({ billingPeriod: 'yearly' })
    const team = await screen.findByRole('radio', { name: /^Team,/ })
    expect(within(team).getByText(/^83,33\s€$/)).toBeVisible()
    expect(within(team).getByText(/^soit 1\s000,07\s€ HT par an$/)).toBeVisible()
  })

  it('names the annual total in the card’s accessible name', async () => {
    renderPlanStep({ billingPeriod: 'yearly' })
    expect(
      await screen.findByRole('radio', {
        name: /^Team, 161\s€ par mois, facturé annuellement, soit 1\s932\s€ HT par an,/,
      })
    ).toBeInTheDocument()
  })
})

describe('the catalogue as it launches, before Docs is on sale', () => {
  it('offers no Docs option, and sells Business Plus Visio-only at 690 €', async () => {
    server.use(...todayHandlers)
    const { update } = renderPlanStep({ billingPeriod: 'yearly' })
    const plus = await screen.findByRole('radio', {
      name: /^Business Plus, 621\s€ par mois, facturé annuellement, soit 7\s452\s€ HT par an,/,
    })
    expect(screen.queryByRole('checkbox', { name: 'Docs — documents collaboratifs' })).toBeNull()
    expect(screen.queryByText(/Docs est inclus/)).toBeNull()
    await userEvent.click(plus)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityTierCode: 'L', packCode: 'visio' })
    )
    await userEvent.click(screen.getByRole('radio', { name: 'Mensuel, sans engagement' }))
    expect(
      await screen.findByRole('radio', { name: /^Business Plus, 690\s€ par mois sans engagement,/ })
    ).toBeInTheDocument()
  })
})
