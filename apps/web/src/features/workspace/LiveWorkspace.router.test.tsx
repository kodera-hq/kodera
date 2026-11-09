// The live workspace under a real router, shaped like `routes.tsx`: a channel chosen in the view
// becomes the address, and what the view shows and sends agrees with the address the router has
// committed — never with a navigation that was given up on the way.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { EspaceLiveView, type EspaceStoreLike } from '../espace/EspaceLiveView'
import type { EspaceSnapshot } from '../espace/matrix/store'
import { useChannelNavigation } from './useChannelNavigation'
import type { Workspace } from './workspace'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const WELCOME = 'a1111111-1111-4111-8111-000000000002'
const GENERAL_ROOM = '!general:matrix.acme.kodera.io'
const WELCOME_ROOM = '!welcome:matrix.acme.kodera.io'

const channel = (id: string, name: string) => ({
  id,
  kind: 'text' as const,
  name,
  template_key: name,
  topic: '',
  lifecycle: 'active' as const,
  room_state: 'ready' as const,
})

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-general',
      name: 'General',
      template_key: 'general',
      channels: [channel(GENERAL, 'general'), channel(WELCOME, 'welcome')],
    },
  ],
  uncategorised_channels: [],
}

function fakeStore(): EspaceStoreLike {
  const room = (roomId: string, name: string) => ({
    roomId,
    name,
    alias: null,
    kind: 'text' as const,
    unread: 0,
    mentions: 0,
    occupancy: null,
  })
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map([
      [GENERAL, { state: 'resolved', roomId: GENERAL_ROOM }],
      [WELCOME, { state: 'resolved', roomId: WELCOME_ROOM }],
    ]),
    rooms: [room(GENERAL_ROOM, 'general'), room(WELCOME_ROOM, 'welcome')],
    invites: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: () => [],
    getThread: () => [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  }
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The workspace's routes, with the organisation's `beforeLoad` held for one channel. */
function workspaceRouter(store: EspaceStoreLike, initial: string) {
  const held = { gate: null as ReturnType<typeof deferred> | null }
  function Live() {
    const params = useParams({ strict: false }) as { org: string; channelId?: string }
    const navigation = useChannelNavigation(params.org)
    return (
      <EspaceLiveView
        org={params.org}
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={params.channelId}
        store={store}
        {...navigation}
      />
    )
  }
  const root = createRootRoute()
  const org = createRoute({
    getParentRoute: () => root,
    path: '$org',
    // The application's settings for this route (`src/app/org-route.tsx`).
    pendingComponent: () => <p>Chargement…</p>,
    pendingMs: 0,
    pendingMinMs: 0,
    beforeLoad: async ({ params }) => {
      const { channelId } = params as { channelId?: string }
      if (channelId === WELCOME && held.gate !== null) await held.gate.promise
    },
  })
  const workspace = createRoute({ getParentRoute: () => org, path: 'workspace', component: Live })
  const index = createRoute({ getParentRoute: () => workspace, path: '/' })
  const byChannel = createRoute({ getParentRoute: () => workspace, path: '$channelId' })
  const router = createRouter({
    routeTree: root.addChildren([org.addChildren([workspace.addChildren([index, byChannel])])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  return { router, held }
}

describe('the live workspace under the router', () => {
  it('shows and sends to the channel the address names after a navigation given up with Back', async () => {
    const user = userEvent.setup()
    const store = fakeStore()
    const { router, held } = workspaceRouter(store, `/acme/workspace/${GENERAL}`)
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('général')

    // #bienvenue is asked for, and its navigation is held.
    held.gate = deferred()
    await user.click(screen.getByRole('link', { name: 'bienvenue' }))
    // While the address is undecided, nothing can be sent.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled())
    // Read-only, so the focus stays in it, and said to be unavailable.
    expect(screen.getByRole('combobox')).toHaveAttribute('readonly')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-disabled', 'true')

    // Back before it commits: the address is #général again.
    act(() => router.history.back())
    await waitFor(() => expect(router.state.location.pathname).toBe(`/acme/workspace/${GENERAL}`))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Envoyer' })).not.toBeDisabled())
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
    const composer = screen.getByLabelText('Message dans #général')
    await user.type(composer, 'pour général{Enter}')
    expect(store.send).toHaveBeenCalledTimes(1)
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'pour général', {})

    // The held navigation finishing late changes nothing.
    await act(async () => {
      held.gate?.resolve()
      await Promise.resolve()
    })
    expect(router.state.location.pathname).toBe(`/acme/workspace/${GENERAL}`)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
  })

  it('makes a clicked channel the address, and shows it once the router commits it', async () => {
    const user = userEvent.setup()
    const store = fakeStore()
    const { router } = workspaceRouter(store, `/acme/workspace/${GENERAL}`)
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('général')
    await user.click(screen.getByRole('link', { name: 'bienvenue' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/acme/workspace/${WELCOME}`))
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('bienvenue')
    )
    await user.type(screen.getByLabelText('Message dans #bienvenue'), 'pour bienvenue{Enter}')
    expect(store.send).toHaveBeenCalledWith(WELCOME_ROOM, 'pour bienvenue', {})
  })

  it('opens the channel chosen in the search, and leaves focus on its heading', async () => {
    const user = userEvent.setup()
    const { router } = workspaceRouter(fakeStore(), `/acme/workspace/${GENERAL}`)
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('général')

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.keyboard('bienv{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe(`/acme/workspace/${WELCOME}`))
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('bienvenue')
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
  })
})
