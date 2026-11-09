// Where the status screen's support actions send the customer, for the two
// that no end-to-end scenario reaches or that this change moved:
// - a failed installation that still lists its steps offers the failed step's
//   own "Nous écrire" (no overlay serves `failed` with steps), which must carry
//   the step's reference to the Aide page;
// - "Nous en parler" on the capacity card is about capacity, and the Aide page
//   repeats the topic to the customer (06-support.md §4.0): it used to arrive
//   as `reason=incident`, which the page would have read back as an incident.
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import '@/i18n'
import { StatusScreen } from './StatusScreen'

// `HelpLink` is a router link; these tests render without a router, so it
// renders the URL `helpHref` writes for the same context.
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

const f = vi.hoisted(() => ({
  navigate: vi.fn(),
  status: 'failed' as string,
  steps: [] as unknown[],
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useLoaderData: () => ({
      membership: {
        role: 'org_owner',
        organisation: { id: 'org-id', slug: 'acme-sa', name: 'Acme' },
      },
    }),
    useParams: () => ({ org: 'acme-sa' }),
  },
}))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: f.navigate }) }))
vi.mock('@/ui/LinkButton/LinkButton', () => ({
  LinkButton: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('./ProvisioningOverview', () => ({
  ProvisioningOverview: ({
    onSupport,
  }: {
    onSupport: (context: { reason: 'step-failed'; jobId?: string }) => void
  }) => (
    <button type="button" onClick={() => onSupport({ reason: 'step-failed', jobId: 'job-42' })}>
      step support
    </button>
  ),
}))
vi.mock('./LiveOverview', () => ({
  LiveOverview: ({ onTalkToUs }: { onTalkToUs: () => void }) => (
    <button type="button" onClick={onTalkToUs}>
      capacity support
    </button>
  ),
}))
vi.mock('./queries', () => ({
  useOrganisationTenant: () => ({
    data: { id: 'tenant' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTenantStatus: () => ({
    data: {
      status: f.status,
      agent: { stale: false },
      components: [],
      provisioning_steps: f.steps,
    },
    isLoading: false,
    isError: false,
    dataUpdatedAt: 1,
    refetch: vi.fn(),
  }),
  useActiveSubscription: () => ({ data: null, isLoading: false, isError: false }),
  useOpenIncidents: () => ({ data: [], isLoading: false, isError: false }),
  useStatusComponents: () => ({ data: [], isLoading: false, isError: false }),
  useTenantAvailability: () => ({ data: [], isLoading: false, isError: false }),
}))

beforeEach(() => {
  f.navigate.mockClear()
})

it("sends a failed installation's step support to Aide with the step's reference", () => {
  f.status = 'failed'
  f.steps = [{ key: 'install', state: 'failed', job_id: 'job-42' }]
  render(<StatusScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'step support' }))
  expect(f.navigate).toHaveBeenCalledWith({
    href: '/acme-sa/help?reason=step-failed&job_id=job-42',
  })
})

it('sends « Nous en parler » to Aide as a capacity question, not an incident', () => {
  f.status = 'active'
  f.steps = []
  render(<StatusScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'capacity support' }))
  expect(f.navigate).toHaveBeenCalledWith({ href: '/acme-sa/help?topic=capacity' })
})
