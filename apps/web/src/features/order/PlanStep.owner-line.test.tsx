// The sentence a non-owner reads in place of the order form: « Seul le propriétaire peut passer
// commande. Demandez à … ». It names the owner by their name, else by their address where Core
// discloses it. From a member Core withholds a colleague's address (contract 0.42.0, « Directory
// privacy »), omitted or `null` alike: the sentence then names no one, and must still say whom to
// ask, never a dash, a blank or the word « null ».

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { configure, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { member, type Membership } from '@/mocks/overlays/support/people'
import { emptyDraft } from './draft'
import { PlanStep } from './PlanStep'
import type { OrderRole } from './PlanStep'

// The waits are for a read MSW answers: long, so that only a wrong sentence fails, not a late one.
configure({ asyncUtilTimeout: 10_000 })
vi.setConfig({ testTimeout: 30_000 })

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

function askedAs(owner: Membership) {
  server.use(
    http.get('*/api/v1/organisations/:organisation_id/memberships', () =>
      HttpResponse.json({ data: [owner], next_cursor: null, has_more: false })
    )
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  // A member's own role in the order: not the owner's, so the sentence is drawn, not the form.
  const role: OrderRole = 'member'
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
  /** Resolves once the owner was read: what is drawn from then on is drawn from the answer. */
  return () =>
    waitFor(() =>
      expect(client.getQueryState(['order', 'organisation-owner', 'org-1'])?.status).toBe('success')
    )
}

const SENTENCE = 'Seul le propriétaire peut passer commande. Demandez à'
const SOMEONE = 'un⋅e administrateur⋅trice de votre organisation'

it('names the owner by their name', async () => {
  const read = askedAs(member('Marie Dupont', 'marie.dupont@acme.fr', 'org_owner'))
  await read()
  expect(await screen.findByText(`${SENTENCE} Marie Dupont.`)).toBeVisible()
})

it('names the owner by their address when Core discloses one and they chose no name', async () => {
  const read = askedAs(member(null, 'marie.dupont@acme.fr', 'org_owner'))
  await read()
  expect(await screen.findByText(`${SENTENCE} marie.dupont@acme.fr.`)).toBeVisible()
})

it.each([
  ['null', { email: null }],
  ['omitted', {}],
  ['empty', { email: '' }],
] as const)(
  'says whom to ask when the owner has no name and their address is withheld (%s)',
  async (_form, withheld) => {
    const owner: Membership = { ...member('  ', null, 'org_owner'), ...withheld }
    const read = askedAs(owner)
    await read()
    expect(await screen.findByText(`${SENTENCE} ${SOMEONE}.`)).toBeVisible()
    expect(document.body).not.toHaveTextContent(/Demandez à (—|null|undefined|\s*\.)/)
  }
)
