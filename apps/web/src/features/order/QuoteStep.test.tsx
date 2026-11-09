// Ruling C: the quote page's subtitle said « Au-delà de 330 personnes » while
// the plans stop at 333 (the largest tier's range, from the catalogue). It now
// names the same catalogue-derived cutoff as the plan step.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { EXAMPLES } from '@/mocks/generated/examples'
import { QuoteStep } from './QuoteStep'

const BASE = 'https://core.test/api/v1'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  server.use(...catalogueHandlers)
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

it('names the cutoff the plans stop at, from the catalogue', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <QuoteStep onBack={vi.fn()} />
    </QueryClientProvider>
  )
  expect(
    await screen.findByText('Au-delà de 666 personnes, nous dimensionnons votre espace avec vous.')
  ).toBeInTheDocument()
  expect(screen.queryByText(/660/)).not.toBeInTheDocument()
})

it('draws the needs field with the control edge', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <QuoteStep onBack={vi.fn()} />
    </QueryClientProvider>
  )
  await screen.findByText(/Au-delà de 666 personnes/)
  expect(container.querySelector('#quote-needs')).toHaveClass('border-c-border-input')
})

function renderQuote() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <QuoteStep onBack={vi.fn()} />
    </QueryClientProvider>
  )
}

it('sends the headcount typed, after the field is left (live defect, 11-06)', async () => {
  const user = userEvent.setup()
  const subjects: string[] = []
  server.use(
    http.post(`${BASE}/support/tickets`, async ({ request }) => {
      subjects.push(((await request.json()) as { subject: string }).subject)
      return HttpResponse.json(EXAMPLES.createSupportTicket.body, { status: 201 })
    })
  )
  renderQuote()
  const headcount = await screen.findByRole('spinbutton', {
    name: 'Combien de personnes dans votre organisation ?',
  })
  await user.clear(headcount)
  await user.type(headcount, '700')
  // Leaving the field validates it (`mode: 'onBlur'`): the value must stay a number.
  await user.tab()
  expect(screen.queryByText('Indiquez un nombre de personnes.')).toBeNull()
  await user.type(screen.getByRole('textbox', { name: 'Décrivez votre besoin' }), 'Visio pour 700')
  await user.type(screen.getByRole('textbox', { name: 'Votre adresse e-mail' }), 'achats@acme.fr')
  await user.click(screen.getByRole('button', { name: 'Envoyer ma demande' }))
  await waitFor(() => expect(subjects).toEqual(['Devis Enterprise — 700 personnes']))
})

it('says what is missing in French when the headcount is left empty, never zod’s text', async () => {
  const user = userEvent.setup()
  renderQuote()
  const headcount = await screen.findByRole('spinbutton', {
    name: 'Combien de personnes dans votre organisation ?',
  })
  await user.clear(headcount)
  await user.tab()
  expect(await screen.findByText('Indiquez un nombre de personnes.')).toBeInTheDocument()
  expect(screen.queryByText(/Invalid input|expected/)).toBeNull()
})
