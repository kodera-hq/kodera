import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '../../api/client'
import { EXAMPLES } from '../../mocks/generated/examples'
import type { components } from '../../api/schema'
import { ToastProvider } from '../../ui/Toast/Toast'
import { HomeDefault } from './HomeDefault'

const fixture = vi.hoisted(() => ({
  subscriptionError: undefined as unknown,
  helpError: false,
  invitationsEnabled: vi.fn(),
}))
vi.mock('./queries', () => ({
  useStatusSummaryQuery: () => ({
    data: {
      overall: 'operational',
      capacity: {
        participants: { pct: 92, used: 92, included: 100 },
        threshold_pct: 90,
        upgrade_prompt: true,
      },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useActiveSubscriptionQuery: () => ({
    data: undefined,
    isError: !!fixture.subscriptionError,
    error: fixture.subscriptionError,
    refetch: vi.fn(),
  }),
  useLatestIssuedInvoiceQuery: () => ({ data: null, isError: false, refetch: vi.fn() }),
  usePendingInvitationsQuery: (_id: string, enabled: boolean) => {
    fixture.invitationsEnabled(enabled)
    return { data: { invitations: [], hasMore: false }, isError: false }
  },
  useHelpContextQuery: () => ({ data: undefined, isError: fixture.helpError, refetch: vi.fn() }),
  useTenantStatusQuery: () => ({
    data: { apps: [], agent: { stale: false } },
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/acme-sa/people">{children}</a>,
}))
const me = EXAMPLES.getMe.body as components['schemas']['Me']
function mounted(role: components['schemas']['OrganisationRole']) {
  return render(
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <HomeDefault
        me={me}
        org="acme-sa"
        organisationId="org-id"
        tenantId="tenant-id"
        role={role}
        online
      />
    </ToastProvider>
  )
}
beforeEach(() => {
  fixture.subscriptionError = undefined
  fixture.helpError = false
  fixture.invitationsEnabled.mockClear()
})
it.each(['org_owner', 'org_admin', 'org_billing', 'org_member'] as const)(
  'uses explicit management and billing visibility for %s',
  (role) => {
    mounted(role)
    const invite = screen.queryByRole('link', { name: 'Inviter des personnes' })
    if (role === 'org_owner' || role === 'org_admin') {
      expect(invite).toHaveAttribute('href', '/acme-sa/people/invite')
    } else {
      expect(invite).toBeNull()
    }
    expect(fixture.invitationsEnabled).toHaveBeenCalledWith(
      role === 'org_owner' || role === 'org_admin'
    )
    expect(screen.queryByRole('link', { name: 'Voir les formules' }) !== null).toBe(
      role !== 'org_member'
    )
  }
)
it('shows real subscription and help failures as card errors', () => {
  fixture.subscriptionError = new Error('synthetic unavailable')
  fixture.helpError = true
  mounted('org_owner')
  expect(screen.getAllByText(/momentanément indisponible/)).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Réessayer' })).toHaveLength(3)
})
it('hides forbidden subscription/invoice cards rather than retrying forbidden reads', () => {
  fixture.subscriptionError = new ApiProblem({
    type: 'https://kodera.io/problems/forbidden',
    status: 403,
    title: 'synthetic',
  })
  mounted('org_owner')
  expect(screen.queryByText('Prochaine facture')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull()
})
