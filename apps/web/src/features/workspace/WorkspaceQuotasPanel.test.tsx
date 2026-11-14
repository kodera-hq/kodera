import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { WorkspaceQuotasPanel } from './WorkspaceQuotasPanel'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: ReactNode
    to: string
    params: { org: string }
    className?: string
  }) => (
    <a href={to.replace('$org', params.org)} className={className}>
      {children}
    </a>
  ),
}))

beforeEach(async () => {
  await i18n.changeLanguage('fr')
})

afterEach(async () => {
  await i18n.changeLanguage('fr')
})

const ownerRole = 'org_owner' as const
const billingRole = 'org_billing' as const

describe('WorkspaceQuotasPanel accessible quota meters (`style-src-attr none`)', () => {
  it('renders normal (< 80%), warning (>= 80%), and limit (100%) meters with zero `[style]` attributes', async () => {
    const { container, rerender } = render(
      <WorkspaceQuotasPanel
        org="acme-sa"
        organisationId="org-1"
        role={ownerRole}
        initialUsage={{
          usage: {
            seats: 40,
            mediaBytes: 85_000_000_000,
            pages: 500,
          },
          limits: {
            seats: 100,
            mediaBytes: 100_000_000_000,
            pages: 500,
          },
          measuredAt: '2026-11-13T12:00:00Z',
        }}
      />
    )

    const meters = screen.getAllByRole('meter')
    expect(meters).toHaveLength(3)

    // Seats: 40 / 100 (40%, Normal)
    expect(meters[0]).toHaveAttribute('aria-valuenow', '40')
    expect(meters[0]).toHaveAttribute('aria-valuemin', '0')
    expect(meters[0]).toHaveAttribute('aria-valuemax', '100')
    expect(meters[0]?.getAttribute('aria-valuetext')).toMatch(/40 sur 100 sièges.*Normal/)

    // Storage: 85 GB / 100 GB (85%, Warning >= 80%)
    expect(meters[1]).toHaveAttribute('aria-valuenow', '85000000000')
    expect(meters[1]).toHaveAttribute('aria-valuemax', '100000000000')
    expect(screen.getByText(/Seuil d’alerte \(≥ 80\s%\)/)).toBeVisible()

    // Pages: 500 / 500 (100%, Limit reached)
    expect(meters[2]).toHaveAttribute('aria-valuenow', '500')
    expect(meters[2]).toHaveAttribute('aria-valuemax', '500')
    expect(screen.getByText(/Limite atteinte \(100\s%\)/)).toBeVisible()
    expect(screen.getByText(/Une limite de quota est atteinte/)).toBeVisible()

    // Owner gets direct upgrade CTA to order flow
    expect(screen.getByRole('link', { name: 'Passer à une capacité supérieure' })).toHaveAttribute(
      'href',
      '/acme-sa/order'
    )

    // Strict CSP: zero inline style attributes anywhere in the rendered subtree!
    expect(container.querySelectorAll('[style]')).toHaveLength(0)

    // Verify EN parity + unlimited (`null` limit) + 402 / 413 structured problem banner
    await i18n.changeLanguage('en')
    rerender(
      <WorkspaceQuotasPanel
        org="acme-sa"
        organisationId="org-1"
        role={billingRole}
        activeProblem={{ status: 413, detail: 'Upload exceeds remaining attachment quota.' }}
        initialUsage={{
          usage: {
            seats: 82,
            mediaBytes: 50_000_000_000,
            pages: 25,
          },
          limits: {
            seats: 100,
            mediaBytes: 50_000_000_000,
            pages: null,
          },
          measuredAt: '2026-11-13T12:00:00Z',
        }}
      />
    )

    expect(
      screen.getByText(/Attachment storage quota exceeded \(HTTP 413\)/)
    ).toBeVisible()
    expect(screen.getByText('Upload exceeds remaining attachment quota.')).toBeVisible()
    expect(screen.getByText('Approaching limit (≥ 80%)')).toBeVisible()
    expect(screen.getByText('Limit reached (100%)')).toBeVisible()
    expect(screen.getByText('Unlimited')).toBeVisible()
    expect(screen.getAllByRole('meter')).toHaveLength(2)
    expect(
      screen.getAllByRole('link', { name: 'View subscription and plan' })[0]
    ).toHaveAttribute('href', '/acme-sa/invoices/subscription')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('surfaces structured HTTP 402 seat/page exhaustion banner with upgrade CTA', () => {
    const { container } = render(
      <WorkspaceQuotasPanel
        org="acme-sa"
        organisationId="org-1"
        role={ownerRole}
        activeProblem={{ status: 402, detail: 'Seat quota reached for current plan.' }}
        initialUsage={{
          usage: { seats: 10, mediaBytes: 1_000_000, pages: 10 },
          limits: { seats: 10, mediaBytes: 10_000_000_000, pages: 100 },
          measuredAt: '2026-11-13T12:00:00Z',
        }}
      />
    )

    expect(
      screen.getByText(/Quota de sièges ou de pages atteint \(HTTP 402\)/)
    ).toBeVisible()
    expect(screen.getByText('Seat quota reached for current plan.')).toBeVisible()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })
})
