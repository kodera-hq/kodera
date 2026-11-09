import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import {
  useActiveSubscriptionQuery,
  useFallbackTenantIdQuery,
  useLatestIssuedInvoiceQuery,
  useStatusSummaryQuery,
} from './queries'
import { ContractCard } from './ContractCard'
import { SupportCard } from './SupportCard'
import * as analytics from './analytics'
import { ApplicationsCard } from './ApplicationsCard'
const responses = vi.hoisted(() => ({ body: { data: [], has_more: false } as unknown }))
beforeEach(() => {
  responses.body = { data: [], has_more: false }
})
vi.mock('../../api/client', () => ({
  coreApi: () => ({ GET: async () => ({ data: responses.body }) }),
}))
vi.mock('../../ui/LinkButton/LinkButton', () => ({
  LinkButton: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

describe('successful empty reads', () => {
  it.each(['fallback', 'subscription', 'invoice'] as const)(
    '%s preserves successful absence',
    async (kind) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
      const { result, unmount } = renderHook(
        () =>
          kind === 'fallback'
            ? useFallbackTenantIdQuery('org', true)
            : kind === 'subscription'
              ? useActiveSubscriptionQuery('org', true)
              : useLatestIssuedInvoiceQuery('org', true),
        { wrapper }
      )
      await waitFor(() => expect(result.current.isPending).toBe(false))
      expect(result.current.isSuccess).toBe(true)
      expect(result.current.data).toBeNull()
      unmount()
      client.clear()
    }
  )
})

it('does not announce clipboard success while write is still pending', async () => {
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(new Promise(() => {}))
  render(
    <ApplicationsCard
      apps={[{ code: 'visio', name: 'Visio', url: 'https://visio.example.test', state: 'live' }]}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
})

it.each(['contract', 'support'] as const)(
  'renders a recoverable %s error instead of a permanent skeleton',
  (kind) => {
    const retry = vi.fn()
    render(
      kind === 'contract' ? (
        <ContractCard subscription={undefined} errored onRetry={retry} />
      ) : (
        <SupportCard org="acme-sa" helpContext={undefined} errored onRetry={retry} />
      )
    )
    expect(screen.getByRole('status')).toHaveTextContent('momentanément indisponible')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  }
)

it('handles a denied clipboard write without success feedback or analytics', async () => {
  const user = userEvent.setup()
  const tracked = vi.spyOn(analytics, 'trackAppUrlCopied')
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('synthetic denial'))
  render(
    <ApplicationsCard
      apps={[{ code: 'visio', name: 'Visio', url: 'https://visio.example.test', state: 'live' }]}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  expect(
    await screen.findByText('Copie impossible. Sélectionnez l’adresse pour la copier.')
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
  expect(tracked).not.toHaveBeenCalled()
})

it.each(['fallback', 'subscription', 'invoice'] as const)(
  'does not mistake a malformed %s page for successful absence',
  async (kind) => {
    responses.body = {}
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(
      () =>
        kind === 'fallback'
          ? useFallbackTenantIdQuery('org', true)
          : kind === 'subscription'
            ? useActiveSubscriptionQuery('org', true)
            : useLatestIssuedInvoiceQuery('org', true),
      { wrapper }
    )
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.isError).toBe(true)
    expect(result.current.data).toBeUndefined()
    unmount()
    client.clear()
  }
)

it('rejects a summary without an explicit tenant identifier or absence', async () => {
  responses.body = {}
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result, unmount } = renderHook(() => useStatusSummaryQuery('org'), { wrapper })
  await waitFor(() => expect(result.current.isPending).toBe(false))
  expect(result.current.isError).toBe(true)
  unmount()
  client.clear()
})

it('does not label a replacement URL copied when an older write completes', async () => {
  const user = userEvent.setup()
  let resolve!: () => void
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  const app = {
    code: 'visio' as const,
    name: 'Visio',
    url: 'https://old.example.test',
    state: 'live' as const,
  }
  const { rerender } = render(<ApplicationsCard apps={[app]} />)
  await user.click(screen.getByRole('button', { name: 'Copier' }))
  rerender(<ApplicationsCard apps={[{ ...app, url: 'https://new.example.test' }]} />)
  await act(async () => {
    resolve()
  })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Copié' })).toBeNull()
})
