// @vitest-environment-options {"url":"https://kodera-asset.localhost/"}
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { setTokenProvider } from '../../api/client'
import { queryClient } from '../../app/queryClient'
import { AppProviders } from '../../app/providers'
import { rootRoute } from '../../app/root-route'
import { authAdapter } from '../../auth/oidc'
import { isDesktopBundledOrigin } from '../../auth/desktopOidc'
import { EXAMPLES } from '../../mocks/generated/examples'
import { server } from '../../mocks/server'
import { selfServeWorkspaceRoute } from './selfServeRoute'
import { loginRoute } from '../login/routes'

const invoke = vi.fn()
let requestFamily = 0
const dispatched: Request[] = []
const session = {
  ok: true,
  access_token: 'synthetic-desktop-bearer',
  expires_in: 300,
  realm: 'community',
  issuer: 'https://auth.example.test/realms/community',
  subject: 'synthetic-member',
}

let nativeSession = session

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(async () => {
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  vi.stubEnv('VITE_CORE_API_URL', `https://core-${++requestFamily}.test/api/v1`)
  dispatched.length = 0
  const transport = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected browser Core fetch'))
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://auth.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'kodera-desktop')
  queryClient.clear()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  Object.defineProperty(window, 'koderaDesktop', { configurable: true, value: { invoke } })
  nativeSession = session
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command !== 'desktop_core_api_request') return nativeSession
    // Simulate the native HTTP boundary against the API fixtures, bypassing WebView fetch.
    const request = new Request(args!['url'] as string, {
      method: args!['method'] as string,
      headers: args!['headers'] as Record<string, string>,
      body:
        args!['bodyBase64'] === undefined
          ? null
          : Uint8Array.from(atob(args!['bodyBase64'] as string), (char) => char.charCodeAt(0)),
      credentials: 'omit',
      redirect: 'error',
    })
    dispatched.push(request)
    const response = await transport(request)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body_base64: btoa(
        Array.from(new Uint8Array(await response.arrayBuffer()), (byte) =>
          String.fromCharCode(byte)
        ).join('')
      ),
    }
  })
  await authAdapter.signIn('community')
  setTokenProvider(() => authAdapter.getAccessToken())
})
afterEach(async () => {
  await act(async () => {
    await authAdapter.signOut()
  })
  queryClient.clear()
  setTokenProvider(() => undefined)
  delete (window as unknown as Record<string, unknown>)['koderaDesktop']
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
afterAll(() => server.close())

async function mount(path = '/workspaces/new') {
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      selfServeWorkspaceRoute,
      loginRoute,
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/$org/workspace',
        component: () => <h1>Workspace ready</h1>,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/$org/order',
        component: () => <h1>Dedicated configuration</h1>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMinMs: 0,
  })
  const rendered = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  )
  await act(async () => {
    await router.load()
  })
  return { ...rendered, router }
}

it.each(['kodera-asset://localhost/', 'https://kodera-asset.localhost/'])(
  'signs in, loads /me and creates a workspace through native Core IPC from %s',
  async (origin) => {
    // Preserve jsdom's DOM and storage while exercising the actual bundled-origin detector.
    const bundledWindow = Object.create(window) as Window
    Object.defineProperty(bundledWindow, 'location', { value: new URL(origin) })
    vi.stubGlobal('window', bundledWindow)
    expect(isDesktopBundledOrigin()).toBe(true)
    const requests: Request[] = []
    server.use(
      http.get('*/api/v1/me', ({ request }) => {
        requests.push(request)
        return HttpResponse.json({ ...EXAMPLES.getMe.body, organisations: [] })
      }),
      http.post('*/api/v1/workspaces/self-serve', async ({ request }) => {
        requests.push(request)
        expect(await request.json()).toEqual({
          name: 'Test Studio',
          slug: 'test-studio',
          locale: 'fr',
        })
        expect(request.headers.get('Idempotency-Key')).toBeTruthy()
        return HttpResponse.json(EXAMPLES.createSelfServeWorkspace.body, { status: 201 })
      })
    )
    await authAdapter.signOut()
    invoke.mockClear()
    const { container, router } = await mount('/login')
    await userEvent.click(await screen.findByRole('button', { name: 'Créer un espace' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/new'))
    expect(invoke).toHaveBeenCalledWith(
      'desktop_oidc_exchange_loopback',
      expect.objectContaining({ realm: 'community', registration: true })
    )
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Nom de l’espace' }),
      'Test Studio'
    )
    expect(container.querySelector('[style]')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Créer mon espace gratuit' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(await screen.findByRole('heading', { name: 'Workspace ready' })).toBeVisible()
    expect(dispatched).toHaveLength(2)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const coreCalls = invoke.mock.calls.filter(
      ([command]) => command === 'desktop_core_api_request'
    )
    expect(coreCalls).toHaveLength(2)
    expect(coreCalls[0]![1]).toEqual(
      expect.objectContaining({
        url: expect.stringMatching(/\/api\/v1\/me$/),
        method: 'GET',
      })
    )
    expect(coreCalls[1]![1]).toEqual(
      expect.objectContaining({
        url: expect.stringMatching(/\/api\/v1\/workspaces\/self-serve$/),
        method: 'POST',
        bodyBase64: btoa(
          JSON.stringify({ name: 'Test Studio', slug: 'test-studio', locale: 'fr' })
        ),
        requestId: expect.stringMatching(/^[0-9a-f]{32}$/),
      })
    )
    for (const [, payload] of coreCalls) {
      expect(payload!['headers']).toEqual(
        expect.objectContaining({
          authorization: 'Bearer synthetic-desktop-bearer',
        })
      )
      expect(payload!['headers']).not.toHaveProperty('origin')
      expect(payload!['headers']).not.toHaveProperty('cookie')
    }
  }
)

it('preserves the existing owner organisation after loading /me', async () => {
  vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', 'true')
  const membership = EXAMPLES.getMe.body.organisations[0]!
  server.use(
    http.get('*/api/v1/me', () =>
      HttpResponse.json({
        ...EXAMPLES.getMe.body,
        organisations: [{ ...membership, role: 'org_owner' }],
      })
    )
  )
  const { router } = await mount('/workspaces/new?plan=sovereign')
  expect(
    await screen.findByRole('button', { name: 'Continuer vers la configuration dédiée' })
  ).toBeEnabled()
  await userEvent.click(
    screen.getByRole('button', { name: 'Continuer vers la configuration dédiée' })
  )
  await waitFor(() => expect(router.state.location.pathname).toBe('/acme-sa/order'))
  expect(router.state.location.search).toEqual({ pack: 'sovereign' })
})

function useAppOrigin() {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
  const appWindow = Object.create(window) as Window
  Object.defineProperty(appWindow, 'location', {
    value: new URL('https://app.kodera.io/workspaces/new?signIn=community'),
  })
  vi.stubGlobal('window', appWindow)
}

it('starts Community OIDC on the app origin and returns to the form without replaying the handoff', async () => {
  await authAdapter.signOut()
  useAppOrigin()
  const signIn = vi.spyOn(authAdapter, 'signIn').mockResolvedValue(undefined)
  await mount('/workspaces/new?signIn=community')
  await waitFor(() => expect(signIn).toHaveBeenCalledWith('community'))
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/workspaces/new')
  expect(dispatched).toHaveLength(0)
  expect(screen.queryByRole('textbox', { name: 'Nom de l’espace' })).toBeNull()
})

it('opens the form without another sign-in for an active Community session on the app origin', async () => {
  useAppOrigin()
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue(session.access_token)
  vi.mocked(globalThis.fetch).mockRestore()
  const signIn = vi.spyOn(authAdapter, 'signIn').mockResolvedValue(undefined)
  server.use(http.get('*/api/v1/me', () => HttpResponse.json(EXAMPLES.getMe.body)))

  const { router } = await mount('/workspaces/new?signIn=community')
  expect(await screen.findByRole('textbox', { name: 'Nom de l’espace' })).toBeVisible()
  expect(router.state.location.href).toBe('/workspaces/new')
  expect(signIn).not.toHaveBeenCalled()
})

it('opens the new free workspace for a Sovereign deep link before checkout is ready', async () => {
  vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', undefined)
  const owned = { ...EXAMPLES.getMe.body.organisations[0]!, role: 'org_owner' }
  const created = EXAMPLES.createSelfServeWorkspace.body
  server.use(
    http.get('*/api/v1/me', () =>
      HttpResponse.json({ ...EXAMPLES.getMe.body, organisations: [owned] })
    ),
    http.post('*/api/v1/workspaces/self-serve', () => HttpResponse.json(created, { status: 201 }))
  )
  const { router } = await mount('/workspaces/new?plan=sovereign')
  await userEvent.type(
    await screen.findByRole('textbox', { name: 'Nom de l’espace' }),
    'Test Studio'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Créer mon espace gratuit' }))
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${created.organisation_slug}/workspace`)
  )
  expect(router.state.location.pathname).not.toBe(`/${owned.organisation.slug}/order`)
  expect(router.state.location.search).toEqual({})
})

it.each([0, 401, 403, 503])('fails closed when /me fails with status %s', async (status) => {
  server.use(
    http.get('*/api/v1/me', () =>
      status === 0
        ? HttpResponse.error()
        : HttpResponse.json(
            {
              type: `https://kodera.io/problems/${status === 401 ? 'unauthenticated' : 'forbidden'}`,
              title: 'Refused',
              status,
            },
            { status }
          )
    )
  )
  const { router } = await mount()
  await waitFor(() =>
    expect(router.state.matches.some((match) => match.status === 'error')).toBe(true)
  )
  expect(screen.queryByRole('textbox', { name: 'Nom de l’espace' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Créer mon espace gratuit' })).toBeNull()
})

it.each([
  { community: false, button: 'Créer un espace' },
  { community: true, button: 'Se connecter' },
  { community: true, button: 'Créer un espace' },
])(
  'preserves the Sovereign plan after 401 recovery through $button (Community: $community)',
  async ({ community, button }) => {
    vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', 'true')
    const destination = '/workspaces/new?plan=sovereign'
    const freshToken = 'synthetic-fresh-desktop-bearer'
    server.use(
      http.get('*/api/v1/me', ({ request }) =>
        request.headers.get('Authorization') === `Bearer ${freshToken}`
          ? HttpResponse.json({ ...EXAMPLES.getMe.body, organisations: [] })
          : HttpResponse.json(
              {
                type: 'https://kodera.io/problems/unauthenticated',
                title: 'Unauthenticated',
                status: 401,
              },
              { status: 401 }
            )
      )
    )
    const { router } = await mount(destination)
    expect(authAdapter.getAccessToken()).toBe(session.access_token)
    invoke.mockClear()
    await userEvent.click(await screen.findByRole('button', { name: 'Se reconnecter' }))
    expect(await screen.findByRole('button', { name: 'Créer un espace' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/login')
    expect(authAdapter.getAccessToken()).toBeUndefined()
    expect(await authAdapter.restoreSession()).toBe(false)
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe(destination)
    expect(dispatched).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('desktop_oidc_clear_session', { realm: 'community' })

    nativeSession = { ...session, access_token: freshToken }
    if (community) {
      await act(async () => {
        await router.navigate({ to: '/login', search: { org: 'community' } })
      })
    }
    await userEvent.click(await screen.findByRole('button', { name: button }))
    expect(await screen.findByRole('textbox', { name: 'Nom de l’espace' })).toBeVisible()
    expect(screen.getByRole('radio', { name: /dédié/i })).toBeChecked()
    expect(invoke).toHaveBeenCalledWith(
      'desktop_oidc_exchange_loopback',
      expect.objectContaining({ realm: 'community', registration: button === 'Créer un espace' })
    )
    expect(router.state.location.href).toBe(destination)
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]?.headers.get('Authorization')).toBe(`Bearer ${freshToken}`)
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBeNull()
  }
)

it('allows a newly registered identity only after the explicit identity-unknown response', async () => {
  server.use(
    http.get('*/api/v1/me', () =>
      HttpResponse.json(
        {
          type: 'https://kodera.io/problems/identity-unknown',
          title: 'No membership yet',
          status: 403,
        },
        { status: 403 }
      )
    )
  )
  await mount()
  expect(await screen.findByRole('textbox', { name: 'Nom de l’espace' })).toBeVisible()
})
