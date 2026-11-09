import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'
import { saveInvitation, INVITATION_RECOVERY_KEY, type InvitationOwner } from './invitationRecovery'
import '@/i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '../../ui/Toast/Toast'
import { PeopleInviteBody, PeopleListBody, PeopleRecoveryGate } from './PeopleArea'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  listeners: new Set<() => void>(),
  token: 'credential' as string | undefined,
  session: {} as AuthSessionSnapshot,
  me: {} as components['schemas']['Me'],
  meGeneration: 4,
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
  useSearch: () => ({}),
  useParams: () => ({}),
}))
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => state.session }))
vi.mock('../../auth/oidc', () => ({
  authAdapter: {
    getSnapshot: () => state.session,
    getAccessToken: () => state.token,
    subscribe: (listener: () => void) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
  },
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({
      me: state.me,
      membership: state.me.organisations[0],
      meGeneration: state.meGeneration,
    }),
  },
}))
vi.mock('./PeopleScreen', () => ({
  PeopleScreen: ({ children }: { children?: ReactNode }) => (
    <>
      <h1>People list</h1>
      {children}
    </>
  ),
}))
const owner: InvitationOwner = {
  issuer: 'https://id.example.test/realms/acme-sa',
  subject: 'owner',
  organisationId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  identityId: '00000000-0000-4000-8000-000000000003',
  generation: 4,
  role: 'org_owner',
}
function setup() {
  state.token = 'credential'
  state.meGeneration = 4
  state.session = {
    status: 'ready',
    generation: 4,
    credentialGeneration: 1,
    user: {
      realm: 'acme-sa',
      identity: { issuer: owner.issuer, subject: owner.subject },
    },
  }
  state.me = {
    id: '00000000-0000-4000-8000-000000000004',
    email: 'owner@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: owner.identityId,
        issuer: owner.issuer,
        subject: owner.subject,
        realm: 'acme-sa',
        email: 'owner@example.test',
      },
    ],
    organisations: [
      {
        organisation: { id: owner.organisationId, slug: 'acme-sa', name: 'Acme' },
        membership_id: owner.membershipId,
        identity_id: owner.identityId,
        role: 'org_owner',
        state: 'active',
      },
    ],
  }
  saveInvitation(owner, { text: 'unfinished@', role: 'org_admin', open: true })
}
afterEach(() => {
  state.listeners.clear()
  vi.clearAllMocks()
  sessionStorage.clear()
})
it('reopens the actual People list destination only after matching current authority and leaves consumption to the drawer', async () => {
  setup()
  render(<PeopleListBody />)
  expect(screen.getByRole('heading')).toHaveTextContent('People list')
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith({ to: '/acme-sa/people/invite', replace: true })
  )
  expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).not.toBeNull()
})
it.each(['pending', 'credential', 'stale', 'other owner', 'permission'])(
  'does not reopen from %s authority',
  async (failure) => {
    setup()
    switch (failure) {
      case 'pending':
        state.session = { ...state.session, status: 'pending' }
        break
      case 'credential':
        state.token = undefined
        break
      case 'stale':
        state.meGeneration--
        break
      case 'other owner':
        state.me.identities[0]!.subject = 'another'
        break
      case 'permission':
        state.me.organisations[0]!.role = 'org_member'
        break
    }
    render(
      <PeopleRecoveryGate>
        <PeopleListBody />
      </PeopleRecoveryGate>
    )
    await Promise.resolve()
    expect(state.navigate).not.toHaveBeenCalled()
    if (failure === 'other owner' || failure === 'permission')
      expect(sessionStorage.getItem(INVITATION_RECOVERY_KEY)).toBeNull()
  }
)

it('resets the actual private drawer when the SDK context is replaced before new authority arrives', () => {
  setup()
  const client = new QueryClient()
  const tree = () => (
    <QueryClientProvider client={client}>
      <ToastProvider label="Notifications" viewportLabel="Notifications" closeLabel="Close">
        <PeopleRecoveryGate>
          <PeopleInviteBody />
        </PeopleRecoveryGate>
      </ToastProvider>
    </QueryClientProvider>
  )
  const rendered = render(tree())
  const field = screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  expect(field).toHaveValue('unfinished@')
  state.session = {
    ...state.session,
    generation: 5,
    user: { ...state.session.user!, identity: { issuer: owner.issuer, subject: 'replacement' } },
  }
  rendered.rerender(tree())
  expect(screen.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })).toHaveValue('')
  expect(screen.getByRole('radio', { name: /^Membre —/ })).toBeChecked()
})
