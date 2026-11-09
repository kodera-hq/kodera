import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type * as ApiClient from '../../api/client'
import { User, UserManager } from 'oidc-client-ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { AuthProvider } from '../../auth/AuthProvider'
import { authAdapter } from '../../auth/oidc'
import { rootRoute } from '../../app/root-route'
import { orgRoute } from '../../app/org-route'
import { orderRouteWithChildren } from './routes'
import { saveEditable } from './editableStorage'
import { emptyDraft } from './draft'
import type { OrderDraft } from './draft'

const { get, loadCurrentUser, oldMe } = vi.hoisted(() => ({
  get: vi.fn(),
  loadCurrentUser: vi.fn(),
  oldMe: {
    id: '11111111-2222-4333-8444-555555555555',
    email: 'old@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        issuer: 'https://id.example.test/realms/acme-sa',
        realm: 'acme-sa',
        subject: 'subject',
        email: 'old@example.test',
        mfa_enrolled: true,
      },
    ],
    organisations: [
      {
        identity_id: '00000000-0000-4000-8000-000000000003',
        membership_id: '00000000-0000-4000-8000-000000000002',
        state: 'active',
        role: 'org_owner',
        organisation: {
          id: '00000000-0000-4000-8000-000000000001',
          slug: 'acme-sa',
          name: 'Acme',
          realm: 'acme-sa',
        },
      },
    ],
  },
}))
// `ApiProblem` stays real: the error screens tell a 401 from any other failure by it.
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  coreApi: () => ({ GET: get }),
  setTokenProvider: () => {},
}))
vi.mock('../../app/currentUser', () => ({
  loadCurrentUser,
}))
vi.mock('../../app/Shell', () => ({
  Shell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('../../app/SessionExpiryDialog', () => ({ SessionExpiryDialog: () => null }))
// The order's billing gate is `OrderGate.test.tsx`'s subject; here the deployment bills.
vi.mock('../home/queries', () => ({
  useStatusSummaryQuery: () => ({ data: { billing_enabled: true }, isLoading: false }),
}))
vi.mock('./PlanStep', () => ({
  PlanStep: ({ draft }: { draft: OrderDraft }) => (
    <p>Editable choice: {draft.packCode ?? 'empty'}</p>
  ),
}))
const issuer = 'https://id.example.test/realms/acme-sa'
const owner = {
  issuer,
  subject: 'subject',
  organisationId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  identityId: '00000000-0000-4000-8000-000000000003',
  generation: 0,
}
function freshMe(active = true) {
  return {
    id: 'person',
    email: 'person@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: owner.identityId,
        issuer,
        subject: owner.subject,
        realm: 'acme-sa',
        email: 'person@example.test',
      },
    ],
    organisations: [
      {
        organisation: { id: owner.organisationId, slug: 'acme-sa', name: 'Acme' },
        membership_id: owner.membershipId,
        identity_id: owner.identityId,
        state: active ? 'active' : 'removed',
        role: 'org_owner',
      },
    ],
  }
}
beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  get.mockReset()
  loadCurrentUser.mockReset()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(
    new User({
      access_token: 'token',
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      profile: { iss: issuer, sub: owner.subject, aud: 'console', iat: 0, exp: 9999999999 },
    })
  )
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()
  const { generation, credentialGeneration } = authAdapter.getSnapshot()
  loadCurrentUser.mockResolvedValue({ me: oldMe, generation, credentialGeneration })
})
afterEach(async () => {
  await authAdapter.signOut()
  vi.unstubAllEnvs()
})
function mount(path = '/acme-sa/order/known/plan') {
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([orderRouteWithChildren])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  return render(
    // The organisation layout reads the workspace tenant from the query cache, as in the app.
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider adapter={authAdapter}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  )
}
it('waits for actual fresh order context before hydrating an owned draft on deep entry', async () => {
  saveEditable({ ...emptyDraft(), draftId: 'known', packCode: 'visio' }, owner)
  let finish!: (result: unknown) => void
  get.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  mount()
  expect(screen.queryByText('Editable choice: visio')).not.toBeInTheDocument()
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  expect(get.mock.calls[0]?.[0]).toBe('/me')
  finish({ data: freshMe() })
  expect(await screen.findByText('Editable choice: visio')).toBeInTheDocument()
  expect(
    screen.getByText(
      'L’envoi des commandes est temporairement suspendu. Vous pouvez préparer votre brouillon.'
    )
  ).toBeInTheDocument()
})
it('refuses revoked fresh membership even when the parent loader retains its old owner role', async () => {
  get.mockResolvedValueOnce({ data: freshMe(false) })
  mount()
  expect(
    await screen.findByText(
      'Nous n’avons pas pu vérifier vos droits pour cette commande. Réessayez avant de poursuivre.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByText(/Editable choice:/)).not.toBeInTheDocument()
})

it.each(['org_admin', 'org_billing', 'org_member', 'member'])(
  'does not mount editable ordering for fresh %s membership',
  async (role) => {
    const me = freshMe()
    me.organisations[0]!.role = role
    get.mockResolvedValueOnce({ data: me })
    mount()
    expect(
      await screen.findByText(
        'Seul le propriétaire de l’organisation peut préparer cette commande et générer son DPA.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Editable choice:/)).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
  }
)

it('retries failed fresh ownership verification without reloading or rendering stale authority', async () => {
  get.mockRejectedValueOnce(new Error('temporary Core failure'))
  mount()
  const retry = await screen.findByRole('button', { name: 'Réessayer' })
  expect(screen.queryByText(/Editable choice:/)).not.toBeInTheDocument()
  let finish!: (result: unknown) => void
  get.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await userEvent.click(retry)
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(/Editable choice:/)).not.toBeInTheDocument()
  finish({ data: freshMe() })
  expect(await screen.findByText('Editable choice: empty')).toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(2)
})
