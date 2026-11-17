import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('matches only the exact configured community.{VITE_MATRIX_DOMAIN} host and rejects look-alikes', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    const { shouldRenderCommunityWelcome } = await import('./routes')
    expect(shouldRenderCommunityWelcome('community', undefined, 'localhost')).toBe(true)
    expect(shouldRenderCommunityWelcome('community', 'tenant', 'community.kodera.io')).toBe(true)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.kodera.io')).toBe(true)
    expect(shouldRenderCommunityWelcome(undefined, 'tenant', 'community.kodera.io')).toBe(false)
    expect(shouldRenderCommunityWelcome('acme-sa', undefined, 'community.kodera.io')).toBe(false)
    expect(
      shouldRenderCommunityWelcome(undefined, undefined, 'community.kodera.io.attacker.test')
    ).toBe(false)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.acme.fr')).toBe(false)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.staging.kodera.io')).toBe(
      false
    )
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'localhost')).toBe(false)
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'console.kodera.io')).toBe(false)

    vi.stubEnv('VITE_MATRIX_DOMAIN', 'staging.kodera.io')
    expect(shouldRenderCommunityWelcome(undefined, undefined, 'community.staging.kodera.io')).toBe(
      true
    )
  })

  it('renders CommunityWelcome on community.kodera.io /login and SPA-navigates to /login?mode=tenant', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    Object.defineProperty(window, 'location', {
      value: new URL('https://community.kodera.io/login'),
      configurable: true,
    })
    const { loginRoute } = await import('./routes')
    const routeTree = rootRoute.addChildren([loginRoute])

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/login'] }),
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
    expect(await screen.findByRole('heading', { name: 'Kodera Community' })).toBeVisible()
    const tenantLink = screen.getByRole('link', { name: 'Connexion organisation dédiée' })
    expect(tenantLink).toHaveAttribute('href', '/login?mode=tenant')

    await userEvent.click(tenantLink)
    expect(await screen.findByRole('textbox')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Kodera Community' })).not.toBeInTheDocument()
  })
})
