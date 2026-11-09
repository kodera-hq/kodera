// The order's pages with billing off (run-notes quick-workspace SPEC §2.2, W1): there is no order
// to place, so they send the owner home, where « Créez votre espace » is.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RouterModule from '@tanstack/react-router'
import '@/i18n'
import { OrderGate } from './routes'

const summary = vi.hoisted(() => ({
  current: { data: undefined as { billing_enabled: boolean } | undefined, isLoading: false },
}))
vi.mock('../home/queries', () => ({ useStatusSummaryQuery: () => summary.current }))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({ membership: { organisation: { id: 'org-id' }, role: 'org_owner' } }),
    useParams: () => ({ org: 'acme-sa' }),
  },
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof RouterModule>()),
  Navigate: ({ to, params }: { to: string; params: { org: string } }) => (
    <p data-testid="redirect">{to.replace('$org', params.org)}</p>
  ),
  Outlet: () => <p data-testid="order" />,
}))

beforeEach(() => {
  summary.current = { data: undefined, isLoading: false }
})

describe('the order with the billing switch', () => {
  it('sends the owner home when the deployment does not bill', () => {
    summary.current = { data: { billing_enabled: false }, isLoading: false }
    render(<OrderGate />)
    expect(screen.getByTestId('redirect')).toHaveTextContent('/acme-sa/home')
    expect(screen.queryByTestId('order')).toBeNull()
  })

  it('keeps the order when billing is on, or when the summary cannot be read', () => {
    summary.current = { data: { billing_enabled: true }, isLoading: false }
    const view = render(<OrderGate />)
    expect(screen.getByTestId('order')).toBeInTheDocument()
    view.unmount()
    summary.current = { data: undefined, isLoading: false }
    render(<OrderGate />)
    expect(screen.getByTestId('order')).toBeInTheDocument()
  })

  it('shows neither while the summary loads, so no order flashes', () => {
    summary.current = { data: undefined, isLoading: true }
    render(<OrderGate />)
    expect(screen.queryByTestId('order')).toBeNull()
    expect(screen.queryByTestId('redirect')).toBeNull()
  })
})
