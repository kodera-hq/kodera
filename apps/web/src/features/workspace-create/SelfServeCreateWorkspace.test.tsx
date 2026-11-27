import { render, screen, waitFor } from '@testing-library/react'
import * as axe from 'axe-core'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RouterModule from '@tanstack/react-router'
import '@/i18n'
import { setTokenProvider } from '@/api/client'
import { clearKnownSharedRealmSlugs, isKnownSharedRealmSlug } from '@/app/communityAccess'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { server } from '@/mocks/server'
import { SelfServeCreateWorkspace } from './CreateWorkspace'

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof RouterModule>()),
  useRouter: () => ({ navigate: navigateMock, invalidate: vi.fn() }),
}))

const BASE = 'https://core.test/api/v1'

function renderSelfServe(props: Parameters<typeof SelfServeCreateWorkspace>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SelfServeCreateWorkspace {...props} />
    </QueryClientProvider>
  )
}

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(() => 'synthetic-community-bearer')
  navigateMock.mockReset()
  navigateMock.mockResolvedValue(undefined)
  clearKnownSharedRealmSlugs()
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
afterAll(() => server.close())

describe('SelfServeCreateWorkspace (B1.1 cardless PME self-serve)', () => {
  it('keeps the plan radios accessible and free of inline styles inside the creation form', async () => {
    vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', 'true')
    const { container } = renderSelfServe()
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelector('[style]')).toBeNull()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations
    ).toEqual([])
    const user = userEvent.setup()
    const free = screen.getByRole('radio', { name: /gratuit/i })
    free.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: /dédié/i })).toBeChecked()
    await user.keyboard('{ArrowDown}')
    expect(free).toBeChecked()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('radio', { name: /dédié/i })).toBeChecked()
    await user.keyboard('{ArrowLeft}')
    expect(free).toBeChecked()
    await user.tab()
    expect(screen.getByRole('textbox', { name: 'Nom de l’espace' })).toHaveFocus()
    expect(new FormData(container.querySelector('form')!).get('plan')).toBe('freemium')
  })

  it.each([undefined, 'false', '1', 'TRUE'])(
    'offers only cardless creation for a Sovereign request when readiness is %s',
    (value) => {
      vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', value)
      renderSelfServe({ initialPlan: 'sovereign', existingSovereignOrgSlug: 'existing-owner' })
      expect(screen.queryByRole('radio')).toBeNull()
      expect(screen.getByRole('button', { name: 'Créer mon espace gratuit' })).toBeDisabled()
    }
  )

  it('provisions a cardless freemium PME workspace and navigates straight to /$org/workspace', async () => {
    let hintAtNavigation: unknown
    navigateMock.mockImplementation(async () => {
      hintAtNavigation = sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')
    })
    const observed: { key: string | null; body: unknown }[] = []
    server.use(
      http.post('*/api/v1/workspaces/self-serve', async ({ request }) => {
        observed.push({
          key: request.headers.get('Idempotency-Key'),
          body: await request.json(),
        })
        return HttpResponse.json(
          {
            organisation_id: '01950000-0000-7000-8000-000000000077',
            organisation_slug: 'studio-lumiere',
            workspace_id: '01950000-0000-7000-8000-000000000078',
            tenant_id: '01950000-0000-7000-8000-000000000079',
            redirect_path: '/studio-lumiere/workspace',
            quota: {
              policy_ref: 'freemium:pme:seats-5',
              seats: 5,
              used: 1,
              remaining: 4,
            },
          },
          { status: 201 }
        )
      })
    )

    renderSelfServe()
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), 'Studio Lumière')
    expect(screen.getByText('/studio-lumiere/workspace')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Créer mon espace gratuit' }))

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/$org/workspace',
        params: { org: 'studio-lumiere' },
      })
    )
    expect(observed).toHaveLength(1)
    expect(observed[0]?.key).toBeTruthy()
    expect(observed[0]?.body).toEqual({
      name: 'Studio Lumière',
      slug: 'studio-lumiere',
      locale: 'fr',
    })
    expect(isKnownSharedRealmSlug('studio-lumiere')).toBe(true)
    expect(JSON.parse(hintAtNavigation as string)).toContain('studio-lumiere')
  })

  it('offers clickable slug suggestions on 409 slug-taken and surfaces 429 rate limits', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/workspaces/self-serve', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            {
              type: 'https://kodera.io/problems/slug-taken',
              title: 'Slug taken',
              status: 409,
              request_id: 'req-slug-01',
              slug: 'atelier-nord',
              suggestions: ['atelier-nord-2', 'atelier-nord-3'],
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } }
          )
        }
        return HttpResponse.json(
          {
            type: 'https://kodera.io/problems/rate-limited',
            title: 'Too many requests',
            status: 429,
            request_id: 'req-limit-02',
            code: 'self_serve_workspace_limit',
            retry_after_s: 3600,
          },
          { status: 429, headers: { 'Content-Type': 'application/problem+json' } }
        )
      })
    )

    renderSelfServe()
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), 'Atelier Nord')
    await userEvent.click(screen.getByRole('button', { name: 'Créer mon espace gratuit' }))

    const suggestion = await screen.findByRole('button', {
      name: /atelier-nord-2/,
    })
    await userEvent.click(suggestion)
    await userEvent.click(screen.getByRole('button', { name: 'Créer mon espace gratuit' }))

    expect(
      await screen.findByText(/Vous avez atteint la limite de 3 espaces gratuits actifs/)
    ).toBeVisible()
  })

  it('routes ?plan=sovereign directly to /$org/order?pack=sovereign when an owned organisation already exists', async () => {
    vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', 'true')
    renderSelfServe({
      initialPlan: 'sovereign',
      existingSovereignOrgSlug: 'maison-vercelli',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Continuer vers la configuration dédiée' })
    )
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/$org/order',
        params: { org: 'maison-vercelli' },
        search: { pack: 'sovereign' },
      })
    )
  })

  it('carries ?pack=sovereign into /$org/order when creating a new organisation under ?plan=sovereign', async () => {
    server.use(
      http.post('*/api/v1/workspaces/self-serve', () =>
        HttpResponse.json(
          {
            organisation_id: '01950000-0000-7000-8000-000000000090',
            organisation_slug: 'atelier-souverain',
            workspace_id: '01950000-0000-7000-8000-000000000091',
            tenant_id: '01950000-0000-7000-8000-000000000092',
            redirect_path: '/atelier-souverain/workspace',
            quota: {
              policy_ref: 'freemium:pme:seats-5',
              seats: 5,
              used: 1,
              remaining: 4,
            },
          },
          { status: 201 }
        )
      )
    )
    vi.stubEnv('VITE_SOVEREIGN_LIVE_READY', 'true')
    renderSelfServe({ initialPlan: 'sovereign' })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Nom de l’espace' }),
      'Atelier Souverain'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Continuer vers la configuration dédiée' })
    )
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/$org/order',
        params: { org: 'atelier-souverain' },
        search: { pack: 'sovereign' },
      })
    )
  })
})
