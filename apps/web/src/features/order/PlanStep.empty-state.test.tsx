import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { handlers as emptyHandlers } from '@/mocks/overlays/order.catalogue-empty'
import { handlers as unavailableHandlers } from '@/mocks/overlays/order.catalogue-unavailable'
import { emptyDraft } from './draft'
import { PlanStep } from './PlanStep'
import type { OrderRole } from './PlanStep'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.test/api/v1')
  server.use(...catalogueHandlers)
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const role: OrderRole = 'org_owner'
  render(
    <QueryClientProvider client={client}>
      <PlanStep
        draft={emptyDraft()}
        update={vi.fn()}
        role={role}
        organisationId="org-1"
        onContinue={vi.fn()}
        onRequestQuote={vi.fn()}
      />
    </QueryClientProvider>
  )
}

async function expectEmptyHierarchy() {
  const emptyHeading = await screen.findByRole('heading', {
    level: 2,
    name: /Les formules sont momentanément indisponibles/,
  })
  expect(emptyHeading).toBeVisible()
  expect(emptyHeading).toHaveTextContent('support@kodera.io')
  const headings = screen.getAllByRole('heading')
  expect(headings.map((heading) => heading.tagName)).toEqual(['H1', 'H2'])
  expect(headings[0]).toHaveTextContent('Choisissez votre formule')
  expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Continuer' })).not.toBeInTheDocument()
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

it('places valid-empty catalogue feedback directly under the plan heading without skipping a level', async () => {
  server.use(...emptyHandlers)
  renderPlan()
  await expectEmptyHierarchy()
})

it('keeps loading distinct until the catalogue resolves successfully empty', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    requested = resolve
  })
  server.use(
    http.get('*/api/v1/catalog/capacity-tiers', async () => {
      requested()
      await pending
      return HttpResponse.json({ data: [], next_cursor: null, has_more: false })
    })
  )
  renderPlan()
  try {
    await requestStarted
    expect(
      screen.queryByText(/Les formules sont momentanément indisponibles/)
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  } finally {
    release()
  }
  await expectEmptyHierarchy()
})

it('keeps failure retry available and reaches valid-empty feedback after a successful retry', async () => {
  const user = userEvent.setup()
  server.use(...unavailableHandlers)
  renderPlan()
  expect(await screen.findByRole('alert')).toHaveTextContent('support@kodera.io')
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Choisissez votre formule')
  expect(
    screen.queryByText(/Les formules sont momentanément indisponibles/)
  ).not.toBeInTheDocument()
  const retry = screen.getByRole('button', { name: 'Réessayer' })
  expect(retry).toBeEnabled()
  server.use(...catalogueHandlers)
  server.use(...emptyHandlers)
  await user.click(retry)
  await expectEmptyHierarchy()
})
