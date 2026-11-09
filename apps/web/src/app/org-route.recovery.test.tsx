import { createMemoryHistory, createRoute, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authAdapter } from '../auth/oidc'
import { onBeforeSignIn } from '../auth/beforeSignIn'
import { orgRoute } from './org-route'
import { rootRoute } from './root-route'
import { loadCurrentUser } from './currentUser'
import { loginRoute } from '../features/login/routes'
import type { components } from '../api/schema'
import type { AuthSessionSnapshot } from '../auth/AuthAdapter'

vi.mock('./currentUser', () => ({ loadCurrentUser: vi.fn() }))
const me: components['schemas']['Me'] = {
  id: '00000000-0000-4000-8000-000000000004',
  email: 'owner@example.test',
  locale: 'fr',
  staff: false,
  identities: [],
  organisations: [
    {
      organisation: { id: '00000000-0000-4000-8000-000000000001', slug: 'acme-sa', name: 'Acme' },
      membership_id: '00000000-0000-4000-8000-000000000002',
      state: 'active',
      role: 'org_owner',
    },
  ],
}
let session: AuthSessionSnapshot
let token: string | undefined
let unsubscribe: (() => void) | undefined
beforeEach(() => {
  token = 'credential'
  session = {
    status: 'ready',
    generation: 4,
    credentialGeneration: 7,
    user: {
      realm: 'acme-sa',
      identity: { issuer: 'https://id.example.test/realms/acme-sa', subject: 'owner' },
    },
  }
  vi.spyOn(authAdapter, 'getSnapshot').mockImplementation(() => session)
  vi.spyOn(authAdapter, 'getAccessToken').mockImplementation(() => token)
  vi.spyOn(authAdapter, 'getUser').mockImplementation(() => session.user)
  vi.spyOn(authAdapter, 'restoreSession').mockResolvedValue(true)
  vi.spyOn(authAdapter, 'signIn').mockResolvedValue()
  vi.mocked(loadCurrentUser).mockResolvedValue({
    me,
    generation: 4,
    credentialGeneration: 7,
  })
})
afterEach(() => {
  unsubscribe?.()
  unsubscribe = undefined
  vi.restoreAllMocks()
  sessionStorage.clear()
})
function router() {
  const page = createRoute({
    getParentRoute: () => orgRoute,
    path: 'people',
    component: () => null,
  })
  const invite = createRoute({
    getParentRoute: () => orgRoute,
    path: 'people/invite',
    component: () => null,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([loginRoute, orgRoute.addChildren([page, invite])]),
    history: createMemoryHistory({ initialEntries: ['/acme-sa/people'] }),
  })
}
it('does not park a cold expired same-realm entry without retained loader authority', async () => {
  token = undefined
  const calls: string[] = []
  unsubscribe = onBeforeSignIn(() => calls.push('save'))
  vi.mocked(authAdapter.restoreSession).mockImplementation(async () => {
    calls.push('restore')
    return false
  })
  vi.mocked(authAdapter.signIn).mockImplementation(async () => {
    calls.push('redirect')
    token = 'new'
  })
  const actual = router()
  await actual.load()
  expect(calls).toEqual(['restore', 'redirect'])
  expect(actual.state.status).toBe('idle')
  expect(actual.state.matches.find((match) => match.routeId === orgRoute.id)?.status).toBe(
    'success'
  )
})

it('does not park an expired retry when the prior organisation match failed', async () => {
  vi.mocked(loadCurrentUser).mockRejectedValueOnce(new Error('Initial current-user failure.'))
  const actual = router()
  await actual.load()
  expect(actual.state.matches.find((match) => match.routeId === orgRoute.id)?.status).toBe('error')

  token = undefined
  const calls: string[] = []
  vi.mocked(authAdapter.restoreSession).mockImplementation(async () => {
    calls.push('restore')
    return false
  })
  vi.mocked(authAdapter.signIn).mockImplementation(async () => {
    calls.push('redirect')
    token = 'new'
  })

  await actual.invalidate()
  expect(calls).toEqual(['restore', 'redirect'])
  expect(actual.state.status).toBe('idle')
  expect(actual.state.matches.find((match) => match.routeId === orgRoute.id)?.status).toBe(
    'success'
  )
})

it('does not park a cached successful organisation match when re-entering after expiry', async () => {
  const actual = router()
  await actual.load()
  await actual.navigate({ to: '/login' })

  token = undefined
  const calls: string[] = []
  vi.mocked(authAdapter.restoreSession).mockImplementation(async () => {
    calls.push('restore')
    return false
  })
  vi.mocked(authAdapter.signIn).mockImplementation(async () => {
    calls.push('redirect')
    token = 'new'
  })

  await actual.navigate({ to: '/$org/people', params: { org: 'acme-sa' } })
  expect(calls).toEqual(['restore', 'redirect'])
  expect(actual.state.status).toBe('idle')
  expect(actual.state.location.pathname).toBe('/acme-sa/people')
  expect(actual.state.matches.find((match) => match.routeId === orgRoute.id)?.status).toBe(
    'success'
  )
})

it('saves and reauthenticates when expired Browser Back enters a different leaf', async () => {
  const actual = router()
  await actual.load()
  await actual.navigate({ to: '/$org/people/invite', params: { org: 'acme-sa' } })

  token = undefined
  const calls: string[] = []
  unsubscribe = onBeforeSignIn(() => calls.push('save'))
  vi.mocked(authAdapter.restoreSession).mockImplementation(async () => {
    calls.push('restore')
    return false
  })
  vi.mocked(authAdapter.signIn).mockImplementation(async () => {
    calls.push('redirect')
    token = 'new'
  })

  actual.history.back()
  await actual.load()
  expect(calls).toEqual(['save', 'restore', 'redirect'])
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/people')
})

it.each(['live', 'initial', 'other realm'])('does not save on %s routing', async (mode) => {
  if (mode === 'initial') {
    token = undefined
    session = {
      status: 'unauthenticated',
      generation: 5,
      credentialGeneration: 8,
      user: undefined,
    }
  }
  if (mode === 'other realm') session = { ...session, user: { ...session.user!, realm: 'another' } }
  const save = vi.fn()
  unsubscribe = onBeforeSignIn(save)
  await router().load()
  expect(save).not.toHaveBeenCalled()
})
it('returns the captured /me generation from the actual route loader', async () => {
  const actual = router()
  await actual.load()
  const data = actual.state.matches.find((match) => match.routeId === orgRoute.id)?.loaderData
  expect(data).toMatchObject({ me, meGeneration: 4, meCredentialGeneration: 7 })
})
it('rejects a held /me after session generation replacement instead of restamping it', async () => {
  let release!: (value: Awaited<ReturnType<typeof loadCurrentUser>>) => void
  vi.mocked(loadCurrentUser).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const actual = router()
  const loading = actual.load()
  await vi.waitFor(() => expect(release).toBeDefined())
  session = { ...session, generation: 5 }
  release({ me, generation: 4, credentialGeneration: 7 })
  await loading
  const match = actual.state.matches.find((entry) => entry.routeId === orgRoute.id)
  expect(match?.status).toBe('error')
  expect(match?.loaderData).toBeUndefined()
})

it('rejects a held /me after credential replacement inside the same session', async () => {
  let release!: (value: Awaited<ReturnType<typeof loadCurrentUser>>) => void
  vi.mocked(loadCurrentUser).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const actual = router()
  const loading = actual.load()
  await vi.waitFor(() => expect(release).toBeDefined())
  session = { ...session, credentialGeneration: 8 }
  release({ me, generation: 4, credentialGeneration: 7 })
  await loading
  const match = actual.state.matches.find((entry) => entry.routeId === orgRoute.id)
  expect(match?.status).toBe('error')
  expect(match?.loaderData).toBeUndefined()
})
