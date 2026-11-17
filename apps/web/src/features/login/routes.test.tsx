import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { rootRoute } from '../../app/root-route'

describe('Community /login routing and tenant escape hatch', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr')
  })

  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')

  afterEach(() => {
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation)
    }
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('validates mode=tenant and treats malformed mode values as absent', async () => {
    const { loginSearchSchema } = await import('./routes')
    expect(loginSearchSchema.parse({})).toEqual({ org: undefined, mode: undefined })
    expect(loginSearchSchema.parse({ mode: 'tenant' })).toEqual({
      org: undefined,
      mode: 'tenant',
    })
    expect(loginSearchSchema.parse({ mode: 'unexpected' })).toEqual({
      org: undefined,
      mode: undefined,
    })
    expect(loginSearchSchema.parse({ org: 'community' })).toEqual({
      org: 'community',
      mode: undefined,
    })
  })

  it('defaults bare /login to Community only on community.* hostnames unless mode=tenant is set', async () => {
    const { shouldRenderCommunityWelcome } = await import('./routes')
    expect(shouldRenderCommunityWelcome('community', undefined, 'localhost')).toBe(true)
    expect(shouldRenderCommunityWelcome('community', 'tenant', 'community.kodera.io')).toBe(true)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.kodera.io')).toBe(true)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.staging.kodera.io')).toBe(
      true
    )
    expect(shouldRenderCommunityWelcome(undefined, 'tenant', 'community.kodera.io')).toBe(false)
    expect(shouldRenderCommunityWelcome('acme-sa', undefined, 'community.kodera.io')).toBe(false)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'localhost')).toBe(false)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'console.kodera.io')).toBe(false)
  })

  it('renders CommunityWelcome on community.kodera.io /login and LoginScreen on /login?mode=tenant', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    Object.defineProperty(window, 'location', {
      value: new URL('https://community.kodera.io/login'),
      configurable: true,
    })
    const { loginRoute } = await import('./routes')
    const routeTree = rootRoute.addChildren([loginRoute])

    const communityRouter = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/login'] }),
    })
    const firstRender = render(<RouterProvider router={communityRouter} />)
    expect(await screen.findByRole('heading', { name: 'Kodera Community' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Connexion organisation dédiée' })).toHaveAttribute(
      'href',
      '/login?mode=tenant'
    )
    firstRender.unmount()

    const tenantRouter = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/login?mode=tenant'] }),
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={tenantRouter} />
      </QueryClientProvider>
    )
    expect(await screen.findByRole('textbox')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Kodera Community' })).not.toBeInTheDocument()
  })
})
