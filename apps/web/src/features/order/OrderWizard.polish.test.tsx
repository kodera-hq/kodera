import { StrictMode, useLayoutEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { server } from '../../mocks/server'
import { handlers as catalogueHandlers } from '../../mocks/overlays/order.catalogue-default'
import { AuthProvider } from '../../auth/AuthProvider'
import { authAdapter } from '../../auth/oidc'
import { SessionExpiryProvider, useReauthenticate } from '../../auth/sessionExpiry'
import { consumeReturnTo } from '../../auth/return-to'
import type { OrderOwner } from './owner'
import { emptyDraft, furthestStep } from './draft'
import { readEditable, saveEditable } from './editableStorage'
import { stashContacts } from './contactStash'
import { OrderWizard } from './OrderWizard'

const BASE = 'https://core.test/api/v1'
const owner: OrderOwner = {
  issuer: 'https://id.example.test/realms/acme-sa',
  subject: 'person-a',
  organisationId: 'org-a',
  membershipId: 'membership-a',
  identityId: 'identity-a',
  generation: 1,
}
const contacts = {
  legalName: 'Synthetic buyer',
  slug: 'synthetic-buyer',
  registrationNumber: '123456789',
  vatNumber: '',
  addressLine1: 'Synthetic road',
  postalCode: '00000',
  city: 'Synthetic city',
  country: 'FR',
  billingReference: '',
  adminEmail: 'admin@example.test',
  billingEmail: 'billing@example.test',
  securityEmail: 'security@example.test',
}
function sessionFor(scope: OrderOwner) {
  const user = {
    realm: 'acme-sa',
    identity: { issuer: scope.issuer, subject: scope.subject },
  }
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: scope.generation,
    credentialGeneration: 1,
    user,
  })
  vi.spyOn(authAdapter, 'getUser').mockReturnValue(user)
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
}
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  localStorage.clear()
  sessionStorage.clear()
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  server.use(...catalogueHandlers)
  sessionFor(owner)
  vi.spyOn(authAdapter, 'signIn').mockResolvedValue()
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())
function Reauthenticate() {
  const reauthenticate = useReauthenticate()
  return <button onClick={() => reauthenticate()}>Sign in again</button>
}
function wrapper(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <AuthProvider>
      <SessionExpiryProvider>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </SessionExpiryProvider>
    </AuthProvider>
  )
}
function mount(
  step: 'contacts' | 'agreements',
  scope = owner,
  strict = false,
  onNavigate = vi.fn()
) {
  const content = wrapper(
    <>
      <OrderWizard
        org="acme-sa"
        owner={scope}
        draftId="known"
        step={step}
        organisationId={scope.organisationId}
        // Organisation authority prop, not a DOM ARIA role.
        // eslint-disable-next-line jsx-a11y/aria-role
        role="org_owner"
        signatoryName="Synthetic buyer"
        signatoryEmail="buyer@example.test"
        onNavigate={onNavigate}
        onGoToStatus={vi.fn()}
      />
      <Reauthenticate />
    </>
  )
  return render(strict ? <StrictMode>{content}</StrictMode> : content)
}
function seed(
  step: 'contacts' | 'agreements',
  scope = owner,
  billingPeriod: 'monthly' | 'yearly' = 'monthly'
) {
  saveEditable(
    {
      ...emptyDraft(),
      draftId: 'known',
      packCode: 'visio-docs',
      capacityTierCode: 'M',
      billingPeriod,
      ...(step === 'agreements' ? { contacts } : {}),
    },
    scope
  )
}
it.each(['contacts', 'agreements'] as const)(
  'shows the actual selected catalogue summary on %s',
  async (step) => {
    seed(step)
    mount(step)
    const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
    await waitFor(() => expect(within(summary).getByText('Visio + Docs')).toBeInTheDocument())
    expect(within(summary).getByText('Business')).toBeInTheDocument()
    expect(within(summary).getByText('448 €', { exact: false })).toBeInTheDocument()
    expect(within(summary).getByText('Total mensuel')).toBeInTheDocument()
  }
)
it.each(['contacts', 'agreements'] as const)(
  'shows the exact annual-period amount and existing billing-period wording on %s',
  async (step) => {
    seed(step, owner, 'yearly')
    mount(step)
    const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
    await waitFor(() => expect(within(summary).getByText('4 836 €')).toBeInTheDocument())
    expect(within(summary).getByText('Facturé annuellement')).toBeInTheDocument()
    expect(within(summary).queryByText('448 €')).toBeNull()
  }
)
const selectedPrice = {
  id: 'sentinel-price',
  plan_code: 'business',
  plan_version: 1,
  pack_code: 'visio-docs',
  capacity_tier_code: 'M',
  billing_period: 'monthly',
  amount_excl_vat: { amount_minor: 98765, currency: 'EUR' },
  valid_from: '2026-01-01T00:00:00Z',
}
it('selects the exact pack/tier/period catalogue row without applying an NGO discount', async () => {
  seed('contacts')
  const saved = readEditable('known', owner).draft
  saveEditable({ ...saved, ngoRate: true }, owner)
  server.use(
    http.get('*/api/v1/catalog/prices', () =>
      HttpResponse.json({
        data: [
          {
            ...selectedPrice,
            pack_code: 'visio',
            amount_excl_vat: { amount_minor: 100, currency: 'EUR' },
          },
          {
            ...selectedPrice,
            capacity_tier_code: 'S',
            amount_excl_vat: { amount_minor: 200, currency: 'EUR' },
          },
          {
            ...selectedPrice,
            billing_period: 'yearly',
            amount_excl_vat: { amount_minor: 300, currency: 'EUR' },
          },
          selectedPrice,
        ],
        has_more: false,
        next_cursor: null,
      })
    )
  )
  mount('contacts')
  const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
  await waitFor(() => expect(within(summary).getByText('987,65 €')).toBeInTheDocument())
  expect(within(summary).getByText('Visio + Docs')).toBeInTheDocument()
  expect(within(summary).getByText('Business')).toBeInTheDocument()
})
it.each(['missing', 'other-pack', 'other-tier', 'other-period', 'request-error'])(
  'shows no guessed or stale amount when the selected price is %s',
  async (failure) => {
    seed('contacts')
    server.use(
      http.get('*/api/v1/catalog/prices', () => {
        if (failure === 'request-error') return new HttpResponse(null, { status: 503 })
        const row = { ...selectedPrice }
        if (failure === 'other-pack') row.pack_code = 'visio'
        if (failure === 'other-tier') row.capacity_tier_code = 'S'
        if (failure === 'other-period') row.billing_period = 'yearly'
        return HttpResponse.json({
          data: failure === 'missing' ? [] : [row],
          has_more: false,
          next_cursor: null,
        })
      })
    )
    mount('contacts')
    const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
    await waitFor(() => expect(within(summary).getByRole('alert')).toBeInTheDocument())
    expect(within(summary).getByText('—')).toBeInTheDocument()
    expect(within(summary).queryByText(/€/)).toBeNull()
  }
)
it.each(['unavailable-pack', 'unavailable-tier', 'missing-compatibility', 'incompatible-tier'])(
  'shows unavailable data instead of a price for %s catalogue metadata',
  async (failure) => {
    seed('contacts')
    server.use(
      http.get('*/api/v1/catalog/packs', () =>
        HttpResponse.json({
          data: [
            {
              code: 'visio-docs',
              name: 'Visio + Docs',
              available: failure !== 'unavailable-pack',
              ...(failure === 'missing-compatibility'
                ? {}
                : { capacity_tier_codes: failure === 'incompatible-tier' ? ['S'] : ['M'] }),
            },
          ],
          has_more: false,
          next_cursor: null,
        })
      ),
      http.get('*/api/v1/catalog/capacity-tiers', () =>
        HttpResponse.json({
          data: [{ code: 'M', name: 'Capacité M', available: failure !== 'unavailable-tier' }],
          has_more: false,
          next_cursor: null,
        })
      )
    )
    mount('contacts')
    const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
    await waitFor(() => expect(within(summary).getByRole('alert')).toBeInTheDocument())
    expect(within(summary).getByText('—')).toBeInTheDocument()
    expect(within(summary).queryByText(/€/)).toBeNull()
  }
)
it('keeps the selected summary visible when legal documents fail to load', async () => {
  seed('agreements')
  server.use(http.get('*/api/v1/legal-documents', () => new HttpResponse(null, { status: 503 })))
  mount('agreements')
  const summary = await screen.findByRole('complementary', { name: 'Votre commande' })
  await waitFor(() => expect(within(summary).getByText('448 €')).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Signer et recevoir la facture' })).toBeNull()
})
it('associates the held submission reason with the disabled final action', async () => {
  seed('agreements')
  mount('agreements')
  const submit = await screen.findByRole('button', { name: 'Signer et recevoir la facture' })
  expect(submit).toBeDisabled()
  expect(submit).toHaveAccessibleDescription(
    'L’envoi des commandes est temporairement suspendu. Vous pouvez préparer votre brouillon.'
  )
})
it('recovers an unreachable step through the actual router only after commit in StrictMode', async () => {
  let committed = false
  const phases: boolean[] = []
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '$step', component: RoutedOrder })
  function RoutedOrder() {
    const { step } = route.useParams()
    const navigate = useNavigate()
    useLayoutEffect(() => {
      committed = true
    }, [])
    return (
      <OrderWizard
        org="acme-sa"
        owner={owner}
        draftId="known"
        step={step as 'agreements'}
        organisationId={owner.organisationId}
        // Organisation authority prop, not a DOM ARIA role.
        // eslint-disable-next-line jsx-a11y/aria-role
        role="org_owner"
        signatoryName="Synthetic buyer"
        signatoryEmail="buyer@example.test"
        onNavigate={(next) => {
          phases.push(committed)
          void navigate({ href: `/${next}` })
        }}
        onGoToStatus={vi.fn()}
      />
    )
  }
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/agreements'] }),
  })
  render(
    wrapper(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    )
  )
  await waitFor(() => expect(router.state.location.pathname).toBe('/plan'))
  expect(phases.length).toBeGreaterThan(0)
  expect(phases.every(Boolean)).toBe(true)
})
it('reopens partial contact edits without skipping to agreements', async () => {
  seed('contacts')
  const first = mount('contacts')
  fireEvent.change(screen.getByLabelText('Raison sociale'), {
    target: { value: 'Partly typed buyer' },
  })
  first.unmount()
  const recovered = readEditable('known', owner).draft
  expect(furthestStep(recovered)).toBe('contacts')
  mount('contacts')
  expect(screen.getByLabelText('Raison sociale')).toHaveValue('Partly typed buyer')
})
it('keeps possible submitted outcomes held without navigation or contact hydration', () => {
  seed('agreements')
  stashContacts(owner, 'known', { ...contacts, legalName: 'Private redirect fields' })
  const legacy = JSON.stringify({ orderId: 'unresolved-order' })
  localStorage.setItem('order-draft:known', legacy)
  const onNavigate = vi.fn()
  mount('agreements', owner, true, onNavigate)
  expect(
    screen.getByText(
      `Une commande pourrait déjà avoir été envoyée. Écrivez-nous à ${SUPPORT_EMAIL} avant d’en créer une autre.`
    )
  ).toBeInTheDocument()
  expect(screen.queryByLabelText('Raison sociale')).toBeNull()
  expect(screen.queryByText('Private redirect fields')).toBeNull()
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(onNavigate).not.toHaveBeenCalled()
  expect(localStorage.getItem('order-draft:known')).toBe(legacy)
  const contact = screen.getByRole('link', { name: 'Nous écrire' })
  expect(contact).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
  contact.focus()
  expect(contact).toHaveFocus()
  expect(readEditable('known', owner).status).toBe('held')
})
it('retains the latest fields through the real form-stash callback and a mocked sign-in remount', async () => {
  seed('contacts')
  window.history.replaceState(null, '', '/acme-sa/order/known/contacts?keep=1')
  const first = mount('contacts')
  fireEvent.change(screen.getByLabelText('Raison sociale'), { target: { value: 'Before expiry' } })
  vi.mocked(authAdapter.getAccessToken).mockReturnValue(undefined)
  fireEvent.change(screen.getByLabelText('Raison sociale'), {
    target: { value: 'Latest unsent edit' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
  expect(authAdapter.signIn).toHaveBeenCalledWith('acme-sa')
  expect(consumeReturnTo()).toBe('/acme-sa/order/known/contacts?keep=1')
  first.unmount()
  const renewed = { ...owner, generation: 2 }
  sessionFor(renewed)
  mount('contacts', renewed, true)
  expect(screen.getByLabelText('Raison sociale')).toHaveValue('Latest unsent edit')
  await waitFor(() =>
    expect(readEditable('known', renewed).draft.contactEdits?.legalName).toBe('Latest unsent edit')
  )
  expect(Object.keys(sessionStorage).filter((key) => key.includes('order.contactStash'))).toEqual(
    []
  )
  expect(furthestStep(readEditable('known', renewed).draft)).toBe('contacts')
})
it.each(['issuer', 'subject', 'organisationId'] as const)(
  'does not hydrate contact edits after a different %s signs in',
  async (field) => {
    seed('contacts')
    const first = mount('contacts')
    fireEvent.change(screen.getByLabelText('Raison sociale'), {
      target: { value: 'Private owner edit' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    first.unmount()
    const other = { ...owner, [field]: 'another-owner', generation: 2 }
    sessionFor(other)
    seed('contacts', other)
    mount('contacts', other)
    expect(screen.getByLabelText('Raison sociale')).toHaveValue('')
    expect(JSON.stringify(sessionStorage)).toContain('Private owner edit')
  }
)
