import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw/http'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as invoiceDeferredHandlers } from '@/mocks/overlays/order.invoice-deferred'
import { handlers as paymentLinkFailedHandlers } from '@/mocks/overlays/order.payment-link-failed'
import { ConfirmationStep } from './ConfirmationStep'

vi.mock('../support/HelpLink', async () => {
  const { helpHref } = await import('../support/helpHref')
  return {
    HelpLink: ({
      org,
      search,
      children,
    }: {
      org: string
      search?: Parameters<typeof helpHref>[1]
      children: ReactNode
    }) => <a href={helpHref(org, search)}>{children}</a>,
  }
})

const BASE = 'https://core.test/api/v1'
const ORDER_ID = 'a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => vi.stubEnv('VITE_CORE_API_URL', BASE))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function renderConfirmation(
  role: 'org_owner' | 'org_admin' | 'org_member' | 'org_billing' = 'org_owner',
  org = 'acme-sa'
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConfirmationStep
        org={org}
        role={role}
        orderId={ORDER_ID}
        firstName="Marie"
        onGoToStatus={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('ConfirmationStep', () => {
  it('confirms the order when the invoice is not ready yet, and offers no payment button', async () => {
    server.use(...invoiceDeferredHandlers)
    renderConfirmation()

    expect(await screen.findByRole('heading', { name: /Merci, Marie/ })).toBeInTheDocument()
    expect(
      await screen.findByText(
        'Votre commande est enregistrée. La facture est en cours de préparation et vous parviendra par e-mail.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Payer en ligne' })).not.toBeInTheDocument()
  })

  it('falls back to transfer when the payment link fails, and offers a retry', async () => {
    server.use(...paymentLinkFailedHandlers)
    renderConfirmation()

    expect(
      await screen.findByText(
        'Le paiement en ligne est momentanément indisponible. Réglez par virement avec les coordonnées de la facture, ou réessayez.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Télécharger la facture' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(
      await screen.findByText(
        'Le paiement en ligne est momentanément indisponible. Réglez par virement avec les coordonnées de la facture, ou réessayez.'
      )
    ).toBeInTheDocument()
  })

  // Owner ruling E (2026-09-24): the order's support action goes through Aide
  // like every other, not a bare mailto.
  it('sends the customer to Aide with the order as the subject when the order cannot load', async () => {
    server.use(
      http.get(`${BASE}/orders/:order_id`, () =>
        HttpResponse.json({ type: 'about:blank', title: 'down', status: 503 }, { status: 503 })
      )
    )
    renderConfirmation()
    // The order query retries once (`useOrderQuery`), a second later.
    const support = await screen.findByRole('link', { name: 'Nous écrire' }, { timeout: 5000 })
    expect(support).toHaveAttribute('href', '/acme-sa/help?topic=order')
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
  })

  // People preparation is live; Domain setup remains withheld.
  it('offers no link that leads nowhere, and promises no invitation', async () => {
    server.use(...invoiceDeferredHandlers)
    renderConfirmation()
    expect(await screen.findByRole('heading', { name: /Merci, Marie/ })).toBeInTheDocument()
    expect(document.querySelector('a[href="#"]')).toBeNull()
    // …nor promises an invitation the console cannot send yet.
    expect(screen.getByText('Nous vous écrivons à chaque étape.')).toBeInTheDocument()
    expect(screen.queryByText(/inviter vos collègues/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Pendant ce temps' })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Préparer la liste de vos collaborateurs' })
    ).toHaveAttribute('href', '/acme-sa/people/import?from=order')
    expect(screen.queryByRole('link', { name: 'Réserver votre adresse' })).toBeNull()
  })
})

it.each(['org_owner', 'org_admin', 'org_member', 'org_billing'] as const)(
  'scopes standalone confirmation preparation for %s',
  async (role) => {
    server.use(...invoiceDeferredHandlers)
    renderConfirmation(role, 'another-org')
    expect(await screen.findByRole('heading', { name: /Merci, Marie/ })).toBeInTheDocument()
    const prepare = screen.queryByRole('link', { name: 'Préparer la liste de vos collaborateurs' })
    if (role === 'org_owner' || role === 'org_admin') {
      expect(prepare).toHaveAttribute('href', '/another-org/people/import?from=order')
    } else {
      expect(prepare).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Pendant ce temps' })).toBeNull()
    }
  }
)
