import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { InvitationsBanner } from './InvitationsBanner'
import { ToastProvider } from '../../ui/Toast/Toast'
import type { components } from '../../api/schema'

type Invitation = components['schemas']['Invitation']

function invitation(id: string, email: string): Invitation {
  return {
    id,
    organisation_id: 'org-1',
    email,
    role: 'org_member',
    state: 'pending',
    expires_at: '2026-09-09T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
  }
}

function withToast(children: ReactNode) {
  return (
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      {children}
    </ToastProvider>
  )
}

const BASE = 'https://core.test/api/v1'

describe('InvitationsBanner', () => {
  const server = setupServer()
  beforeAll(() => {
    vi.stubEnv('VITE_CORE_API_URL', BASE)
    server.listen({ onUnhandledFrame: 'error' })
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    vi.unstubAllEnvs()
    server.close()
  })

  it('renders nothing while there is nothing to show', () => {
    render(withToast(<InvitationsBanner invitations={[]} hasMore={false} />))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('tracks a later, non-empty `invitations` prop rather than the one it mounted with', () => {
    // The regression this guards: a parent that starts with `invitations=[]`
    // while its own query is still loading, then re-renders with the real
    // page once it resolves — the banner must reflect the CURRENT prop, not
    // whatever it happened to be on this component's first render.
    const { rerender } = render(withToast(<InvitationsBanner invitations={[]} hasMore={false} />))
    expect(screen.queryByText(/invitation/)).not.toBeInTheDocument()

    rerender(
      withToast(
        <InvitationsBanner
          invitations={[invitation('a', 'marc@acme.fr'), invitation('b', 'julie@acme.fr')]}
          hasMore={false}
        />
      )
    )

    expect(screen.getByText('2 invitations attendent depuis plus de 3 jours.')).toBeInTheDocument()
  })

  it('shows the quiet note when the invitations call failed, even with no invitations loaded', () => {
    render(withToast(<InvitationsBanner invitations={[]} hasMore={false} errored />))
    expect(
      screen.getByText(/Les invitations en attente n'ont pas pu être lues\./)
    ).toBeInTheDocument()
  })

  it('resends every invitation and reports success once all succeed', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/invitations/:id/actions/resend', () => {
        calls += 1
        return HttpResponse.json({ id: 'x', sent_count: 2, last_sent_at: '2026-09-02T00:00:00Z' })
      })
    )

    render(
      withToast(
        <InvitationsBanner
          invitations={[invitation('a', 'marc@acme.fr'), invitation('b', 'julie@acme.fr')]}
          hasMore={false}
        />
      )
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))

    expect(await screen.findByText('2 invitations renvoyées', { exact: true })).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('lists only the failed address and does not re-attempt the successes', async () => {
    server.use(
      http.post('*/api/v1/invitations/:id/actions/resend', ({ params }) => {
        if (params['id'] === 'b') {
          return HttpResponse.json(
            {
              type: 'https://kodera.io/problems/rate-limited',
              title: 'x',
              status: 429,
              retry_after_s: 20,
            },
            { status: 429 }
          )
        }
        return HttpResponse.json({
          id: params['id'],
          sent_count: 2,
          last_sent_at: '2026-09-02T00:00:00Z',
        })
      })
    )

    render(
      withToast(
        <InvitationsBanner
          invitations={[invitation('a', 'marc@acme.fr'), invitation('b', 'julie@acme.fr')]}
          hasMore={false}
        />
      )
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))

    expect(await screen.findByText('julie@acme.fr')).toBeInTheDocument()
    expect(screen.queryByText('marc@acme.fr')).not.toBeInTheDocument()
    expect(screen.getByText('1 invitation attend depuis plus de 3 jours.')).toBeInTheDocument()
    expect(screen.getByText('Trop de tentatives. Réessayez dans 20 secondes.')).toBeInTheDocument()
  })

  it('disables the resend action with the offline reason', () => {
    render(
      withToast(
        <InvitationsBanner
          invitations={[invitation('a', 'marc@acme.fr')]}
          hasMore={false}
          offline
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Relancer' })).toBeDisabled()
    expect(screen.getByText(/connexion à Internet est interrompue/)).toBeInTheDocument()
  })

  it('writes "au moins {count}" when the page has more', () => {
    render(
      withToast(
        <InvitationsBanner invitations={[invitation('a', 'marc@acme.fr')]} hasMore={true} />
      )
    )
    expect(
      screen.getByText('Au moins 1 invitations attendent depuis plus de 3 jours.')
    ).toBeInTheDocument()
  })
  it('admits new pending invitations after an earlier successful batch', async () => {
    server.use(
      http.post('*/api/v1/invitations/:id/actions/resend', () =>
        HttpResponse.json({ id: 'a', sent_count: 2, last_sent_at: '2026-09-02T00:00:00Z' })
      )
    )
    const { rerender } = render(
      withToast(
        <InvitationsBanner invitations={[invitation('a', 'old@example.test')]} hasMore={false} />
      )
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))
    expect(await screen.findByText('1 invitation renvoyée', { exact: true })).toBeInTheDocument()
    rerender(
      withToast(
        <InvitationsBanner
          invitations={[invitation('a', 'old@example.test'), invitation('b', 'new@example.test')]}
          hasMore={false}
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Relancer' })).toBeInTheDocument()
    expect(screen.getByText('1 invitation attend depuis plus de 3 jours.')).toBeInTheDocument()
  })

  it('counts down rate limits and refuses early retries while admitting a later retry', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/invitations/:id/actions/resend', () => {
        calls += 1
        return HttpResponse.json(
          {
            type: 'https://kodera.io/problems/rate-limited',
            title: 'limited',
            status: 429,
            retry_after_s: 20,
          },
          { status: 429 }
        )
      })
    )
    render(
      withToast(
        <InvitationsBanner invitations={[invitation('a', 'rate@example.test')]} hasMore={false} />
      )
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))
    expect(
      await screen.findByText('Trop de tentatives. Réessayez dans 20 secondes.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relancer' })).toBeDisabled()
    expect(calls).toBe(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 1000)
    await waitFor(
      () =>
        expect(
          screen.getByText('Trop de tentatives. Réessayez dans 19 secondes.')
        ).toBeInTheDocument(),
      { timeout: 2000 }
    )
    vi.spyOn(Date, 'now').mockReturnValue(now + 21000)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Relancer' })).toBeEnabled(), {
      timeout: 2000,
    })
  })
  it('lets a new eligible ID proceed without retrying a cooling-down ID', async () => {
    const attempts: string[] = []
    server.use(
      http.post('*/api/v1/invitations/:id/actions/resend', ({ params }) => {
        attempts.push(String(params['id']))
        return params['id'] === 'a'
          ? HttpResponse.json(
              {
                type: 'https://kodera.io/problems/rate-limited',
                title: 'limited',
                status: 429,
                retry_after_s: 20,
              },
              { status: 429 }
            )
          : HttpResponse.json({ id: 'b', sent_count: 2, last_sent_at: '2026-09-02T00:00:00Z' })
      })
    )
    const first = invitation('a', 'rate@example.test')
    const { rerender } = render(
      withToast(<InvitationsBanner invitations={[first]} hasMore={false} />)
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))
    await screen.findByText('Trop de tentatives. Réessayez dans 20 secondes.')
    rerender(
      withToast(
        <InvitationsBanner
          invitations={[first, invitation('b', 'new@example.test')]}
          hasMore={false}
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Relancer' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Relancer' }))
    expect(attempts).toEqual(['a', 'b'])
    expect(screen.getByText('1 invitation attend depuis plus de 3 jours.')).toBeInTheDocument()
  })
})
